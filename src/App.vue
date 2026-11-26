<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import {
  AudioWaveform,
  Sun,
  Wind,
  Pill,
  Moon,
  Monitor,
  Smartphone,
  ShieldCheck,
  Database,
  FileDown,
  Layers,
  Download,
  RefreshCw,
  Printer,
  Trash2,
  X,
  HeartPulse,
  Wifi,
  WifiOff,
  CheckCircle2,
} from 'lucide-vue-next';

import bgFragShader from './shaders/intrauterineAcousticWaveBackground.glsl?raw';
import { initRustPediatricsBridge } from './engines/rustPediatricsBridge.js';
import {
  getVaultSnapshot,
  flushSyncQueue,
  clearAllVaultRecords,
  exportPediatricianHandoffReport,
} from './db/pediaVaultDb.js';

import InfantCryFormantClassifier from './components/InfantCryFormantClassifier.vue';
import BilirubinBhutaniNomogramScanner from './components/BilirubinBhutaniNomogramScanner.vue';
import TachypneaRetractionMonitor from './components/TachypneaRetractionMonitor.vue';
import PediatricMgKgPharmacokinetics from './components/PediatricMgKgPharmacokinetics.vue';
import NurserySafeSleepTogArchitect from './components/NurserySafeSleepTogArchitect.vue';
import HardwarePermissionGatekeeper from './components/HardwarePermissionGatekeeper.vue';
import PolyglotRuntimeInspectorModal from './components/PolyglotRuntimeInspectorModal.vue';
import ApkReleaseDownloadModal from './components/ApkReleaseDownloadModal.vue';

const bgCanvas = ref(null);

// Navigation & View Modes
const activeTab = ref('cry'); // 'cry' | 'bilirubin' | 'respiratory' | 'dosing' | 'nursery'
const previewMode = ref('desktop'); // 'desktop' | 'mobile_apk'
const activeTheme = ref('nicu-obsidian'); // 'nicu-obsidian' | 'clinic-daylight' | 'night-630nm' | 'eco-glass'
const activeRole = ref('parent'); // 'parent' | 'pediatrician' | 'architect'

// Modals & Drawers
const showPermissionModal = ref(false);
const showPolyglotModal = ref(false);
const showApkModal = ref(false);
const showVaultDrawer = ref(false);

const anyModalOpen = computed(
  () => showPermissionModal.value || showPolyglotModal.value || showApkModal.value
);

// Hardware Permissions & Telemetry
const permissions = ref({
  microphone: 'prompt',
  camera: 'prompt',
  sensors: 'simulator_ready',
});
const acousticEnergy = ref(0.25);
const pointerNorm = ref({ x: 0.5, y: 0.5 });
const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true);
const patientMeta = ref({ weightKg: 8.4, ageMonths: 9, gestationalWeeks: 38, postnatalHours: 64 });

// Vault & Sync State
const vaultSnapshot = ref({
  cry_formant_logs: [],
  bilirubin_tcb_scans: [],
  respiratory_imci_checks: [],
  medication_pk_doses: [],
  nursery_sleep_audits: [],
  syncQueue: [],
});
const syncMessage = ref('');
const syncing = ref(false);

const totalVaultRecords = computed(() =>
  vaultSnapshot.value.cry_formant_logs.length +
  vaultSnapshot.value.bilirubin_tcb_scans.length +
  vaultSnapshot.value.respiratory_imci_checks.length +
  vaultSnapshot.value.medication_pk_doses.length +
  vaultSnapshot.value.nursery_sleep_audits.length
);

const pendingSyncCount = computed(() =>
  vaultSnapshot.value.syncQueue.filter((q) => q.status === 'PENDING_OFFLINE').length
);

const dockModules = [
  { id: 'cry', label: 'Cry LPC Lab', icon: AudioWaveform },
  { id: 'bilirubin', label: 'Bilirubin TcB', icon: Sun },
  { id: 'respiratory', label: 'IMCI Resp', icon: Wind },
  { id: 'dosing', label: 'mg/kg PK', icon: Pill },
  { id: 'nursery', label: 'Safe-Sleep TOG', icon: Moon },
];

const themes = [
  { id: 'nicu-obsidian', label: 'NICU Obsidian', modeFloat: 0.0 },
  { id: 'clinic-daylight', label: 'Clinic Daylight', modeFloat: 1.0 },
  { id: 'night-630nm', label: '3AM 630nm Night', modeFloat: 2.0 },
  { id: 'eco-glass', label: 'Eco-Glass', modeFloat: 3.0 },
];

const roles = [
  { id: 'parent', label: 'Parent' },
  { id: 'pediatrician', label: 'Pediatrician / NICU' },
  { id: 'architect', label: 'Architect' },
];

function applyTheme(themeId) {
  activeTheme.value = themeId;
  document.documentElement.setAttribute('data-theme', themeId);
}

function handlePointerMove(e) {
  const nx = Math.max(0, Math.min(1, e.clientX / Math.max(1, window.innerWidth)));
  const ny = Math.max(0, Math.min(1, e.clientY / Math.max(1, window.innerHeight)));
  pointerNorm.value = { x: nx, y: 1.0 - ny };
  document.documentElement.style.setProperty('--mx', `${(nx * 100).toFixed(1)}%`);
  document.documentElement.style.setProperty('--my', `${(ny * 100).toFixed(1)}%`);
}

function handleDeviceOrientation(e) {
  if (typeof e.gamma === 'number' && typeof e.beta === 'number') {
    const nx = Math.max(0, Math.min(1, 0.5 + e.gamma / 90));
    const ny = Math.max(0, Math.min(1, 0.5 + (e.beta - 45) / 90));
    pointerNorm.value = { x: nx, y: ny };
    document.documentElement.style.setProperty('--mx', `${(nx * 100).toFixed(1)}%`);
    document.documentElement.style.setProperty('--my', `${((1 - ny) * 100).toFixed(1)}%`);
  }
}

function handlePermissionUpdate({ sensor, state }) {
  permissions.value = { ...permissions.value, [sensor]: state };
}

async function refreshVault() {
  vaultSnapshot.value = await getVaultSnapshot();
}

async function handleFlushSync() {
  syncing.value = true;
  syncMessage.value = '';
  try {
    const res = await flushSyncQueue();
    syncMessage.value = res.message;
    await refreshVault();
  } finally {
    syncing.value = false;
  }
}

async function handleExportHandoff() {
  await exportPediatricianHandoffReport({
    ...patientMeta.value,
    role: activeRole.value,
  });
  syncMessage.value = 'Exported 1-Tap Pediatrician Clinical Handoff Report (.json).';
  setTimeout(() => { syncMessage.value = ''; }, 3600);
}

function handlePrintSummary() {
  window.print();
}

async function handleClearVault() {
  await clearAllVaultRecords();
  await refreshVault();
  syncMessage.value = 'Cleared local IndexedDB clinical vault records.';
}

// --- WebGL2 Ambient Intrauterine Wave Background ---
let gl = null;
let bgProg = null;
let rafId = null;
let bgStart = performance.now();

function initBgWebGl() {
  const canvas = bgCanvas.value;
  if (!canvas) return;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
  };
  resize();
  window.addEventListener('resize', resize);

  gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'low-power' });
  if (!gl) return;

  const vertSrc = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };

  bgProg = gl.createProgram();
  gl.attachShader(bgProg, compile(gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(bgProg, compile(gl.FRAGMENT_SHADER, bgFragShader));
  gl.linkProgram(bgProg);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(bgProg, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const render = (now) => {
    if (gl && bgProg && canvas) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(bgProg);
      const themeIdx = themes.find((t) => t.id === activeTheme.value)?.modeFloat ?? 0.0;
      gl.uniform1f(gl.getUniformLocation(bgProg, 'uTime'), (now - bgStart) / 1000);
      gl.uniform2f(gl.getUniformLocation(bgProg, 'uResolution'), canvas.width, canvas.height);
      gl.uniform2f(gl.getUniformLocation(bgProg, 'uPointer'), pointerNorm.value.x, pointerNorm.value.y);
      gl.uniform1f(gl.getUniformLocation(bgProg, 'uAcousticEnergy'), acousticEnergy.value);
      gl.uniform1f(gl.getUniformLocation(bgProg, 'uThemeMode'), themeIdx);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    rafId = requestAnimationFrame(render);
  };
  rafId = requestAnimationFrame(render);
}

function updateOnlineState() {
  isOnline.value = navigator.onLine;
}

onMounted(async () => {
  applyTheme(activeTheme.value);
  await initRustPediatricsBridge();
  await refreshVault();
  initBgWebGl();
  window.addEventListener('pointermove', handlePointerMove, { passive: true });
  window.addEventListener('deviceorientation', handleDeviceOrientation, { passive: true });
  window.addEventListener('online', updateOnlineState);
  window.addEventListener('offline', updateOnlineState);
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('deviceorientation', handleDeviceOrientation);
  window.removeEventListener('online', updateOnlineState);
  window.removeEventListener('offline', updateOnlineState);
});

watch(activeRole, (role) => {
  if (role === 'architect') {
    showPolyglotModal.value = true;
  }
});
</script>

<template>
  <!-- Ambient WebGL2 Intrauterine Wave Underlay -->
  <canvas ref="bgCanvas" class="webgl-underlay-canvas"></canvas>

  <!-- Main Workspace Shell (scales to 0.94 on modal depth-push) -->
  <div class="workspace-shell" :class="{ 'modal-depth-pushed': anyModalOpen }">
    <!-- Top Frosted Command Bar -->
    <header class="glass-panel top-command-bar">
      <div class="brand-lockup">
        <div class="brand-orb">
          <HeartPulse :size="20" />
        </div>
        <div>
          <div class="brand-title">PEDIA-SPECTRA</div>
          <div class="brand-sub">Pediatric &amp; Neonatal Triage · v1.26.0 · 0.0% TS</div>
        </div>
      </div>

      <!-- Desktop Workstation vs Live Mobile APK Bezel Switcher -->
      <div class="segmented-control" role="group" aria-label="Viewport Mode">
        <button :class="{ active: previewMode === 'desktop' }" @click="previewMode = 'desktop'">
          <Monitor :size="14" /> Desktop Workstation
        </button>
        <button :class="{ active: previewMode === 'mobile_apk' }" @click="previewMode = 'mobile_apk'">
          <Smartphone :size="14" /> Mobile APK Frame
        </button>
      </div>

      <!-- Theme + RBAC + Utility Actions -->
      <div class="toolbar-cluster">
        <select
          class="clinical-select"
          style="width: auto; padding: 6px 10px; font-size: 0.77rem;"
          :value="activeTheme"
          aria-label="Clinical Theme"
          @change="applyTheme($event.target.value)"
        >
          <option v-for="t in themes" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>

        <select
          class="clinical-select"
          style="width: auto; padding: 6px 10px; font-size: 0.77rem;"
          v-model="activeRole"
          aria-label="Clinical Role"
        >
          <option v-for="r in roles" :key="r.id" :value="r.id">Role: {{ r.label }}</option>
        </select>

        <button class="btn-glass" @click="showPermissionModal = true" title="Hardware Permission Gatekeeper">
          <ShieldCheck :size="14" style="color: var(--accent-cyan);" /> Sensors
        </button>

        <button class="btn-glass" @click="showVaultDrawer = !showVaultDrawer" title="Offline IndexedDB Vault & Sync Queue">
          <Database :size="14" style="color: var(--accent-teal);" />
          Vault ({{ totalVaultRecords }})
          <span v-if="pendingSyncCount > 0" class="mono" style="background: var(--accent-amber); color: #05111c; border-radius: 99px; padding: 1px 6px; font-size: 0.68rem; font-weight: 800;">
            {{ pendingSyncCount }}
          </span>
        </button>

        <button class="btn-glass" @click="showPolyglotModal = true" title="Polyglot Runtime Inspector">
          <Layers :size="14" style="color: var(--accent-violet);" /> Stack
        </button>

        <button class="btn-glass btn-primary" @click="showApkModal = true">
          <Download :size="14" /> Download .APK v1.26.0
        </button>
      </div>
    </header>

    <!-- Clinical Context Ribbon (Role + Hardware Parity + 1-Tap Handoff) -->
    <div class="stage-container" style="margin-top: 10px;">
      <div class="glass-panel" style="padding: 9px 15px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 14px;">
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 0.77rem;">
          <span class="status-badge" :class="isOnline ? 'badge-green' : 'badge-amber'">
            <Wifi v-if="isOnline" :size="12" />
            <WifiOff v-else :size="12" />
            {{ isOnline ? 'ONLINE + OFFLINE VAULT READY' : 'OFFLINE EDGE MODE' }}
          </span>
          <span class="status-badge badge-cyan">
            Role: {{ roles.find((r) => r.id === activeRole)?.label }}
          </span>
          <span style="color: var(--text-secondary);">
            All 5 modules run live hardware sensors OR 1-tap built-in mathematical simulators locally on-device.
          </span>
        </div>

        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          <button class="btn-glass" style="padding: 5px 10px; font-size: 0.75rem;" @click="handleExportHandoff">
            <FileDown :size="13" /> 1-Tap Pediatrician Handoff (.JSON)
          </button>
          <button class="btn-glass" style="padding: 5px 10px; font-size: 0.75rem;" @click="handlePrintSummary">
            <Printer :size="13" /> Print Summary
          </button>
        </div>
      </div>

      <!-- Main Clinical Stage: Full Desktop Workstation OR Interactive Mobile APK Frame -->
      <div :class="previewMode === 'mobile_apk' ? 'mobile-apk-bezel-wrapper' : ''">
        <main :class="previewMode === 'mobile_apk' ? 'mobile-apk-bezel' : ''">
          <div v-if="previewMode === 'mobile_apk'" class="mobile-status-notch">
            <span>com.pediaspectra.neonatal · APK v1.26.0</span>
            <span>50 dBA LOCK · D65</span>
          </div>

          <InfantCryFormantClassifier
            v-show="activeTab === 'cry'"
            :role="activeRole"
            :permission-status="permissions"
            @acoustic-energy="acousticEnergy = $event"
            @record-saved="refreshVault"
            @request-permission="handlePermissionUpdate"
          />

          <BilirubinBhutaniNomogramScanner
            v-show="activeTab === 'bilirubin'"
            :role="activeRole"
            @record-saved="refreshVault"
            @request-permission="handlePermissionUpdate"
          />

          <TachypneaRetractionMonitor
            v-show="activeTab === 'respiratory'"
            :role="activeRole"
            @record-saved="refreshVault"
            @request-permission="handlePermissionUpdate"
          />

          <PediatricMgKgPharmacokinetics
            v-show="activeTab === 'dosing'"
            :role="activeRole"
            @record-saved="refreshVault"
            @patient-updated="patientMeta = { ...patientMeta, ...$event }"
          />

          <NurserySafeSleepTogArchitect
            v-show="activeTab === 'nursery'"
            :role="activeRole"
            @record-saved="refreshVault"
            @request-permission="handlePermissionUpdate"
          />
        </main>
      </div>

      <!-- Clinical Triage Disclaimer Footer -->
      <footer class="glass-panel clinical-disclaimer">
        <span>
          <strong>Clinical Triage Notice:</strong> PEDIA-SPECTRA implements AAP 2022 Bhutani hyperbilirubinemia curves, WHO IMCI respiratory cutoffs, Holliday-Segar 4-2-1 fluids, and Bateman PK models for bedside triage and parent education. It does not replace emergency care or a licensed pediatrician.
        </span>
        <span class="mono" style="color: var(--accent-cyan);">
          Vue 3.5 · Rust 2021 · ES2024 · Java 17 · Go 1.22 · WebGL2
        </span>
      </footer>
    </div>
  </div>

  <!-- Floating Bottom Gooey Frosted Navigation Dock -->
  <nav id="pedia-gooey-dock" aria-label="Pediatric Triage Modules">
    <button
      v-for="mod in dockModules"
      :key="mod.id"
      class="dock-item"
      :class="{ active: activeTab === mod.id }"
      @click="activeTab = mod.id"
    >
      <component :is="mod.icon" :size="19" />
      <span>{{ mod.label }}</span>
    </button>
  </nav>

  <!-- Offline IndexedDB Vault & Mutation Sync Queue Drawer -->
  <aside v-if="showVaultDrawer" class="sync-drawer">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 7px; font-weight: 800; font-size: 0.94rem;">
        <Database :size="17" style="color: var(--accent-teal);" />
        Offline IndexedDB Vault &amp; Sync Queue
      </div>
      <button class="btn-glass" style="padding: 5px 8px;" @click="showVaultDrawer = false"><X :size="15" /></button>
    </div>

    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 12px; font-size: 0.76rem;">
      <div class="glass-subcard" style="padding: 9px;">Cry Formant Logs: <strong class="mono">{{ vaultSnapshot.cry_formant_logs.length }}</strong></div>
      <div class="glass-subcard" style="padding: 9px;">Bilirubin Scans: <strong class="mono">{{ vaultSnapshot.bilirubin_tcb_scans.length }}</strong></div>
      <div class="glass-subcard" style="padding: 9px;">IMCI Resp Checks: <strong class="mono">{{ vaultSnapshot.respiratory_imci_checks.length }}</strong></div>
      <div class="glass-subcard" style="padding: 9px;">Medication Doses: <strong class="mono">{{ vaultSnapshot.medication_pk_doses.length }}</strong></div>
      <div class="glass-subcard" style="padding: 9px; grid-column: span 2;">Nursery Sleep Audits: <strong class="mono">{{ vaultSnapshot.nursery_sleep_audits.length }}</strong></div>
    </div>

    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
      <button class="btn-glass btn-primary" :disabled="syncing" @click="handleFlushSync">
        <RefreshCw :size="14" /> {{ syncing ? 'Syncing...' : `Sync Queue (${pendingSyncCount})` }}
      </button>
      <button class="btn-glass" @click="handleExportHandoff">
        <FileDown :size="14" /> Export Handoff
      </button>
      <button class="btn-glass btn-danger" @click="handleClearVault">
        <Trash2 :size="14" /> Clear
      </button>
    </div>

    <div v-if="syncMessage" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-emerald); color: var(--accent-emerald); font-size: 0.78rem; display: flex; align-items: center; gap: 6px;">
      <CheckCircle2 :size="15" /> {{ syncMessage }}
    </div>

    <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); margin-bottom: 6px;">
      RECENT MUTATION SYNC QUEUE ({{ vaultSnapshot.syncQueue.length }})
    </div>
    <div v-if="vaultSnapshot.syncQueue.length === 0" style="font-size: 0.78rem; color: var(--text-muted);">
      No logged clinical snapshots yet. Tap "Log" or "Save" in any module to persist offline into IndexedDB.
    </div>
    <div v-else style="display: flex; flex-direction: column; gap: 6px;">
      <div
        v-for="item in vaultSnapshot.syncQueue.slice(0, 8)"
        :key="item.id"
        class="glass-subcard"
        style="padding: 8px 10px; font-size: 0.74rem;"
      >
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
          <strong class="mono">{{ item.store }}</strong>
          <span class="mono" :style="item.status === 'SYNCED' ? 'color: var(--accent-emerald)' : 'color: var(--accent-amber)'">
            {{ item.status }}
          </span>
        </div>
        <div class="mono" style="color: var(--text-muted); font-size: 0.69rem;">
          POST /api/pediatric_clinical_solver · {{ item.timestamp.slice(11, 19) }} UTC
        </div>
      </div>
    </div>
  </aside>

  <!-- Depth-Pushed Modals -->
  <HardwarePermissionGatekeeper
    :open="showPermissionModal"
    :permissions="permissions"
    @close="showPermissionModal = false"
    @update-permission="handlePermissionUpdate"
  />
  <PolyglotRuntimeInspectorModal
    :open="showPolyglotModal"
    @close="showPolyglotModal = false"
  />
  <ApkReleaseDownloadModal
    :open="showApkModal"
    @close="showApkModal = false"
  />
</template>
