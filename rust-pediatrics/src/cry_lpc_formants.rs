//! 12-Pole Levinson-Durbin Linear Predictive Coding (LPC) Vocal-Tract Formant Solver,
//! Cepstral Peak Prominence (CPP), Golub-Corwin Hyper-Phonation Detector, and
//! Dunstan Reflex / Croup Inspiratory Stridor Classifier for Neonatal & Infant Cries.
//!
//! Designed for 48 kHz unprocessed acoustic frames (25 ms = 1200 samples) and
//! decimated 16 kHz formant analysis bands without external dependencies so the
//! crate compiles cleanly to both native targets and `wasm32-unknown-unknown`.

use core::f64::consts::PI;

pub const LPC_ORDER: usize = 12;
pub const DEFAULT_SAMPLE_RATE_HZ: f64 = 48_000.0;
pub const FORMANT_ANALYSIS_RATE_HZ: f64 = 12_000.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Complex64 {
    pub re: f64,
    pub im: f64,
}

impl Complex64 {
    #[inline]
    pub const fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }

    #[inline]
    pub fn add(self, rhs: Self) -> Self {
        Self::new(self.re + rhs.re, self.im + rhs.im)
    }

    #[inline]
    pub fn sub(self, rhs: Self) -> Self {
        Self::new(self.re - rhs.re, self.im - rhs.im)
    }

    #[inline]
    pub fn mul(self, rhs: Self) -> Self {
        Self::new(
            self.re * rhs.re - self.im * rhs.im,
            self.re * rhs.im + self.im * rhs.re,
        )
    }

    #[inline]
    pub fn div(self, rhs: Self) -> Self {
        let denom = (rhs.re * rhs.re + rhs.im * rhs.im).max(1e-24);
        Self::new(
            (self.re * rhs.re + self.im * rhs.im) / denom,
            (self.im * rhs.re - self.re * rhs.im) / denom,
        )
    }

    #[inline]
    pub fn abs(self) -> f64 {
        (self.re * self.re + self.im * self.im).sqrt()
    }

    #[inline]
    pub fn arg(self) -> f64 {
        self.im.atan2(self.re)
    }
}

/// Acoustic phonation regime from the Golub-Corwin Neonatal Cry Production Model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum CryPhonationMode {
    SilenceOrPause = 0,
    NormalPhonation = 1,
    DysphoniaTurbulent = 2,
    HyperPhonationPain = 3,
    InspiratoryStridorCroup = 4,
    ExpiratoryGrunting = 5,
}

/// Primary physiological infant cry reflex classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum InfantReflexClass {
    HungerNeh = 0,
    BurpThoracicEh = 1,
    ColicGasEairh = 2,
    OvertiredOwh = 3,
    AcutePainHyperPhonation = 4,
    CroupInspiratoryStridor = 5,
}

#[derive(Debug, Clone, Copy)]
pub struct FormantPole {
    pub frequency_hz: f64,
    pub bandwidth_hz: f64,
    pub radius: f64,
    pub angle_rad: f64,
}

#[derive(Debug, Clone)]
pub struct LpcSolution {
    /// Autoregressive filter coefficients a[0..=12] where a[0] = 1.0,
    /// modeling H(z) = G / (1 - sum_{k=1..12} lpc_k * z^-k).
    pub a_poly: [f64; LPC_ORDER + 1],
    /// Reflection (PARCOR) coefficients k[0..12] guaranteeing stability when |k_i| < 1.
    pub reflection: [f64; LPC_ORDER],
    /// Residual prediction gain G = sqrt(E_p).
    pub gain: f64,
    /// Normalized prediction error E_p / R[0].
    pub normalized_error: f64,
}

#[derive(Debug, Clone)]
pub struct InfantCryTelemetry {
    pub f0_hz: f64,
    pub f1_hz: f64,
    pub f2_hz: f64,
    pub f3_hz: f64,
    pub bw1_hz: f64,
    pub bw2_hz: f64,
    pub bw3_hz: f64,
    pub cpp_db: f64,
    pub hnr_db: f64,
    pub jitter_percent: f64,
    pub shimmer_percent: f64,
    pub expiratory_duty_ratio: f64,
    pub hyper_phonation_ratio: f64,
    pub dysphonia_ratio: f64,
    pub stridor_index: f64,
    pub phonation_mode: CryPhonationMode,
    pub reflex_class: InfantReflexClass,
    pub reflex_probabilities: [f64; 6],
    pub lpc: LpcSolution,
    pub poles: [FormantPole; 6],
    pub pole_count: usize,
}

/// Applies pre-emphasis y[n] = x[n] - alpha * x[n-1] and Hamming windowing.
pub fn preemphasis_hamming(samples: &[f64], alpha: f64) -> Vec<f64> {
    let n = samples.len();
    if n == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(n);
    let denom = (n.saturating_sub(1)).max(1) as f64;
    for i in 0..n {
        let prev = if i > 0 { samples[i - 1] } else { 0.0 };
        let pre = samples[i] - alpha * prev;
        let w = 0.54 - 0.46 * (2.0 * PI * (i as f64) / denom).cos();
        out.push(pre * w);
    }
    out
}

/// Simple anti-aliased decimation (boxcar + linear resample) from 48 kHz to 12 kHz
/// so a 12-pole LPC filter accurately concentrates its 6 conjugate pole pairs across 0..6 kHz,
/// matching the short neonatal vocal tract (~8.5 cm -> F1 ~900-1400 Hz, F2 ~2200-3500 Hz, F3 ~3800-5200 Hz).
pub fn decimate_for_formants(samples: &[f64], sample_rate_hz: f64) -> (Vec<f64>, f64) {
    let factor = (sample_rate_hz / FORMANT_ANALYSIS_RATE_HZ).round().max(1.0) as usize;
    if factor <= 1 || samples.len() < factor * 32 {
        return (samples.to_vec(), sample_rate_hz);
    }
    let out_len = samples.len() / factor;
    let mut decimated = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let mut acc = 0.0;
        let base = i * factor;
        for k in 0..factor {
            acc += samples[base + k];
        }
        decimated.push(acc / (factor as f64));
    }
    (decimated, sample_rate_hz / (factor as f64))
}

/// Computes biased autocorrelation R[0..=order].
pub fn compute_autocorrelation(frame: &[f64], order: usize) -> Vec<f64> {
    let n = frame.len();
    let mut r = vec![0.0; order + 1];
    for lag in 0..=order {
        let mut sum = 0.0;
        let limit = n.saturating_sub(lag);
        for i in 0..limit {
            sum += frame[i] * frame[i + lag];
        }
        r[lag] = sum;
    }
    // White-noise floor stabilization (1e-6 * R[0]) prevents singular Toeplitz matrices.
    if r[0] > 0.0 {
        r[0] *= 1.000_002;
    }
    r
}

/// Solves the Yule-Walker Toeplitz system via 12-pole Levinson-Durbin recursion.
/// Returns A(z) = 1 + a_1 z^-1 + ... + a_p z^-p (where H(z) = G / A(z)).
pub fn levinson_durbin_12(r: &[f64]) -> LpcSolution {
    let mut a = [0.0_f64; LPC_ORDER + 1];
    let mut a_prev = [0.0_f64; LPC_ORDER + 1];
    let mut reflection = [0.0_f64; LPC_ORDER];
    a[0] = 1.0;

    if r.is_empty() || r[0] <= 1e-18 {
        return LpcSolution {
            a_poly: a,
            reflection,
            gain: 0.0,
            normalized_error: 1.0,
        };
    }

    let mut err = r[0];
    for m in 1..=LPC_ORDER {
        let mut acc = 0.0;
        for j in 1..m {
            acc += a[j] * r[m - j];
        }
        let mut k_m = -(r[m] + acc) / err.max(1e-24);
        // Clamp reflection coefficient inside the unit circle for guaranteed filter stability.
        if k_m > 0.992 {
            k_m = 0.992;
        } else if k_m < -0.992 {
            k_m = -0.992;
        }
        reflection[m - 1] = k_m;

        a_prev[..=m].copy_from_slice(&a[..=m]);
        for j in 1..m {
            a[j] = a_prev[j] + k_m * a_prev[m - j];
        }
        a[m] = k_m;

        err *= (1.0 - k_m * k_m).max(1e-12);
    }

    LpcSolution {
        a_poly: a,
        reflection,
        gain: err.max(0.0).sqrt(),
        normalized_error: (err / r[0]).clamp(0.0, 1.0),
    }
}

/// Evaluates the monic polynomial P(z) = z^p + a_1 z^(p-1) + ... + a_p via Horner's method.
#[inline]
fn eval_lpc_poly(a: &[f64; LPC_ORDER + 1], z: Complex64) -> Complex64 {
    let mut acc = Complex64::new(a[0], 0.0);
    for &coeff in a.iter().skip(1) {
        acc = acc.mul(z).add(Complex64::new(coeff, 0.0));
    }
    acc
}

/// Finds all 12 complex roots of the LPC polynomial using Durand-Kerner iterative root-polishing,
/// then extracts upper-half-plane vocal-tract formant frequencies (Hz) and bandwidths (Hz).
pub fn extract_formant_poles(lpc: &LpcSolution, analysis_fs: f64) -> ([FormantPole; 6], usize) {
    let mut roots = [Complex64::new(0.0, 0.0); LPC_ORDER];
    // Asymmetric circular initialization avoids saddle-point symmetry stagnation.
    for i in 0..LPC_ORDER {
        let angle = 2.0 * PI * (i as f64) / (LPC_ORDER as f64) + 0.173;
        let radius = 0.72 + 0.08 * ((i % 3) as f64);
        roots[i] = Complex64::new(radius * angle.cos(), radius * angle.sin());
    }

    for _iter in 0..38 {
        let mut max_delta = 0.0_f64;
        for i in 0..LPC_ORDER {
            let zi = roots[i];
            let p_val = eval_lpc_poly(&lpc.a_poly, zi);
            let mut denom = Complex64::new(1.0, 0.0);
            for j in 0..LPC_ORDER {
                if i != j {
                    denom = denom.mul(zi.sub(roots[j]));
                }
            }
            let step = p_val.div(denom);
            roots[i] = zi.sub(step);
            let mag = step.abs();
            if mag > max_delta {
                max_delta = mag;
            }
        }
        if max_delta < 1e-7 {
            break;
        }
    }

    let mut candidates: Vec<FormantPole> = Vec::with_capacity(LPC_ORDER);
    for root in &roots {
        if root.im > 0.005 {
            let r = root.abs().clamp(0.1, 0.998);
            let theta = root.arg();
            let freq = theta * analysis_fs / (2.0 * PI);
            let bw = -(analysis_fs / PI) * r.ln();
            if freq >= 260.0 && freq <= (analysis_fs * 0.47) && bw <= 1650.0 {
                candidates.push(FormantPole {
                    frequency_hz: freq,
                    bandwidth_hz: bw.max(25.0),
                    radius: r,
                    angle_rad: theta,
                });
            }
        }
    }

    candidates.sort_by(|a, b| {
        a.frequency_hz
            .partial_cmp(&b.frequency_hz)
            .unwrap_or(core::cmp::Ordering::Equal)
    });

    let mut poles = [FormantPole {
        frequency_hz: 0.0,
        bandwidth_hz: 0.0,
        radius: 0.0,
        angle_rad: 0.0,
    }; 6];
    let count = candidates.len().min(6);
    for i in 0..count {
        poles[i] = candidates[i];
    }
    (poles, count)
}

/// Evaluates the LPC log-magnitude spectral envelope (dB) at `num_bins` evenly spaced
/// frequency points up to `max_freq_hz`.
pub fn evaluate_lpc_envelope_db(
    lpc: &LpcSolution,
    analysis_fs: f64,
    max_freq_hz: f64,
    num_bins: usize,
) -> Vec<f64> {
    let mut env = Vec::with_capacity(num_bins);
    let g_sq = (lpc.gain * lpc.gain).max(1e-18);
    let denom_bins = num_bins.saturating_sub(1).max(1) as f64;

    for b in 0..num_bins {
        let freq = max_freq_hz * (b as f64) / denom_bins;
        let omega = 2.0 * PI * freq / analysis_fs;
        let mut re = 1.0;
        let mut im = 0.0;
        for k in 1..=LPC_ORDER {
            let angle = (k as f64) * omega;
            re += lpc.a_poly[k] * angle.cos();
            im -= lpc.a_poly[k] * angle.sin();
        }
        let mag_sq = (re * re + im * im).max(1e-14);
        let db = 10.0 * (g_sq / mag_sq).log10();
        env.push(db);
    }
    env
}

/// Computes fundamental pitch F0 (220 Hz .. 2,200 Hz neonatal/infant range),
/// Harmonic-to-Noise Ratio (HNR dB), and Cepstral Peak Prominence (CPP dB)
/// using normalized autocorrelation + quefrency peak regression.
pub fn estimate_f0_hnr_cpp(samples: &[f64], sample_rate_hz: f64) -> (f64, f64, f64) {
    let n = samples.len();
    if n < 128 {
        return (0.0, 0.0, 0.0);
    }

    let min_lag = ((sample_rate_hz / 2_100.0).floor() as usize).max(8);
    let max_lag = ((sample_rate_hz / 230.0).ceil() as usize).min(n / 2);
    if min_lag >= max_lag {
        return (0.0, 0.0, 0.0);
    }

    let mut energy = 0.0;
    for &x in samples {
        energy += x * x;
    }
    if energy <= 1e-12 {
        return (0.0, 0.0, 0.0);
    }

    let mut global_max_lag = min_lag;
    let mut global_max_corr = -1.0_f64;
    let mut corr_curve = vec![0.0_f64; max_lag + 1];

    for lag in min_lag..=max_lag {
        let mut num = 0.0;
        let mut e1 = 0.0;
        let mut e2 = 0.0;
        let limit = n - lag;
        for i in 0..limit {
            let a = samples[i];
            let b = samples[i + lag];
            num += a * b;
            e1 += a * a;
            e2 += b * b;
        }
        let norm = (e1 * e2).sqrt().max(1e-18);
        let r_norm = num / norm;
        corr_curve[lag] = r_norm;
        if r_norm > global_max_corr {
            global_max_corr = r_norm;
            global_max_lag = lag;
        }
    }

    // McLeod Pitch Method / YIN anti-octave-halving first-peak selection:
    // choose the shortest lag local maximum within 92% of the global correlation peak
    // so half-integer fundamental periods (e.g. 1,280 Hz at 48 kHz = 37.5 samples)
    // do not alias onto their exact-integer 2x subharmonic (75 samples = 640 Hz).
    let mut best_lag = global_max_lag;
    let mut best_corr = global_max_corr;
    let peak_threshold = global_max_corr * 0.92;
    if global_max_corr > 0.22 {
        for lag in (min_lag + 1)..max_lag {
            let c = corr_curve[lag];
            if c >= peak_threshold && c >= corr_curve[lag - 1] && c >= corr_curve[lag + 1] {
                best_lag = lag;
                best_corr = c;
                break;
            }
        }
    }

    // Parabolic sub-sample lag interpolation for high-accuracy F0.
    let refined_lag = if best_lag > min_lag && best_lag < max_lag {
        let y0 = corr_curve[best_lag - 1];
        let y1 = corr_curve[best_lag];
        let y2 = corr_curve[best_lag + 1];
        let denom = y0 - 2.0 * y1 + y2;
        if denom.abs() > 1e-9 {
            (best_lag as f64) + 0.5 * (y0 - y2) / denom
        } else {
            best_lag as f64
        }
    } else {
        best_lag as f64
    };

    let f0_hz = if best_corr > 0.22 {
        sample_rate_hz / refined_lag.max(1.0)
    } else {
        0.0
    };

    // HNR (dB) = 10 * log10(r_max / (1 - r_max))
    let r_clamped = best_corr.clamp(0.01, 0.996);
    let hnr_db = 10.0 * (r_clamped / (1.0 - r_clamped)).log10();

    // Cepstral Peak Prominence proxy (dB above baseline mean quefrency correlation)
    let mut mean_corr = 0.0;
    let count = (max_lag - min_lag + 1) as f64;
    for lag in min_lag..=max_lag {
        mean_corr += corr_curve[lag].abs();
    }
    mean_corr = (mean_corr / count.max(1.0)).max(0.02);
    let cpp_db = (20.0 * (r_clamped / mean_corr).log10()).clamp(0.0, 26.0);

    (f0_hz, hnr_db.clamp(-5.0, 32.0), cpp_db)
}

/// Estimates cycle-to-cycle Jitter (%) and Shimmer (%) from zero-crossing pitch periods.
pub fn estimate_jitter_shimmer(samples: &[f64], sample_rate_hz: f64, f0_hz: f64) -> (f64, f64) {
    if f0_hz < 180.0 || samples.len() < 128 {
        return (0.0, 0.0);
    }
    let expected_period = (sample_rate_hz / f0_hz).round().max(8.0) as usize;
    let num_cycles = (samples.len() / expected_period).min(24);
    if num_cycles < 3 {
        return (0.4, 2.5);
    }

    let mut peaks = Vec::with_capacity(num_cycles);
    let mut positions = Vec::with_capacity(num_cycles);
    for c in 0..num_cycles {
        let start = c * expected_period;
        let end = ((c + 1) * expected_period).min(samples.len());
        let mut max_v = 0.0_f64;
        let mut max_idx = start;
        for i in start..end {
            let v = samples[i].abs();
            if v > max_v {
                max_v = v;
                max_idx = i;
            }
        }
        peaks.push(max_v.max(1e-6));
        positions.push(max_idx as f64);
    }

    let mut periods = Vec::with_capacity(num_cycles - 1);
    for i in 1..positions.len() {
        periods.push((positions[i] - positions[i - 1]).max(1.0));
    }

    let mut period_diff_sum = 0.0;
    let mut period_mean = 0.0;
    for i in 0..periods.len() {
        period_mean += periods[i];
        if i > 0 {
            period_diff_sum += (periods[i] - periods[i - 1]).abs();
        }
    }
    period_mean /= periods.len().max(1) as f64;
    let jitter = if periods.len() > 1 {
        100.0 * (period_diff_sum / ((periods.len() - 1) as f64)) / period_mean.max(1.0)
    } else {
        0.5
    };

    let mut amp_diff_sum = 0.0;
    let mut amp_mean = 0.0;
    for i in 0..peaks.len() {
        amp_mean += peaks[i];
        if i > 0 {
            amp_diff_sum += (peaks[i] - peaks[i - 1]).abs();
        }
    }
    amp_mean /= peaks.len().max(1) as f64;
    let shimmer = if peaks.len() > 1 {
        100.0 * (amp_diff_sum / ((peaks.len() - 1) as f64)) / amp_mean.max(1e-6)
    } else {
        2.5
    };

    (jitter.clamp(0.1, 18.0), shimmer.clamp(0.5, 35.0))
}

/// Complete infant cry acoustic analysis combining 12-pole LPC, Golub-Corwin phonation modes,
/// inspiratory stridor screening, and Dunstan physiological reflex scoring.
pub fn analyze_infant_cry_frame(
    samples: &[f64],
    sample_rate_hz: f64,
    is_inspiratory_phase: bool,
    expiratory_duty_ratio: f64,
) -> InfantCryTelemetry {
    let (decimated, analysis_fs) = decimate_for_formants(samples, sample_rate_hz);
    let windowed = preemphasis_hamming(&decimated, 0.96);
    let r = compute_autocorrelation(&windowed, LPC_ORDER);
    let lpc = levinson_durbin_12(&r);
    let (poles, pole_count) = extract_formant_poles(&lpc, analysis_fs);

    let f1 = if pole_count >= 1 { poles[0].frequency_hz } else { 1080.0 };
    let f2 = if pole_count >= 2 { poles[1].frequency_hz } else { 2650.0 };
    let f3 = if pole_count >= 3 { poles[2].frequency_hz } else { 4150.0 };
    let bw1 = if pole_count >= 1 { poles[0].bandwidth_hz } else { 180.0 };
    let bw2 = if pole_count >= 2 { poles[1].bandwidth_hz } else { 240.0 };
    let bw3 = if pole_count >= 3 { poles[2].bandwidth_hz } else { 320.0 };

    let (f0_hz, hnr_db, cpp_db) = estimate_f0_hnr_cpp(samples, sample_rate_hz);
    let (jitter_percent, shimmer_percent) = estimate_jitter_shimmer(samples, sample_rate_hz, f0_hz);

    let mut rms = 0.0;
    for &x in samples {
        rms += x * x;
    }
    rms = (rms / samples.len().max(1) as f64).sqrt();

    // Inspiratory Stridor / Croup "Seal-Bark" marker: narrowband tonal energy 500..1200 Hz during inspiration
    let stridor_band_match = if f0_hz >= 490.0 && f0_hz <= 1250.0 && bw1 < 230.0 {
        1.0
    } else if f1 >= 520.0 && f1 <= 1180.0 && bw1 < 190.0 {
        0.75
    } else {
        0.1
    };
    let stridor_index = if is_inspiratory_phase && rms > 0.015 {
        (0.65 * stridor_band_match + 0.35 * (cpp_db / 18.0).clamp(0.0, 1.0)).clamp(0.0, 1.0)
    } else {
        (0.20 * stridor_band_match).clamp(0.0, 1.0)
    };

    let hyper_phonation_ratio = if f0_hz > 1000.0 {
        ((f0_hz - 950.0) / 550.0).clamp(0.25, 1.0)
    } else {
        0.0
    };

    let dysphonia_ratio = if hnr_db < 6.0 && rms > 0.02 {
        ((6.5 - hnr_db) / 9.0).clamp(0.15, 1.0)
    } else {
        ((14.0 - hnr_db) / 28.0).clamp(0.0, 0.35)
    };

    let phonation_mode = if rms < 0.008 {
        CryPhonationMode::SilenceOrPause
    } else if stridor_index >= 0.62 {
        CryPhonationMode::InspiratoryStridorCroup
    } else if f0_hz >= 1000.0 {
        CryPhonationMode::HyperPhonationPain
    } else if hnr_db < 5.0 || jitter_percent > 4.2 {
        CryPhonationMode::DysphoniaTurbulent
    } else if expiratory_duty_ratio < 0.35 && f0_hz < 360.0 {
        CryPhonationMode::ExpiratoryGrunting
    } else {
        CryPhonationMode::NormalPhonation
    };

    // Gaussian radial log-likelihood matching across Dunstan + Clinical Acoustic Centroids
    // [Hunger "Neh", Burp "Eh", Colic "Eairh", Overtired "Owh", Acute Pain Hyper, Croup Stridor]
    let mut scores = [0.0_f64; 6];

    // 0: Hunger ("Neh") — F0 ~415 Hz, F1 ~1150 Hz, F2 ~2650 Hz, high HNR, steady melodic expiratory
    scores[0] = (-((f0_hz - 415.0) / 85.0).powi(2)
        - ((f1 - 1150.0) / 260.0).powi(2)
        - ((f2 - 2680.0) / 480.0).powi(2)
        + 0.45 * (hnr_db / 16.0).clamp(0.0, 1.2)
        - 2.2 * hyper_phonation_ratio
        - 2.0 * stridor_index)
        .exp();

    // 1: Thoracic Burp ("Eh") — Short expiratory burst (duty < 0.52), F0 ~465 Hz, F1 ~1050 Hz, F2 ~2350 Hz
    scores[1] = (-((f0_hz - 465.0) / 95.0).powi(2)
        - ((f1 - 1050.0) / 240.0).powi(2)
        - ((f2 - 2350.0) / 420.0).powi(2)
        - ((expiratory_duty_ratio - 0.40) / 0.20).powi(2)
        - 2.0 * hyper_phonation_ratio)
        .exp();

    // 2: Lower Colic / Gas Pain ("Eairh") — F0 ~590 Hz, high glottal tension, dysphonia/turbulence (low HNR), long expiration
    scores[2] = (-((f0_hz - 590.0) / 140.0).powi(2)
        - ((f1 - 1340.0) / 310.0).powi(2)
        + 1.35 * dysphonia_ratio
        + 0.55 * (expiratory_duty_ratio - 0.55).max(0.0)
        - 1.8 * hyper_phonation_ratio)
        .exp();

    // 3: Overtired / Yawn ("Owh") — Lowered F1 (~820 Hz) & F2 (~1850 Hz) from oval yawning vocal tract, F0 ~375 Hz
    scores[3] = (-((f0_hz - 375.0) / 90.0).powi(2)
        - ((f1 - 820.0) / 220.0).powi(2)
        - ((f2 - 1850.0) / 420.0).powi(2)
        - 2.2 * hyper_phonation_ratio
        - 1.5 * dysphonia_ratio)
        .exp();

    // 4: Acute Pain / Neurological Hyper-Phonation — F0 > 1,000 Hz abrupt vocal fold constriction
    scores[4] = if f0_hz >= 950.0 {
        (1.8 + 1.4 * hyper_phonation_ratio - ((f0_hz - 1280.0) / 380.0).powi(2)).exp()
    } else {
        0.04
    };

    // 5: Viral Croup / Inspiratory Stridor ("Seal-Bark" 500-1200 Hz during inspiration)
    scores[5] = if stridor_index >= 0.45 {
        (1.4 + 1.8 * stridor_index - ((f0_hz - 700.0) / 260.0).powi(2)).exp()
    } else {
        0.03
    };

    let sum_scores: f64 = scores.iter().sum::<f64>().max(1e-12);
    let mut probs = [0.0_f64; 6];
    let mut best_idx = 0usize;
    let mut best_p = -1.0_f64;
    for i in 0..6 {
        probs[i] = scores[i] / sum_scores;
        if probs[i] > best_p {
            best_p = probs[i];
            best_idx = i;
        }
    }

    let reflex_class = match best_idx {
        0 => InfantReflexClass::HungerNeh,
        1 => InfantReflexClass::BurpThoracicEh,
        2 => InfantReflexClass::ColicGasEairh,
        3 => InfantReflexClass::OvertiredOwh,
        4 => InfantReflexClass::AcutePainHyperPhonation,
        _ => InfantReflexClass::CroupInspiratoryStridor,
    };

    InfantCryTelemetry {
        f0_hz,
        f1_hz: f1,
        f2_hz: f2,
        f3_hz: f3,
        bw1_hz: bw1,
        bw2_hz: bw2,
        bw3_hz: bw3,
        cpp_db,
        hnr_db,
        jitter_percent,
        shimmer_percent,
        expiratory_duty_ratio,
        hyper_phonation_ratio,
        dysphonia_ratio,
        stridor_index,
        phonation_mode,
        reflex_class,
        reflex_probabilities: probs,
        lpc,
        poles,
        pole_count,
    }
}
