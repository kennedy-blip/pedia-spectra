//! Melanin-Decoupled Kubelka-Munk Transcutaneous Bilirubin (TcB) Optical Inversion,
//! 2022 AAP Hour-Specific Bhutani Phototherapy & Exchange-Transfusion Spline Evaluator,
//! and 1-Compartment Bateman Pediatric Pharmacokinetic Superposition Solver.

pub const MG_DL_TO_UMOL_L: f64 = 17.1;

#[derive(Debug, Clone, Copy)]
pub struct RgbSample {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct BilirubinOpticalResult {
    pub od_melanin: f64,
    pub od_bilirubin_raw: f64,
    pub od_bilirubin_compensated: f64,
    pub cie_b_star: f64,
    pub tcb_mg_dl: f64,
    pub tcb_umol_l: f64,
    pub estimated_kramer_zone: u8,
    pub melanin_compensation_factor: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum BhutaniRiskZone {
    LowRisk = 0,
    LowIntermediate = 1,
    HighIntermediate = 2,
    HighRiskAbove95th = 3,
    ExceedsPhototherapy = 4,
    ExceedsExchangeTransfusion = 5,
}

#[derive(Debug, Clone, Copy)]
pub struct AapBhutaniEvaluation {
    pub postnatal_hours: f64,
    pub gestational_weeks: u8,
    pub has_neurotoxicity_risk: bool,
    pub tcb_mg_dl: f64,
    pub tcb_umol_l: f64,
    pub phototherapy_threshold_mg_dl: f64,
    pub exchange_threshold_mg_dl: f64,
    pub escalation_of_care_mg_dl: f64,
    pub bhutani_40th_mg_dl: f64,
    pub bhutani_75th_mg_dl: f64,
    pub bhutani_95th_mg_dl: f64,
    pub delta_below_photo_mg_dl: f64,
    pub rate_of_rise_mg_dl_per_hr: f64,
    pub hemolysis_velocity_alert: bool,
    pub risk_zone: BhutaniRiskZone,
}

/// Converts normalized linear sRGB to approximate CIE L*a*b* b* yellowness channel (D65).
pub fn rgb_to_cie_b_star(sample: RgbSample, white_ref: RgbSample) -> f64 {
    let r = (sample.r / white_ref.r.max(0.05)).clamp(0.001, 1.2);
    let g = (sample.g / white_ref.g.max(0.05)).clamp(0.001, 1.2);
    let b = (sample.b / white_ref.b.max(0.05)).clamp(0.001, 1.2);

    // sRGB -> CIE XYZ (D65)
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = 0.0193 * r + 0.1192 * g + 0.9505 * b;

    let yn = 1.0;
    let zn = 1.08883;

    let f = |t: f64| -> f64 {
        if t > 0.008856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };

    200.0 * (f(y / yn) - f(z / zn))
}

/// Solves two-chromophore (Bilirubin 460 nm + Melanin 650 nm) Modified Beer-Lambert /
/// Kubelka-Munk optical density inversion for unbiased TcB estimation across Fitzpatrick I-VI.
pub fn invert_kubelka_munk_bilirubin(
    skin: RgbSample,
    white_ref: RgbSample,
    fitzpatrick_type: u8,
    is_sclera_mode: bool,
) -> BilirubinOpticalResult {
    let r_norm = (skin.r / white_ref.r.max(0.05)).clamp(0.015, 1.05);
    let g_norm = (skin.g / white_ref.g.max(0.05)).clamp(0.015, 1.05);
    let b_norm = (skin.b / white_ref.b.max(0.05)).clamp(0.010, 1.05);

    // Red-channel reflectance primarily tracks epidermal melanin (negligible bilirubin absorption at 650 nm)
    let od_melanin = -r_norm.log10();

    // Blue (460 nm) vs Green (550 nm) differential optical density isolates bilirubin chromophore
    let od_bilirubin_raw = (g_norm / b_norm).log10();

    // Fitzpatrick-informed melanin scattering cross-talk coefficient k_mel
    let k_mel = if is_sclera_mode {
        0.04
    } else {
        match fitzpatrick_type {
            1 => 0.16,
            2 => 0.19,
            3 => 0.23,
            4 => 0.27,
            5 => 0.31,
            _ => 0.35,
        }
    };

    let od_bilirubin_compensated = (od_bilirubin_raw - k_mel * od_melanin).max(0.0);
    let cie_b_star = rgb_to_cie_b_star(skin, white_ref);

    // Calibrated optical transfer curve to mg/dL (0..25 mg/dL clinical span)
    let tcb_mg_dl = if is_sclera_mode {
        (0.55 * cie_b_star.max(0.0) + 18.0 * od_bilirubin_compensated - 0.8).clamp(0.4, 24.0)
    } else {
        (41.5 * od_bilirubin_compensated + 0.12 * cie_b_star.max(0.0) + 0.6).clamp(0.5, 25.0)
    };

    let estimated_kramer_zone = if tcb_mg_dl < 6.0 {
        1
    } else if tcb_mg_dl < 10.0 {
        2
    } else if tcb_mg_dl < 13.0 {
        3
    } else if tcb_mg_dl < 15.5 {
        4
    } else {
        5
    };

    BilirubinOpticalResult {
        od_melanin,
        od_bilirubin_raw,
        od_bilirubin_compensated,
        cie_b_star,
        tcb_mg_dl,
        tcb_umol_l: tcb_mg_dl * MG_DL_TO_UMOL_L,
        estimated_kramer_zone,
        melanin_compensation_factor: k_mel,
    }
}

/// Piecewise linear interpolation over (hour, mg/dL) clinical nomogram knots.
fn interp_knots(knots: &[(f64, f64)], hour: f64) -> f64 {
    if hour <= knots[0].0 {
        return knots[0].1;
    }
    let last = knots.len() - 1;
    if hour >= knots[last].0 {
        return knots[last].1;
    }
    for i in 0..last {
        let (x0, y0) = knots[i];
        let (x1, y1) = knots[i + 1];
        if hour >= x0 && hour <= x1 {
            let t = (hour - x0) / (x1 - x0).max(1e-6);
            return y0 + t * (y1 - y0);
        }
    }
    knots[last].1
}

/// Evaluates the 2022 AAP Clinical Practice Guideline hour-specific phototherapy and
/// exchange-transfusion thresholds (0..168 hours) plus Bhutani percentile curves.
pub fn evaluate_aap_2022_bhutani(
    postnatal_hours: f64,
    tcb_mg_dl: f64,
    gestational_weeks: u8,
    has_neurotoxicity_risk: bool,
    prior_tcb_mg_dl: f64,
    prior_hours: f64,
) -> AapBhutaniEvaluation {
    let h = postnatal_hours.clamp(0.0, 168.0);
    let ga = gestational_weeks.clamp(35, 40);

    // Base AAP 2022 Phototherapy curve for >= 38w, NO neurotoxicity risk factors (Kemper et al., Pediatrics 2022)
    const PHOTO_BASE_38W_NO_RISK: [(f64, f64); 8] = [
        (0.0, 7.2),
        (12.0, 9.6),
        (24.0, 12.1),
        (36.0, 14.3),
        (48.0, 16.0),
        (72.0, 18.6),
        (96.0, 20.1),
        (168.0, 21.0),
    ];

    // Base AAP 2022 Exchange Transfusion curve for >= 38w, NO neurotoxicity risk factors
    const EXCHANGE_BASE_38W_NO_RISK: [(f64, f64); 8] = [
        (0.0, 14.5),
        (12.0, 16.5),
        (24.0, 19.0),
        (36.0, 21.2),
        (48.0, 23.0),
        (72.0, 25.0),
        (96.0, 25.8),
        (168.0, 26.0),
    ];

    // Classical Bhutani Hour-Specific Risk Track Percentiles (40th, 75th, 95th)
    const BHUTANI_40TH: [(f64, f64); 7] = [
        (0.0, 2.0),
        (12.0, 3.8),
        (24.0, 5.2),
        (48.0, 8.6),
        (72.0, 11.2),
        (96.0, 12.4),
        (168.0, 13.0),
    ];
    const BHUTANI_75TH: [(f64, f64); 7] = [
        (0.0, 3.2),
        (12.0, 5.4),
        (24.0, 7.1),
        (48.0, 11.4),
        (72.0, 14.0),
        (96.0, 15.2),
        (168.0, 15.8),
    ];
    const BHUTANI_95TH: [(f64, f64); 7] = [
        (0.0, 4.5),
        (12.0, 6.8),
        (24.0, 8.5),
        (48.0, 13.4),
        (72.0, 16.1),
        (96.0, 17.5),
        (168.0, 18.0),
    ];

    // Gestational age offset relative to >= 38w (AAP 2022 lowers thresholds ~1.2 mg/dL per week below 38w)
    let ga_offset = match ga {
        35 => -3.6,
        36 => -2.4,
        37 => -1.2,
        38 => 0.0,
        39 => 0.5,
        _ => 0.9,
    };

    // Presence of any neurotoxicity risk factor (G6PD, isoimmune hemolysis, sepsis, albumin < 3.0)
    // lowers phototherapy threshold by ~2.3 mg/dL and exchange threshold by ~2.8 mg/dL.
    let risk_photo_offset = if has_neurotoxicity_risk { -2.3 } else { 0.0 };
    let risk_exchange_offset = if has_neurotoxicity_risk { -2.8 } else { 0.0 };

    let phototherapy_threshold =
        (interp_knots(&PHOTO_BASE_38W_NO_RISK, h) + ga_offset + risk_photo_offset).max(4.5);
    let exchange_threshold =
        (interp_knots(&EXCHANGE_BASE_38W_NO_RISK, h) + ga_offset * 0.9 + risk_exchange_offset)
            .max(10.0);
    let escalation_of_care = (exchange_threshold - 2.0).max(phototherapy_threshold + 1.0);

    let b40 = interp_knots(&BHUTANI_40TH, h);
    let b75 = interp_knots(&BHUTANI_75TH, h);
    let b95 = interp_knots(&BHUTANI_95TH, h);

    let delta_below_photo = phototherapy_threshold - tcb_mg_dl;
    let dt = h - prior_hours;
    let rate_of_rise = if dt >= 1.0 && prior_tcb_mg_dl > 0.0 {
        (tcb_mg_dl - prior_tcb_mg_dl) / dt
    } else {
        0.0
    };
    let hemolysis_velocity_alert = rate_of_rise >= 0.20;

    let risk_zone = if tcb_mg_dl >= exchange_threshold {
        BhutaniRiskZone::ExceedsExchangeTransfusion
    } else if tcb_mg_dl >= phototherapy_threshold {
        BhutaniRiskZone::ExceedsPhototherapy
    } else if tcb_mg_dl >= b95 {
        BhutaniRiskZone::HighRiskAbove95th
    } else if tcb_mg_dl >= b75 {
        BhutaniRiskZone::HighIntermediate
    } else if tcb_mg_dl >= b40 {
        BhutaniRiskZone::LowIntermediate
    } else {
        BhutaniRiskZone::LowRisk
    };

    AapBhutaniEvaluation {
        postnatal_hours: h,
        gestational_weeks: ga,
        has_neurotoxicity_risk,
        tcb_mg_dl,
        tcb_umol_l: tcb_mg_dl * MG_DL_TO_UMOL_L,
        phototherapy_threshold_mg_dl: phototherapy_threshold,
        exchange_threshold_mg_dl: exchange_threshold,
        escalation_of_care_mg_dl: escalation_of_care,
        bhutani_40th_mg_dl: b40,
        bhutani_75th_mg_dl: b75,
        bhutani_95th_mg_dl: b95,
        delta_below_photo_mg_dl: delta_below_photo,
        rate_of_rise_mg_dl_per_hr: rate_of_rise,
        hemolysis_velocity_alert,
        risk_zone,
    }
}

/// 1-Compartment Oral Pharmacokinetic parameters for pediatric antipyretics.
#[derive(Debug, Clone, Copy)]
pub struct BatemanDrugParams {
    /// Bioavailability F (0..1)
    pub bioavailability: f64,
    /// First-order absorption rate constant k_a (1/hour)
    pub ka_per_hr: f64,
    /// First-order elimination rate constant k_e (1/hour) = ln(2) / t_half
    pub ke_per_hr: f64,
    /// Apparent volume of distribution V_d (L/kg)
    pub vd_l_per_kg: f64,
    /// Minimum effective analgesic/antipyretic plasma concentration (ug/mL == mg/L)
    pub therapeutic_min_ug_ml: f64,
    /// Target upper therapeutic concentration (ug/mL)
    pub therapeutic_max_ug_ml: f64,
    /// Clinical toxicity alert threshold (ug/mL)
    pub toxicity_ceiling_ug_ml: f64,
}

impl BatemanDrugParams {
    /// Pediatric Acetaminophen (Paracetamol): t_1/2 ~ 2.2h, T_max ~ 45 min, V_d ~ 0.90 L/kg
    pub const ACETAMINOPHEN: Self = Self {
        bioavailability: 0.88,
        ka_per_hr: 2.35,
        ke_per_hr: 0.315,
        vd_l_per_kg: 0.90,
        therapeutic_min_ug_ml: 10.0,
        therapeutic_max_ug_ml: 20.0,
        toxicity_ceiling_ug_ml: 150.0,
    };

    /// Pediatric Ibuprofen (age >= 6 months): t_1/2 ~ 2.0h, T_max ~ 75 min, V_d ~ 0.16 L/kg
    pub const IBUPROFEN: Self = Self {
        bioavailability: 0.92,
        ka_per_hr: 1.55,
        ke_per_hr: 0.346,
        vd_l_per_kg: 0.16,
        therapeutic_min_ug_ml: 10.0,
        therapeutic_max_ug_ml: 50.0,
        toxicity_ceiling_ug_ml: 100.0,
    };
}

#[derive(Debug, Clone, Copy)]
pub struct LoggedDose {
    pub dose_mg: f64,
    pub time_hr: f64,
}

/// Evaluates the 1-compartment Bateman oral absorption-elimination superposition equation:
/// C_p(t) = sum_i [ (F * D_i * k_a) / (V_d_total * (k_a - k_e)) * (exp(-k_e*(t-t_i)) - exp(-k_a*(t-t_i))) * H(t - t_i) ]
/// Returns plasma concentration in ug/mL (= mg/L).
pub fn bateman_concentration_ug_ml(
    params: BatemanDrugParams,
    weight_kg: f64,
    doses: &[LoggedDose],
    t_hr: f64,
) -> f64 {
    let vd_total_l = (params.vd_l_per_kg * weight_kg.max(1.5)).max(0.2);
    let denom = vd_total_l * (params.ka_per_hr - params.ke_per_hr);
    if denom.abs() < 1e-9 {
        return 0.0;
    }

    let mut total = 0.0;
    for d in doses {
        let dt = t_hr - d.time_hr;
        if dt > 0.0 && d.dose_mg > 0.0 {
            let coeff = (params.bioavailability * d.dose_mg * params.ka_per_hr) / denom;
            let conc = coeff * ((-params.ke_per_hr * dt).exp() - (-params.ka_per_hr * dt).exp());
            if conc > 0.0 {
                total += conc;
            }
        }
    }
    total
}

/// Generates a 24-hour Bateman pharmacokinetic plasma trajectory sampled every `step_hr`.
pub fn simulate_bateman_24h_curve(
    params: BatemanDrugParams,
    weight_kg: f64,
    doses: &[LoggedDose],
    step_hr: f64,
) -> Vec<(f64, f64)> {
    let dt = step_hr.clamp(0.1, 1.0);
    let steps = (24.0 / dt).round() as usize;
    let mut curve = Vec::with_capacity(steps + 1);
    for i in 0..=steps {
        let t = (i as f64) * dt;
        let cp = bateman_concentration_ug_ml(params, weight_kg, doses, t);
        curve.push((t, cp));
    }
    curve
}
