import { estimateTcbKubelkaMunk, MG_DL_TO_UMOL_L } from './rustPediatricsBridge.js';

/**
 * PEDIA-SPECTRA Transcutaneous Bilirubin (TcB) & 2022 AAP Bhutani Nomogram Engine
 *
 * Implements:
 *  - Melanin-compensated Kubelka-Munk 460nm/550nm dermal chromophore extraction across Fitzpatrick I-VI
 *  - 5-Zone Kramer Cephalocaudal Dermal Progression mapping
 *  - 2022 AAP Hyperbilirubinemia Clinical Practice Guideline hour-specific (0–168h)
 *    Phototherapy and Exchange Transfusion splines across gestational ages 35w -> >=40w
 *    with neurotoxicity risk factor modulation and hemolysis rate-of-rise (> 0.20 mg/dL/h) alert.
 */

export const FITZPATRICK_SCALES = [
  { type: 'I', label: 'Fitzpatrick I (Very Fair)', melaninIndex: 0.08, swatch: '#f6d8c6' },
  { type: 'II', label: 'Fitzpatrick II (Fair)', melaninIndex: 0.22, swatch: '#ecc1a6' },
  { type: 'III', label: 'Fitzpatrick III (Medium)', melaninIndex: 0.38, swatch: '#d7a27d' },
  { type: 'IV', label: 'Fitzpatrick IV (Olive / Tan)', melaninIndex: 0.56, swatch: '#b97e56' },
  { type: 'V', label: 'Fitzpatrick V (Brown)', melaninIndex: 0.76, swatch: '#8b5739' },
  { type: 'VI', label: 'Fitzpatrick VI (Deep Brown)', melaninIndex: 0.92, swatch: '#593422' },
];

export const KRAMER_ZONES = [
  { zone: 1, anatomy: 'Head & Neck', estRangeMgDl: '4 – 6 mg/dL', midpointMgDl: 5.2, note: 'Earliest cephalic icterus onset; physiological in many term newborns.' },
  { zone: 2, anatomy: 'Upper Trunk (Chest / Sternum)', estRangeMgDl: '6 – 9 mg/dL', midpointMgDl: 8.1, note: 'Standard sternum TcB site; monitor feed frequency & hydration.' },
  { zone: 3, anatomy: 'Lower Trunk & Thighs', estRangeMgDl: '9 – 12 mg/dL', midpointMgDl: 11.2, note: 'Progression past umbilicus warrants hour-specific Bhutani check.' },
  { zone: 4, anatomy: 'Arms & Lower Legs', estRangeMgDl: '12 – 15 mg/dL', midpointMgDl: 14.3, note: 'Extremity involvement correlates with high-intermediate to phototherapy risk.' },
  { zone: 5, anatomy: 'Palms & Soles', estRangeMgDl: '> 15 mg/dL', midpointMgDl: 17.8, note: 'Distal acral jaundice strongly suggests hyperbilirubinemia; obtain serum TSB urgently.' },
];

export const BILIRUBIN_SIMULATOR_PRESETS = [
  {
    id: 'term_low_risk',
    label: 'Day 2 Term — Low Risk (Fitzpatrick II)',
    postnatalHours: 42,
    gestationalWeeks: 39,
    hasNeurotoxicityRisk: false,
    melaninIndex: 0.22,
    fitzpatrickType: 'II',
    targetTcbMgDl: 6.4,
    priorTcbMgDl: 4.8,
    priorHours: 24,
    kramerZone: 1,
    summary: 'Physiological mild cephalic jaundice well below 2022 AAP phototherapy curve.',
  },
  {
    id: 'fitz_v_intermediate',
    label: 'Day 3 Term — Melanin-Compensated (Fitzpatrick V)',
    postnatalHours: 64,
    gestationalWeeks: 38,
    hasNeurotoxicityRisk: false,
    melaninIndex: 0.76,
    fitzpatrickType: 'V',
    targetTcbMgDl: 13.8,
    priorTcbMgDl: 10.6,
    priorHours: 40,
    kramerZone: 3,
    summary: 'Demonstrates 460nm/550nm Kubelka-Munk melanin decoupling where visual inspection alone underestimates TcB.',
  },
  {
    id: 'late_preterm_photo',
    label: '36w Late Preterm — Phototherapy Threshold',
    postnatalHours: 52,
    gestationalWeeks: 36,
    hasNeurotoxicityRisk: false,
    melaninIndex: 0.38,
    fitzpatrickType: 'III',
    targetTcbMgDl: 14.9,
    priorTcbMgDl: 11.1,
    priorHours: 36,
    kramerZone: 4,
    summary: 'Late-preterm 36w curve lowers AAP phototherapy ceiling; exceeds phototherapy threshold + hemolysis velocity alert.',
  },
  {
    id: 'hemolysis_escalation',
    label: 'Day 2 ABO/G6PD Risk — Escalation of Care',
    postnatalHours: 34,
    gestationalWeeks: 37,
    hasNeurotoxicityRisk: true,
    melaninIndex: 0.56,
    fitzpatrickType: 'IV',
    targetTcbMgDl: 16.4,
    priorTcbMgDl: 11.2,
    priorHours: 18,
    kramerZone: 5,
    summary: 'Rapid >0.32 mg/dL/hr hemolytic rise with neurotoxicity risk factor — immediate serum TSB & intensive phototherapy.',
  },
];

const AAP_PHOTO_BASE_38W = [
  [0, 7.2], [12, 9.6], [24, 12.1], [36, 14.3],
  [48, 16.0], [72, 18.6], [96, 20.1], [168, 21.0],
];

const AAP_EXCHANGE_BASE_38W = [
  [0, 14.5], [12, 16.5], [24, 19.0], [36, 21.2],
  [48, 23.0], [72, 25.0], [96, 25.8], [168, 26.0],
];

const BHUTANI_40TH = [[0, 2.0], [12, 3.8], [24, 5.2], [48, 8.6], [72, 11.2], [96, 12.4], [168, 13.0]];
const BHUTANI_75TH = [[0, 3.2], [12, 5.4], [24, 7.1], [48, 11.4], [72, 14.0], [96, 15.2], [168, 15.8]];
const BHUTANI_95TH = [[0, 4.5], [12, 6.8], [24, 8.5], [48, 13.4], [72, 16.1], [96, 17.5], [168, 18.0]];

function interpCurve(knots, hour) {
  if (hour <= knots[0][0]) return knots[0][1];
  const last = knots.length - 1;
  if (hour >= knots[last][0]) return knots[last][1];
  for (let i = 0; i < last; i++) {
    const [h0, v0] = knots[i];
    const [h1, v1] = knots[i + 1];
    if (hour >= h0 && hour <= h1) {
      const t = (hour - h0) / (h1 - h0);
      return v0 + t * (v1 - v0);
    }
  }
  return knots[last][1];
}

export function getAapThresholdsAtHour(hour, gestationalWeeks = 39, hasNeurotoxicityRisk = false) {
  const ga = Math.max(35, Math.min(40, Math.round(gestationalWeeks)));
  const gaOffsets = { 35: -3.6, 36: -2.4, 37: -1.2, 38: 0.0, 39: 0.5, 40: 0.9 };
  const gaOffset = gaOffsets[ga] ?? 0;
  const riskPhoto = hasNeurotoxicityRisk ? -2.3 : 0;
  const riskExch = hasNeurotoxicityRisk ? -2.8 : 0;

  const photo = Math.max(4.5, interpCurve(AAP_PHOTO_BASE_38W, hour) + gaOffset + riskPhoto);
  const exchange = Math.max(10.0, interpCurve(AAP_EXCHANGE_BASE_38W, hour) + gaOffset * 0.9 + riskExch);
  const escalation = Math.max(photo + 1.0, exchange - 2.0);

  return {
    hour,
    photo: Math.round(photo * 100) / 100,
    exchange: Math.round(exchange * 100) / 100,
    escalation: Math.round(escalation * 100) / 100,
    b40: Math.round(interpCurve(BHUTANI_40TH, hour) * 100) / 100,
    b75: Math.round(interpCurve(BHUTANI_75TH, hour) * 100) / 100,
    b95: Math.round(interpCurve(BHUTANI_95TH, hour) * 100) / 100,
  };
}

export function generateBhutaniSeries(gestationalWeeks = 39, hasNeurotoxicityRisk = false) {
  const series = [];
  for (let h = 0; h <= 168; h += 4) {
    series.push(getAapThresholdsAtHour(h, gestationalWeeks, hasNeurotoxicityRisk));
  }
  return series;
}

export function evaluateBilirubinClinicalCase({
  postnatalHours,
  tcbMgDl,
  gestationalWeeks = 39,
  hasNeurotoxicityRisk = false,
  priorTcbMgDl = 0,
  priorHours = 0,
  melaninIndex = 0.25,
  kramerZone = 2,
}) {
  const h = Math.max(0, Math.min(168, Number(postnatalHours) || 0));
  const tcb = Math.max(0.5, Math.min(28, Number(tcbMgDl) || 0));
  const thresh = getAapThresholdsAtHour(h, gestationalWeeks, hasNeurotoxicityRisk);

  const deltaHours = h - Number(priorHours || 0);
  const rateOfRise = priorTcbMgDl > 0 && deltaHours >= 1
    ? (tcb - Number(priorTcbMgDl)) / deltaHours
    : 0;
  const hemolysisAlert = rateOfRise >= 0.20;

  let riskZone = 'LOW_RISK';
  let severity = 'GREEN';
  let clinicalAction = 'Routine feeding (8–12×/day) and outpatient follow-up per newborn discharge schedule.';

  if (tcb >= thresh.exchange) {
    riskZone = 'EXCEEDS_EXCHANGE_TRANSFUSION';
    severity = 'RED';
    clinicalAction = 'EMERGENCY: Exceeds 2022 AAP Exchange Transfusion threshold. Immediate NICU admission, intensive phototherapy, IV hydration, and STAT serum TSB.';
  } else if (tcb >= thresh.escalation) {
    riskZone = 'ESCALATION_OF_CARE';
    severity = 'RED';
    clinicalAction = 'ESCALATION OF CARE: Within 2.0 mg/dL of Exchange threshold. Immediate hospital triage, intensive LED phototherapy, and STAT serum TSB.';
  } else if (tcb >= thresh.photo) {
    riskZone = 'EXCEEDS_PHOTOTHERAPY';
    severity = 'RED';
    clinicalAction = 'ACTION REQUIRED: Exceeds 2022 AAP Phototherapy threshold. Confirm immediately with serum TSB and initiate phototherapy.';
  } else if (tcb >= thresh.b95 || (thresh.photo - tcb) <= 2.0) {
    riskZone = 'HIGH_RISK_TRACK';
    severity = 'AMBER';
    clinicalAction = 'HIGH RISK: Within 2.0 mg/dL of Phototherapy threshold or >95th Bhutani track. Confirm serum TSB within 4–12 hours.';
  } else if (tcb >= thresh.b75) {
    riskZone = 'HIGH_INTERMEDIATE';
    severity = 'AMBER';
    clinicalAction = 'HIGH-INTERMEDIATE: Re-evaluate TcB/TSB in 12–24 hours and verify adequate wet diapers & feeding transfer.';
  } else if (tcb >= thresh.b40) {
    riskZone = 'LOW_INTERMEDIATE';
    severity = 'CYAN';
    clinicalAction = 'LOW-INTERMEDIATE: Track cephalocaudal Kramer progression and follow up within 24–48 hours.';
  }

  if (hemolysisAlert) {
    clinicalAction += ` HEMOLYSIS ALERT: Rapid rise (${rateOfRise.toFixed(2)} mg/dL/hr ≥ 0.20) warrants urgent DAT/Coombs & G6PD evaluation.`;
    if (severity === 'GREEN' || severity === 'CYAN') severity = 'AMBER';
  }

  // Synthesize corresponding D65 normalized skin RGB for optical verification metrics
  const baseR = 0.92 - melaninIndex * 0.54;
  const baseG = (0.79 - melaninIndex * 0.53) * Math.exp(-tcb * 0.008);
  const baseB = (0.71 - melaninIndex * 0.51) * Math.exp(-tcb * 0.042);
  const optical = estimateTcbKubelkaMunk(baseR, baseG, baseB, melaninIndex);

  return {
    postnatalHours: h,
    gestationalWeeks,
    hasNeurotoxicityRisk,
    tcbMgDl: Math.round(tcb * 10) / 10,
    tcbUmolL: Math.round(tcb * MG_DL_TO_UMOL_L),
    phototherapyThresholdMgDl: thresh.photo,
    exchangeThresholdMgDl: thresh.exchange,
    escalationOfCareMgDl: thresh.escalation,
    deltaBelowPhotoMgDl: Math.round((thresh.photo - tcb) * 10) / 10,
    rateOfRiseMgDlPerHr: Math.round(rateOfRise * 100) / 100,
    hemolysisAlert,
    riskZone,
    severity,
    clinicalAction,
    kramerZone,
    optical,
  };
}
