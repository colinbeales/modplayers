import { ModPlayer, OUTPUT_RATE } from './mod';
import type { PlayerState } from './types';

export class AudioController {
  private context: AudioContext | null = null;
  private modNode: ScriptProcessorNode | null = null;
  private modPlayer: ModPlayer | null = null;
  private wavBuffer: AudioBuffer | null = null;
  private wavSource: AudioBufferSourceNode | null = null;
  private wavAnalyser: AnalyserNode | null = null;
  private wavStartedAt = 0;
  private wavPausedAt = 0;
  private wavDuration = 0;
  private wavState: 'stopped' | 'playing' | 'paused' = 'stopped';

  setModPlayer(player: ModPlayer): void {
    this.stop();
    this.modPlayer = player;
    this.wavAnalyser = null;
    this.wavSource = null;
  }

  async setWav(buffer: AudioBuffer): Promise<void> {
    this.stop();
    this.modPlayer = null;
    this.wavBuffer = buffer;
    this.wavDuration = buffer.duration;
    this.wavPausedAt = 0;
    const context = await this.ensureContext();
    this.wavAnalyser = context.createAnalyser();
    this.wavAnalyser.fftSize = 2048;
    this.wavSource = this.createWavSource(buffer);
    this.wavState = 'stopped';
  }

  async play(): Promise<void> {
    const context = await this.ensureContext();
    await context.resume();
    if (this.modPlayer) {
      this.ensureModNode(context);
      this.modPlayer.play();
      return;
    }
    if (this.wavBuffer && this.wavState !== 'playing') {
      if (!this.wavSource) this.wavSource = this.createWavSource(this.wavBuffer);
      this.wavStartedAt = context.currentTime - this.wavPausedAt;
      this.wavSource.start(0, this.wavPausedAt);
      this.wavState = 'playing';
    }
  }

  pause(): void {
    if (this.modPlayer) {
      this.modPlayer.pause();
      return;
    }
    if (this.wavSource && this.context && this.wavState === 'playing') {
      this.wavPausedAt = this.context.currentTime - this.wavStartedAt;
      this.wavSource.stop();
      this.wavSource.disconnect();
      this.wavSource = null;
      this.wavState = 'paused';
    }
  }

  stop(): void {
    this.modPlayer?.stop();
    if (this.modNode) {
      this.modNode.disconnect();
      this.modNode = null;
    }
    if (this.wavSource) {
      try {
        this.wavSource.stop();
      } catch {
        // Source may not have started yet.
      }
      this.wavSource.disconnect();
      this.wavSource = null;
    }
    this.wavPausedAt = 0;
    this.wavStartedAt = 0;
    this.wavState = 'stopped';
  }

  state(): PlayerState {
    if (this.modPlayer) return this.modPlayer.state();
    const scope = new Float32Array(256);
    let peak = 0;
    if (this.wavAnalyser) {
      const data = new Float32Array(this.wavAnalyser.fftSize);
      this.wavAnalyser.getFloatTimeDomainData(data);
      const step = Math.max(1, Math.floor(data.length / scope.length));
      for (let i = 0; i < scope.length; i++) {
        const value = data[i * step] ?? 0;
        scope[i] = value;
        peak = Math.max(peak, Math.abs(value));
      }
    }
    const elapsed = this.context && this.wavState === 'playing'
      ? this.context.currentTime - this.wavStartedAt
      : this.wavPausedAt;
    return {
      mode: this.wavAnalyser ? 'wav' : 'empty',
      transport: this.wavState,
      songPos: elapsed,
      patternIndex: 0,
      row: Math.floor(elapsed),
      tick: 0,
      speed: 0,
      bpm: Math.round(this.wavDuration),
      finished: this.wavDuration > 0 && elapsed >= this.wavDuration,
      channels: [0, 1, 2, 3].map((index) => ({
        index,
        muted: false,
        solo: false,
        sampleNum: 0,
        sampleName: index === 0 ? 'WAV waveform' : '',
        period: 0,
        effectivePeriod: 0,
        volume: Math.round(peak * 64),
        effectiveVolume: Math.round(peak * 64),
        effectCmd: 0,
        effectData: 0,
        peak,
        scope,
      })),
    };
  }

  seekMod(songPos: number, row: number): void {
    this.modPlayer?.seek(songPos, row);
  }

  setMute(index: number, muted: boolean): void {
    this.modPlayer?.setMute(index, muted);
  }

  toggleSolo(index: number): void {
    this.modPlayer?.toggleSolo(index);
  }

  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    const context = await this.ensureContext();
    return context.decodeAudioData(data.slice(0));
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: OUTPUT_RATE });
    }
    return this.context;
  }

  private ensureModNode(context: AudioContext): void {
    if (this.modNode) return;
    this.modNode = context.createScriptProcessor(1024, 0, 2);
    this.modNode.onaudioprocess = (event) => {
      const player = this.modPlayer;
      if (!player) return;
      const left = event.outputBuffer.getChannelData(0);
      const right = event.outputBuffer.getChannelData(1);
      const frames = player.render(left.length);
      for (let i = 0; i < left.length; i++) {
        left[i] = frames[i * 2] ?? 0;
        right[i] = frames[i * 2 + 1] ?? 0;
      }
    };
    this.modNode.connect(context.destination);
  }

  private createWavSource(buffer: AudioBuffer): AudioBufferSourceNode {
    if (!this.context || !this.wavAnalyser) {
      throw new Error('Audio context is not ready');
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.wavAnalyser);
    this.wavAnalyser.connect(this.context.destination);
    source.onended = () => {
      if (this.wavState === 'playing' && this.context) {
        this.wavPausedAt = Math.min(this.wavDuration, this.context.currentTime - this.wavStartedAt);
        this.wavState = 'stopped';
        this.wavSource = null;
      }
    };
    return source;
  }
}
