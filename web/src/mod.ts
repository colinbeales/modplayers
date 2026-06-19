import type { ChannelState, ModFile, NoteCell, Pattern, PlayerState, SampleInfo, TransportState } from './types';

export const OUTPUT_RATE = 44100;
const PAULA_CLOCK = 7_093_789.2;
const SINE_TABLE = Array.from({ length: 64 }, (_, i) => Math.round(255 * Math.sin(Math.PI * 2 * i / 64)));
const NOTE_PERIODS = [
  ['C-1', 856], ['C#1', 808], ['D-1', 762], ['D#1', 720], ['E-1', 678], ['F-1', 640],
  ['F#1', 604], ['G-1', 570], ['G#1', 538], ['A-1', 508], ['A#1', 480], ['B-1', 453],
  ['C-2', 428], ['C#2', 404], ['D-2', 381], ['D#2', 360], ['E-2', 339], ['F-2', 320],
  ['F#2', 302], ['G-2', 285], ['G#2', 269], ['A-2', 254], ['A#2', 240], ['B-2', 226],
  ['C-3', 214], ['C#3', 202], ['D-3', 190], ['D#3', 180], ['E-3', 170], ['F-3', 160],
  ['F#3', 151], ['G-3', 143], ['G#3', 135], ['A-3', 127], ['A#3', 120], ['B-3', 113],
] as const;

interface Channel {
  sampleNum: number;
  pos: number;
  period: number;
  effectivePeriod: number;
  volume: number;
  effectiveVolume: number;
  effectCmd: number;
  effectData: number;
  portTarget: number;
  portSpeed: number;
  vibSpeed: number;
  vibDepth: number;
  vibPos: number;
  vibWaveform: number;
  tremSpeed: number;
  tremDepth: number;
  tremPos: number;
  tremWaveform: number;
  arpBasePeriod: number;
  loopRow: number;
  loopCount: number;
  noteDelay: number;
  delayedNote: NoteCell | null;
  noteCutTick: number;
  retrigCount: number;
  muted: boolean;
  solo: boolean;
  peak: number;
  scope: Float32Array;
  scopePos: number;
}

export function parseMod(data: ArrayBuffer): ModFile {
  const bytes = new Uint8Array(data);
  if (bytes.length < 1084) {
    throw new Error('File is too short to be a ProTracker MOD');
  }

  const title = readString(bytes, 0, 20);
  const samples: Array<SampleInfo | null> = [null];
  for (let i = 0; i < 31; i++) {
    const off = 20 + i * 30;
    const fineRaw = bytes[off + 24] & 0x0f;
    samples.push({
      name: readString(bytes, off, 22),
      length: readU16(bytes, off + 22) * 2,
      finetune: fineRaw < 8 ? fineRaw : fineRaw - 16,
      volume: Math.min(bytes[off + 25], 64),
      loopStart: readU16(bytes, off + 26) * 2,
      loopLen: readU16(bytes, off + 28) * 2,
      dataFloat: new Float32Array(),
    });
  }

  const songLength = bytes[950];
  const restartPos = bytes[951];
  const patternTable = Array.from(bytes.slice(952, 1080));
  const tag = readString(bytes, 1080, 4, false);
  const numChannels = tag === '6CHN' ? 6 : ['8CHN', 'FLT8', 'OCTA'].includes(tag) ? 8 : 4;
  const numPatterns = Math.max(0, ...patternTable.slice(0, songLength)) + 1;

  let offset = 1084;
  const patterns: Pattern[] = [];
  for (let p = 0; p < numPatterns; p++) {
    const rows: NoteCell[][] = [];
    for (let row = 0; row < 64; row++) {
      const notes: NoteCell[] = [];
      for (let ch = 0; ch < numChannels; ch++) {
        if (offset + 4 > bytes.length) {
          notes.push({ sampleNum: 0, period: 0, effectCmd: 0, effectData: 0 });
          continue;
        }
        const b0 = bytes[offset];
        const b1 = bytes[offset + 1];
        const b2 = bytes[offset + 2];
        const b3 = bytes[offset + 3];
        offset += 4;
        notes.push({
          sampleNum: (b0 & 0xf0) | (b2 >> 4),
          period: ((b0 & 0x0f) << 8) | b1,
          effectCmd: b2 & 0x0f,
          effectData: b3,
        });
      }
      rows.push(notes);
    }
    patterns.push({ rows });
  }

  for (let i = 1; i <= 31; i++) {
    const sample = samples[i];
    if (!sample) continue;
    const raw = bytes.slice(offset, Math.min(offset + sample.length, bytes.length));
    const floatData = new Float32Array(sample.length);
    for (let j = 0; j < raw.length; j++) {
      floatData[j] = (raw[j] << 24 >> 24) / 128;
    }
    sample.dataFloat = floatData;
    offset += sample.length;
  }

  return { title, numChannels, samples, songLength, restartPos, patternTable, patterns };
}

export class ModPlayer {
  readonly mod: ModFile;
  private channels: Channel[];
  private songPos = 0;
  private row = 0;
  private tick = 0;
  private speed = 6;
  private bpm = 125;
  private samplesPerTick = this.calcSamplesPerTick(125);
  private tickSamplePos = 0;
  private jumpFlag = false;
  private jumpPos = -1;
  private breakRow = -1;
  private patternDelay = 0;
  private pan: number[];
  private finished = false;
  private transport: TransportState = 'stopped';

  constructor(mod: ModFile) {
    this.mod = mod;
    this.channels = Array.from({ length: mod.numChannels }, () => this.newChannel());
    this.pan = Array.from({ length: mod.numChannels }, (_, i) => [0, 1, 1, 0][i % 4]);
    this.processRow();
    this.tick = 1;
  }

  play(): void {
    if (this.finished) this.seek(0, 0);
    this.transport = 'playing';
  }

  pause(): void {
    this.transport = 'paused';
  }

  stop(): void {
    this.transport = 'stopped';
    this.seek(0, 0);
  }

  seek(songPos: number, row: number): void {
    this.songPos = clamp(Math.trunc(songPos), 0, Math.max(0, this.mod.songLength - 1));
    this.row = clamp(Math.trunc(row), 0, 63);
    this.tick = 0;
    this.tickSamplePos = 0;
    this.jumpFlag = false;
    this.jumpPos = -1;
    this.breakRow = -1;
    this.patternDelay = 0;
    this.finished = false;
    this.channels = Array.from({ length: this.mod.numChannels }, () => this.newChannel());
    this.processRow();
    this.tick = 1;
  }

  setMute(index: number, muted: boolean): void {
    if (this.channels[index]) this.channels[index].muted = muted;
  }

  toggleSolo(index: number): void {
    if (this.channels[index]) this.channels[index].solo = !this.channels[index].solo;
  }

  render(nFrames: number): Float32Array {
    const output = new Float32Array(nFrames * 2);
    if (this.transport !== 'playing') return output;

    let done = 0;
    while (done < nFrames) {
      const remaining = Math.max(1, this.samplesPerTick - this.tickSamplePos);
      const toRender = Math.min(nFrames - done, remaining);
      const hasSolo = this.channels.some((ch) => ch.solo);

      for (let chIdx = 0; chIdx < this.channels.length; chIdx++) {
        const ch = this.channels[chIdx];
        const col = this.pan[chIdx] ?? 0;
        const audible = (!hasSolo || ch.solo) && !ch.muted;
        const samples = this.renderChannel(chIdx, toRender);
        for (let i = 0; i < samples.length; i++) {
          if (audible) output[(done + i) * 2 + col] += samples[i];
        }
      }

      done += toRender;
      this.tickSamplePos += toRender;
      if (this.tickSamplePos >= this.samplesPerTick) {
        this.tickSamplePos = 0;
        this.advanceTick();
      }
    }

    for (let i = 0; i < output.length; i++) output[i] = clamp(output[i], -1, 1);
    return output;
  }

  state(): PlayerState {
    const patternIndex = this.mod.patternTable[this.songPos] ?? 0;
    return {
      mode: 'mod',
      transport: this.transport,
      songPos: this.songPos,
      patternIndex,
      row: this.row,
      tick: this.tick,
      speed: this.speed,
      bpm: this.bpm,
      finished: this.finished,
      channels: this.channels.map((ch, index): ChannelState => {
        const sample = this.mod.samples[ch.sampleNum] ?? null;
        return {
          index,
          muted: ch.muted,
          solo: ch.solo,
          sampleNum: ch.sampleNum,
          sampleName: sample?.name ?? '',
          period: ch.period,
          effectivePeriod: ch.effectivePeriod,
          volume: ch.volume,
          effectiveVolume: ch.effectiveVolume,
          effectCmd: ch.effectCmd,
          effectData: ch.effectData,
          peak: ch.peak,
          scope: ch.scope.slice(),
        };
      }),
    };
  }

  private newChannel(): Channel {
    return {
      sampleNum: 0, pos: 0, period: 0, effectivePeriod: 0, volume: 0, effectiveVolume: 0,
      effectCmd: 0, effectData: 0, portTarget: 0, portSpeed: 0, vibSpeed: 0, vibDepth: 0,
      vibPos: 0, vibWaveform: 0, tremSpeed: 0, tremDepth: 0, tremPos: 0, tremWaveform: 0,
      arpBasePeriod: 0, loopRow: 0, loopCount: 0, noteDelay: 0, delayedNote: null, noteCutTick: -1,
      retrigCount: 0, muted: false, solo: false, peak: 0, scope: new Float32Array(256), scopePos: 0,
    };
  }

  private calcSamplesPerTick(bpm: number): number {
    return Math.max(1, Math.round(OUTPUT_RATE * 2.5 / bpm));
  }

  private advanceTick(): void {
    const effectiveSpeed = this.speed * (1 + this.patternDelay);
    if (this.tick === 0) this.processRow();
    else this.processTickEffects(this.tick % this.speed);
    this.tick++;
    if (this.tick >= effectiveSpeed) {
      this.tick = 0;
      this.patternDelay = 0;
      this.advancePosition();
    }
  }

  private advancePosition(): void {
    if (this.jumpFlag) {
      this.jumpFlag = false;
      const nextPos = this.jumpPos >= 0 ? this.jumpPos : this.songPos + 1;
      const nextRow = this.breakRow >= 0 ? this.breakRow : 0;
      this.jumpPos = -1;
      this.breakRow = -1;
      this.songPos = this.mod.songLength > 0 ? nextPos % this.mod.songLength : 0;
      this.row = clamp(nextRow, 0, 63);
      return;
    }

    this.row++;
    if (this.row >= 64) {
      this.row = 0;
      this.songPos++;
      if (this.songPos >= this.mod.songLength) {
        this.songPos = this.mod.songLength > 0 ? this.mod.restartPos % this.mod.songLength : 0;
        this.finished = true;
        this.transport = 'stopped';
      }
    }
  }

  private processRow(): void {
    const pattern = this.mod.patterns[this.mod.patternTable[this.songPos] ?? 0];
    const notes = pattern?.rows[this.row] ?? [];
    for (let chIdx = 0; chIdx < this.channels.length; chIdx++) {
      const note = notes[chIdx] ?? { sampleNum: 0, period: 0, effectCmd: 0, effectData: 0 };
      const ch = this.channels[chIdx];
      ch.noteCutTick = -1;
      ch.noteDelay = 0;
      ch.delayedNote = null;
      ch.effectCmd = note.effectCmd;
      ch.effectData = note.effectData;

      const isNoteDelay = note.effectCmd === 0xe && (note.effectData >> 4) === 0xd && (note.effectData & 0xf) > 0;
      if (isNoteDelay) {
        ch.noteDelay = note.effectData & 0xf;
        ch.delayedNote = note;
      } else if (note.period > 0 || note.sampleNum > 0) {
        this.triggerNote(chIdx, note);
      }

      this.processTick0Effect(chIdx, note);
      if (![0x4, 0x6, 0x7].includes(note.effectCmd)) ch.effectivePeriod = ch.period;
      if (note.effectCmd !== 0x7) ch.effectiveVolume = ch.volume;
    }
  }

  private triggerNote(chIdx: number, note: NoteCell): void {
    const ch = this.channels[chIdx];
    if (note.sampleNum > 0) {
      const sample = this.mod.samples[note.sampleNum];
      if (sample && sample.length > 0) {
        ch.sampleNum = note.sampleNum;
        ch.volume = sample.volume;
        ch.effectiveVolume = ch.volume;
      }
    }
    if (note.period > 0) {
      if (note.effectCmd === 0x3 || note.effectCmd === 0x5) {
        ch.portTarget = note.period;
        if (note.effectCmd === 0x3 && note.effectData !== 0) ch.portSpeed = note.effectData;
      } else {
        const finetune = this.mod.samples[ch.sampleNum]?.finetune ?? 0;
        ch.period = finetune !== 0 ? Math.max(1, Math.round(note.period * Math.pow(2, -finetune / 96))) : note.period;
        ch.effectivePeriod = ch.period;
        ch.pos = 0;
        ch.arpBasePeriod = ch.period;
        if (ch.vibWaveform < 4) ch.vibPos = 0;
        if (ch.tremWaveform < 4) ch.tremPos = 0;
      }
    }
  }

  private processTick0Effect(chIdx: number, note: NoteCell): void {
    const ch = this.channels[chIdx];
    const data = note.effectData;
    const x = data >> 4;
    const y = data & 0xf;
    switch (note.effectCmd) {
      case 0x4: if (x) ch.vibSpeed = x; if (y) ch.vibDepth = y; break;
      case 0x7: if (x) ch.tremSpeed = x; if (y) ch.tremDepth = y; break;
      case 0x9: ch.pos = data * 256; break;
      case 0xb: this.jumpPos = data; this.jumpFlag = true; break;
      case 0xc: ch.volume = Math.min(data, 64); ch.effectiveVolume = ch.volume; break;
      case 0xd:
        this.breakRow = x * 10 + y;
        if (this.jumpPos < 0) this.jumpPos = this.songPos + 1;
        this.jumpFlag = true;
        break;
      case 0xf:
        if (data === 0) this.transport = 'stopped';
        else if (data < 0x20) this.speed = Math.max(1, data);
        else { this.bpm = data; this.samplesPerTick = this.calcSamplesPerTick(data); }
        break;
      case 0xe: this.processExtendedTick0(chIdx, x, y); break;
    }
  }

  private processExtendedTick0(chIdx: number, sub: number, value: number): void {
    const ch = this.channels[chIdx];
    switch (sub) {
      case 0x1: ch.period = Math.max(1, ch.period - value); break;
      case 0x2: ch.period = Math.min(0xfff, ch.period + value); break;
      case 0x4: ch.vibWaveform = value; break;
      case 0x5: ch.loopRow = this.row; ch.loopCount = 0; break;
      case 0x6:
        if (value === 0) { ch.loopRow = this.row; ch.loopCount = 0; }
        else if (ch.loopCount === 0) { ch.loopCount = value; this.breakRow = ch.loopRow; this.jumpPos = this.songPos; this.jumpFlag = true; }
        else if (--ch.loopCount > 0) { this.breakRow = ch.loopRow; this.jumpPos = this.songPos; this.jumpFlag = true; }
        break;
      case 0x7: ch.tremWaveform = value; break;
      case 0x9: ch.retrigCount = value; break;
      case 0xa: ch.volume = Math.min(64, ch.volume + value); ch.effectiveVolume = ch.volume; break;
      case 0xb: ch.volume = Math.max(0, ch.volume - value); ch.effectiveVolume = ch.volume; break;
      case 0xc: ch.noteCutTick = value; break;
      case 0xe: this.patternDelay = value; break;
    }
  }

  private processTickEffects(tick: number): void {
    for (let chIdx = 0; chIdx < this.channels.length; chIdx++) {
      const ch = this.channels[chIdx];
      const data = ch.effectData;
      const x = data >> 4;
      const y = data & 0xf;
      if (ch.noteCutTick >= 0 && tick === ch.noteCutTick) {
        ch.volume = 0; ch.effectiveVolume = 0;
      }
      if (ch.noteDelay > 0 && tick === ch.noteDelay && ch.delayedNote) {
        this.triggerNote(chIdx, ch.delayedNote);
        ch.effectivePeriod = ch.period;
        ch.effectiveVolume = ch.volume;
        this.processTick0Effect(chIdx, ch.delayedNote);
        ch.delayedNote = null;
        ch.noteDelay = 0;
      }
      switch (ch.effectCmd) {
        case 0x0:
          if (data) {
            const phase = tick % 3;
            const semis = phase === 1 ? x : phase === 2 ? y : 0;
            ch.effectivePeriod = Math.max(1, Math.round(ch.arpBasePeriod / Math.pow(2, semis / 12)));
          }
          break;
        case 0x1: ch.period = Math.max(1, ch.period - data); ch.effectivePeriod = ch.period; break;
        case 0x2: ch.period = Math.min(0xfff, ch.period + data); ch.effectivePeriod = ch.period; break;
        case 0x3: this.doPortamento(ch); break;
        case 0x4: this.doVibrato(ch); break;
        case 0x5: this.doPortamento(ch); this.doVolumeSlide(ch, data); break;
        case 0x6: this.doVibrato(ch); this.doVolumeSlide(ch, data); break;
        case 0x7: this.doTremolo(ch); break;
        case 0xa: this.doVolumeSlide(ch, data); break;
        case 0xe:
          if (x === 0x9 && ch.retrigCount > 0 && tick % ch.retrigCount === 0) ch.pos = 0;
          break;
      }
    }
  }

  private doPortamento(ch: Channel): void {
    if (ch.portTarget === 0 || ch.period === 0) return;
    ch.period = ch.period < ch.portTarget
      ? Math.min(ch.portTarget, ch.period + ch.portSpeed)
      : Math.max(ch.portTarget, ch.period - ch.portSpeed);
    ch.effectivePeriod = ch.period;
  }

  private doVibrato(ch: Channel): void {
    ch.vibPos = (ch.vibPos + ch.vibSpeed) & 63;
    ch.effectivePeriod = Math.max(1, ch.period + ((waveValue(ch.vibPos, ch.vibWaveform) * ch.vibDepth) >> 7));
  }

  private doTremolo(ch: Channel): void {
    ch.tremPos = (ch.tremPos + ch.tremSpeed) & 63;
    ch.effectiveVolume = clamp(ch.volume + ((waveValue(ch.tremPos, ch.tremWaveform) * ch.tremDepth) >> 6), 0, 64);
  }

  private doVolumeSlide(ch: Channel, data: number): void {
    const x = data >> 4;
    const y = data & 0xf;
    if (x) ch.volume = Math.min(64, ch.volume + x);
    else if (y) ch.volume = Math.max(0, ch.volume - y);
    ch.effectiveVolume = ch.volume;
  }

  private renderChannel(chIdx: number, nFrames: number): Float32Array {
    const ch = this.channels[chIdx];
    const out = new Float32Array(nFrames);
    const sample = this.mod.samples[ch.sampleNum];
    ch.peak *= 0.86;
    if (!sample || sample.dataFloat.length === 0 || ch.effectivePeriod <= 0) return out;

    const loopEnd = Math.min(sample.loopStart + sample.loopLen, sample.dataFloat.length);
    const hasLoop = sample.loopLen > 2 && loopEnd > sample.loopStart;
    const loopLen = loopEnd - sample.loopStart;
    const rate = PAULA_CLOCK / (ch.effectivePeriod * 2 * OUTPUT_RATE);
    const volume = ch.effectiveVolume / 64;

    for (let i = 0; i < nFrames; i++) {
      const sampleIndex = Math.trunc(ch.pos);
      if (sampleIndex >= sample.dataFloat.length) break;
      const value = sample.dataFloat[sampleIndex] * volume;
      out[i] = value;
      ch.scope[ch.scopePos++ % ch.scope.length] = value;
      ch.peak = Math.max(ch.peak, Math.abs(value));
      ch.pos += rate;
      if (hasLoop && ch.pos >= loopEnd) ch.pos -= loopLen;
    }
    return out;
  }
}

export function noteName(period: number): string {
  if (!period) return '---';
  let best: readonly [string, number] = NOTE_PERIODS[0];
  let bestDelta = Math.abs(period - best[1]);
  for (const note of NOTE_PERIODS) {
    const delta = Math.abs(period - note[1]);
    if (delta < bestDelta) {
      best = note;
      bestDelta = delta;
    }
  }
  return best[0];
}

export function effectString(note: NoteCell): string {
  return `${note.effectCmd.toString(16).toUpperCase()}${note.effectData.toString(16).padStart(2, '0').toUpperCase()}`;
}

function waveValue(pos: number, waveform: number): number {
  const p = pos & 63;
  if ((waveform & 3) === 0) return SINE_TABLE[p];
  if ((waveform & 3) === 1) return 255 - p * 8;
  return p < 32 ? 255 : -255;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readString(bytes: Uint8Array, offset: number, length: number, trim = true): string {
  const slice = bytes.slice(offset, offset + length);
  const end = trim ? slice.indexOf(0) : -1;
  const usable = end >= 0 ? slice.slice(0, end) : slice;
  return Array.from(usable, (b) => String.fromCharCode(b)).join('').trimEnd();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
