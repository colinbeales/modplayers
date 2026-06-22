import './styles.css';
import { AudioController } from './audio';
import { effectString, ModPlayer, noteName, parseMod } from './mod';
import type { ModFile, PlayerState } from './types';

const audio = new AudioController();
let currentMod: ModFile | null = null;
let currentFileName = '';
let selectedSampleIndex = 0;

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="protracker-shell">
    <section class="top-grid">
      <div class="field-stack">
        <div class="pt-field"><span>POS</span><strong id="pos">000</strong></div>
        <div class="pt-field"><span>PATTERN</span><strong id="pattern">000</strong></div>
        <div class="pt-field"><span>LENGTH</span><strong id="length">000</strong></div>
      </div>
      <div class="transport pt-bevel">
        <button id="play" class="pt-button">PLAY</button>
        <button id="pause" class="pt-button">PAUSE</button>
        <button id="stop" class="pt-button">STOP</button>
        <label class="pt-button file-button">LOAD MOD<input id="file" type="file" accept=".mod,.MOD" /></label>
      </div>
      <div class="field-stack">
        <div class="pt-field"><span>TEMPO</span><strong id="bpm">125</strong></div>
        <div class="pt-field"><span>SPEED</span><strong id="speed">006</strong></div>
        <div class="pt-field status-field"><span>STATUS</span><div id="status" class="status-indicator" title="IDLE"></div></div>
      </div>
    </section>

    <section class="scope-panel pt-bevel">
      <header>QUADRASCOPE</header>
      <div id="scopes" class="scopes"></div>
    </section>

    <section class="name-bars">
      <div class="pt-namebar"><span>SONGNAME:</span><strong id="song-name">DROP A MOD OR WAV FILE</strong></div>
      <div class="pt-namebar"><span>SAMPLENAME:</span><strong id="sample-name">--</strong></div>
    </section>

    <section class="info-grid">
      <div class="sample-panel pt-bevel">
        <h2>SAMPLES</h2>
        <div id="sample-list" class="sample-list"></div>
      </div>
      <div class="pattern-panel pt-bevel" id="pattern-mode">
        <div class="pattern-toolbar">
          <div>ROW <strong id="row">00</strong></div>
          <div>TICK <strong id="tick">0</strong></div>
          <div>MODE <strong id="mode">EMPTY</strong></div>
        </div>
        <div id="pattern-grid" class="pattern-grid"></div>
      </div>
      <div class="waveform-panel pt-bevel" id="waveform-mode" style="display: none;">
        <div class="waveform-header">
          <button id="back-button" class="pt-button back-btn">◀ BACK</button>
        </div>
        <canvas id="waveform-canvas" class="waveform-canvas"></canvas>
        <div class="waveform-controls">
          <div class="control-row">
            <label>SPEED:</label>
            <input id="sample-speed" type="range" min="0.1" max="2" step="0.05" value="1" />
            <span id="speed-value">1.0x</span>
          </div>
          <div class="control-row">
            <label>PITCH:</label>
            <input id="sample-pitch" type="range" min="-12" max="12" step="1" value="0" />
            <span id="pitch-value">0</span>
          </div>
          <div class="sample-buttons">
            <button id="play-sample" class="pt-button sample-btn">PLAY</button>
            <button id="pause-sample" class="pt-button sample-btn">PAUSE</button>
            <button id="stop-sample" class="pt-button sample-btn">STOP</button>
          </div>
        </div>
      </div>
      <div class="channel-panel pt-bevel" id="channel-mode">
        <h2>CHANNELS</h2>
        <div id="channels"></div>
      </div>
    </section>
  </main>
`;

const els = {
  file: byId<HTMLInputElement>('file'),
  play: byId<HTMLButtonElement>('play'),
  pause: byId<HTMLButtonElement>('pause'),
  stop: byId<HTMLButtonElement>('stop'),
  back: byId<HTMLButtonElement>('back-button'),
  playSample: byId<HTMLButtonElement>('play-sample'),
  pauseSample: byId<HTMLButtonElement>('pause-sample'),
  stopSample: byId<HTMLButtonElement>('stop-sample'),
  sampleSpeed: byId<HTMLInputElement>('sample-speed'),
  samplePitch: byId<HTMLInputElement>('sample-pitch'),
  speedValue: byId('speed-value'),
  pitchValue: byId('pitch-value'),
  pos: byId('pos'),
  pattern: byId('pattern'),
  length: byId('length'),
  bpm: byId('bpm'),
  speed: byId('speed'),
  status: byId('status'),
  songName: byId('song-name'),
  sampleName: byId('sample-name'),
  sampleList: byId('sample-list'),
  patternGrid: byId('pattern-grid'),
  patternMode: byId('pattern-mode'),
  waveformMode: byId('waveform-mode'),
  waveformCanvas: byId<HTMLCanvasElement>('waveform-canvas'),
  channels: byId('channels'),
  channelMode: byId('channel-mode'),
  scopes: byId('scopes'),
  row: byId('row'),
  tick: byId('tick'),
  mode: byId('mode'),
};

const scopeCanvases: HTMLCanvasElement[] = [];
for (let i = 0; i < 4; i++) {
  const scope = document.createElement('canvas');
  scope.width = 260;
  scope.height = 96;
  scope.className = 'scope-canvas';
  scope.dataset.channel = `${i + 1}`;
  els.scopes.append(scope);
  scopeCanvases.push(scope);
}

els.file.addEventListener('change', async () => {
  const file = els.file.files?.[0];
  if (!file) return;
  await loadFile(file);
});

document.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
document.addEventListener('drop', async (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) await loadFile(file);
});

els.play.addEventListener('click', () => void audio.play());
els.pause.addEventListener('click', () => audio.pause());
els.stop.addEventListener('click', () => audio.stop());

els.back.addEventListener('click', () => {
  audio.stopSample();
  els.patternMode.style.display = 'block';
  els.waveformMode.style.display = 'none';
  els.channelMode.style.display = 'block';
});

els.playSample.addEventListener('click', () => void audio.playSample());
els.pauseSample.addEventListener('click', () => audio.pauseSample());
els.stopSample.addEventListener('click', () => audio.stopSample());

els.sampleSpeed.addEventListener('change', (e) => {
   const speed = parseFloat((e.target as HTMLInputElement).value);
   audio.setSampleSpeed(speed);
   els.speedValue.textContent = speed.toFixed(1) + 'x';
});

els.samplePitch.addEventListener('change', (e) => {
   const pitch = parseInt((e.target as HTMLInputElement).value);
   audio.setSamplePitch(pitch);
   els.pitchValue.textContent = String(pitch);
});

async function loadFile(file: File): Promise<void> {
  currentFileName = file.name;
  const bytes = await file.arrayBuffer();
  try {
    if (file.name.toLowerCase().endsWith('.wav') || file.type.includes('wav')) {
      const buffer = await audio.decodeAudioData(bytes);
      currentMod = null;
      await audio.setWav(buffer);
      renderSamples(null);
      els.songName.textContent = file.name;
      els.sampleName.textContent = 'PCM WAV';
      return;
    }

    currentMod = parseMod(bytes);
    audio.setModPlayer(new ModPlayer(currentMod));
    els.songName.textContent = currentMod.title || file.name;
    renderSamples(currentMod);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    els.status.textContent = 'ERROR';
    els.songName.textContent = `${file.name}: ${message}`;
  }
}

function renderSamples(mod: ModFile | null): void {
  els.sampleList.innerHTML = '';
  if (!mod) {
    els.sampleList.innerHTML = '<div class="sample-row">WAV decoded by Web Audio</div>';
    els.patternMode.style.display = 'block';
    els.waveformMode.style.display = 'none';
    els.channelMode.style.display = 'block';
    return;
  }
  mod.samples.slice(1).forEach((sample, index) => {
    if (!sample || (!sample.name && sample.length === 0)) return;
    const row = document.createElement('button');
    row.className = 'sample-row';
    row.innerHTML = `<strong>${hex(index + 1, 2)}</strong><span>${escapeHtml(sample.name || '(unnamed)')}</span><em>${sample.length}</em>`;
    row.addEventListener('click', () => {
      selectedSampleIndex = index + 1;
      els.sampleName.textContent = `${sample.name || '(unnamed)'}  LEN ${hex(sample.length, 5)} VOL ${sample.volume} FIN ${sample.finetune}`;
      audio.setSampleData(selectedSampleIndex, sample);
      els.patternMode.style.display = 'none';
      els.waveformMode.style.display = 'block';
      els.channelMode.style.display = 'none';
      drawWaveform(sample);
      els.sampleSpeed.value = '1';
      els.samplePitch.value = '0';
      els.speedValue.textContent = '1.0x';
      els.pitchValue.textContent = '0';
    });
    els.sampleList.append(row);
  });
}

function renderPattern(mod: ModFile, state: PlayerState): void {
  const pattern = mod.patterns[state.patternIndex];
  if (!pattern) return;
  const start = Math.max(0, Math.min(64 - 15, state.row - 7));
  const rows: string[] = [];
  for (let r = start; r < Math.min(64, start + 15); r++) {
    const cells = pattern.rows[r] ?? [];
    rows.push(`
      <button class="pattern-row ${r === state.row ? 'active' : ''}" data-row="${r}">
        <span class="row-num">${hex(r, 2)}</span>
        ${cells.slice(0, 4).map((note, ch) => `
          <span class="pattern-cell ${state.channels[ch]?.muted ? 'muted' : ''}">
            <b>${noteName(note.period)}</b><i>${note.sampleNum ? hex(note.sampleNum, 2) : '--'}</i><em>${effectString(note)}</em>
          </span>
        `).join('')}
      </button>
    `);
  }
  els.patternGrid.innerHTML = rows.join('');
  els.patternGrid.querySelectorAll<HTMLButtonElement>('.pattern-row').forEach((row) => {
    row.addEventListener('click', () => audio.seekMod(state.songPos, Number(row.dataset.row ?? 0)));
  });
}

function drawWaveform(sample: { dataFloat: Float32Array; length: number }): void {
  const canvas = els.waveformCanvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const width = canvas.width;
  const height = canvas.height;
  const centerY = height / 2;

  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#0066cc';
  ctx.lineWidth = 1;
  ctx.beginPath();

  const data = sample.dataFloat;
  const samplesPerPixel = Math.max(1, Math.floor(data.length / width));

  for (let x = 0; x < width; x++) {
    let min = 0, max = 0;
    for (let s = 0; s < samplesPerPixel; s++) {
      const idx = x * samplesPerPixel + s;
      if (idx < data.length) {
        const val = data[idx];
        min = Math.min(min, val);
        max = Math.max(max, val);
      }
    }
    const minY = centerY + min * (height * 0.4);
    const maxY = centerY + max * (height * 0.4);
    if (x === 0) ctx.moveTo(x, minY);
    ctx.lineTo(x, maxY);
  }
  ctx.stroke();
}

function renderChannels(state: PlayerState): void {
  els.channels.innerHTML = state.channels.slice(0, 4).map((ch) => `
    <div class="channel-strip">
      <button data-mute="${ch.index}" class="lamp ${ch.muted ? '' : 'on'}">${ch.index + 1}</button>
      <button data-solo="${ch.index}" class="solo ${ch.solo ? 'on' : ''}">S</button>
      <div class="meter"><span style="height:${Math.round(ch.peak * 100)}%"></span></div>
      <div class="channel-text">
        <strong>${noteName(ch.effectivePeriod)}</strong>
        <span>${ch.sampleNum ? hex(ch.sampleNum, 2) : '--'} ${hex(ch.effectCmd, 1)}${hex(ch.effectData, 2)}</span>
      </div>
    </div>
  `).join('');

  els.channels.querySelectorAll<HTMLButtonElement>('[data-mute]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.mute);
      const current = state.channels[index];
      audio.setMute(index, !current?.muted);
    });
  });
  els.channels.querySelectorAll<HTMLButtonElement>('[data-solo]').forEach((button) => {
    button.addEventListener('click', () => audio.toggleSolo(Number(button.dataset.solo)));
  });
}

function drawScopes(state: PlayerState): void {
  for (let i = 0; i < scopeCanvases.length; i++) {
    const canvas = scopeCanvases[i];
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const channel = state.channels[i] ?? state.channels[0];
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = channel?.muted ? '#24552e' : '#f4f000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const scope = channel?.scope ?? new Float32Array(256);
    for (let x = 0; x < canvas.width; x++) {
      const value = scope[Math.floor((x / canvas.width) * scope.length)] ?? 0;
      const y = canvas.height / 2 - value * (canvas.height * 0.42);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#d8d8d8';
    ctx.font = '14px monospace';
    ctx.fillText(String(i + 1), 8, 18);
  }
}

function frame(): void {
  const state = audio.state();
  els.pos.textContent = state.mode === 'wav' ? formatTime(state.songPos) : hex(state.songPos, 3);
  els.pattern.textContent = hex(state.patternIndex, 3);
  els.length.textContent = currentMod ? hex(currentMod.songLength, 3) : currentFileName ? 'WAV' : '000';
  els.bpm.textContent = String(state.bpm).padStart(3, '0');
  els.speed.textContent = String(state.speed).padStart(3, '0');
  const statusText = state.transport.toUpperCase();
  els.status.setAttribute('title', statusText);
  els.status.className = `status-indicator ${state.transport}`;
  els.status.textContent = state.transport === 'playing' ? '▶' : state.transport === 'paused' ? '‖' : '■';
  els.row.textContent = state.mode === 'wav' ? formatTime(state.songPos) : hex(state.row, 2);
  els.tick.textContent = String(state.tick);
  els.mode.textContent = state.mode.toUpperCase();
  document.body.dataset.transport = state.transport;

  // Draw waveform with playhead if in waveform mode
  if (els.waveformMode.style.display !== 'none' && currentMod && selectedSampleIndex > 0) {
    const sample = currentMod.samples[selectedSampleIndex];
    if (sample) drawWaveformWithPlayhead(sample);
  }

  if (currentMod) renderPattern(currentMod, state);
  else els.patternGrid.innerHTML = '<div class="empty-pattern">WAV mode: waveform scopes and meters are active.</div>';
  renderChannels(state);
  drawScopes(state);
  requestAnimationFrame(frame);
}

function drawWaveformWithPlayhead(sample: { dataFloat: Float32Array; length: number }): void {
  const canvas = els.waveformCanvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const width = canvas.width;
  const height = canvas.height;
  const centerY = height / 2;

  // Draw background
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, width, height);

  // Draw waveform
  ctx.strokeStyle = '#0066cc';
  ctx.lineWidth = 1;
  ctx.beginPath();

  const data = sample.dataFloat;
  const samplesPerPixel = Math.max(1, Math.floor(data.length / width));

  for (let x = 0; x < width; x++) {
    let min = 0, max = 0;
    for (let s = 0; s < samplesPerPixel; s++) {
      const idx = x * samplesPerPixel + s;
      if (idx < data.length) {
        const val = data[idx];
        min = Math.min(min, val);
        max = Math.max(max, val);
      }
    }
    const minY = centerY + min * (height * 0.4);
    const maxY = centerY + max * (height * 0.4);
    if (x === 0) ctx.moveTo(x, minY);
    ctx.lineTo(x, maxY);
  }
  ctx.stroke();

  // Draw playhead
  const playheadTime = audio.getSamplePlaybackTime();
  const sampleDuration = sample.length / 44100;
  if (sampleDuration > 0 && playheadTime >= 0) {
    // Playhead X is calculated as a fraction of sample duration, independent of playback rate
    const playheadX = (playheadTime / sampleDuration) * width;
    if (playheadX >= 0 && playheadX <= width) {
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    }
  }
}

requestAnimationFrame(frame);

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function hex(value: number, width: number): string {
  return Math.max(0, Math.trunc(value)).toString(16).toUpperCase().padStart(width, '0');
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[char]!);
}
