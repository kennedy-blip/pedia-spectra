<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import {
  Wind,
  Camera,
  CameraOff,
  AlertOctagon,
  Save,
  CheckCircle2,
  Hand,
  Sparkles,
  Timer,
} from 'lucide-vue-next';
import {
  RESPIRATORY_SIMULATOR_PRESETS,
  sampleDualRoiRespiratoryWave,
  computeKonnoMeadPhaseAngle,
  evaluateWhoImciTriage,
} from '../engines/tachypneaThoracoAbdominalEngine.js';
import { saveClinicalRecord } from '../db/pediaVaultDb.js';

const props = defineProps({
  role: { type: String, default: 'parent' },
});

const emit = defineEmits(['record-saved', 'request-permission']);

const waveCanvas = ref(null);
const lissajousCanvas = ref(null);
const videoEl = ref(null);
const roiCanvas = ref(null);

const activePresetId = ref('calm_sleep');
const ageMonths = ref(4);
const hasStridorOrGrunt = ref(false);
const mode = ref('simulator'); // 'simulator' | 'camera_roi'
const cameraError = ref('');
const saveToast = ref('');

const liveBpm = ref(34);
const livePhaseDeg = ref(9);
const currentApneaSec = ref(0);
const longestApneaSec = ref(0);
const tapTimestamps = ref([]);

const thoraxHistory = [];
const abdomenHistory = [];
const MAX_POINTS = 220;

let rafId = null;
let elapsedSec = 0;
let lastTs = 0;
let mediaStream = null;
let cameraZeroCrossings = [];
let lastAbSign = 0;

const activePreset = computed(
  () => RESPIRATORY_SIMULATOR_PRESETS.find((p) => p.id === activePresetId.value) || RESPIRATORY_SIMULATOR_PRESETS[0]
);

const imciAssessment = computed(() =>
  evaluateWhoImciTriage({
    ageMonths: ageMonths.value,
    respiratoryRate: liveBpm.value,
    taaPhaseAngleDeg: livePhaseDeg.value,
    longestApneaSec: Math.max(longestApneaSec.value, currentApneaSec.value),
    hasStridorOrGrunt: hasStridorOrGrunt.value,
  })
);

const urgencyBadgeClass = computed(() => {
  if (imciAssessment.value.urgency === 'RED') return 'badge-red';
  if (imciAssessment.value.urgency === 'AMBER') return 'badge-amber';
  return 'badge-green';
});

function selectPreset(preset) {
  stopCameraRoi();
  mode.value = 'simulator';
  activePresetId.value = preset.id;
  ageMonths.value = preset.ageMonths;
  hasStridorOrGrunt.value = preset.hasStridorOrGrunt;
  liveBpm.value = preset.targetBpm;
  livePhaseDeg.value = preset.phaseDeg;
  currentApneaSec.value = 0;
  longestApneaSec.value = 0;
  elapsedSec = 0;
  thoraxHistory.length = 0;
  abdomenHistory.length = 0;
}

function recordManualBreathTap() {
  const now = performance.now();
  tapTimestamps.value.push(now);
  if (tapTimestamps.value.length > 8) {
    tapTimestamps.value.shift();
  }
  if (tapTimestamps.value.length >= 2) {
    const spanSec = (tapTimestamps.value[tapTimestamps.value.length - 1] - tapTimestamps.value[0]) / 1000;
    if (spanSec > 0.5) {
      const bpm = Math.round(((tapTimestamps.value.length - 1) / spanSec) * 60);
      liveBpm.value = Math.max(10, Math.min(110, bpm));
    }
  }
}

async function toggleCameraEulerianRoi() {
  cameraError.value = '';
  if (mode.value === 'camera_roi') {
    stopCameraRoi();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError.value = 'Camera API unavailable. Built-in Eulerian Thoracic/Abdominal Simulator active.';
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 240 } },
      audio: false,
    });
    if (videoEl.value) {
      videoEl.value.srcObject = mediaStream;
      await videoEl.value.play();
    }
    mode.value = 'camera_roi';
    thoraxHistory.length = 0;
    abdomenHistory.length = 0;
    cameraZeroCrossings = [];
    currentApneaSec.value = 0;
    longestApneaSec.value = 0;
    emit('request-permission', { sensor: 'camera', state: 'granted' });
  } catch (err) {
    cameraError.value = `Camera unavailable (${err.message || 'Permission denied'}). Simulator active.`;
    emit('request-permission', { sensor: 'camera', state: 'denied' });
  }
}

function stopCameraRoi() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (videoEl.value) videoEl.value.srcObject = null;
  mode.value = 'simulator';
}

function sampleCameraDualRoiLuminance(nowMs) {
  const v = videoEl.value;
  const c = roiCanvas.value;
  if (!v || !c || v.readyState < 2) {
    return { thorax: 0, abdomen: 0, inApnea: false, currentPauseSec: 0 };
  }
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, 80, 60);
  // Upper ROI: Thorax box (y: 10..26, x: 24..56); Lower ROI: Abdomen box (y: 34..50, x: 24..56)
  const thData = ctx.getImageData(24, 10, 32, 16).data;
  const abData = ctx.getImageData(24, 34, 32, 16).data;

  let thSum = 0;
  let abSum = 0;
  for (let i = 0; i < thData.length; i += 4) {
    thSum += 0.299 * thData[i] + 0.587 * thData[i + 1] + 0.114 * thData[i + 2];
    abSum += 0.299 * abData[i] + 0.587 * abData[i + 1] + 0.114 * abData[i + 2];
  }
  const thMean = thSum / (thData.length / 4);
  const abMean = abSum / (abData.length / 4);

  // Subtract moving baseline for Eulerian AC micro-motion extraction
  const prevThAvg = thoraxHistory.length ? thoraxHistory.reduce((a, b) => a + b, 0) / thoraxHistory.length : 0;
  const prevAbAvg = abdomenHistory.length ? abdomenHistory.reduce((a, b) => a + b, 0) / abdomenHistory.length : 0;
  const thAc = Math.max(-1.6, Math.min(1.6, ((thMean - 128) / 20) - prevThAvg * 0.25));
  const abAc = Math.max(-1.6, Math.min(1.6, ((abMean - 128) / 20) - prevAbAvg * 0.25));

  const sign = abAc >= 0 ? 1 : -1;
  if (lastAbSign < 0 && sign > 0) {
    cameraZeroCrossings.push(nowMs);
    const cutoff = nowMs - 15000;
    cameraZeroCrossings = cameraZeroCrossings.filter((t) => t >= cutoff);
    if (cameraZeroCrossings.length >= 2) {
      const spanSec = (cameraZeroCrossings[cameraZeroCrossings.length - 1] - cameraZeroCrossings[0]) / 1000;
      if (spanSec > 1) {
        liveBpm.value = Math.max(12, Math.min(96, Math.round(((cameraZeroCrossings.length - 1) / spanSec) * 60)));
      }
    }
  }
  lastAbSign = sign;

  return { thorax: thAc, abdomen: abAc, inApnea: false, currentPauseSec: 0 };
}

function drawDualTraceWaveforms() {
  const canvas = waveCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#060e1d';
  ctx.fillRect(0, 0, w, h);

  // Horizontal midlines for Upper Thorax and Lower Abdomen channels
  const thMid = h * 0.30;
  const abMid = h * 0.72;
  ctx.strokeStyle = 'rgba(148, 210, 255, 0.14)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, thMid);
  ctx.lineTo(w, thMid);
  ctx.moveTo(0, abMid);
  ctx.lineTo(w, abMid);
  ctx.stroke();
  ctx.setLineDash([]);

  const drawChannel = (buf, midY, color) => {
    if (buf.length < 2) return;
    ctx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const x = (i / (MAX_POINTS - 1)) * w;
      const y = midY - buf[i] * (h * 0.16);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.stroke();
  };

  drawChannel(thoraxHistory, thMid, '#22d3ee');
  drawChannel(abdomenHistory, abMid, '#fb7185');

  ctx.font = '700 11px JetBrains Mono, monospace';
  ctx.fillStyle = '#22d3ee';
  ctx.fillText('ROI-1: UPPER THORAX / STERNUM', 10, 18);
  ctx.fillStyle = '#fb7185';
  ctx.fillText('ROI-2: LOWER ABDOMEN / DIAPHRAGM', 10, h * 0.54);

  if (currentApneaSec.value >= 3) {
    ctx.fillStyle = currentApneaSec.value >= 15 ? 'rgba(244, 63, 94, 0.90)' : 'rgba(251, 191, 36, 0.90)';
    ctx.font = '800 13px JetBrains Mono, monospace';
    ctx.fillText(`CENTRAL APNEA PAUSE: ${currentApneaSec.value.toFixed(1)}s`, w - 245, 22);
  }
}

function drawKonnoMeadLissajous() {
  const canvas = lissajousCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const scale = Math.min(w, h) * 0.31;

  ctx.fillStyle = '#060e1d';
  ctx.fillRect(0, 0, w, h);

  // Reference axes + Synchronous 45° diagonal vs Paradoxical 135° diagonal
  ctx.strokeStyle = 'rgba(148, 210, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, 16);
  ctx.lineTo(cx, h - 16);
  ctx.moveTo(16, cy);
  ctx.lineTo(w - 16, cy);
  ctx.stroke();

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(52, 211, 153, 0.35)';
  ctx.beginPath();
  ctx.moveTo(cx - scale, cy + scale);
  ctx.lineTo(cx + scale, cy - scale);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(244, 63, 94, 0.35)';
  ctx.beginPath();
  ctx.moveTo(cx - scale, cy - scale);
  ctx.lineTo(cx + scale, cy + scale);
  ctx.stroke();
  ctx.setLineDash([]);

  // Plot trailing Konno-Mead X=Abdomen, Y=Thorax loop
  const count = Math.min(90, thoraxHistory.length);
  if (count > 3) {
    const startIdx = thoraxHistory.length - count;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = cx + abdomenHistory[startIdx + i] * scale * 0.72;
      const y = cy - thoraxHistory[startIdx + i] * scale * 0.72;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = livePhaseDeg.value >= 110
      ? '#f43f5e'
      : (livePhaseDeg.value >= 55 ? '#fbbf24' : '#34d399');
    ctx.lineWidth = 2.6;
    ctx.stroke();

    // Glowing head marker
    const lastX = cx + abdomenHistory[thoraxHistory.length - 1] * scale * 0.72;
    const lastY = cy - thoraxHistory[thoraxHistory.length - 1] * scale * 0.72;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  ctx.font = '600 10px JetBrains Mono, monospace';
  ctx.fillStyle = '#34d399';
  ctx.fillText('0° Sync', w - 58, 22);
  ctx.fillStyle = '#f43f5e';
  ctx.fillText('180° Seesaw', 10, 22);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`X: Abdomen · Y: Thorax · phi_TAA = ${livePhaseDeg.value.toFixed(1)}°`, 12, h - 8);
}

async function logRespiratoryCheck() {
  const a = imciAssessment.value;
  const saved = await saveClinicalRecord('respiratory_imci_checks', {
    ageMonths: ageMonths.value,
    ageTierLabel: a.ageTierLabel,
    whoCutoffBpm: a.whoCutoffBpm,
    respiratoryRateBpm: liveBpm.value,
    taaPhaseAngleDeg: livePhaseDeg.value,
    longestApneaSec: Math.max(longestApneaSec.value, currentApneaSec.value),
    hasStridorOrGrunt: hasStridorOrGrunt.value,
    retractionSeverity: a.retractionSeverity,
    imciClassification: a.imciClassification,
    urgency: a.urgency,
  });
  saveToast.value = `Logged ${liveBpm.value} bpm · phi_TAA ${livePhaseDeg.value}° (${a.urgency}) to Vault.`;
  emit('record-saved', { store: 'respiratory_imci_checks', record: saved });
  setTimeout(() => { saveToast.value = ''; }, 3400);
}

function tick(now) {
  if (!lastTs) lastTs = now;
  const dt = Math.min(0.08, (now - lastTs) / 1000);
  if (dt >= 0.032) {
    lastTs = now;
    elapsedSec += dt;

    let sample;
    if (mode.value === 'camera_roi') {
      sample = sampleCameraDualRoiLuminance(now);
    } else {
      sample = sampleDualRoiRespiratoryWave(activePreset.value, elapsedSec);
      liveBpm.value = sample.inApnea ? 0 : activePreset.value.targetBpm;
    }

    thoraxHistory.push(sample.thorax);
    abdomenHistory.push(sample.abdomen);
    if (thoraxHistory.length > MAX_POINTS) {
      thoraxHistory.shift();
      abdomenHistory.shift();
    }

    currentApneaSec.value = sample.currentPauseSec;
    if (sample.currentPauseSec > longestApneaSec.value) {
      longestApneaSec.value = sample.currentPauseSec;
    }

    if (thoraxHistory.length >= 30 && !sample.inApnea) {
      livePhaseDeg.value = computeKonnoMeadPhaseAngle(
        thoraxHistory.slice(-90),
        abdomenHistory.slice(-90)
      );
    }

    drawDualTraceWaveforms();
    drawKonnoMeadLissajous();
  }
  rafId = requestAnimationFrame(tick);
}

onMounted(() => {
  rafId = requestAnimationFrame(tick);
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  stopCameraRoi();
});

watch(ageMonths, () => {
  // Re-evaluates WHO IMCI cutoff automatically via computed
});
</script>

<template>
  <section class="glass-panel" style="padding: 20px;">
    <video ref="videoEl" playsinline muted style="display: none;"></video>
    <canvas ref="roiCanvas" width="80" height="60" style="display: none;"></canvas>

    <!-- Header -->
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px;">
      <div>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <Wind :size="19" style="color: var(--accent-teal);" />
          <h2 style="margin: 0; font-size: 1.18rem; font-weight: 800;">
            Contact-Free Eulerian Respiratory (WHO IMCI) &amp; Retraction Monitor
          </h2>
          <span class="status-badge" :class="urgencyBadgeClass">
            {{ imciAssessment.urgency }} · {{ imciAssessment.retractionSeverity.replace(/_/g, ' ') }}
          </span>
        </div>
        <p style="margin: 0; font-size: 0.83rem; color: var(--text-secondary);">
          Dual-ROI Thorax vs. Abdomen optical phase solver, Konno-Mead Lissajous retraction angle (φ_TAA), apnea stopwatch (&gt;15–20s), and WHO IMCI cutoffs.
        </p>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        <button class="btn-glass" :class="mode === 'camera_roi' ? 'btn-danger' : 'btn-primary'" @click="toggleCameraEulerianRoi">
          <Camera v-if="mode !== 'camera_roi'" :size="15" />
          <CameraOff v-else :size="15" />
          {{ mode === 'camera_roi' ? 'Stop Optical Camera' : 'Start Contact-Free Camera' }}
        </button>
        <button class="btn-glass" @click="recordManualBreathTap">
          <Hand :size="15" /> Tap Each Breath ({{ tapTimestamps.length }})
        </button>
        <button class="btn-glass" @click="logRespiratoryCheck">
          <Save :size="15" /> Save IMCI Check
        </button>
      </div>
    </div>

    <div v-if="cameraError" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-amber); color: var(--accent-amber); font-size: 0.82rem;">
      {{ cameraError }}
    </div>
    <div v-if="saveToast" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-emerald); color: var(--accent-emerald); font-size: 0.82rem; display: flex; align-items: center; gap: 8px;">
      <CheckCircle2 :size="16" /> {{ saveToast }}
    </div>

    <!-- 1-Tap Respiratory Presets + Age / Clinical Risk Bar -->
    <div class="glass-subcard" style="margin-bottom: 16px;">
      <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px;">
        <span style="font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
          <Sparkles :size="14" style="color: var(--accent-teal);" />
          1-Tap Respiratory Distress &amp; Apnea Simulators
        </span>
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 0.78rem;">
          <label style="display: inline-flex; align-items: center; gap: 6px;">
            <span>Child Age (Months):</span>
            <input v-model.number="ageMonths" type="number" min="0" max="60" step="0.5" class="clinical-input" style="width: 72px; padding: 4px 8px;" />
          </label>
          <label style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;">
            <input v-model="hasStridorOrGrunt" type="checkbox" />
            <span>Audible Grunting / Rest Stridor</span>
          </label>
        </div>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        <button
          v-for="preset in RESPIRATORY_SIMULATOR_PRESETS"
          :key="preset.id"
          class="btn-glass"
          :class="{ active: mode === 'simulator' && activePresetId === preset.id }"
          @click="selectPreset(preset)"
        >
          {{ preset.label }}
        </button>
      </div>
    </div>

    <!-- KPI Telemetry Row -->
    <div class="kpi-row-4" style="margin-bottom: 16px;">
      <div class="kpi-card">
        <span class="kpi-label">Respiratory Rate (RR)</span>
        <span class="kpi-value" :style="imciAssessment.isTachypneic ? 'color: var(--accent-danger)' : 'color: var(--accent-emerald)'">
          {{ liveBpm }} <small style="font-size: 0.74rem;">bpm</small>
        </span>
        <span class="kpi-unit">WHO IMCI Limit: ≥{{ imciAssessment.whoCutoffBpm }} bpm ({{ imciAssessment.ageTierLabel }})</span>
      </div>

      <div class="kpi-card">
        <span class="kpi-label">Konno-Mead Phase (φ_TAA)</span>
        <span class="kpi-value" :style="livePhaseDeg >= 110 ? 'color: var(--accent-danger)' : (livePhaseDeg >= 55 ? 'color: var(--accent-amber)' : 'color: var(--accent-cyan)')">
          {{ livePhaseDeg.toFixed(1) }}°
        </span>
        <span class="kpi-unit">0–25° Sync · 55–105° Indrawing · ≥110° Seesaw</span>
      </div>

      <div class="kpi-card">
        <span class="kpi-label">Central Apnea Stopwatch</span>
        <span class="kpi-value" :style="Math.max(currentApneaSec, longestApneaSec) >= 15 ? 'color: var(--accent-danger)' : 'color: var(--accent-teal)'">
          {{ currentApneaSec.toFixed(1) }}s
        </span>
        <span class="kpi-unit">
          <Timer :size="11" style="vertical-align: -1px;" /> Max Pause: {{ longestApneaSec.toFixed(1) }}s (Alert ≥15–20s)
        </span>
      </div>

      <div class="kpi-card">
        <span class="kpi-label">WHO IMCI Age Cutoffs</span>
        <span class="kpi-value" style="font-size: 1.05rem; color: var(--accent-violet);">
          60 / 50 / 40
        </span>
        <span class="kpi-unit">&lt;2m ≥60 · 2–11m ≥50 · 1–5y ≥40 bpm</span>
      </div>
    </div>

    <!-- Dual Visualizations -->
    <div class="module-grid-2" style="margin-bottom: 14px;">
      <div class="glass-subcard">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span style="font-size: 0.82rem; font-weight: 700;">Dual-ROI Thorax vs. Abdomen Motion Oscillograph</span>
          <span class="mono" style="font-size: 0.72rem; color: var(--accent-cyan);">
            {{ mode === 'camera_roi' ? 'LIVE OPTICAL EULERIAN' : 'DUAL-ROI SIMULATOR' }}
          </span>
        </div>
        <canvas ref="waveCanvas" width="600" height="245" class="canvas-stage"></canvas>
      </div>

      <div class="glass-subcard">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span style="font-size: 0.82rem; font-weight: 700;">Konno-Mead Lissajous Loop (Retraction Phase Portrait)</span>
          <span class="mono" style="font-size: 0.72rem; color: var(--accent-teal);">φ_TAA = arccos(r)</span>
        </div>
        <canvas ref="lissajousCanvas" width="460" height="245" class="canvas-stage"></canvas>
      </div>
    </div>

    <!-- WHO IMCI Clinical Triage Banner -->
    <div
      class="glass-subcard"
      :style="imciAssessment.urgency === 'RED' ? 'border-color: var(--accent-danger); background: rgba(244,63,94,0.14);' : (imciAssessment.urgency === 'AMBER' ? 'border-color: var(--accent-amber); background: rgba(251,191,36,0.10);' : 'border-color: var(--accent-emerald);')"
    >
      <div style="display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 0.90rem; margin-bottom: 4px;">
        <AlertOctagon :size="18" :style="imciAssessment.urgency === 'RED' ? 'color: var(--accent-danger)' : 'color: var(--accent-emerald)'" />
        {{ imciAssessment.imciClassification }}
      </div>
      <p style="margin: 0; font-size: 0.82rem; color: var(--text-primary); line-height: 1.46;">
        {{ imciAssessment.guidance }}
      </p>
    </div>
  </section>
</template>
