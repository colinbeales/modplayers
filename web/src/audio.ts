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
  private sampleBuffer: AudioBuffer | null = null;
  private sampleSource: AudioBufferSourceNode | null = null;
  private sampleAnalyser: AnalyserNode | null = null;
  private sampleStartedAt = 0;
  private samplePausedAt = 0;
  private samplePausedRate = 1; // Rate used when paused (for resume calculation)
  private sampleState: 'stopped' | 'playing' | 'paused' = 'stopped';
  private cachedSampleIndex = -1;
  private sampleGain = 1;
  private sampleSpeed = 1;
  private samplePitch = 0;
  private gainNode: GainNode | null = null;

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
    if (this.sampleSource) {
      try {
        this.sampleSource.stop();
      } catch {
        // Source may not have started yet.
      }
      this.sampleSource.disconnect();
      this.sampleSource = null;
    }
    this.wavPausedAt = 0;
    this.wavStartedAt = 0;
    this.wavState = 'stopped';
    this.samplePausedAt = 0;
    this.sampleStartedAt = 0;
    this.sampleState = 'stopped';
  }

  private getPlaybackRate(): number {
    // Pitch is in semitones: convert to frequency ratio using 2^(semitones/12)
    const pitchRatio = Math.pow(2, this.samplePitch / 12);
    return this.sampleSpeed * pitchRatio;
  }

  async playSample(): Promise<void> {
    if (!this.sampleBuffer) return;
    const context = await this.ensureContext();
    await context.resume();

    // If paused, resume from pause point
    if (this.sampleState === 'paused') {
      this.sampleSource = this.createSampleSource(this.sampleBuffer, this.sampleAnalyser!);
      // samplePausedAt is in audio time, convert to wall time for sampleStartedAt
      this.sampleStartedAt = context.currentTime - this.samplePausedAt / this.samplePausedRate;
      this.sampleSource.playbackRate.value = this.samplePausedRate;
      this.sampleSource.start(0, this.samplePausedAt);
      this.sampleState = 'playing';
      return;
    }

    // Playing already, do nothing
    if (this.sampleState === 'playing') return;

    // Starting fresh
    const playbackRate = this.getPlaybackRate();
    this.sampleAnalyser = context.createAnalyser();
    this.sampleAnalyser.fftSize = 2048;
    this.sampleSource = this.createSampleSource(this.sampleBuffer, this.sampleAnalyser);
    this.sampleStartedAt = context.currentTime;
    this.samplePausedAt = 0;
    this.sampleSource.playbackRate.value = playbackRate;
    this.sampleSource.start(0);
    this.sampleState = 'playing';
  }

  pauseSample(): void {
    if (this.sampleSource && this.context && this.sampleState === 'playing') {
      const playbackRate = this.getPlaybackRate();
      // samplePausedAt is in audio time (matches getSamplePlaybackTime)
      this.samplePausedAt = (this.context.currentTime - this.sampleStartedAt) * playbackRate;
      this.samplePausedRate = playbackRate;
      this.sampleSource.stop();
      this.sampleSource.disconnect();
      this.sampleSource = null;
      this.sampleState = 'paused';
    }
  }

  stopSample(): void {
    if (this.sampleSource) {
      try {
        this.sampleSource.stop();
      } catch {
        // Source may not have started yet.
      }
      this.sampleSource.disconnect();
      this.sampleSource = null;
    }
    this.samplePausedAt = 0;
    this.samplePausedRate = 1;
    this.sampleStartedAt = 0;
    this.sampleState = 'stopped';
    this.sampleBuffer = null;
    this.sampleAnalyser = null;
  }

  getSamplePlaybackTime(): number {
    if (this.sampleState === 'playing' && this.context) {
      const playbackRate = this.getPlaybackRate();
      return (this.context.currentTime - this.sampleStartedAt) * playbackRate;
    }
    return this.samplePausedAt;
  }

  setSampleData(index: number, data: { dataFloat: Float32Array; volume: number }): void {
    if (this.cachedSampleIndex !== index) {
      this.stopSample();
      const context = (this.context || new AudioContext());
      const buffer = context.createBuffer(1, data.dataFloat.length, 44100);
      const channelData = buffer.getChannelData(0);
      const gain = Math.max(0, Math.min(1, data.volume / 64));
      for (let i = 0; i < data.dataFloat.length; i++) {
        channelData[i] = data.dataFloat[i] * gain;
      }
      this.sampleBuffer = buffer;
      this.cachedSampleIndex = index;
      this.sampleGain = gain;
    }
  }

  setSampleSpeed(speed: number): void {
    this.sampleSpeed = speed;
  }

  setSamplePitch(semitones: number): void {
    this.samplePitch = semitones;
  }

  private createSampleSource(buffer: AudioBuffer, analyser: AnalyserNode): AudioBufferSourceNode {
    if (!this.context) {
      throw new Error('Audio context is not ready');
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    analyser.connect(this.context.destination);
    source.onended = () => {
      if (this.sampleState === 'playing') {
        this.sampleState = 'stopped';
        this.sampleSource = null;
        this.samplePausedAt = 0;
      }
    };
    return source;
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
