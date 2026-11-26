import { evaluateBatemanCurve } from './rustPediatricsBridge.js';

/**
 * PEDIA-SPECTRA Pediatric mg/kg Overdose Shield, 1-Compartment Bateman PK & Holliday-Segar Engine
 *
 * Guardrails:
 *  1. Weight unit normalization (kg / lbs) + WHO age-vs-weight plausibility sanity guard.
 *  2. Hard Clinical Block: Ibuprofen strictly contraindicated < 6 months of age.
 *  3. Concentration Trap Shield: Flags Infant Concentrated Ibuprofen Drops (50mg / 1.25mL = 40mg/mL)
 *     vs Children's Suspension (100mg / 5mL = 20mg/mL — a 2.0x overdose trap!).
 *  4. 1-Compartment Oral Bateman C_p(t) 24-hour plasma concentration trajectory + lockout timer.
 *  5. Holliday-Segar 4-2-1 maintenance fluids + WHO Plan B ORS (75 mL/kg over 4 hours).
 */

export const PEDIATRIC_DRUG_FORMULARY = {
  acetaminophen: {
    id: 'acetaminophen',
    name: 'Acetaminophen (Paracetamol)',
    category: 'Antipyretic / Analgesic',
    minAgeMonths: 0,
    minMgPerKg: 10,
    targetMgPerKg: 15,
    maxSingleMg: 650,
    maxDailyMgPerKg: 75,
    maxDailyAbsMg: 4000,
    minIntervalHours: 4,
    maxDosesPer24h: 5,
    kaPerHr: 1.85,
    kePerHr: 0.28, // t1/2 ~2.5h
    vdLPerKg: 0.95,
    bioavailability: 0.88,
    therapeuticMinMgL: 10,
    therapeuticMaxMgL: 20,
    hepatotoxicWatchMgL: 35,
    concentrations: [
      { id: 'apap_160_5', label: '160 mg / 5 mL (Standard Infant & Children’s Liquid)', mg: 160, ml: 5, isConcentratedTrap: false },
      { id: 'apap_120_5', label: '120 mg / 5 mL (UK / International Infant Suspension)', mg: 120, ml: 5, isConcentratedTrap: false },
      { id: 'apap_250_5', label: '250 mg / 5 mL (Six-Plus / High Strength — Verify!)', mg: 250, ml: 5, isConcentratedTrap: true, trapNote: '1.56× stronger than standard 160mg/5mL suspension. Double-check bottle label!' },
    ],
  },
  ibuprofen: {
    id: 'ibuprofen',
    name: 'Ibuprofen (NSAID)',
    category: 'Anti-Inflammatory / Antipyretic',
    minAgeMonths: 6,
    minMgPerKg: 5,
    targetMgPerKg: 10,
    maxSingleMg: 400,
    maxDailyMgPerKg: 40,
    maxDailyAbsMg: 1200,
    minIntervalHours: 6,
    maxDosesPer24h: 4,
    kaPerHr: 1.55,
    kePerHr: 0.34, // t1/2 ~2.0h
    vdLPerKg: 0.16,
    bioavailability: 0.92,
    therapeuticMinMgL: 15,
    therapeuticMaxMgL: 50,
    hepatotoxicWatchMgL: 85,
    concentrations: [
      { id: 'ibu_100_5', label: '100 mg / 5 mL (Children’s Suspension — 20 mg/mL)', mg: 100, ml: 5, isConcentratedTrap: false },
      { id: 'ibu_50_125', label: '50 mg / 1.25 mL (Infant Concentrated Drops — 40 mg/mL)', mg: 50, ml: 1.25, isConcentratedTrap: true, trapNote: '2.0× CONCENTRATION TRAP: Infant Drops (40 mg/mL) are TWICE as strong per mL as Children’s Ibuprofen (20 mg/mL)! Never swap volumes.' },
    ],
  },
  amoxicillin: {
    id: 'amoxicillin',
    name: 'Amoxicillin (High-Dose Otitis/CAP)',
    category: 'Beta-Lactam Antibiotic (Rx Only)',
    minAgeMonths: 1,
    minMgPerKg: 22.5,
    targetMgPerKg: 45, // 90 mg/kg/day divided BID
    maxSingleMg: 1000,
    maxDailyMgPerKg: 90,
    maxDailyAbsMg: 3000,
    minIntervalHours: 12,
    maxDosesPer24h: 2,
    kaPerHr: 1.40,
    kePerHr: 0.55, // t1/2 ~1.25h
    vdLPerKg: 0.32,
    bioavailability: 0.85,
    therapeuticMinMgL: 4,
    therapeuticMaxMgL: 28,
    hepatotoxicWatchMgL: 65,
    concentrations: [
      { id: 'amox_400_5', label: '400 mg / 5 mL (Standard Pediatric Suspension)', mg: 400, ml: 5, isConcentratedTrap: false },
      { id: 'amox_250_5', label: '250 mg / 5 mL (Lower Strength Suspension)', mg: 250, ml: 5, isConcentratedTrap: false },
    ],
  },
  cetirizine: {
    id: 'cetirizine',
    name: 'Cetirizine (2nd-Gen Antihistamine)',
    category: 'Allergy / Urticaria',
    minAgeMonths: 6,
    minMgPerKg: 0.25,
    targetMgPerKg: 0.25,
    maxSingleMg: 5,
    maxDailyMgPerKg: 0.5,
    maxDailyAbsMg: 10,
    minIntervalHours: 24,
    maxDosesPer24h: 1,
    kaPerHr: 1.9,
    kePerHr: 0.095, // t1/2 ~7.3h
    vdLPerKg: 0.50,
    bioavailability: 0.90,
    therapeuticMinMgL: 0.12,
    therapeuticMaxMgL: 0.45,
    hepatotoxicWatchMgL: 0.9,
    concentrations: [
      { id: 'cet_5_5', label: '5 mg / 5 mL (1 mg/mL Pediatric Oral Solution)', mg: 5, ml: 5, isConcentratedTrap: false },
    ],
  },
  diphenhydramine: {
    id: 'diphenhydramine',
    name: 'Diphenhydramine (1st-Gen Antihistamine)',
    category: 'Acute Allergic Reaction (Clinician Guided)',
    minAgeMonths: 24,
    minMgPerKg: 1.0,
    targetMgPerKg: 1.25,
    maxSingleMg: 50,
    maxDailyMgPerKg: 5,
    maxDailyAbsMg: 300,
    minIntervalHours: 6,
    maxDosesPer24h: 4,
    kaPerHr: 1.35,
    kePerHr: 0.14, // t1/2 ~5h
    vdLPerKg: 3.5,
    bioavailability: 0.72,
    therapeuticMinMgL: 0.04,
    therapeuticMaxMgL: 0.16,
    hepatotoxicWatchMgL: 0.35,
    concentrations: [
      { id: 'diph_125_5', label: '12.5 mg / 5 mL (Children’s Liquid)', mg: 12.5, ml: 5, isConcentratedTrap: false },
    ],
  },
};

/**
 * Rough WHO weight-for-age plausibility range to catch accidental lbs-entered-as-kg errors.
 */
export function checkAgeWeightSanity(ageMonths, weightKg) {
  const m = Math.max(0, Number(ageMonths) || 0);
  const w = Number(weightKg) || 0;
  if (w < 1.8 || w > 95) {
    return { ok: false, warning: `Weight ${w.toFixed(1)} kg is outside typical pediatric range (1.8–95 kg). Verify kg vs. lbs toggle.` };
  }
  const expectedMin = m < 1 ? 2.2 : m < 6 ? 3.5 : m < 12 ? 6.0 : m < 24 ? 8.0 : 9.5 + (m / 12 - 2) * 1.3;
  const expectedMax = m < 1 ? 5.8 : m < 6 ? 11.0 : m < 12 ? 14.5 : m < 24 ? 18.0 : 19.0 + (m / 12 - 2) * 4.2;

  if (w > expectedMax * 1.45) {
    return {
      ok: false,
      warning: `SANITY GUARD: ${w.toFixed(1)} kg is unusually high for ${m} months old. Did you accidentally enter pounds (lbs) while in kilograms (kg) mode?`,
    };
  }
  if (w < expectedMin * 0.65) {
    return {
      ok: false,
      warning: `SANITY GUARD: ${w.toFixed(1)} kg is unusually low for ${m} months old. Please double-check weight measurement before dosing.`,
    };
  }
  return { ok: true, warning: '' };
}

/**
 * Holliday-Segar 4-2-1 Maintenance Fluid & WHO Plan B Oral Rehydration Solution (ORS) Solver
 */
export function computeHollidaySegarAndOrs(weightKg, dehydrationSeverity = 'mild_moderate') {
  const w = Math.max(1.5, Number(weightKg) || 5);
  let hourlyMaintMl = 0;
  if (w <= 10) {
    hourlyMaintMl = 4 * w;
  } else if (w <= 20) {
    hourlyMaintMl = 40 + 2 * (w - 10);
  } else {
    hourlyMaintMl = 60 + 1 * (w - 20);
  }
  const dailyMaintMl = hourlyMaintMl * 24;
  const orsPlanB4hTotalMl = dehydrationSeverity === 'none' ? 0 : 75 * w; // WHO Plan B: 75 mL/kg over 4 hours
  const orsSyringePer3MinMl = orsPlanB4hTotalMl / 80; // 80 intervals of 3 minutes in 4 hours
  const minExpectedUrineMlPerHr = 1.5 * w;
  const minWetDiapersPer24h = w < 10 ? 6 : 4;

  return {
    hourlyMaintMl: Math.round(hourlyMaintMl * 10) / 10,
    dailyMaintMl: Math.round(dailyMaintMl),
    orsPlanB4hTotalMl: Math.round(orsPlanB4hTotalMl),
    orsSyringePer3MinMl: Math.round(orsSyringePer3MinMl * 10) / 10,
    minExpectedUrineMlPerHr: Math.round(minExpectedUrineMlPerHr * 10) / 10,
    minWetDiapersPer24h,
  };
}

/**
 * Complete Pediatric Dosing Audit + Syringe Sizing + 24h Bateman PK Superposition
 */
export function calculatePediatricMedicationPlan({
  drugId,
  concentrationId,
  weightKg,
  ageMonths,
  priorDoses = [], // [{ timeHr, doseMg }]
  syringeCapacityMl = 5,
}) {
  const drug = PEDIATRIC_DRUG_FORMULARY[drugId] || PEDIATRIC_DRUG_FORMULARY.acetaminophen;
  const conc = drug.concentrations.find((c) => c.id === concentrationId) || drug.concentrations[0];
  const w = Math.max(1.5, Number(weightKg) || 5);
  const ageM = Math.max(0, Number(ageMonths) || 0);

  const sanity = checkAgeWeightSanity(ageM, w);
  const mgPerMl = conc.mg / conc.ml;

  // Hard age contraindication shield
  let allowed = true;
  let blockReason = '';
  if (drug.id === 'ibuprofen' && ageM < 6) {
    allowed = false;
    blockReason = 'HARD CLINICAL BLOCK: Ibuprofen is contraindicated under 6 months of age (neonatal renal prostaglandin & GI bleeding risk). Switch to clinician-guided Acetaminophen.';
  } else if (drug.id === 'diphenhydramine' && ageM < 24) {
    allowed = false;
    blockReason = 'HARD CLINICAL BLOCK: Diphenhydramine should not be given under 2 years of age without direct emergency physician direction.';
  } else if (drug.id === 'cetirizine' && ageM < 6) {
    allowed = false;
    blockReason = 'HARD CLINICAL BLOCK: Cetirizine is not approved for infants under 6 months without pediatric allergist supervision.';
  } else if (drug.id === 'acetaminophen' && ageM < 3) {
    blockReason = 'INFANT < 3 MONTHS NOTICE: Fever >= 38.0°C (100.4°F) in an infant under 3 months requires immediate medical evaluation BEFORE masking fever with acetaminophen.';
  }

  const singleDoseMinMg = Math.min(drug.minMgPerKg * w, drug.maxSingleMg);
  const singleDoseTargetMg = Math.min(drug.targetMgPerKg * w, drug.maxSingleMg);
  const maxDaily24hMg = Math.min(drug.maxDailyMgPerKg * w, drug.maxDailyAbsMg);

  const rawTargetMl = singleDoseTargetMg / mgPerMl;
  const targetSyringeMl = Math.round(rawTargetMl * 10) / 10;

  // Recommended oral syringe barrel size (1, 5, or 10 mL)
  const autoSyringeSizeMl = targetSyringeMl <= 1.0 ? 1 : targetSyringeMl <= 5.0 ? 5 : 10;
  const activeSyringeCapacityMl = Math.max(syringeCapacityMl, autoSyringeSizeMl);

  const totalGiven24hMg = priorDoses.reduce((acc, d) => acc + (Number(d.doseMg) || 0), 0);
  const remaining24hMg = Math.max(0, maxDaily24hMg - totalGiven24hMg);
  const exceeds24hCeiling = allowed && (totalGiven24hMg + singleDoseTargetMg) > maxDaily24hMg + 1;

  // Calculate next safe lockout time relative to latest dose
  let latestDoseHr = -99;
  for (const d of priorDoses) {
    if (d.timeHr > latestDoseHr) latestDoseHr = d.timeHr;
  }
  const nextSafeHour = latestDoseHr >= 0 ? latestDoseHr + drug.minIntervalHours : 0;

  // Simulate 24h Bateman plasma trajectory including logged doses (or 1 preview dose at t=0 if empty)
  const curveDoses = priorDoses.length > 0
    ? priorDoses
    : (allowed ? [{ timeHr: 0, doseMg: singleDoseTargetMg }] : []);

  const pkCurve = evaluateBatemanCurve({
    weightKg: w,
    doses: curveDoses,
    kaPerHr: drug.kaPerHr,
    kePerHr: drug.kePerHr,
    vdLPerKg: drug.vdLPerKg,
    bioavailability: drug.bioavailability,
    horizonHours: 24,
    stepHours: 0.25,
  });

  return {
    drug,
    concentration: conc,
    mgPerMl: Math.round(mgPerMl * 100) / 100,
    allowed,
    blockReason,
    sanity,
    singleDoseMinMg: Math.round(singleDoseMinMg),
    singleDoseTargetMg: Math.round(singleDoseTargetMg),
    maxDaily24hMg: Math.round(maxDaily24hMg),
    totalGiven24hMg: Math.round(totalGiven24hMg),
    remaining24hMg: Math.round(remaining24hMg),
    exceeds24hCeiling,
    targetSyringeMl,
    autoSyringeSizeMl,
    activeSyringeCapacityMl,
    nextSafeHour: Math.round(nextSafeHour * 10) / 10,
    pkCurve,
  };
}
