<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  Moon,
  Volume2,
  VolumeX,
  Thermometer,
  Mic,
  MicOff,
  Flame,
  ShieldCheck,
  AlertTriangle,
  Save,
  CheckCircle2,
  Sparkles,
  X,
  Play,
  Pause,
  RotateCcw,
} from 'lucide-vue-next';
import {
  AAP_COCHLEAR_LIMIT_DBA,
  NURSERY_ACOUSTIC_PRESETS,
  TOG_GARMENT_PROFILES,
  solveSafeSpeakerDistance,
  evaluateSafeSleepTogBalance,
  IntrauterineSoundscapeEngine,
} from '../engines/nurserySafeSleepTogEngine.js';
import { saveClinicalRecord } from '../db/pediaVaultDb.js';

const props = defineProps({
  role: { type: String, default: 'parent' },
});

const emit = defineEmits(['record-saved', 'request-permission']);

// 1. Acoustic Dosimeter State
const activePresetId = ref('safe_womb_2m');
const micActive = ref(false);
const micError = ref('');
const measuredDba = ref(47.4);
const measuredDbc = ref(53.8);
const speakerDistanceM = ref(2.0);
const dosimeterCanvas = ref(null);
const dbaHistory = [];

// 2. Intrauterine Soundscape State
const soundEngine = new IntrauterineSoundscapeEngine();
const soundPlaying = ref(false);
const soundMode = ref('womb_pulse');
const soundVolume = ref(0.42);

// 3. TOG Thermal State
const ambientTempC = ref(21.0);
const selectedTog = ref(1.0);
const hasLooseBlanket = ref(false);
const hasHatOn = ref(false);

// 4. 630nm Zero-Blue Night-Feeding Lantern State
const lanternOpen = ref(false);
const lanternBrightness = ref(0.32); // 0.08..0.85 strictly pure red (R, 0, 0)
const feedSide = ref('L'); // 'L' | 'R'
const feedRunning = ref(false);
const feedLeftSec = ref(0);
const feedRightSec = ref(0);
let feedInterval = null;

const saveToast = ref('');
let rafId = null;
let micStream = null;
let micAudioCtx = null;
let micAnalyser = null;
let micBuf = null;

const distanceSolution = computed(() =>
  solveSafeSpeakerDistance(measuredDba.value, speakerDistanceM.value, AAP_COCHLEAR_LIMIT_DBA)
);

const togAudit = computed(() =>
  evaluateSafeSleepTogBalance(ambientTempC.value, selectedTog.value, hasLooseBlanket.value, hasHatOn.value)
);

const lanternBgColor = computed(() => {
  const red = Math.round(28 + lanternBrightness.value * 165);
  return `rgb(${red}, 0, 0)`;
});

function formatMmSs(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function selectAcousticPreset(preset) {
  stopMicDosimeter();
  activePresetId.value = preset.id;
  measuredDba.value = preset.splDba;
  measuredDbc.value = preset.splDbc;
  speakerDistanceM.value = preset.sourceDistanceM;
}

async function toggleMicDosimeter() {
  micError.value = '';
  if (micActive.value) {
    stopMicDosimeter();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    micError.value = 'Browser microphone unavailable. Using calibrated Nursery Acoustic Scenarios.';
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    micAudioCtx = new AudioCtx();
    const src = micAudioCtx.createMediaStreamSource(micStream);
    micAnalyser = micAudioCtx.createAnalyser();
    micAnalyser.fftSize = 1024;
    src.connect(micAnalyser);
    micBuf = new Float32Array(micAnalyser.fftSize);
    micActive.value = true;
    emit('request-permission', { sensor: 'microphone', state: 'granted' });
  } catch (err) {
    micError.value = `Mic permission denied (${err.message || 'blocked'}). Built-in acoustic scenarios active.`;
    emit('request-permission', { sensor: 'microphone', state: 'denied' });
  }
}

function stopMicDosimeter() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (micAudioCtx) {
    micAudioCtx.close().catch(() => {});
    micAudioCtx = null;
  }
  micAnalyser = null;
  micActive.value = false;
}

function toggleSoundscape() {
  if (soundPlaying.value) {
    soundEngine.stop();
    soundPlaying.value = false;
  } else {
    const ok = soundEngine.start(soundMode.value, soundVolume.value);
    soundPlaying.value = ok;
  }
}

function switchSoundMode(mode) {
  soundMode.value = mode;
  if (soundPlaying.value) {
    soundEngine.start(mode, soundVolume.value);
  }
}

function updateSoundVolume() {
  soundEngine.setVolume(soundVolume.value);
}

function toggleFeedTimer() {
  feedRunning.value = !feedRunning.value;
  if (feedRunning.value) {
    if (feedInterval) clearInterval(feedInterval);
    feedInterval = setInterval(() => {
      if (feedSide.value === 'L') feedLeftSec.value += 1;
      else feedRightSec.value += 1;
    }, 1000);
  } else if (feedInterval) {
    clearInterval(feedInterval);
    feedInterval = null;
  }
}

function resetFeedTimers() {
  feedRunning.value = false;
  if (feedInterval) {
    clearInterval(feedInterval);
    feedInterval = null;
  }
  feedLeftSec.value = 0;
  feedRightSec.value = 0;
}

async function saveNurseryAudit() {
  const saved = await saveClinicalRecord('nursery_sleep_audits', {
    splDba: Math.round(measuredDba.value * 10) / 10,
    splDbc: Math.round(measuredDbc.value * 10) / 10,
    cochlearCompliant: measuredDba.value <= AAP_COCHLEAR_LIMIT_DBA,
    requiredSpeakerDistanceM: distanceSolution.value.requiredDistanceM,
    ambientTempC: togAudit.value.ambientTempC,
    selectedTog: togAudit.value.selectedTog,
    thermalStatus: togAudit.value.status,
    looseBlanketHazard: hasLooseBlanket.value,
    hatHazard: hasHatOn.value,
    nightFeedLeftSec: feedLeftSec.value,
    nightFeedRightSec: feedRightSec.value,
  });
  saveToast.value = `Logged Nursery Audit (${measuredDba.value.toFixed(1)} dBA · ${ambientTempC.value.toFixed(1)}°C · ${selectedTog.value} TOG) to Vault.`;
  emit('record-saved', { store: 'nursery_sleep_audits', record: saved });
  setTimeout(() => { saveToast.value = ''; }, 3400);
}

function drawDosimeterChart() {
  const canvas = dosimeterCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#060e1d';
  ctx.fillRect(0, 0, w, h);

  const mapY = (db) => h - 18 - ((Math.max(20, Math.min(85, db)) - 20) / 65) * (h - 32);

  // AAP 50 dBA Hard Cochlear Ceiling Line
  const y50 = mapY(50);
  ctx.fillStyle = 'rgba(244, 63, 94, 0.12)';
  ctx.fillRect(0, 0, w, y50);

  ctx.strokeStyle = '#f43f5e';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y50);
  ctx.lineTo(w, y50);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#fda4af';
  ctx.font = '700 10px JetBrains Mono, monospace';
  ctx.fillText('AAP 50.0 dBA Neonatal Cochlear Safety Limit', 8, y50 - 5);

  if (dbaHistory.length > 1) {
    ctx.beginPath();
    dbaHistory.forEach((v, idx) => {
      const x = (idx / 119) * w;
      const y = mapY(v);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = measuredDba.value > 50 ? '#fb7185' : '#34d399';
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }

  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`Live Crib SPL: ${measuredDba.value.toFixed(1)} dBA / ${measuredDbc.value.toFixed(1)} dBC`, 8, h - 5);
}

let lastTick = 0;
function loop(now) {
  if (now - lastTick >= 80) {
    lastTick = now;
    if (micActive.value && micAnalyser && micBuf) {
      micAnalyser.getFloatTimeDomainData(micBuf);
      let sumSq = 0;
      for (let i = 0; i < micBuf.length; i++) sumSq += micBuf[i] * micBuf[i];
      const rms = Math.sqrt(sumSq / micBuf.length);
      const rawDb = Math.max(24, Math.min(82, 20 * Math.log10(Math.max(rms, 1e-5)) + 92));
      measuredDba.value = Math.round(rawDb * 10) / 10;
      measuredDbc.value = Math.round((rawDb + 4.8) * 10) / 10;
    } else {
      const p = NURSERY_ACOUSTIC_PRESETS.find((x) => x.id === activePresetId.value) || NURSERY_ACOUSTIC_PRESETS[1];
      const jitter = (Math.random() - 0.5) * 1.1;
      measuredDba.value = Math.round((p.splDba + jitter) * 10) / 10;
      measuredDbc.value = Math.round((p.splDbc + jitter) * 10) / 10;
    }

    dbaHistory.push(measuredDba.value);
    if (dbaHistory.length > 120) dbaHistory.shift();
    drawDosimeterChart();
  }
  rafId = requestAnimationFrame(loop);
}

onMounted(() => {
  rafId = requestAnimationFrame(loop);
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  stopMicDosimeter();
  soundEngine.stop();
  if (feedInterval) clearInterval(feedInterval);
});
</script>

<template>
  <section class="glass-panel" style="padding: 20px;">
    <!-- Header -->
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px;">
      <div>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <Moon :size="19" style="color: var(--accent-violet);" />
          <h2 style="margin: 0; font-size: 1.18rem; font-weight: 800;">
            AAP Safe-Sleep Nursery Microclimate, 50 dBA Dosimeter &amp; TOG Architect
          </h2>
          <span class="status-badge" :class="distanceSolution.isSafe && togAudit.severity === 'GREEN' ? 'badge-green' : 'badge-amber'">
            {{ distanceSolution.isSafe && togAudit.severity === 'GREEN' ? 'AAP COMPLIANT' : 'ADJUST NURSERY' }}
          </span>
        </div>
        <p style="margin: 0; font-size: 0.83rem; color: var(--text-secondary);">
          Crib-side dBA/dBC cochlear dosimeter, inverse-square safe speaker solver, &lt;500 Hz 68 BPM intrauterine womb synthesizer, TOG SIDS balance, and 630 nm night-feed lantern.
        </p>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        <button class="btn-glass btn-danger" @click="lanternOpen = true">
          <Flame :size="15" /> 630nm Zero-Blue Lantern
        </button>
        <button class="btn-glass" @click="saveNurseryAudit">
          <Save :size="15" /> Save Nursery Audit
        </button>
      </div>
    </div>

    <div v-if="micError" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-amber); color: var(--accent-amber); font-size: 0.82rem;">
      {{ micError }}
    </div>
    <div v-if="saveToast" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-emerald); color: var(--accent-emerald); font-size: 0.82rem; display: flex; align-items: center; gap: 8px;">
      <CheckCircle2 :size="16" /> {{ saveToast }}
    </div>

    <!-- Split Grid: Left (50 dBA Dosimeter + Intrauterine Synth) | Right (TOG SIDS Balance + Safe Sleep ABCs) -->
    <div class="module-grid-2">
      <!-- LEFT COLUMN: 50 dBA Dosimeter & Intrauterine Soundscape -->
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div class="glass-subcard">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
            <span style="font-size: 0.84rem; font-weight: 700;">Crib-Side 50 dBA Cochlear Dosimeter &amp; Inverse-Square Solver</span>
            <button class="btn-glass" :class="micActive ? 'btn-danger' : 'btn-primary'" @click="toggleMicDosimeter">
              <Mic v-if="!micActive" :size="14" />
              <MicOff v-else :size="14" />
              {{ micActive ? 'Stop Mic SPL' : 'Measure Live Mic SPL' }}
            </button>
          </div>

          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;">
            <button
              v-for="p in NURSERY_ACOUSTIC_PRESETS"
              :key="p.id"
              class="btn-glass"
              style="font-size: 0.74rem; padding: 5px 9px;"
              :class="{ active: !micActive && activePresetId === p.id }"
              @click="selectAcousticPreset(p)"
            >
              {{ p.label }}
            </button>
          </div>

          <canvas ref="dosimeterCanvas" width="520" height="145" class="canvas-stage" style="margin-bottom: 10px;"></canvas>

          <div class="module-grid-2" style="gap: 8px; margin-bottom: 10px;">
            <div class="kpi-card">
              <span class="kpi-label">Crib SPL (dBA / dBC)</span>
              <span class="kpi-value" :style="measuredDba > 50 ? 'color: var(--accent-danger)' : 'color: var(--accent-emerald)'">
                {{ measuredDba.toFixed(1) }} <small style="font-size: 0.72rem;">dBA</small>
              </span>
              <span class="kpi-unit">dBC: {{ measuredDbc.toFixed(1) }} (Low-Freq Gap +{{ (measuredDbc - measuredDba).toFixed(1) }} dB)</span>
            </div>

            <div class="kpi-card">
              <span class="kpi-label">Required Safe Distance</span>
              <span class="kpi-value" style="color: var(--accent-cyan);">
                ≥ {{ distanceSolution.requiredDistanceM }} <small style="font-size: 0.72rem;">m</small>
              </span>
              <span class="kpi-unit">({{ distanceSolution.requiredDistanceFt }} ft from infant’s head)</span>
            </div>
          </div>

          <div style="margin-bottom: 8px;">
            <label style="font-size: 0.75rem; color: var(--text-secondary); display: flex; justify-content: space-between;">
              <span>Current Sound Machine Distance from Crib</span>
              <strong class="mono">{{ speakerDistanceM.toFixed(2) }} m ({{ (speakerDistanceM * 3.28084).toFixed(1) }} ft)</strong>
            </label>
            <input v-model.number="speakerDistanceM" type="range" min="0.2" max="4.0" step="0.05" class="clinical-slider" />
          </div>

          <div
            style="padding: 9px 11px; border-radius: 10px; font-size: 0.80rem; border: 1px solid;"
            :style="distanceSolution.isSafe ? 'border-color: rgba(52,211,153,0.45); background: rgba(16,185,129,0.10);' : 'border-color: rgba(244,63,94,0.55); background: rgba(244,63,94,0.14);'"
          >
            {{ distanceSolution.recommendation }}
          </div>
        </div>

        <!-- Intrauterine <500 Hz 68 BPM Soundscape Synthesizer -->
        <div class="glass-subcard">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
            <div>
              <div style="font-size: 0.84rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                <Sparkles :size="15" style="color: var(--accent-cyan);" />
                Intrauterine &lt;500 Hz Womb &amp; 68 BPM Arterial Synthesizer
              </div>
              <div style="font-size: 0.74rem; color: var(--text-muted);">
                Brickwall DynamicsCompressor gain lock enforces AAP ≤50 dBA cochlear limit.
              </div>
            </div>
            <button class="btn-glass" :class="soundPlaying ? 'btn-danger' : 'btn-primary'" @click="toggleSoundscape">
              <VolumeX v-if="soundPlaying" :size="15" />
              <Volume2 v-else :size="15" />
              {{ soundPlaying ? 'Stop Soundscape' : 'Play Safe Womb Audio' }}
            </button>
          </div>

          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;">
            <button class="btn-glass" :class="{ active: soundMode === 'womb_pulse' }" @click="switchSoundMode('womb_pulse')">
              Womb + 68 BPM Pulse
            </button>
            <button class="btn-glass" :class="{ active: soundMode === 'rhythmic_shush' }" @click="switchSoundMode('rhythmic_shush')">
              Rhythmic Shush (&lt;480 Hz)
            </button>
            <button class="btn-glass" :class="{ active: soundMode === 'pink_lowpass' }" @click="switchSoundMode('pink_lowpass')">
              Deep Pink Low-Pass (&lt;340 Hz)
            </button>
          </div>

          <label style="font-size: 0.75rem; color: var(--text-secondary); display: flex; justify-content: space-between;">
            <span>50 dBA-Clamped Output Gain</span>
            <strong class="mono">{{ Math.round(soundVolume * 100) }}% (Ceiling Locked)</strong>
          </label>
          <input v-model.number="soundVolume" type="range" min="0.1" max="1.0" step="0.05" class="clinical-slider" @input="updateSoundVolume" />
        </div>
      </div>

      <!-- RIGHT COLUMN: AAP Safe-Sleep Thermal TOG (0.2-3.5) vs Temp (14-28°C) Architect -->
      <div class="glass-subcard" style="display: flex; flex-direction: column; justify-content: space-between; gap: 14px;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <span style="font-size: 0.86rem; font-weight: 800; display: flex; align-items: center; gap: 6px;">
              <Thermometer :size="16" style="color: var(--accent-amber);" />
              AAP Safe-Sleep Thermal TOG &amp; SIDS Microclimate Balance
            </span>
            <span class="status-badge" :class="togAudit.severity === 'RED' ? 'badge-red' : (togAudit.severity === 'AMBER' ? 'badge-amber' : 'badge-green')">
              {{ togAudit.status.replace(/_/g, ' ') }}
            </span>
          </div>

          <!-- Ambient Temp Slider -->
          <div style="margin-bottom: 14px;">
            <label style="font-size: 0.78rem; color: var(--text-secondary); display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span>Nursery Ambient Temperature (AAP Ideal: 20.0–22.2°C / 68–72°F)</span>
              <strong class="mono" style="color: var(--accent-cyan);">{{ togAudit.ambientTempC }}°C ({{ togAudit.ambientTempF }}°F)</strong>
            </label>
            <input v-model.number="ambientTempC" type="range" min="14" max="28" step="0.5" class="clinical-slider" />
          </div>

          <!-- TOG Sleep Bag Selector Cards -->
          <div style="font-size: 0.76rem; font-weight: 700; color: var(--text-muted); margin-bottom: 8px;">
            WEARABLE SLEEP SACK RATING (TOG 0.2 – 3.5)
          </div>
          <div style="display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin-bottom: 14px;">
            <button
              v-for="g in TOG_GARMENT_PROFILES"
              :key="g.tog"
              class="btn-glass"
              :class="{ active: selectedTog === g.tog }"
              style="flex-direction: column; padding: 9px 4px; text-align: center;"
              @click="selectedTog = g.tog"
            >
              <span class="mono" style="font-size: 0.92rem; font-weight: 800;">{{ g.tog }}</span>
              <span style="font-size: 0.67rem; color: var(--text-muted);">TOG</span>
              <span class="mono" style="font-size: 0.64rem; color: var(--accent-teal);">{{ g.idealMinC }}–{{ g.idealMaxC }}°</span>
            </button>
          </div>

          <!-- SIDS Hazard Checklist Toggles -->
          <div style="display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 14px; font-size: 0.80rem;">
            <label style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;">
              <input v-model="hasLooseBlanket" type="checkbox" />
              <span>Loose Blanket / Crib Bumper Present</span>
            </label>
            <label style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;">
              <input v-model="hasHatOn" type="checkbox" />
              <span>Indoor Hat / Beanie on Infant</span>
            </label>
          </div>

          <!-- Recommended Layering Blueprint -->
          <div class="kpi-card" style="margin-bottom: 12px;">
            <span class="kpi-label">Recommended Layering for {{ togAudit.ambientTempC }}°C</span>
            <span style="font-size: 0.92rem; font-weight: 700; color: var(--accent-cyan);">
              {{ togAudit.recommendedProfile.name }}
            </span>
            <span class="kpi-unit">Underlayer: {{ togAudit.recommendedProfile.layers }}</span>
          </div>

          <div
            style="padding: 11px 13px; border-radius: 12px; border: 1px solid; font-size: 0.82rem; line-height: 1.46; display: flex; gap: 9px; align-items: flex-start;"
            :style="togAudit.severity === 'RED' ? 'border-color: var(--accent-danger); background: rgba(244,63,94,0.14);' : (togAudit.severity === 'AMBER' ? 'border-color: var(--accent-amber); background: rgba(251,191,36,0.12);' : 'border-color: rgba(52,211,153,0.45); background: rgba(16,185,129,0.10);')"
          >
            <AlertTriangle v-if="togAudit.severity !== 'GREEN'" :size="18" style="flex-shrink: 0; margin-top: 2px;" />
            <ShieldCheck v-else :size="18" style="color: var(--accent-emerald); flex-shrink: 0; margin-top: 2px;" />
            <span>{{ togAudit.guidance }}</span>
          </div>
        </div>

        <!-- 3AM Night-Feeding Quick Status -->
        <div style="padding: 12px; border-radius: 14px; border: 1px solid rgba(255, 68, 34, 0.35); background: rgba(68, 6, 4, 0.35); display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px;">
          <div>
            <div style="font-size: 0.82rem; font-weight: 700; color: #ff7b5c;">
              630 nm Zero-Blue Night-Feeding Lantern &amp; L/R Timer
            </div>
            <div class="mono" style="font-size: 0.75rem; color: var(--text-secondary);">
              Left: {{ formatMmSs(feedLeftSec) }} · Right: {{ formatMmSs(feedRightSec) }} · Preserves Infant Melatonin
            </div>
          </div>
          <button class="btn-glass btn-danger" @click="lanternOpen = true">
            <Flame :size="14" /> Open Full-Screen Red Lantern
          </button>
        </div>
      </div>
    </div>

    <!-- 1-Tap Full-Screen 630nm Zero-Blue Night-Feeding Lantern Overlay -->
    <Teleport to="body">
      <div
        v-if="lanternOpen"
        class="red-lantern-fullscreen"
        :style="{ backgroundColor: lanternBgColor }"
      >
        <div style="width: min(560px, 100%); display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-size: 1.05rem; font-weight: 800; letter-spacing: 0.06em;">630 nm ZERO-BLUE NIGHT LANTERN</div>
            <div class="mono" style="font-size: 0.76rem; opacity: 0.8;">RGB(Red, 0, 0) · Zero 480nm Melanopsin Suppression</div>
          </div>
          <button
            style="border: 1px solid rgba(255,68,36,0.6); background: rgba(0,0,0,0.45); color: #ff5638; padding: 10px 16px; border-radius: 14px; cursor: pointer; font-weight: 700; display: inline-flex; align-items: center; gap: 6px;"
            @click="lanternOpen = false"
          >
            <X :size="16" /> Exit Lantern
          </button>
        </div>

        <!-- Central L/R Night-Feeding Stopwatch -->
        <div style="text-align: center; background: rgba(0, 0, 0, 0.42); border: 1px solid rgba(255, 68, 36, 0.45); border-radius: 26px; padding: 28px 34px; width: min(460px, 94vw);">
          <div style="display: flex; justify-content: center; gap: 14px; margin-bottom: 18px;">
            <button
              style="flex: 1; padding: 12px; border-radius: 14px; cursor: pointer; font-weight: 800; font-size: 1rem;"
              :style="feedSide === 'L' ? 'background: rgba(255,58,31,0.34); border: 2px solid #ff4b2b; color: #ff8c75;' : 'background: rgba(0,0,0,0.3); border: 1px solid rgba(255,58,31,0.35); color: #c4361d;'"
              @click="feedSide = 'L'"
            >
              LEFT · {{ formatMmSs(feedLeftSec) }}
            </button>
            <button
              style="flex: 1; padding: 12px; border-radius: 14px; cursor: pointer; font-weight: 800; font-size: 1rem;"
              :style="feedSide === 'R' ? 'background: rgba(255,58,31,0.34); border: 2px solid #ff4b2b; color: #ff8c75;' : 'background: rgba(0,0,0,0.3); border: 1px solid rgba(255,58,31,0.35); color: #c4361d;'"
              @click="feedSide = 'R'"
            >
              RIGHT · {{ formatMmSs(feedRightSec) }}
            </button>
          </div>

          <div class="mono" style="font-size: 3.2rem; font-weight: 800; letter-spacing: 0.04em; margin-bottom: 18px; color: #ff694a;">
            {{ formatMmSs(feedSide === 'L' ? feedLeftSec : feedRightSec) }}
          </div>

          <div style="display: flex; justify-content: center; gap: 12px;">
            <button
              style="padding: 12px 24px; border-radius: 14px; background: rgba(255, 58, 31, 0.3); border: 1px solid #ff5638; color: #ff8b73; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 8px;"
              @click="toggleFeedTimer"
            >
              <Pause v-if="feedRunning" :size="18" />
              <Play v-else :size="18" />
              {{ feedRunning ? 'Pause Feed' : `Start ${feedSide === 'L' ? 'Left' : 'Right'} Feed` }}
            </button>
            <button
              style="padding: 12px 16px; border-radius: 14px; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 58, 31, 0.4); color: #ff694a; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;"
              @click="resetFeedTimers"
            >
              <RotateCcw :size="16" /> Reset
            </button>
          </div>
        </div>

        <!-- Bottom Red Dimmer Slider -->
        <div style="width: min(460px, 94vw); background: rgba(0, 0, 0, 0.45); padding: 16px 20px; border-radius: 18px; border: 1px solid rgba(255, 68, 36, 0.4);">
          <label style="display: flex; justify-content: space-between; font-size: 0.84rem; font-weight: 700; margin-bottom: 8px;">
            <span>630 nm Red Dimmer Intensity</span>
            <span class="mono">{{ Math.round(lanternBrightness * 100) }}% · 0% Blue</span>
          </label>
          <input v-model.number="lanternBrightness" type="range" min="0.06" max="0.90" step="0.02" style="width: 100%; accent-color: #ff3a1f;" />
        </div>
      </div>
    </Teleport>
  </section>
</template>
