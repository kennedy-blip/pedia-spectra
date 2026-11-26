<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import {
  Pill,
  Syringe,
  ShieldAlert,
  Droplets,
  Clock,
  PlusCircle,
  Trash2,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-vue-next';
import {
  PEDIATRIC_DRUG_FORMULARY,
  calculatePediatricMedicationPlan,
  computeHollidaySegarAndOrs,
} from '../engines/pediatricMgKgDosingEngine.js';
import { useSpringPhysics } from '../composables/useSpringPhysics.js';
import { saveClinicalRecord } from '../db/pediaVaultDb.js';

const props = defineProps({
  role: { type: String, default: 'parent' },
});

const emit = defineEmits(['record-saved', 'patient-updated']);

const pkCanvas = ref(null);

const weightUnit = ref('kg'); // 'kg' | 'lbs'
const rawWeightInput = ref(8.4);
const ageMonths = ref(9);
const selectedDrugId = ref('acetaminophen');
const selectedConcentrationId = ref('apap_160_5');
const selectedSyringeCap = ref(5);
const dehydrationSeverity = ref('mild_moderate');

// Pre-seeded realistic recent dose log (in hours relative to t=0) so Bateman PK curve is immediately instructive
const doseHistory = ref([
  { id: 'd1', timeHr: 0, doseMg: 126, drugId: 'acetaminophen', label: '00:00 (Initial Dose)' },
  { id: 'd2', timeHr: 5.0, doseMg: 126, drugId: 'acetaminophen', label: '+5.0h (Follow-Up)' },
]);
const nextDoseHour = ref(10.0);
const saveToast = ref('');

const weightKg = computed(() => {
  const val = Number(rawWeightInput.value) || 0;
  return weightUnit.value === 'lbs' ? Math.round((val / 2.20462) * 100) / 100 : val;
});

const drugList = Object.values(PEDIATRIC_DRUG_FORMULARY);
const activeDrug = computed(() => PEDIATRIC_DRUG_FORMULARY[selectedDrugId.value]);

const relevantDoses = computed(() =>
  doseHistory.value.filter((d) => d.drugId === selectedDrugId.value)
);

const plan = computed(() =>
  calculatePediatricMedicationPlan({
    drugId: selectedDrugId.value,
    concentrationId: selectedConcentrationId.value,
    weightKg: weightKg.value,
    ageMonths: ageMonths.value,
    priorDoses: relevantDoses.value,
    syringeCapacityMl: selectedSyringeCap.value,
  })
);

const hydration = computed(() =>
  computeHollidaySegarAndOrs(weightKg.value, dehydrationSeverity.value)
);

// 1:1 Hooke's Law Spring-Animated Oral Syringe Plunger (stiffness: 180, damping: 22)
const syringeFillRatioTarget = computed(() => {
  if (!plan.value.allowed) return 0;
  return Math.max(0, Math.min(1, plan.value.targetSyringeMl / plan.value.activeSyringeCapacityMl));
});
const { current: animatedFillRatio } = useSpringPhysics(syringeFillRatioTarget, {
  stiffness: 180,
  damping: 22,
});

const syringeTicks = computed(() => {
  const cap = plan.value.activeSyringeCapacityMl;
  const step = cap === 1 ? 0.1 : cap === 5 ? 0.5 : 1.0;
  const ticks = [];
  for (let v = 0; v <= cap + 0.001; v += step) {
    const rounded = Math.round(v * 10) / 10;
    ticks.push({
      val: rounded,
      ratio: rounded / cap,
      major: cap === 1 ? (Math.round(rounded * 10) % 2 === 0) : (Math.abs(rounded - Math.round(rounded)) < 0.01),
    });
  }
  return ticks;
});

function toggleWeightUnit(nextUnit) {
  if (nextUnit === weightUnit.value) return;
  const current = Number(rawWeightInput.value) || 0;
  if (nextUnit === 'lbs') {
    rawWeightInput.value = Math.round(current * 2.20462 * 10) / 10;
  } else {
    rawWeightInput.value = Math.round((current / 2.20462) * 10) / 10;
  }
  weightUnit.value = nextUnit;
}

function selectDrug(drugId) {
  selectedDrugId.value = drugId;
  const d = PEDIATRIC_DRUG_FORMULARY[drugId];
  selectedConcentrationId.value = d.concentrations[0].id;
}

async function logNewDose() {
  if (!plan.value.allowed || plan.value.exceeds24hCeiling) return;
  const newEntry = {
    id: `dose_${Date.now()}`,
    timeHr: Number(nextDoseHour.value) || 0,
    doseMg: plan.value.singleDoseTargetMg,
    drugId: selectedDrugId.value,
    label: `+${Number(nextDoseHour.value).toFixed(1)}h (${plan.value.targetSyringeMl} mL)`,
  };
  doseHistory.value.push(newEntry);
  nextDoseHour.value = Math.min(22, Math.round((newEntry.timeHr + activeDrug.value.minIntervalHours) * 10) / 10);

  const saved = await saveClinicalRecord('medication_pk_doses', {
    drug: activeDrug.value.name,
    concentration: plan.value.concentration.label,
    weightKg: weightKg.value,
    ageMonths: ageMonths.value,
    singleDoseMg: plan.value.singleDoseTargetMg,
    syringeVolumeMl: plan.value.targetSyringeMl,
    total24hMg: plan.value.totalGiven24hMg + plan.value.singleDoseTargetMg,
    maxDaily24hMg: plan.value.maxDaily24hMg,
    cMaxMgPerL: plan.value.pkCurve.cMaxMgPerL,
  });

  saveToast.value = `Logged ${plan.value.singleDoseTargetMg} mg (${plan.value.targetSyringeMl} mL) of ${activeDrug.value.name} to Vault.`;
  emit('record-saved', { store: 'medication_pk_doses', record: saved });
  setTimeout(() => { saveToast.value = ''; }, 3400);
}

function removeDose(id) {
  doseHistory.value = doseHistory.value.filter((d) => d.id !== id);
}

function drawBatemanPkChart() {
  const canvas = pkCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const padL = 46;
  const padR = 18;
  const padT = 20;
  const padB = 32;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.fillStyle = '#060e1d';
  ctx.fillRect(0, 0, w, h);

  const drug = activeDrug.value;
  const pts = plan.value.pkCurve.points;
  const yMax = Math.max(drug.hepatotoxicWatchMgL * 1.12, plan.value.pkCurve.cMaxMgPerL * 1.25, 1);

  const mapX = (hr) => padL + (hr / 24) * plotW;
  const mapY = (cp) => padT + plotH - (Math.min(yMax, cp) / yMax) * plotH;

  // Therapeutic window band
  const yTherTop = mapY(drug.therapeuticMaxMgL);
  const yTherBot = mapY(drug.therapeuticMinMgL);
  ctx.fillStyle = 'rgba(52, 211, 153, 0.13)';
  ctx.fillRect(padL, yTherTop, plotW, Math.max(2, yTherBot - yTherTop));

  // Toxic / Caution ceiling line
  const yTox = mapY(drug.hepatotoxicWatchMgL);
  ctx.strokeStyle = 'rgba(244, 63, 94, 0.65)';
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, yTox);
  ctx.lineTo(padL + plotW, yTox);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#fda4af';
  ctx.font = '700 10px JetBrains Mono, monospace';
  ctx.fillText(`Safety Watch Ceiling (${drug.hepatotoxicWatchMgL} mg/L)`, padL + 6, Math.max(14, yTox - 5));

  // Time grid (every 4 hours)
  ctx.strokeStyle = 'rgba(148, 210, 255, 0.11)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#94a3b8';
  for (let hr = 0; hr <= 24; hr += 4) {
    const x = mapX(hr);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(`${hr}h`, x - 7, h - 10);
  }

  // Y-axis ticks
  for (let i = 0; i <= 4; i++) {
    const val = (yMax / 4) * i;
    const y = mapY(val);
    ctx.fillText(val >= 10 ? val.toFixed(0) : val.toFixed(2), 6, y + 3);
  }

  // Draw Bateman C_p(t) curve
  if (pts.length > 1) {
    ctx.beginPath();
    pts.forEach((p, idx) => {
      const x = mapX(p.hour);
      const y = mapY(p.cpMgPerL);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = plan.value.allowed ? '#22d3ee' : '#64748b';
    ctx.lineWidth = 2.6;
    ctx.stroke();

    // Soft area gradient
    ctx.lineTo(mapX(24), padT + plotH);
    ctx.lineTo(mapX(0), padT + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, 'rgba(34, 211, 238, 0.30)');
    grad.addColorStop(1, 'rgba(34, 211, 238, 0.0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Mark next safe lockout boundary
  if (plan.value.nextSafeHour > 0 && plan.value.nextSafeHour <= 24) {
    const lx = mapX(plan.value.nextSafeHour);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(lx, padT);
    ctx.lineTo(lx, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(`Next Safe >= ${plan.value.nextSafeHour}h`, Math.min(w - 115, lx + 4), padT + 14);
  }

  ctx.fillStyle = '#34d399';
  ctx.fillText(`Therapeutic Band (${drug.therapeuticMinMgL}–${drug.therapeuticMaxMgL} mg/L)`, padL + 6, Math.min(padT + plotH - 6, yTherBot - 4));
}

onMounted(() => {
  drawBatemanPkChart();
});

watch(
  [weightKg, ageMonths, selectedDrugId, selectedConcentrationId, doseHistory],
  () => {
    drawBatemanPkChart();
    emit('patient-updated', { weightKg: weightKg.value, ageMonths: ageMonths.value });
  },
  { deep: true }
);
</script>

<template>
  <section class="glass-panel" style="padding: 20px;">
    <!-- Header -->
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px;">
      <div>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <Pill :size="19" style="color: var(--accent-rose);" />
          <h2 style="margin: 0; font-size: 1.18rem; font-weight: 800;">
            Pediatric mg/kg Overdose Shield, Bateman PK &amp; Rehydration
          </h2>
          <span class="status-badge" :class="plan.allowed && !plan.exceeds24hCeiling ? 'badge-green' : 'badge-red'">
            {{ !plan.allowed ? 'CONTRAINDICATED BLOCK' : (plan.exceeds24hCeiling ? '24H CEILING EXCEEDED' : 'SAFE WEIGHT-VERIFIED') }}
          </span>
        </div>
        <p style="margin: 0; font-size: 0.83rem; color: var(--text-secondary);">
          Weight-verified oral syringe visualizer (Hooke’s Law spring), 2.0× Ibuprofen drops concentration trap shield, 24h Bateman C_p(t) solver, and Holliday-Segar 4-2-1 fluids.
        </p>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 6px;">
        <button
          v-for="d in drugList"
          :key="d.id"
          class="btn-glass"
          :class="{ active: selectedDrugId === d.id }"
          @click="selectDrug(d.id)"
        >
          {{ d.name.split(' ')[0] }}
        </button>
      </div>
    </div>

    <!-- Patient Weight, Age & Concentration Controls -->
    <div class="module-grid-3" style="margin-bottom: 14px;">
      <div class="glass-subcard">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <label style="font-size: 0.76rem; font-weight: 700; color: var(--text-muted);">CHILD WEIGHT</label>
          <div class="segmented-control">
            <button :class="{ active: weightUnit === 'kg' }" @click="toggleWeightUnit('kg')">kg</button>
            <button :class="{ active: weightUnit === 'lbs' }" @click="toggleWeightUnit('lbs')">lbs</button>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <input v-model.number="rawWeightInput" type="number" step="0.1" min="1.5" max="200" class="clinical-input mono" />
          <span class="mono" style="font-size: 0.8rem; color: var(--accent-cyan); white-space: nowrap;">
            = {{ weightKg.toFixed(1) }} kg
          </span>
        </div>
      </div>

      <div class="glass-subcard">
        <label style="font-size: 0.76rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 6px;">
          CHILD AGE (MONTHS) · IBUPROFEN LOCK &lt;6M
        </label>
        <div style="display: flex; align-items: center; gap: 10px;">
          <input v-model.number="ageMonths" type="range" min="0" max="144" step="1" class="clinical-slider" />
          <span class="mono" style="font-size: 0.86rem; font-weight: 700; min-width: 72px; text-align: right;">
            {{ ageMonths < 24 ? `${ageMonths} mo` : `${(ageMonths / 12).toFixed(1)} yr` }}
          </span>
        </div>
      </div>

      <div class="glass-subcard">
        <label style="font-size: 0.76rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 6px;">
          BOTTLE LIQUID CONCENTRATION
        </label>
        <select v-model="selectedConcentrationId" class="clinical-select">
          <option v-for="c in activeDrug.concentrations" :key="c.id" :value="c.id">
            {{ c.label }}
          </option>
        </select>
      </div>
    </div>

    <!-- Critical Guardrail Alerts (Age Block, Sanity Guard, Concentration 2.0x Trap) -->
    <div v-if="!plan.allowed || plan.blockReason" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-danger); background: rgba(244, 63, 94, 0.16); display: flex; gap: 10px; align-items: flex-start;">
      <ShieldAlert :size="20" style="color: var(--accent-danger); flex-shrink: 0; margin-top: 2px;" />
      <div style="font-size: 0.83rem; font-weight: 600; color: #fecdd3;">{{ plan.blockReason }}</div>
    </div>

    <div v-if="plan.concentration.isConcentratedTrap" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-amber); background: rgba(251, 191, 36, 0.14); display: flex; gap: 10px; align-items: flex-start;">
      <AlertTriangle :size="20" style="color: var(--accent-amber); flex-shrink: 0; margin-top: 2px;" />
      <div style="font-size: 0.83rem; font-weight: 700; color: #fde68a;">{{ plan.concentration.trapNote }}</div>
    </div>

    <div v-if="!plan.sanity.ok" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-amber); background: rgba(251, 191, 36, 0.12); font-size: 0.82rem; color: var(--accent-amber);">
      {{ plan.sanity.warning }}
    </div>

    <div v-if="saveToast" class="glass-subcard" style="margin-bottom: 12px; border-color: var(--accent-emerald); color: var(--accent-emerald); font-size: 0.82rem; display: flex; align-items: center; gap: 8px;">
      <CheckCircle2 :size="16" /> {{ saveToast }}
    </div>

    <!-- Main Split: 1:1 Spring Oral Syringe Visualizer + 24h Bateman PK Canvas -->
    <div class="module-grid-2" style="margin-bottom: 16px;">
      <!-- Left: 1:1 Spring-Animated Oral Syringe -->
      <div class="glass-subcard" style="display: flex; flex-direction: column; justify-content: space-between; gap: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <span style="font-size: 0.84rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
            <Syringe :size="16" style="color: var(--accent-cyan);" />
            1:1 Spring-Animated Oral Syringe ({{ plan.activeSyringeCapacityMl }} mL Barrel)
          </span>
          <div class="segmented-control">
            <button :class="{ active: selectedSyringeCap === 1 }" @click="selectedSyringeCap = 1">1 mL</button>
            <button :class="{ active: selectedSyringeCap === 5 }" @click="selectedSyringeCap = 5">5 mL</button>
            <button :class="{ active: selectedSyringeCap === 10 }" @click="selectedSyringeCap = 10">10 mL</button>
          </div>
        </div>

        <!-- SVG Precision Oral Syringe Driven by Hooke's Law Spring ODE -->
        <div style="padding: 16px 8px; border-radius: 14px; background: rgba(4, 12, 26, 0.72); border: 1px solid var(--glass-border);">
          <svg viewBox="0 0 520 132" width="100%" height="128" role="img" aria-label="Precision oral dosing syringe">
            <!-- Tip nozzle -->
            <rect x="14" y="54" width="38" height="24" rx="5" fill="#94a3b8" fill-opacity="0.35" stroke="#94a3b8" stroke-width="1.5" />
            <!-- Transparent calibrated barrel -->
            <rect x="52" y="34" width="320" height="64" rx="8" fill="rgba(186,234,255,0.08)" stroke="rgba(186,234,255,0.55)" stroke-width="2" />
            <!-- Liquid Medication Column (animated via useSpringPhysics) -->
            <rect
              x="54"
              y="36"
              :width="Math.max(0, animatedFillRatio * 314)"
              height="60"
              rx="6"
              :fill="plan.allowed ? (plan.concentration.isConcentratedTrap ? '#fbbf24' : '#22d3ee') : '#f43f5e'"
              fill-opacity="0.58"
            />
            <!-- Plunger Gasket + Rod -->
            <rect
              :x="54 + animatedFillRatio * 314"
              y="36"
              width="14"
              height="60"
              rx="3"
              fill="#e2e8f0"
            />
            <rect
              :x="68 + animatedFillRatio * 314"
              y="56"
              :width="Math.max(36, 430 - (68 + animatedFillRatio * 314))"
              height="20"
              rx="4"
              fill="rgba(203,213,225,0.45)"
              stroke="#cbd5e1"
              stroke-width="1.2"
            />
            <!-- Finger Flange -->
            <rect x="372" y="20" width="9" height="92" rx="4" fill="#cbd5e1" fill-opacity="0.7" />
            <!-- Thumb Pad -->
            <rect x="492" y="38" width="12" height="56" rx="5" fill="#e2e8f0" fill-opacity="0.82" />

            <!-- Graduation Tick Marks -->
            <g v-for="t in syringeTicks" :key="t.val">
              <line
                :x1="54 + t.ratio * 314"
                y1="34"
                :x2="54 + t.ratio * 314"
                :y2="t.major ? 50 : 43"
                stroke="#eef6ff"
                :stroke-width="t.major ? 1.6 : 1"
                stroke-opacity="0.8"
              />
              <text
                v-if="t.major"
                :x="54 + t.ratio * 314"
                y="26"
                text-anchor="middle"
                fill="#cbd5e1"
                font-size="10"
                font-family="JetBrains Mono, monospace"
              >
                {{ t.val }}
              </text>
            </g>

            <!-- Target Draw Callout -->
            <text
              x="212"
              y="118"
              text-anchor="middle"
              :fill="plan.allowed ? '#22d3ee' : '#fb7185'"
              font-size="13"
              font-weight="800"
              font-family="JetBrains Mono, monospace"
            >
              {{ plan.allowed ? `DRAW EXACTLY ${plan.targetSyringeMl.toFixed(1)} mL (${plan.singleDoseTargetMg} mg)` : 'DOSING BLOCKED FOR AGE' }}
            </text>
          </svg>
        </div>

        <!-- Dosing Telemetry Grid -->
        <div class="module-grid-3" style="gap: 8px;">
          <div class="kpi-card">
            <span class="kpi-label">Target Dose</span>
            <span class="kpi-value" style="font-size: 1.25rem; color: var(--accent-cyan);">
              {{ plan.allowed ? `${plan.targetSyringeMl.toFixed(1)} mL` : 'BLOCK' }}
            </span>
            <span class="kpi-unit">{{ plan.singleDoseTargetMg }} mg ({{ activeDrug.targetMgPerKg }} mg/kg)</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">24h Safety Budget</span>
            <span class="kpi-value" style="font-size: 1.25rem;" :style="plan.exceeds24hCeiling ? 'color: var(--accent-danger)' : 'color: var(--accent-emerald)'">
              {{ plan.remaining24hMg }} mg
            </span>
            <span class="kpi-unit">Used {{ plan.totalGiven24hMg }} / {{ plan.maxDaily24hMg }} mg max</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Lockout Interval</span>
            <span class="kpi-value" style="font-size: 1.25rem; color: var(--accent-amber);">
              q{{ activeDrug.minIntervalHours }}h
            </span>
            <span class="kpi-unit">Max {{ activeDrug.maxDosesPer24h }} doses / 24h</span>
          </div>
        </div>
      </div>

      <!-- Right: 24h Bateman Plasma Concentration C_p(t) & Dose Lockout Log -->
      <div class="glass-subcard" style="display: flex; flex-direction: column; gap: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.84rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
            <Clock :size="16" style="color: var(--accent-teal);" />
            24-Hour 1-Compartment Bateman C_p(t) Pharmacokinetics
          </span>
          <span class="mono" style="font-size: 0.72rem; color: var(--accent-cyan);">
            Cmax {{ plan.pkCurve.cMaxMgPerL }} mg/L · t½ {{ plan.pkCurve.halfLifeHr }}h
          </span>
        </div>

        <canvas ref="pkCanvas" width="560" height="205" class="canvas-stage"></canvas>

        <!-- Add Dose Row + Logged Doses -->
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 6px; font-size: 0.78rem;">
            <span>Log Dose at Hour:</span>
            <input v-model.number="nextDoseHour" type="number" step="0.5" min="0" max="24" class="clinical-input mono" style="width: 72px; padding: 5px 8px;" />
            <button
              class="btn-glass btn-primary"
              :disabled="!plan.allowed || plan.exceeds24hCeiling"
              @click="logNewDose"
            >
              <PlusCircle :size="14" /> Log {{ plan.targetSyringeMl.toFixed(1) }} mL Dose
            </button>
          </div>
          <span class="mono" style="font-size: 0.72rem; color: var(--text-muted);">
            Next Safe ≥ +{{ plan.nextSafeHour }}h
          </span>
        </div>

        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
          <span
            v-for="d in relevantDoses"
            :key="d.id"
            class="status-badge badge-cyan"
            style="gap: 6px;"
          >
            {{ d.label }} · {{ d.doseMg }}mg
            <button style="background: none; border: none; color: inherit; cursor: pointer; padding: 0; display: inline-flex;" @click="removeDose(d.id)">
              <Trash2 :size="12" />
            </button>
          </span>
        </div>
      </div>
    </div>

    <!-- Holliday-Segar 4-2-1 Maintenance Fluids & WHO Plan B ORS Rehydration -->
    <div class="glass-subcard">
      <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px;">
        <span style="font-size: 0.86rem; font-weight: 800; display: flex; align-items: center; gap: 7px;">
          <Droplets :size="17" style="color: var(--accent-cyan);" />
          Holliday-Segar 4-2-1 Maintenance Fluids &amp; WHO Plan B Oral Rehydration (75 mL/kg / 4h)
        </span>
        <div class="segmented-control">
          <button :class="{ active: dehydrationSeverity === 'none' }" @click="dehydrationSeverity = 'none'">Maintenance Only</button>
          <button :class="{ active: dehydrationSeverity === 'mild_moderate' }" @click="dehydrationSeverity = 'mild_moderate'">WHO Plan B (Mild–Mod Dehydration)</button>
        </div>
      </div>

      <div class="kpi-row-4">
        <div class="kpi-card">
          <span class="kpi-label">Holliday-Segar Hourly</span>
          <span class="kpi-value" style="color: var(--accent-cyan);">{{ hydration.hourlyMaintMl }} <small style="font-size: 0.72rem;">mL/hr</small></span>
          <span class="kpi-unit">{{ hydration.dailyMaintMl }} mL / 24h maintenance</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">WHO Plan B ORS (4h)</span>
          <span class="kpi-value" style="color: var(--accent-teal);">{{ hydration.orsPlanB4hTotalMl }} <small style="font-size: 0.72rem;">mL</small></span>
          <span class="kpi-unit">75 mL/kg oral rehydration target</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Micro-Sip Syringe Pace</span>
          <span class="kpi-value" style="color: var(--accent-emerald);">{{ hydration.orsSyringePer3MinMl }} <small style="font-size: 0.72rem;">mL</small></span>
          <span class="kpi-unit">Every 3 minutes (anti-emesis pace)</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Target Urine Output</span>
          <span class="kpi-value" style="color: var(--accent-amber);">&ge;{{ hydration.minWetDiapersPer24h }} <small style="font-size: 0.72rem;">diapers</small></span>
          <span class="kpi-unit">&ge;{{ hydration.minExpectedUrineMlPerHr }} mL/hr expected</span>
        </div>
      </div>
    </div>
  </section>
</template>
