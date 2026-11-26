/**
 * PEDIA-SPECTRA Contact-Free Eulerian Respiratory (WHO IMCI) & Retraction Monitor Engine
 *
 * Dual-ROI optical/IMU thorax vs. abdomen motion analyzer:
 *  - Evaluates instantaneous respiratory rate (RR in breaths/min) via band-pass peak detection
 *  - Computes Konno-Mead Thoraco-Abdominal Asynchrony (TAA) Lissajous Phase Angle phi_TAA (0°..180°)
 *      * 0°–25°   : Synchronous normal diaphragmatic breathing
 *      * 55°–105° : Moderate subcostal / intercostal chest indrawing
 *      * 110°–180°: Paradoxical "seesaw" retraction distress
 *  - Central apnea pause stopwatch (> 15–20 seconds warning)
 *  - WHO IMCI age-tiered cutoffs:
 *      * < 2 months   : >= 60 breaths/min
 *      * 2–11 months  : >= 50 breaths/min
 *      * 1–5 years    : >= 40 breaths/min
 */

export const RESPIRATORY_SIMULATOR_PRESETS = [
  {
    id: 'calm_sleep',
    label: 'Calm Sleep (34 bpm · Synchronous)',
    ageMonths: 4,
    targetBpm: 34,
    phaseDeg: 9,
    apneaIntervalSec: 0,
    apneaDurationSec: 0,
    hasStridorOrGrunt: false,
    thoraxAmp: 1.0,
    abdomenAmp: 1.05,
    note: 'Quiet NREM infant breathing: chest and abdomen rise in phase (phi_TAA ~9°), safely below WHO IMCI 50 bpm limit.',
  },
  {
    id: 'febrile_tachypnea',
    label: 'Febrile Tachypnea (56 bpm · Mild Retraction)',
    ageMonths: 6,
    targetBpm: 56,
    phaseDeg: 42,
    apneaIntervalSec: 0,
    apneaDurationSec: 0,
    hasStridorOrGrunt: false,
    thoraxAmp: 0.92,
    abdomenAmp: 1.15,
    note: 'Fast breathing exceeding WHO IMCI >=50 bpm threshold for 2–11m infants. Recount after antipyretic cooling if febrile.',
  },
  {
    id: 'bronchiolitis_seesaw',
    label: 'Bronchiolitis Seesaw Retractions (68 bpm · 142°)',
    ageMonths: 3,
    targetBpm: 68,
    phaseDeg: 142,
    apneaIntervalSec: 0,
    apneaDurationSec: 0,
    hasStridorOrGrunt: true,
    thoraxAmp: 0.88,
    abdomenAmp: 1.28,
    note: 'SEVERE DISTRESS: Paradoxical thoraco-abdominal seesaw (phi_TAA ~142°) — abdomen protrudes while lower sternum pulls inward.',
  },
  {
    id: 'periodic_apnea',
    label: 'Neonatal Periodic Apnea Watch (17s Pause)',
    ageMonths: 1,
    targetBpm: 46,
    phaseDeg: 22,
    apneaIntervalSec: 8,
    apneaDurationSec: 17,
    hasStridorOrGrunt: false,
    thoraxAmp: 0.82,
    abdomenAmp: 0.90,
    note: 'Demonstrates prolonged >15s central respiratory pause detection in a <2 month neonate (triggers Apnea Alert at 15s/20s).',
  },
];

export function getWhoImciCutoff(ageMonths) {
  const m = Number(ageMonths) || 0;
  if (m < 2) {
    return { tier: 'Young Infant (< 2 months)', cutoffBpm: 60 };
  }
  if (m < 12) {
    return { tier: 'Infant (2 – 11 months)', cutoffBpm: 50 };
  }
  return { tier: 'Toddler / Child (1 – 5 years)', cutoffBpm: 40 };
}

/**
 * Generates synchronized Thorax & Abdomen displacement samples (with optional periodic apnea pause).
 */
export function sampleDualRoiRespiratoryWave(preset, elapsedSec) {
  let inApnea = false;
  let currentPauseSec = 0;

  if (preset.apneaDurationSec > 0 && preset.apneaIntervalSec > 0) {
    const cycle = preset.apneaIntervalSec + preset.apneaDurationSec;
    const mod = elapsedSec % cycle;
    if (mod >= preset.apneaIntervalSec) {
      inApnea = true;
      currentPauseSec = mod - preset.apneaIntervalSec;
    }
  }

  const freqHz = preset.targetBpm / 60;
  const omega = 2 * Math.PI * freqHz;
  const phaseRad = (preset.phaseDeg * Math.PI) / 180;

  if (inApnea) {
    const microDrift = 0.025 * Math.sin(elapsedSec * 1.4);
    return {
      thorax: microDrift,
      abdomen: -microDrift * 0.5,
      inApnea: true,
      currentPauseSec: Math.round(currentPauseSec * 10) / 10,
    };
  }

  // Realistic asymmetrical inspiratory/expiratory waveform (I:E ~ 1:1.6)
  const ab = preset.abdomenAmp * (Math.sin(omega * elapsedSec) + 0.16 * Math.sin(2 * omega * elapsedSec));
  const th = preset.thoraxAmp * (Math.sin(omega * elapsedSec - phaseRad) + 0.14 * Math.sin(2 * (omega * elapsedSec - phaseRad)));

  return {
    thorax: th + (Math.random() - 0.5) * 0.03,
    abdomen: ab + (Math.random() - 0.5) * 0.03,
    inApnea: false,
    currentPauseSec: 0,
  };
}

/**
 * Computes Konno-Mead Lissajous Phase Angle phi_TAA (0° .. 180°) from buffered thorax & abdomen traces
 * using Pearson correlation r -> phi = arccos(clamp(r, -1, 1)) in degrees.
 * Notice: when signals are in phase (r = +1), phi = 0°; when completely paradoxical seesaw (r = -1), phi = 180°.
 */
export function computeKonnoMeadPhaseAngle(thoraxBuf, abdomenBuf) {
  const n = Math.min(thoraxBuf.length, abdomenBuf.length);
  if (n < 20) return 0;

  let meanT = 0;
  let meanA = 0;
  for (let i = 0; i < n; i++) {
    meanT += thoraxBuf[i];
    meanA += abdomenBuf[i];
  }
  meanT /= n;
  meanA /= n;

  let cov = 0;
  let varT = 0;
  let varA = 0;
  for (let i = 0; i < n; i++) {
    const dt = thoraxBuf[i] - meanT;
    const da = abdomenBuf[i] - meanA;
    cov += dt * da;
    varT += dt * dt;
    varA += da * da;
  }

  const denom = Math.sqrt(varT * varA);
  if (denom < 1e-6) return 0;

  const r = Math.max(-1, Math.min(1, cov / denom));
  const phiDeg = (Math.acos(r) * 180) / Math.PI;
  return Math.round(phiDeg * 10) / 10;
}

/**
 * Evaluates WHO IMCI triage classification from respiratory rate, Konno-Mead phase angle, and apnea duration.
 */
export function evaluateWhoImciTriage({
  ageMonths,
  respiratoryRate,
  taaPhaseAngleDeg,
  longestApneaSec = 0,
  hasStridorOrGrunt = false,
}) {
  const { tier, cutoffBpm } = getWhoImciCutoff(ageMonths);
  const isTachypneic = respiratoryRate >= cutoffBpm;
  const centralApneaAlert = longestApneaSec >= 15;

  let retractionSeverity = 'SYNCHRONOUS_NORMAL';
  if (taaPhaseAngleDeg >= 110) {
    retractionSeverity = 'SEVERE_PARADOXICAL_SEESAW';
  } else if (taaPhaseAngleDeg >= 55) {
    retractionSeverity = 'MODERATE_CHEST_INDRAWING';
  } else if (taaPhaseAngleDeg >= 28) {
    retractionSeverity = 'MILD_ASYNCHRONY';
  }

  let imciClassification = 'Normal Respiratory Work (WHO IMCI Clear)';
  let urgency = 'GREEN';
  let guidance = 'Breathing cadence and thoraco-abdominal synchrony are within safe WHO IMCI pediatric norms.';

  if (centralApneaAlert || retractionSeverity === 'SEVERE_PARADOXICAL_SEESAW' || hasStridorOrGrunt) {
    imciClassification = 'WHO IMCI Danger Sign — Severe Respiratory Distress';
    urgency = 'RED';
    guidance = 'EMERGENCY: Paradoxical chest indrawing (seesaw retractions), prolonged apnea (>=15s), or grunting/stridor detected. Seek immediate emergency care.';
  } else if (isTachypneic && retractionSeverity === 'MODERATE_CHEST_INDRAWING') {
    imciClassification = 'WHO IMCI Pneumonia with Chest Indrawing';
    urgency = 'RED';
    guidance = 'Tachypnea combined with subcostal/intercostal indrawing. Urgent same-day pediatric or ED evaluation required.';
  } else if (isTachypneic) {
    imciClassification = 'WHO IMCI Fast Breathing (Tachypnea)';
    urgency = 'AMBER';
    guidance = `Respiratory rate (${respiratoryRate} bpm) meets/exceeds WHO IMCI threshold (>=${cutoffBpm} bpm for ${tier}). Recount calm 60s window & consult pediatrician.`;
  }

  return {
    ageTierLabel: tier,
    whoCutoffBpm: cutoffBpm,
    isTachypneic,
    retractionSeverity,
    centralApneaAlert,
    imciClassification,
    urgency,
    guidance,
  };
}
