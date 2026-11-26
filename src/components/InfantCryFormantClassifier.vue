<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import {
  Mic,
  MicOff,
  Volume2,
  Activity,
  AlertTriangle,
  Radio,
  Save,
  Sparkles,
  CheckCircle2,
  AudioWaveform,
} from 'lucide-vue-next';
import {
  CRY_SIMULATOR_PRESETS,
  synthesizeInfantCryFrame,
  analyzeCryFrame,
  playAudibleCryPreview,
} from '../engines/infantCryFormantEngine.js';
import { saveClinicalRecord } from '../db/pediaVaultDb.js';

const props = defineProps({
  role: { type: String, default: 'parent' },
  permissionStatus: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['acoustic-energy', 'record-saved', 'request-permission']);

const spectrogramCanvas = ref(null);
const formantTriangleCanvas = ref(null);

const captureMode = ref('simulator'); // 'simulator' | 'live_mic'
const activePresetId = ref('hunger_neh');
const isRunning = ref(true);
const micError = ref('');
const saveToast = ref('');

const telemetry = ref({
  f0Hz: 425,
  f1Hz: 780,
  f2Hz: 1860,
  f3Hz: 3320,
  hnrDb: 11.4,
  cppDb: 13.2,
  jitterPercent: 0.72,
  shimmerPercent: 2.45,
  stridorEnergyRatio: 0.04,
  rmsDb: -21.5,
  phonationMode: 'NORMAL_PHONATION',
  computeMs: 0.6,
  classification: {
    label: 'Hunger ("Neh")',
    phoneme: 'Neh',
    severity: 'ROUTINE',
    confidence: 94,
    phonationMode: 'NORMAL_PHONATION',
    guidance: CRY_SIMULATOR_PRESETS[0].clinicalNote,
  },
  lpcEnvelopeDb: new Float32Array(160),
});

const spectrogramHistory = [];
const MAX_SPEC_COLS = 140;
let rafId = null;
let phaseSec = 0;
let lastFrameTime = 0;

// Web Audio live microphone state
let audioCtx = null;
let mediaStream = null;
let analyserNode = null;
let micTimeBuffer = null;

const activePreset = computed(
  () => CRY_SIMULATOR_PRESETS.find((p) => p.id === activePresetId.value) || CRY_SIMULATOR_PRESETS[0]
);

const severityBadgeClass = computed(() => {
  const sev = telemetry.value.classification?.severity;
  if (sev === 'EMERGENCY' || sev === 'URGENT') return 'badge-red';
  if (sev === 'MODERATE') return 'badge-amber';
  if (sev === 'QUIET') return 'badge-cyan';
  return 'badge-green';
});

async function startLiveMicrophone() {
  micError.value = '';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    micError.value = 'Browser MediaDevices API unavailable in this context. Simulator remains active.';
    return;
  }
  try {
    stopLiveMicrophone();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 48000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx({ sampleRate: 48000 });
    const source = audioCtx.createMediaStreamSource(mediaStream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.25;
    source.connect(analyserNode);
    micTimeBuffer = new Float32Array(analyserNode.fftSize);
    captureMode.value = 'live_mic';
    isRunning.value = true;
    emit('request-permission', { sensor: 'microphone', state: 'granted' });
  } catch (err) {
    micError.value = `Microphone unavailable (${err.message || 'Permission denied'}). Falling back to 48 kHz Clinical Simulator.`;
    captureMode.value = 'simulator';
    emit('request-permission', { sensor: 'microphone', state: 'denied' });
  }
}

function stopLiveMicrophone() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyserNode = null;
  micTimeBuffer = null;
  if (captureMode.value === 'live_mic') {
    captureMode.value = 'simulator';
  }
}

function selectPreset(preset) {
  stopLiveMicrophone();
  captureMode.value = 'simulator';
  activePresetId.value = preset.id;
  isRunning.value = true;
}

function auditionPresetAudio(preset) {
  selectPreset(preset);
  playAudibleCryPreview(preset, 1.5);
}

async function logCurrentCrySnapshot() {
  const t = telemetry.value;
  const saved = await saveClinicalRecord('cry_formant_logs', {
    source: captureMode.value,
    presetId: captureMode.value === 'simulator' ? activePresetId.value : 'live_48khz_mic',
    classification: t.classification.label,
    phoneme: t.classification.phoneme,
    severity: t.classification.severity,
    phonationMode: t.phonationMode,
    f0Hz: t.f0Hz,
    f1Hz: t.f1Hz,
    f2Hz: t.f2Hz,
    f3Hz: t.f3Hz,
    hnrDb: t.hnrDb,
    cppDb: t.cppDb,
    stridorEnergyRatio: t.stridorEnergyRatio,
  });
  saveToast.value = `Logged "${t.classification.phoneme}" (${t.f0Hz} Hz) to IndexedDB Vault.`;
  emit('record-saved', { store: 'cry_formant_logs', record: saved });
  setTimeout(() => { saveToast.value = ''; }, 3400);
}

function drawSpectrogramAndLpc(lpcEnvDb, f0, f1, f2, f3) {
  const canvas = spectrogramCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  // Store column normalized 0..1
  const col = new Uint8Array(lpcEnvDb.length);
  for (let i = 0; i < lpcEnvDb.length; i++) {
    const norm = Math.max(0, Math.min(1, (lpcEnvDb[i] + 68) / 72));
    col[i] = Math.round(norm * 255);
  }
  spectrogramHistory.push(col);
  if (spectrogramHistory.length > MAX_SPEC_COLS) {
    spectrogramHistory.shift();
  }

  ctx.fillStyle = '#050c18';
  ctx.fillRect(0, 0, w, h);

  const specH = Math.floor(h * 0.64);
  const envTop = specH + 8;
  const envH = h - envTop - 16;

  // Draw scrolling waterfall spectrogram (0..5500 Hz)
  const colW = w / MAX_SPEC_COLS;
  const bins = lpcEnvDb.length;
  for (let x = 0; x < spectrogramHistory.length; x++) {
    const slice = spectrogramHistory[x];
    const px = x * colW;
    for (let b = 0; b < bins; b += 2) {
      const v = slice[b] / 255;
      if (v < 0.08) continue;
      const py = specH - (b / bins) * specH;
      const hue = 205 - v * 190;
      const light = 16 + v * 52;
      ctx.fillStyle = `hsl(${hue}, 92%, ${light}%)`;
      ctx.fillRect(px, py - 2, Math.ceil(colW) + 1, 3);
    }
  }

  // Horizontal 1,000 Hz Hyper-Phonation reference line
  const y1k = specH - (1000 / 5500) * specH;
  ctx.strokeStyle = 'rgba(251, 113, 133, 0.55)';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y1k);
  ctx.lineTo(w, y1k);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(251, 113, 133, 0.9)';
  ctx.font = '600 10px JetBrains Mono, monospace';
  ctx.fillText('1,000 Hz Hyper-Phonation Threshold', 8, y1k - 4);

  // Draw 12-Pole LPC Vocal Tract Spectral Envelope in lower panel
  ctx.fillStyle = 'rgba(10, 22, 42, 0.88)';
  ctx.fillRect(0, envTop, w, envH);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
  ctx.strokeRect(0, envTop, w, envH);

  ctx.beginPath();
  for (let b = 0; b < bins; b++) {
    const x = (b / (bins - 1)) * w;
    const norm = Math.max(0, Math.min(1, (lpcEnvDb[b] + 68) / 72));
    const y = envTop + envH - norm * (envH - 8) - 4;
    if (b === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Plot F1, F2, F3 Formant markers
  const markers = [
    { label: `F1 ${f1}Hz`, hz: f1, color: '#34d399' },
    { label: `F2 ${f2}Hz`, hz: f2, color: '#fbbf24' },
    { label: `F3 ${f3}Hz`, hz: f3, color: '#fb7185' },
  ];
  for (const m of markers) {
    const mx = Math.max(12, Math.min(w - 58, (m.hz / 5500) * w));
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(mx, envTop);
    ctx.lineTo(mx, envTop + envH);
    ctx.stroke();
    ctx.fillStyle = m.color;
    ctx.font = '700 10px JetBrains Mono, monospace';
    ctx.fillText(m.label, mx + 3, envTop + 13);
  }

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText(`0 Hz`, 6, h - 3);
  ctx.fillText(`F0: ${f0} Hz`, w / 2 - 36, h - 3);
  ctx.fillText(`5.5 kHz (12-Pole LPC)`, w - 122, h - 3);
}

function drawFormantTriangle(f1, f2, activePhoneme) {
  const canvas = formantTriangleCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#060e1d';
  ctx.fillRect(0, 0, w, h);

  // Subtle grid
  ctx.strokeStyle = 'rgba(148, 210, 255, 0.10)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo((w / 4) * i, 16);
    ctx.lineTo((w / 4) * i, h - 24);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(28, (h / 4) * i);
    ctx.lineTo(w - 14, (h / 4) * i);
    ctx.stroke();
  }

  const mapX = (f2Val) => {
    const norm = Math.max(0, Math.min(1, (f2Val - 900) / 2300));
    return 32 + norm * (w - 52);
  };
  const mapY = (f1Val) => {
    const norm = Math.max(0, Math.min(1, (f1Val - 450) / 1200));
    return 24 + norm * (h - 52);
  };

  // Draw neonatal vowel-space triangle outline connecting presets
  const anchors = [
    { name: 'Owh (Tired)', f1: 640, f2: 1220, col: '#a78bfa' },
    { name: 'Neh (Hunger)', f1: 780, f2: 1860, col: '#22d3ee' },
    { name: 'Eh (Burp)', f1: 920, f2: 2040, col: '#34d399' },
    { name: 'Eairh (Colic)', f1: 1120, f2: 1580, col: '#fbbf24' },
    { name: 'Pain (>1k F0)', f1: 1420, f2: 2740, col: '#fb7185' },
    { name: 'Stridor 680', f1: 680, f2: 1480, col: '#f43f5e' },
  ];

  // Reference triangle polygon
  ctx.beginPath();
  ctx.moveTo(mapX(1220), mapY(640));
  ctx.lineTo(mapX(2740), mapY(1420));
  ctx.lineTo(mapX(1580), mapY(1120));
  ctx.closePath();
  ctx.fillStyle = 'rgba(34, 211, 238, 0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.34)';
  ctx.stroke();

  // Plot anchor clusters
  for (const a of anchors) {
    const x = mapX(a.f2);
    const y = mapY(a.f1);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = a.col;
    ctx.fill();
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '600 10px Plus Jakarta Sans, sans-serif';
    ctx.fillText(a.name, Math.min(w - 78, x + 7), y + 3);
  }

  // Live tracked F1/F2 crosshair beacon
  const cx = mapX(f2);
  const cy = mapY(f1);
  ctx.beginPath();
  ctx.arc(cx, cy, 11, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(34, 211, 238, 0.25)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText(`F2 Horizontal (900 -> 3,200 Hz) · Active: ${activePhoneme}`, 28, h - 7);
}

function tick(now) {
  if (!lastFrameTime) lastFrameTime = now;
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);

  // Run DSP update at ~18 Hz for ultra-smooth canvas without taxing battery
  if (isRunning.value && dt >= 0.055) {
    lastFrameTime = now;
    phaseSec += dt;

    let framePcm;
    let sampleRate = 48000;
    let presetHint = null;

    if (captureMode.value === 'live_mic' && analyserNode && micTimeBuffer) {
      analyserNode.getFloatTimeDomainData(micTimeBuffer);
      framePcm = micTimeBuffer;
      sampleRate = audioCtx?.sampleRate || 48000;
    } else {
      framePcm = synthesizeInfantCryFrame(activePreset.value, phaseSec, 48000, 2048);
      presetHint = activePresetId.value;
    }

    const analysis = analyzeCryFrame(framePcm, sampleRate, presetHint);
    telemetry.value = analysis;

    const normalizedEnergy = Math.max(0, Math.min(1.4, (analysis.rmsDb + 58) / 42));
    emit('acoustic-energy', normalizedEnergy);

    drawSpectrogramAndLpc(
      analysis.lpcEnvelopeDb,
      analysis.f0Hz,
      analysis.f1Hz,
      analysis.f2Hz,
      analysis.f3Hz
    );
    drawFormantTriangle(
      analysis.f1Hz,
      analysis.f2Hz,
      analysis.classification.phoneme
    );
  }

  rafId = requestAnimationFrame(tick);
}

onMounted(() => {
  rafId = requestAnimationFrame(tick);
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  stopLiveMicrophone();
});

watch(activePresetId, () => {
  spectrogramHistory.length = 0;
});
</script>

<template>
  <section class="glass-panel" style="padding: 20px;">
    <!-- Module Header -->
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px;">
      <div>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <AudioWaveform :size="19" style="color: var(--accent-cyan);" />
          <h2 style="margin: 0; font-size: 1.18rem; font-weight: 800;">
            Infant Cry 12-Pole LPC Formant &amp; Hyper-Phonation Lab
          </h2>
          <span class="status-badge" :class="severityBadgeClass">
            {{ telemetry.phonationMode.replace(/_/g, ' ') }}
          </span>
        </div>
        <p style="margin: 0; font-size: 0.83rem; color: var(--text-secondary);">
          48 kHz Levinson-Durbin vocal-tract pole extraction, Golub-Corwin hyper-phonation (&gt;1,000 Hz) &amp; inspiratory croup stridor triage.
        </p>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        <button
          v-if="captureMode !== 'live_mic'"
          class="btn-glass btn-primary"
          @click="startLiveMicrophone"
        >
          <Mic :size="15" /> Enable Live 48 kHz Mic
        </button>
        <button
          v-else
          class="btn-glass btn-danger"
          @click="stopLiveMicrophone"
        >
          <MicOff :size="15" /> Stop Live Mic
        </button>

        <button class="btn-glass" @click="isRunning = !isRunning">
          <Radio :size="15" /> {{ isRunning ? 'Pause Stream' : 'Resume Stream' }}
        </button>

        <button class="btn-glass" @click="logCurrentCrySnapshot">
          <Save :size="15" /> Log to Vault
        </button>
      </div>
    </div>

    <!-- Error / Save Notices -->
    <div v-if="micError" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-amber); color: var(--accent-amber); font-size: 0.82rem;">
      {{ micError }}
    </div>
    <div v-if="saveToast" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-emerald); color: var(--accent-emerald); font-size: 0.82rem; display: flex; align-items: center; gap: 8px;">
      <CheckCircle2 :size="16" /> {{ saveToast }}
    </div>

    <!-- High-Acuity Clinical Alert Banner -->
    <div
      v-if="telemetry.classification.severity === 'URGENT' || telemetry.classification.severity === 'EMERGENCY'"
      class="glass-subcard"
      style="margin-bottom: 14px; border-color: var(--accent-danger); background: rgba(244, 63, 94, 0.14); display: flex; gap: 12px; align-items: flex-start;"
    >
      <AlertTriangle :size="22" style="color: var(--accent-danger); flex-shrink: 0; margin-top: 2px;" />
      <div>
        <div style="font-weight: 800; color: #fda4af; font-size: 0.92rem;">
          {{ telemetry.classification.label }}
        </div>
        <div style="font-size: 0.82rem; color: var(--text-primary); margin-top: 2px;">
          {{ telemetry.classification.guidance }}
        </div>
      </div>
    </div>

    <!-- 1-Tap Built-in Audible & Mathematical Cry Simulator Presets -->
    <div class="glass-subcard" style="margin-bottom: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 6px;">
        <span style="font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
          <Sparkles :size="14" style="color: var(--accent-cyan);" />
          1-Tap Built-In Vocal-Tract Formant Simulators (Click to Analyze · Speaker Icon to Audition)
        </span>
        <span class="mono" style="font-size: 0.73rem; color: var(--text-muted);">
          Source: {{ captureMode === 'live_mic' ? 'LIVE 48 kHz MIC' : 'SYNTHETIC GLOTTAL LPC PHANTOM' }}
        </span>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        <div
          v-for="preset in CRY_SIMULATOR_PRESETS"
          :key="preset.id"
          style="display: inline-flex; align-items: center; border-radius: 12px; overflow: hidden; border: 1px solid var(--glass-border);"
          :style="captureMode === 'simulator' && activePresetId === preset.id ? 'border-color: var(--accent-cyan); box-shadow: 0 0 14px rgba(34,211,238,0.22);' : ''"
        >
          <button
            class="btn-glass"
            :class="{ active: captureMode === 'simulator' && activePresetId === preset.id }"
            style="border: none; border-radius: 0;"
            @click="selectPreset(preset)"
          >
            {{ preset.label }}
          </button>
          <button
            class="btn-glass"
            style="border: none; border-left: 1px solid var(--glass-border); border-radius: 0; padding: 7px 9px;"
            :title="`Play soft audible ${preset.label} synthesis`"
            @click="auditionPresetAudio(preset)"
          >
            <Volume2 :size="14" />
          </button>
        </div>
      </div>
    </div>

    <!-- Primary Acoustic KPI Strip -->
    <div class="kpi-row-4" style="margin-bottom: 16px;">
      <div class="kpi-card">
        <span class="kpi-label">Fundamental Pitch (F0)</span>
        <span class="kpi-value" :style="telemetry.f0Hz >= 1000 ? 'color: var(--accent-danger)' : 'color: var(--accent-cyan)'">
          {{ telemetry.f0Hz }} <small style="font-size: 0.75rem;">Hz</small>
        </span>
        <span class="kpi-unit">{{ telemetry.f0Hz >= 1000 ? 'Hyper-Phonation (>1,000 Hz!)' : 'Normal Neonatal Band (300–650 Hz)' }}</span>
      </div>

      <div class="kpi-card">
        <span class="kpi-label">Formants F1 · F2 · F3</span>
        <span class="kpi-value" style="font-size: 1.15rem; color: var(--accent-teal);">
          {{ telemetry.f1Hz }} / {{ telemetry.f2Hz }}
        </span>
        <span class="kpi-unit">F3: {{ telemetry.f3Hz }} Hz · 12-Pole LPC</span>
      </div>

      <div class="kpi-card">
        <span class="kpi-label">CPP &amp; Harmonicity (HNR)</span>
        <span class="kpi-value" style="color: var(--accent-amber);">
          {{ telemetry.cppDb }} <small style="font-size: 0.75rem;">dB</small>
        </span>
        <span class="kpi-unit">HNR {{ telemetry.hnrDb }} dB · Jitter {{ telemetry.jitterPercent }}%</span>
      </div>

      <div class="kpi-card">
        <span class="kpi-label">Croup Stridor Ratio</span>
        <span class="kpi-value" :style="telemetry.stridorEnergyRatio >= 0.24 ? 'color: var(--accent-danger)' : 'color: var(--accent-emerald)'">
          {{ (telemetry.stridorEnergyRatio * 100).toFixed(1) }}%
        </span>
        <span class="kpi-unit">500–1,400 Hz Narrowband · {{ telemetry.computeMs }} ms</span>
      </div>
    </div>

    <!-- Dual Visualization Canvases -->
    <div class="module-grid-2">
      <div class="glass-subcard">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-size: 0.82rem; font-weight: 700;">Real-Time Waterfall Spectrogram &amp; 12-Pole LPC Envelope</span>
          <span class="mono" style="font-size: 0.72rem; color: var(--accent-cyan);">48 kHz · Hamming</span>
        </div>
        <canvas ref="spectrogramCanvas" width="600" height="270" class="canvas-stage"></canvas>
      </div>

      <div class="glass-subcard" style="display: flex; flex-direction: column; justify-content: space-between; gap: 10px;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 0.82rem; font-weight: 700;">F1–F2 Neonatal Vocal-Tract Formant Triangle</span>
            <span class="mono" style="font-size: 0.72rem; color: var(--accent-teal);">
              {{ telemetry.classification.phoneme }} ({{ telemetry.classification.confidence }}%)
            </span>
          </div>
          <canvas ref="formantTriangleCanvas" width="540" height="215" class="canvas-stage"></canvas>
        </div>

        <div style="padding: 10px 12px; border-radius: 12px; background: rgba(34, 211, 238, 0.08); border: 1px solid var(--glass-border);">
          <div style="font-size: 0.78rem; font-weight: 700; color: var(--accent-cyan); display: flex; align-items: center; gap: 6px;">
            <Activity :size="14" /> Clinical Interpretation · {{ telemetry.classification.label }}
          </div>
          <p style="margin: 4px 0 0; font-size: 0.81rem; color: var(--text-secondary); line-height: 1.42;">
            {{ telemetry.classification.guidance }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
