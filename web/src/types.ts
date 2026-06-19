export type TransportState = 'idle' | 'playing' | 'paused' | 'stopped' | 'error';

export interface SampleInfo {
  name: string;
  length: number;
  finetune: number;
  volume: number;
  loopStart: number;
  loopLen: number;
  dataFloat: Float32Array;
}

export interface NoteCell {
  sampleNum: number;
  period: number;
  effectCmd: number;
  effectData: number;
}

export interface Pattern {
  rows: NoteCell[][];
}

export interface ModFile {
  title: string;
  numChannels: number;
  samples: Array<SampleInfo | null>;
  songLength: number;
  restartPos: number;
  patternTable: number[];
  patterns: Pattern[];
}

export interface ChannelState {
  index: number;
  muted: boolean;
  solo: boolean;
  sampleNum: number;
  sampleName: string;
  period: number;
  effectivePeriod: number;
  volume: number;
  effectiveVolume: number;
  effectCmd: number;
  effectData: number;
  peak: number;
  scope: Float32Array;
}

export interface PlayerState {
  mode: 'mod' | 'wav' | 'empty';
  transport: TransportState;
  songPos: number;
  patternIndex: number;
  row: number;
  tick: number;
  speed: number;
  bpm: number;
  finished: boolean;
  channels: ChannelState[];
}
