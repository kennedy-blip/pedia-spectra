<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import {
  Camera,
  CameraOff,
  Sun,
  ShieldAlert,
  Save,
  CheckCircle2,
  Sliders,
  Sparkles,
  Eye,
} from 'lucide-vue-next';
import kubelkaFragSource from '../shaders/kubelkaMunkBilirubinShader.glsl?raw';
import {
  FITZPATRICK_SCALES,
  KRAMER_ZONES,
  BILIRUBIN_SIMULATOR_PRESETS,
  generateBhutaniSeries,
  evaluateBilirubinClinicalCase,
} from '../engines/bilirubinNomogramEngine.js';
import { saveClinicalRecord } from '../db/pediaVaultDb.js';

const props = defineProps({
  role: { type: String, default: 'parent' },
});

const emit = defineEmits(['record-saved', 'request-permission']);

const glCanvas = ref(null);
const nomogramCanvas = ref(null);
const hiddenVideo = ref(null);

const activePresetId = ref('fitz_v_intermediate');
const postnatalHours = ref(64);
const gestationalWeeks = ref(38);
const hasNeurotoxicityRisk = ref(false);
const melaninIndex = ref(0.76);
const tcbMgDl = ref(13.8);
const priorTcbMgDl = ref(10.6);
const priorHours = ref(40);
const kramerZone = ref(3);
const heatmapAlpha = ref(0.55);

const cameraActive = ref(false);
const cameraError = ref('');
const saveToast = ref('');

let gl = null;
let glProgram = null;
let glTexture = null;
let mediaStream = null;
let rafId = null;
let startTime = performance.now();

const assessment = computed(() =>
  evaluateBilirubinClinicalCase({
    postnatalHours: postnatalHours.value,
    tcbMgDl: tcbMgDl.value,
    gestationalWeeks: gestationalWeeks.value,
    hasNeurotoxicityRisk: hasNeurotoxicityRisk.value,
    priorTcbMgDl: priorTcbMgDl.value,
    priorHours: priorHours.value,
    melaninIndex: melaninIndex.value,
    kramerZone: kramerZone.value,
  })
);

const activeFitzpatrick = computed(() => {
  return FITZPATRICK_SCALES.reduce((best, item) =>
    Math.abs(item.melaninIndex - melaninIndex.value) < Math.abs(best.melaninIndex - melaninIndex.value)
      ? item
      : best
  );
});

const badgeClass = computed(() => {
  const s = assessment.value.severity;
  if (s === 'RED') return 'badge-red';
  if (s === 'AMBER') return 'badge-amber';
  if (s === 'CYAN') return 'badge-cyan';
  return 'badge-green';
});

function applyPreset(preset) {
  activePresetId.value = preset.id;
  postnatalHours.value = preset.postnatalHours;
  gestationalWeeks.value = preset.gestationalWeeks;
  hasNeurotoxicityRisk.value = preset.hasNeurotoxicityRisk;
  melaninIndex.value = preset.melaninIndex;
  tcbMgDl.value = preset.targetTcbMgDl;
  priorTcbMgDl.value = preset.priorTcbMgDl;
  priorHours.value = preset.priorHours;
  kramerZone.value = preset.kramerZone;
}

function selectKramerZone(zoneObj) {
  kramerZone.value = zoneObj.zone;
  tcbMgDl.value = zoneObj.midpointMgDl;
}

async function toggleLiveCamera() {
  cameraError.value = '';
  if (cameraActive.value) {
    stopLiveCamera();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError.value = 'Camera API unavailable in this browser context. Using interactive D65 Dermal Phantom.';
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    if (hiddenVideo.value) {
      hiddenVideo.value.srcObject = mediaStream;
      await hiddenVideo.value.play();
    }
    cameraActive.value = true;
    emit('request-permission', { sensor: 'camera', state: 'granted' });
  } catch (err) {
    cameraError.value = `Camera unavailable (${err.message || 'Permission denied'}). D65 Kubelka-Munk Phantom active.`;
    emit('request-permission', { sensor: 'camera', state: 'denied' });
  }
}

function stopLiveCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (hiddenVideo.value) {
    hiddenVideo.value.srcObject = null;
  }
  cameraActive.value = false;
}

async function logBilirubinScan() {
  const a = assessment.value;
  const saved = await saveClinicalRecord('bilirubin_tcb_scans', {
    postnatalHours: a.postnatalHours,
    gestationalWeeks: a.gestationalWeeks,
    hasNeurotoxicityRisk: a.hasNeurotoxicityRisk,
    fitzpatrick: activeFitzpatrick.value.type,
    melaninIndex: melaninIndex.value,
    tcbMgDl: a.tcbMgDl,
    tcbUmolL: a.tcbUmolL,
    phototherapyThresholdMgDl: a.phototherapyThresholdMgDl,
    exchangeThresholdMgDl: a.exchangeThresholdMgDl,
    rateOfRiseMgDlPerHr: a.rateOfRiseMgDlPerHr,
    hemolysisAlert: a.hemolysisAlert,
    kramerZone: a.kramerZone,
    riskZone: a.riskZone,
  });
  saveToast.value = `Saved TcB ${a.tcbMgDl} mg/dL (${a.tcbUmolL} µmol/L) at ${a.postnatalHours}h to Vault.`;
  emit('record-saved', { store: 'bilirubin_tcb_scans', record: saved });
  setTimeout(() => { saveToast.value = ''; }, 3400);
}

// --- WebGL2 Kubelka-Munk 460nm/550nm Bilirubin Shader Pipeline ---
function initWebGlShader() {
  const canvas = glCanvas.value;
  if (!canvas) return;
  gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: false });
  if (!gl) return;

  const vertSrc = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      vUv.y = 1.0 - vUv.y;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl.FRAGMENT_SHADER, kubelkaFragSource);
  glProgram = gl.createProgram();
  gl.attachShader(glProgram, vs);
  gl.attachShader(glProgram, fs);
  gl.linkProgram(glProgram);

  const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

  const posLoc = gl.getAttribLocation(glProgram, 'aPos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  glTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([215, 175, 130, 255]));
}

function renderWebGlFrame(now) {
  if (gl && glProgram) {
    gl.viewport(0, 0, glCanvas.value.width, glCanvas.value.height);
    gl.useProgram(glProgram);

    let useCam = 0.0;
    if (cameraActive.value && hiddenVideo.value && hiddenVideo.value.readyState >= 2) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, glTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, hiddenVideo.value);
      useCam = 1.0;
    }

    gl.uniform1i(gl.getUniformLocation(glProgram, 'uTexture'), 0);
    gl.uniform1f(gl.getUniformLocation(glProgram, 'uTime'), (now - startTime) / 1000);
    gl.uniform1f(gl.getUniformLocation(glProgram, 'uMelaninIndex'), melaninIndex.value);
    gl.uniform1f(gl.getUniformLocation(glProgram, 'uBilirubinTarget'), tcbMgDl.value);
    gl.uniform1f(gl.getUniformLocation(glProgram, 'uOverlayAlpha'), heatmapAlpha.value);
    gl.uniform1f(gl.getUniformLocation(glProgram, 'uUseCameraTexture'), useCam);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  rafId = requestAnimationFrame(renderWebGlFrame);
}

// --- Interactive 2022 AAP Bhutani 0-168h Nomogram Canvas ---
function drawBhutaniNomogram() {
  const canvas = nomogramCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const padL = 44;
  const padR = 20;
  const padT = 18;
  const padB = 32;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.fillStyle = '#060e1e';
  ctx.fillRect(0, 0, w, h);

  const mapX = (hr) => padL + (hr / 168) * plotW;
  const mapY = (mg) => padT + plotH - (Math.min(28, mg) / 28) * plotH;

  // Grid lines (every 24h and every 5 mg/dL)
  ctx.strokeStyle = 'rgba(148, 210, 255, 0.11)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';

  for (let hr = 0; hr <= 168; hr += 24) {
    const x = mapX(hr);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(`${hr}h`, x - 8, h - 10);
  }
  for (let mg = 0; mg <= 25; mg += 5) {
    const y = mapY(mg);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(`${mg}`, 14, y + 3);
  }

  const series = generateBhutaniSeries(gestationalWeeks.value, hasNeurotoxicityRisk.value);

  const drawCurve = (key, color, width = 2, dashed = false) => {
    ctx.beginPath();
    series.forEach((pt, idx) => {
      const x = mapX(pt.hour);
      const y = mapY(pt[key]);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // Shaded Exchange Danger Zone above exchange curve
  ctx.beginPath();
  ctx.moveTo(mapX(0), padT);
  series.forEach((pt) => ctx.lineTo(mapX(pt.hour), mapY(pt.exchange)));
  ctx.lineTo(mapX(168), padT);
  ctx.closePath();
  ctx.fillStyle = 'rgba(244, 63, 94, 0.14)';
  ctx.fill();

  // Shaded Phototherapy Zone between photo & exchange
  ctx.beginPath();
  series.forEach((pt, i) => (i === 0 ? ctx.moveTo(mapX(pt.hour), mapY(pt.photo)) : ctx.lineTo(mapX(pt.hour), mapY(pt.photo))));
  for (let i = series.length - 1; i >= 0; i--) {
    ctx.lineTo(mapX(series[i].hour), mapY(series[i].exchange));
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(251, 191, 36, 0.11)';
  ctx.fill();

  drawCurve('b40', 'rgba(52, 211, 153, 0.55)', 1.2, true);
  drawCurve('b75', 'rgba(56, 189, 248, 0.65)', 1.2, true);
  drawCurve('b95', 'rgba(251, 191, 36, 0.72)', 1.5, true);
  drawCurve('photo', '#fbbf24', 2.6, false);
  drawCurve('exchange', '#f43f5e', 2.8, false);

  // Curve labels on right edge
  const last = series[series.length - 1];
  ctx.font = '700 10px Plus Jakarta Sans, sans-serif';
  ctx.fillStyle = '#f43f5e';
  ctx.fillText('AAP Exchange', mapX(126), mapY(last.exchange) - 6);
  ctx.fillStyle = '#fbbf24';
  ctx.fillText('AAP Phototherapy', mapX(116), mapY(last.photo) - 6);
  ctx.fillStyle = '#34d399';
  ctx.fillText('Bhutani 40th', mapX(126), mapY(last.b40) + 12);

  // Draw prior measurement -> current measurement velocity vector
  if (priorTcbMgDl.value > 0 && priorHours.value < postnatalHours.value) {
    const px0 = mapX(priorHours.value);
    const py0 = mapY(priorTcbMgDl.value);
    const px1 = mapX(postnatalHours.value);
    const py1 = mapY(tcbMgDl.value);

    ctx.strokeStyle = assessment.value.hemolysisAlert ? '#fb7185' : '#22d3ee';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(px0, py0);
    ctx.lineTo(px1, py1);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(px0, py0, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#94a3b8';
    ctx.fill();
  }

  // Current Newborn Point Marker
  const curX = mapX(postnatalHours.value);
  const curY = mapY(tcbMgDl.value);
  ctx.beginPath();
  ctx.arc(curX, curY, 11, 0, Math.PI * 2);
  ctx.fillStyle = assessment.value.severity === 'RED' ? 'rgba(244,63,94,0.30)' : 'rgba(34,211,238,0.28)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(curX, curY, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = assessment.value.severity === 'RED' ? '#f43f5e' : '#22d3ee';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  ctx.fillStyle = '#eef6ff';
  ctx.font = '700 11px JetBrains Mono, monospace';
  ctx.fillText(`${tcbMgDl.value.toFixed(1)} mg/dL`, Math.min(w - 92, curX + 10), Math.max(28, curY - 8));
}

onMounted(() => {
  initWebGlShader();
  rafId = requestAnimationFrame(renderWebGlFrame);
  drawBhutaniNomogram();
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  stopLiveCamera();
});

watch(
  [postnatalHours, gestationalWeeks, hasNeurotoxicityRisk, tcbMgDl, priorTcbMgDl, priorHours],
  () => {
    drawBhutaniNomogram();
  }
);
</script>

<template>
  <section class="glass-panel" style="padding: 20px;">
    <video ref="hiddenVideo" playsinline muted style="display: none;"></video>

    <!-- Header -->
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px;">
      <div>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <Sun :size="19" style="color: var(--accent-amber);" />
          <h2 style="margin: 0; font-size: 1.18rem; font-weight: 800;">
            Transcutaneous Bilirubin (TcB) &amp; 2022 AAP Bhutani Nomogram
          </h2>
          <span class="status-badge" :class="badgeClass">
            {{ assessment.riskZone.replace(/_/g, ' ') }}
          </span>
        </div>
        <p style="margin: 0; font-size: 0.83rem; color: var(--text-secondary);">
          60 FPS WebGL2 Kubelka-Munk 460 nm / 550 nm melanin-decoupled colorimetry (Fitzpatrick I–VI) &amp; 0–168h AAP phototherapy/exchange curves.
        </p>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        <button class="btn-glass" :class="cameraActive ? 'btn-danger' : 'btn-primary'" @click="toggleLiveCamera">
          <Camera v-if="!cameraActive" :size="15" />
          <CameraOff v-else :size="15" />
          {{ cameraActive ? 'Stop D65 Camera' : 'Start D65 Camera' }}
        </button>
        <button class="btn-glass" @click="logBilirubinScan">
          <Save :size="15" /> Save TcB Scan
        </button>
      </div>
    </div>

    <div v-if="cameraError" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-amber); color: var(--accent-amber); font-size: 0.82rem;">
      {{ cameraError }}
    </div>
    <div v-if="saveToast" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-emerald); color: var(--accent-emerald); font-size: 0.82rem; display: flex; align-items: center; gap: 8px;">
      <CheckCircle2 :size="16" /> {{ saveToast }}
    </div>

    <!-- 1-Tap Clinical Scenario Presets -->
    <div class="glass-subcard" style="margin-bottom: 16px;">
      <div style="font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
        <Sparkles :size="14" style="color: var(--accent-amber);" />
        1-Tap Neonatal Jaundice Calibration &amp; Triage Simulators
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        <button
          v-for="preset in BILIRUBIN_SIMULATOR_PRESETS"
          :key="preset.id"
          class="btn-glass"
          :class="{ active: activePresetId === preset.id }"
          @click="applyPreset(preset)"
        >
          {{ preset.label }}
        </button>
      </div>
    </div>

    <!-- KPI Telemetry Strip -->
    <div class="kpi-row-4" style="margin-bottom: 16px;">
      <div class="kpi-card">
        <span class="kpi-label">Melanin-Compensated TcB</span>
        <span class="kpi-value" :style="assessment.severity === 'RED' ? 'color: var(--accent-danger)' : 'color: var(--accent-amber)'">
          {{ assessment.tcbMgDl.toFixed(1) }} <small style="font-size: 0.74rem;">mg/dL</small>
        </span>
        <span class="kpi-unit">{{ assessment.tcbUmolL }} µmol/L · CIE b* {{ assessment.optical.cieBStar }}</span>
      </div>

      <div class="kpi-card">
        <span class="kpi-label">AAP Phototherapy Cutoff</span>
        <span class="kpi-value" style="color: var(--accent-cyan);">
          {{ assessment.phototherapyThresholdMgDl.toFixed(1) }} <small style="font-size: 0.74rem;">mg/dL</small>
        </span>
        <span class="kpi-unit">
          Margin: {{ assessment.deltaBelowPhotoMgDl >= 0 ? `${assessment.deltaBelowPhotoMgDl} below` : `${Math.abs(assessment.deltaBelowPhotoMgDl)} ABOVE` }}
        </span>
      </div>

      <div class="kpi-card">
        <span class="kpi-label">AAP Exchange Cutoff</span>
        <span class="kpi-value" style="color: var(--accent-rose);">
          {{ assessment.exchangeThresholdMgDl.toFixed(1) }} <small style="font-size: 0.74rem;">mg/dL</small>
        </span>
        <span class="kpi-unit">GA {{ gestationalWeeks }}w · {{ hasNeurotoxicityRisk ? 'Neuro-Risk ON' : 'No Risk Factors' }}</span>
      </div>

      <div class="kpi-card">
        <span class="kpi-label">Bilirubin Rate of Rise</span>
        <span class="kpi-value" :style="assessment.hemolysisAlert ? 'color: var(--accent-danger)' : 'color: var(--accent-emerald)'">
          +{{ assessment.rateOfRiseMgDlPerHr.toFixed(2) }}
        </span>
        <span class="kpi-unit">mg/dL/hr · {{ assessment.hemolysisAlert ? 'HEMOLYSIS ALERT (>=0.20)' : 'Within Normal Velocity' }}</span>
      </div>
    </div>

    <!-- Main Split: WebGL2 Kubelka-Munk Scanner + AAP 2022 Bhutani Nomogram -->
    <div class="module-grid-2" style="margin-bottom: 16px;">
      <!-- Left: WebGL2 Optical Scanner & Fitzpatrick Melanin Calibration -->
      <div class="glass-subcard" style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.83rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
            <Eye :size="15" style="color: var(--accent-cyan);" />
            WebGL2 Kubelka-Munk 460nm / 550nm Optical ROI
          </span>
          <span class="mono" style="font-size: 0.72rem; color: var(--accent-amber);">
            Fitzpatrick {{ activeFitzpatrick.type }} · OD460 {{ assessment.optical.od460 }}
          </span>
        </div>

        <canvas ref="glCanvas" width="520" height="250" class="canvas-stage"></canvas>

        <!-- Fitzpatrick Skin-Tone Swatches -->
        <div>
          <div style="display: flex; justify-content: space-between; font-size: 0.76rem; color: var(--text-secondary); margin-bottom: 6px;">
            <span>Fitzpatrick Skin Melanin Calibration (Equity Compensation)</span>
            <span class="mono">{{ activeFitzpatrick.label }}</span>
          </div>
          <div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px;">
            <button
              v-for="f in FITZPATRICK_SCALES"
              :key="f.type"
              class="btn-glass"
              style="justify-content: center; padding: 6px 4px; font-size: 0.74rem;"
              :class="{ active: activeFitzpatrick.type === f.type }"
              @click="melaninIndex = f.melaninIndex"
            >
              <span :style="{ width: '12px', height: '12px', borderRadius: '50%', background: f.swatch, border: '1px solid rgba(255,255,255,0.4)' }"></span>
              {{ f.type }}
            </button>
          </div>
        </div>

        <div class="module-grid-2" style="gap: 10px;">
          <div>
            <label style="font-size: 0.75rem; color: var(--text-secondary); display: flex; justify-content: space-between;">
              <span>Dermal TcB Input / Optical Est.</span>
              <strong class="mono">{{ tcbMgDl.toFixed(1) }} mg/dL</strong>
            </label>
            <input v-model.number="tcbMgDl" type="range" min="1.5" max="24.5" step="0.1" class="clinical-slider" />
          </div>
          <div>
            <label style="font-size: 0.75rem; color: var(--text-secondary); display: flex; justify-content: space-between;">
              <span>Kubelka-Munk Heatmap Overlay</span>
              <strong class="mono">{{ Math.round(heatmapAlpha * 100) }}%</strong>
            </label>
            <input v-model.number="heatmapAlpha" type="range" min="0" max="0.95" step="0.05" class="clinical-slider" />
          </div>
        </div>
      </div>

      <!-- Right: 2022 AAP Bhutani Nomogram + Clinical Parameters -->
      <div class="glass-subcard" style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.83rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
            <Sliders :size="15" style="color: var(--accent-amber);" />
            2022 AAP Hour-Specific Phototherapy &amp; Exchange Nomogram
          </span>
          <span class="mono" style="font-size: 0.72rem; color: var(--text-muted);">0 – 168 Hours</span>
        </div>

        <canvas ref="nomogramCanvas" width="560" height="250" class="canvas-stage"></canvas>

        <div class="module-grid-2" style="gap: 10px;">
          <div>
            <label style="font-size: 0.75rem; color: var(--text-secondary); display: flex; justify-content: space-between;">
              <span>Postnatal Age (Hours)</span>
              <strong class="mono">{{ postnatalHours }}h ({{ (postnatalHours / 24).toFixed(1) }}d)</strong>
            </label>
            <input v-model.number="postnatalHours" type="range" min="4" max="168" step="1" class="clinical-slider" />
          </div>

          <div>
            <label style="font-size: 0.75rem; color: var(--text-secondary); display: flex; justify-content: space-between;">
              <span>Gestational Age at Birth</span>
              <strong class="mono">{{ gestationalWeeks === 40 ? '≥40w' : `${gestationalWeeks}w` }}</strong>
            </label>
            <input v-model.number="gestationalWeeks" type="range" min="35" max="40" step="1" class="clinical-slider" />
          </div>
        </div>

        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;">
          <label style="display: inline-flex; align-items: center; gap: 8px; font-size: 0.8rem; cursor: pointer;">
            <input v-model="hasNeurotoxicityRisk" type="checkbox" />
            <span>Neurotoxicity Risk Factor (DAT+, G6PD, Sepsis, Albumin &lt;3.0)</span>
          </label>
          <div style="display: flex; align-items: center; gap: 6px; font-size: 0.76rem; color: var(--text-secondary);">
            <span>Prior TcB:</span>
            <input v-model.number="priorTcbMgDl" type="number" step="0.2" min="0" max="24" class="clinical-input" style="width: 68px; padding: 4px 7px;" />
            <span>@</span>
            <input v-model.number="priorHours" type="number" step="1" min="0" max="160" class="clinical-input" style="width: 62px; padding: 4px 7px;" />
            <span>h</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom Strip: 5-Zone Kramer Cephalocaudal Progression Map + Clinical Action Banner -->
    <div class="module-grid-2">
      <div class="glass-subcard">
        <div style="font-size: 0.82rem; font-weight: 700; margin-bottom: 10px;">
          5-Zone Kramer Cephalocaudal Dermal Progression Map (Tap Zone to Sync)
        </div>
        <div style="display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px;">
          <button
            v-for="z in KRAMER_ZONES"
            :key="z.zone"
            class="btn-glass"
            :class="{ active: kramerZone >= z.zone }"
            style="flex-direction: column; align-items: flex-start; padding: 9px; white-space: normal; text-align: left;"
            @click="selectKramerZone(z)"
          >
            <span class="mono" style="font-size: 0.72rem; color: var(--accent-amber);">Zone {{ z.zone }}</span>
            <span style="font-size: 0.76rem; font-weight: 700;">{{ z.anatomy }}</span>
            <span class="mono" style="font-size: 0.70rem; color: var(--text-muted);">{{ z.estRangeMgDl }}</span>
          </button>
        </div>
      </div>

      <div
        class="glass-subcard"
        :style="assessment.severity === 'RED' ? 'border-color: var(--accent-danger); background: rgba(244,63,94,0.12);' : 'border-color: var(--accent-cyan);'"
      >
        <div style="display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 0.88rem; margin-bottom: 6px;">
          <ShieldAlert :size="17" :style="assessment.severity === 'RED' ? 'color: var(--accent-danger)' : 'color: var(--accent-cyan)'" />
          2022 AAP Clinical Disposition &amp; Handoff Guidance
        </div>
        <p style="margin: 0; font-size: 0.82rem; line-height: 1.48; color: var(--text-primary);">
          {{ assessment.clinicalAction }}
        </p>
      </div>
    </div>
  </section>
</template>
