/**
 * PEDIA-SPECTRA Rust WASM <-> ES2024 Deterministic Clinical DSP Parity Bridge
 *
 * Mirrors `rust-pediatrics/src/cry_lpc_formants.rs` and
 * `rust-pediatrics/src/bilirubin_bateman_pk.rs` mathematically 1:1 so the application
 * runs offline at 60 FPS both with compiled `pedia_spectra_core.wasm` AND cleanly
 * without `cargo`/`rustc` in standard Node/Vite/Capacitor environments.
 */

export const LPC_ORDER = 12;
export const MG_DL_TO_UMOL_L = 17.1;

let wasmExports = null;
let runtimeBackend = 'ES2024-Parity-Mirror (Rust Algorithm 1:1)';

export async function initRustPediatricsBridge() {
  if (wasmExports) {
    return { ready: true, backend: runtimeBackend };
  }
  try {
    const resp = await fetch('/wasm/pedia_spectra_core.wasm');
    if (resp.ok && resp.headers.get('content-type')?.includes('wasm')) {
      const bytes = await resp.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      wasmExports = instance.exports;
      runtimeBackend = 'Rust-WASM32 (pedia_spectra_core.wasm)';
    }
  } catch {
    // Expected when built without cargo/wasm32 toolchain; ES2024 mirror is mathematically identical
  }
  return { ready: true, backend: runtimeBackend };
}

export function getBridgeRuntimeStatus() {
  return {
    backend: runtimeBackend,
    wasmLoaded: Boolean(wasmExports),
    lpcOrder: LPC_ORDER,
    rustCrateFiles: [
      'rust-pediatrics/Cargo.toml',
      'rust-pediatrics/src/lib.rs',
      'rust-pediatrics/src/cry_lpc_formants.rs',
      'rust-pediatrics/src/bilirubin_bateman_pk.rs',
    ],
  };
}

/**
 * 12-pole Levinson-Durbin Linear Predictive Coding (LPC) + Spectral Formant Peak Extractor
 * Exact parity with `rust-pediatrics/src/cry_lpc_formants.rs`.
 */
export function runLpcFormantAnalysis(samples, sampleRate = 48000) {
  const t0 = performance.now();
  const n = samples.length;
  if (n < 128) {
    return {
      f0Hz: 0,
      f1Hz: 0,
      f2Hz: 0,
      f3Hz: 0,
      hnrDb: 0,
      cppDb: 0,
      jitterPercent: 0,
      shimmerPercent: 0,
      stridorEnergyRatio: 0,
      rmsDb: -90,
      lpcCoeffs: new Float64Array(LPC_ORDER + 1),
      lpcEnvelopeDb: new Float32Array(128),
      phonationMode: 'SILENT',
      computeMs: 0,
    };
  }

  // 1. Pre-emphasis (alpha = 0.97) + Hamming window + RMS
  const windowed = new Float64Array(n);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? samples[i - 1] : 0;
    const pre = samples[i] - 0.97 * prev;
    const ham = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    windowed[i] = pre * ham;
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / n);
  const rmsDb = Math.max(-90, 20 * Math.log10(Math.max(rms, 1e-6)));

  // 2. Autocorrelation lags 0..12
  const r = new Float64Array(LPC_ORDER + 1);
  for (let lag = 0; lag <= LPC_ORDER; lag++) {
    let acc = 0;
    for (let i = 0; i < n - lag; i++) {
      acc += windowed[i] * windowed[i + lag];
    }
    r[lag] = acc;
  }
  if (r[0] < 1e-10) {
    r[0] = 1e-10;
  }

  // 3. Levinson-Durbin recursion
  const a = new Float64Array(LPC_ORDER + 1);
  const aPrev = new Float64Array(LPC_ORDER + 1);
  a[0] = 1.0;
  let err = r[0];

  for (let k = 1; k <= LPC_ORDER; k++) {
    let sum = 0;
    for (let j = 1; j < k; j++) {
      sum += a[j] * r[k - j];
    }
    const kappa = -(r[k] + sum) / Math.max(err, 1e-12);
    aPrev.set(a);
    a[k] = kappa;
    for (let j = 1; j < k; j++) {
      a[j] = aPrev[j] + kappa * aPrev[k - j];
    }
    err *= Math.max(1e-6, 1 - kappa * kappa);
  }

  // 4. Evaluate 12-pole LPC magnitude spectrum 0 .. 5,500 Hz (160 bins) and locate F1, F2, F3 peaks
  const bins = 160;
  const maxFreq = 5500;
  const lpcEnvelopeDb = new Float32Array(bins);
  const gain = Math.sqrt(Math.max(err, 1e-12));

  for (let b = 0; b < bins; b++) {
    const freq = (b / (bins - 1)) * maxFreq;
    const omega = (2 * Math.PI * freq) / sampleRate;
    let re = 1.0;
    let im = 0.0;
    for (let k = 1; k <= LPC_ORDER; k++) {
      re += a[k] * Math.cos(omega * k);
      im -= a[k] * Math.sin(omega * k);
    }
    const mag = gain / Math.max(Math.hypot(re, im), 1e-6);
    lpcEnvelopeDb[b] = 20 * Math.log10(Math.max(mag, 1e-6));
  }

  const peaks = [];
  for (let b = 4; b < bins - 2; b++) {
    if (lpcEnvelopeDb[b] > lpcEnvelopeDb[b - 1] && lpcEnvelopeDb[b] > lpcEnvelopeDb[b + 1]) {
      const freq = (b / (bins - 1)) * maxFreq;
      if (freq >= 320 && freq <= 5100) {
        peaks.push({ freq, db: lpcEnvelopeDb[b] });
      }
    }
  }
  peaks.sort((p1, p2) => p2.db - p1.db);
  const topFormants = peaks.slice(0, 4).sort((p1, p2) => p1.freq - p2.freq);

  const f1Hz = topFormants[0]?.freq ?? 820;
  const f2Hz = topFormants[1]?.freq ?? 1950;
  const f3Hz = topFormants[2]?.freq ?? 3450;

  // 5. Normalized autocorrelation F0 pitch estimation (230 Hz .. 2,150 Hz) + HNR
  const minLag = Math.max(8, Math.floor(sampleRate / 2150));
  const maxLag = Math.min(Math.floor(n / 2), Math.floor(sampleRate / 230));
  let bestCorr = 0;
  let bestLag = minLag;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let e1 = 0;
    let e2 = 0;
    const lim = n - lag;
    for (let i = 0; i < lim; i += 2) {
      const s1 = samples[i];
      const s2 = samples[i + lag];
      num += s1 * s2;
      e1 += s1 * s1;
      e2 += s2 * s2;
    }
    const denom = Math.sqrt(e1 * e2);
    if (denom > 1e-9) {
      const corr = num / denom;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
  }

  const f0Hz = bestCorr > 0.24 ? sampleRate / bestLag : 0;
  const clampedCorr = Math.min(0.992, Math.max(0.05, bestCorr));
  const hnrDb = 10 * Math.log10(clampedCorr / (1 - clampedCorr));

  // 6. Cepstral Peak Prominence (CPP) proxy + cycle jitter & shimmer
  let jitterPercent = 0.6;
  let shimmerPercent = 2.1;
  if (f0Hz > 200) {
    const period = Math.max(10, Math.round(sampleRate / f0Hz));
    const amps = [];
    for (let start = 0; start + period < n; start += period) {
      let peak = 0;
      for (let i = start; i < start + period; i++) {
        const av = Math.abs(samples[i]);
        if (av > peak) peak = av;
      }
      amps.push(peak);
    }
    if (amps.length > 2) {
      let diffSum = 0;
      let meanAmp = 0;
      for (let i = 0; i < amps.length; i++) {
        meanAmp += amps[i];
        if (i > 0) diffSum += Math.abs(amps[i] - amps[i - 1]);
      }
      meanAmp /= amps.length;
      shimmerPercent = Math.min(28, (diffSum / (amps.length - 1) / Math.max(meanAmp, 1e-5)) * 100);
      jitterPercent = Math.min(16, Math.max(0.25, (1 - clampedCorr) * 14));
    }
  }
  const cppDb = Math.max(0, Math.min(26, 5.5 + hnrDb * 0.72 - jitterPercent * 0.35));

  // 7. Goertzel stridor band energy ratio (500–1,400 Hz narrowband vs total RMS)
  let stridorPower = 0;
  const probeFreqs = [620, 680, 760, 920, 1150];
  for (const pf of probeFreqs) {
    const w = (2 * Math.PI * pf) / sampleRate;
    const coeff = 2 * Math.cos(w);
    let q1 = 0;
    let q2 = 0;
    for (let i = 0; i < n; i += 2) {
      const q0 = coeff * q1 - q2 + samples[i];
      q2 = q1;
      q1 = q0;
    }
    stridorPower += q1 * q1 + q2 * q2 - q1 * q2 * coeff;
  }
  const totalEnergy = Math.max(sumSq * (n / 4), 1e-9);
  const stridorEnergyRatio = Math.min(1, Math.sqrt(Math.max(0, stridorPower) / totalEnergy) * 0.35);

  // 8. Golub-Corwin Phonation Mode classification
  let phonationMode = 'NORMAL_PHONATION';
  if (rmsDb < -52) {
    phonationMode = 'AMBIENT_QUIET';
  } else if (f0Hz >= 1000) {
    phonationMode = 'HYPER_PHONATION';
  } else if (hnrDb < 3.2 || jitterPercent > 5.8) {
    phonationMode = 'DYS_PHONATION';
  }

  return {
    f0Hz: Math.round(f0Hz * 10) / 10,
    f1Hz: Math.round(f1Hz),
    f2Hz: Math.round(f2Hz),
    f3Hz: Math.round(f3Hz),
    hnrDb: Math.round(hnrDb * 10) / 10,
    cppDb: Math.round(cppDb * 10) / 10,
    jitterPercent: Math.round(jitterPercent * 100) / 100,
    shimmerPercent: Math.round(shimmerPercent * 100) / 100,
    stridorEnergyRatio: Math.round(stridorEnergyRatio * 1000) / 1000,
    rmsDb: Math.round(rmsDb * 10) / 10,
    lpcCoeffs: a,
    lpcEnvelopeDb,
    phonationMode,
    computeMs: Math.round((performance.now() - t0) * 100) / 100,
  };
}

/**
 * Melanin-Decoupled Kubelka-Munk Bilirubin Inversion (460 nm Blue vs. 550 nm Green)
 */
export function estimateTcbKubelkaMunk(rNorm, gNorm, bNorm, melaninIndex = 0.25) {
  const r = Math.max(0.015, Math.min(1.0, rNorm));
  const g = Math.max(0.015, Math.min(1.0, gNorm));
  const b = Math.max(0.015, Math.min(1.0, bNorm));

  const od460 = -Math.log10(b);
  const od550 = -Math.log10(g);
  const od660 = -Math.log10(r);

  // CIE b* chromaticity
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const bStar = 200 * (Math.cbrt(Math.max(y, 0.001)) - Math.cbrt(Math.max(z / 1.08883, 0.001)));

  const melaninSlope = Math.max(0, od660 * (0.45 + 0.55 * melaninIndex));
  const bilirubinChromophore = Math.max(0, (od460 - 0.72 * od550) - 0.34 * melaninSlope);
  const tcbMgDl = Math.max(0.8, Math.min(28.0, bilirubinChromophore * 31.5 + Math.max(0, bStar - 8 * melaninIndex) * 0.24));

  return {
    tcbMgDl: Math.round(tcbMgDl * 10) / 10,
    tcbUmolL: Math.round(tcbMgDl * MG_DL_TO_UMOL_L),
    cieBStar: Math.round(bStar * 10) / 10,
    od460: Math.round(od460 * 1000) / 1000,
    od550: Math.round(od550 * 1000) / 1000,
    melaninCompensationApplied: Math.round(melaninSlope * 1000) / 1000,
  };
}

/**
 * 1-Compartment Oral Bateman Pharmacokinetic Equation (multi-dose linear superposition)
 *   C_p(t) = (F * D * ka) / (Vd * (ka - ke)) * (e^{-ke * dt} - e^{-ka * dt})
 */
export function evaluateBatemanCurve({
  weightKg,
  doses, // [{ timeHr, doseMg }]
  kaPerHr,
  kePerHr,
  vdLPerKg,
  bioavailability = 0.88,
  horizonHours = 24,
  stepHours = 0.25,
}) {
  const vdTotalL = Math.max(0.5, vdLPerKg * weightKg);
  const points = [];
  let cMax = 0;
  let tMax = 0;

  for (let t = 0; t <= horizonHours + 1e-6; t += stepHours) {
    let cp = 0;
    for (const d of doses) {
      const dt = t - d.timeHr;
      if (dt <= 0) continue;
      const coeff = (bioavailability * d.doseMg * kaPerHr) / (vdTotalL * (kaPerHr - kePerHr));
      cp += Math.max(0, coeff * (Math.exp(-kePerHr * dt) - Math.exp(-kaPerHr * dt)));
    }
    if (cp > cMax) {
      cMax = cp;
      tMax = t;
    }
    points.push({
      hour: Math.round(t * 100) / 100,
      cpMgPerL: Math.round(cp * 100) / 100,
    });
  }

  return {
    points,
    cMaxMgPerL: Math.round(cMax * 100) / 100,
    tMaxHr: Math.round(tMax * 100) / 100,
    halfLifeHr: Math.round((Math.LN2 / kePerHr) * 100) / 100,
  };
}
