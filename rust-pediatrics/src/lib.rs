//! PEDIA-SPECTRA Rust Clinical DSP & Kinetics Library
//!
//! Exports `#[no_mangle] pub extern "C"` bindings compatible with WebAssembly
//! (`wasm32-unknown-unknown`) and native FFI for:
//!  1. 12-pole Levinson-Durbin infant cry LPC formant extraction & hyper-phonation detection
//!  2. Melanin-decoupled Kubelka-Munk transcutaneous bilirubin inversion & AAP 2022 Bhutani risk
//!  3. 1-Compartment Bateman pediatric antipyretic pharmacokinetic curve integration

pub mod bilirubin_bateman_pk;
pub mod cry_lpc_formants;

use bilirubin_bateman_pk::{
    bateman_concentration_ug_ml, evaluate_aap_2022_bhutani, invert_kubelka_munk_bilirubin,
    BatemanDrugParams, LoggedDose, RgbSample,
};
use cry_lpc_formants::analyze_infant_cry_frame;

/// Static scratch buffer for WASM/C callers reading structured float64 telemetry vectors.
static mut TELEMETRY_OUT: [f64; 24] = [0.0; 24];

/// Returns pointer to the shared 24-element f64 output register for zero-copy WASM reads.
#[no_mangle]
pub extern "C" fn pedia_get_telemetry_ptr() -> *const f64 {
    unsafe { TELEMETRY_OUT.as_ptr() }
}

/// Executes 12-pole LPC infant cry formant & Golub-Corwin hyper-phonation triage on raw PCM audio.
/// Writes 18 metrics into TELEMETRY_OUT:
/// [0]=F0, [1]=F1, [2]=F2, [3]=F3, [4]=BW1, [5]=BW2, [6]=BW3, [7]=CPP_dB, [8]=HNR_dB,
/// [9]=Jitter%, [10]=Shimmer%, [11]=HyperRatio, [12]=DysphoniaRatio, [13]=StridorIndex,
/// [14]=PhonationModeCode, [15]=ReflexClassCode, [16]=TopReflexProb, [17]=LpcNormErr
#[no_mangle]
pub extern "C" fn pedia_analyze_cry_lpc(
    samples_ptr: *const f64,
    len: usize,
    sample_rate_hz: f64,
    is_inspiratory: u32,
    expiratory_duty_ratio: f64,
) -> u32 {
    if samples_ptr.is_null() || len < 64 {
        return 0;
    }
    let slice = unsafe { core::slice::from_raw_parts(samples_ptr, len) };
    let res = analyze_infant_cry_frame(
        slice,
        sample_rate_hz,
        is_inspiratory != 0,
        expiratory_duty_ratio,
    );
    let top_idx = res.reflex_class as usize;
    unsafe {
        TELEMETRY_OUT[0] = res.f0_hz;
        TELEMETRY_OUT[1] = res.f1_hz;
        TELEMETRY_OUT[2] = res.f2_hz;
        TELEMETRY_OUT[3] = res.f3_hz;
        TELEMETRY_OUT[4] = res.bw1_hz;
        TELEMETRY_OUT[5] = res.bw2_hz;
        TELEMETRY_OUT[6] = res.bw3_hz;
        TELEMETRY_OUT[7] = res.cpp_db;
        TELEMETRY_OUT[8] = res.hnr_db;
        TELEMETRY_OUT[9] = res.jitter_percent;
        TELEMETRY_OUT[10] = res.shimmer_percent;
        TELEMETRY_OUT[11] = res.hyper_phonation_ratio;
        TELEMETRY_OUT[12] = res.dysphonia_ratio;
        TELEMETRY_OUT[13] = res.stridor_index;
        TELEMETRY_OUT[14] = (res.phonation_mode as u32) as f64;
        TELEMETRY_OUT[15] = (res.reflex_class as u32) as f64;
        TELEMETRY_OUT[16] = res.reflex_probabilities[top_idx.min(5)];
        TELEMETRY_OUT[17] = res.lpc.normalized_error;
    }
    1
}

/// Runs melanin-decoupled Kubelka-Munk optical bilirubin inversion + 2022 AAP Bhutani evaluation.
/// Writes 14 metrics into TELEMETRY_OUT:
/// [0]=TcB_mg_dL, [1]=TcB_umol_L, [2]=OD_melanin, [3]=OD_bili_comp, [4]=CIE_b_star,
/// [5]=KramerZone, [6]=PhotoThresh, [7]=ExchangeThresh, [8]=EscalationThresh,
/// [9]=Bhutani40th, [10]=Bhutani75th, [11]=Bhutani95th, [12]=RateOfRise, [13]=RiskZoneCode
#[no_mangle]
pub extern "C" fn pedia_eval_bilirubin_bhutani(
    skin_r: f64,
    skin_g: f64,
    skin_b: f64,
    white_r: f64,
    white_g: f64,
    white_b: f64,
    fitzpatrick_type: u32,
    is_sclera_mode: u32,
    postnatal_hours: f64,
    gestational_weeks: u32,
    has_neurotoxicity_risk: u32,
    prior_tcb_mg_dl: f64,
    prior_hours: f64,
) -> u32 {
    let opt = invert_kubelka_munk_bilirubin(
        RgbSample {
            r: skin_r,
            g: skin_g,
            b: skin_b,
        },
        RgbSample {
            r: white_r,
            g: white_g,
            b: white_b,
        },
        fitzpatrick_type.clamp(1, 6) as u8,
        is_sclera_mode != 0,
    );
    let aap = evaluate_aap_2022_bhutani(
        postnatal_hours,
        opt.tcb_mg_dl,
        gestational_weeks.clamp(35, 40) as u8,
        has_neurotoxicity_risk != 0,
        prior_tcb_mg_dl,
        prior_hours,
    );
    unsafe {
        TELEMETRY_OUT[0] = opt.tcb_mg_dl;
        TELEMETRY_OUT[1] = opt.tcb_umol_l;
        TELEMETRY_OUT[2] = opt.od_melanin;
        TELEMETRY_OUT[3] = opt.od_bilirubin_compensated;
        TELEMETRY_OUT[4] = opt.cie_b_star;
        TELEMETRY_OUT[5] = opt.estimated_kramer_zone as f64;
        TELEMETRY_OUT[6] = aap.phototherapy_threshold_mg_dl;
        TELEMETRY_OUT[7] = aap.exchange_threshold_mg_dl;
        TELEMETRY_OUT[8] = aap.escalation_of_care_mg_dl;
        TELEMETRY_OUT[9] = aap.bhutani_40th_mg_dl;
        TELEMETRY_OUT[10] = aap.bhutani_75th_mg_dl;
        TELEMETRY_OUT[11] = aap.bhutani_95th_mg_dl;
        TELEMETRY_OUT[12] = aap.rate_of_rise_mg_dl_per_hr;
        TELEMETRY_OUT[13] = (aap.risk_zone as u32) as f64;
    }
    1
}

/// Evaluates single-point Bateman oral plasma concentration (ug/mL) for Acetaminophen (drug_id=0)
/// or Ibuprofen (drug_id=1) across `dose_count` paired (dose_mg, time_hr) entries.
#[no_mangle]
pub extern "C" fn pedia_eval_bateman_pk(
    drug_id: u32,
    weight_kg: f64,
    doses_mg_ptr: *const f64,
    doses_hr_ptr: *const f64,
    dose_count: usize,
    eval_time_hr: f64,
) -> f64 {
    if doses_mg_ptr.is_null() || doses_hr_ptr.is_null() || dose_count == 0 {
        return 0.0;
    }
    let mg_slice = unsafe { core::slice::from_raw_parts(doses_mg_ptr, dose_count) };
    let hr_slice = unsafe { core::slice::from_raw_parts(doses_hr_ptr, dose_count) };
    let mut doses = Vec::with_capacity(dose_count);
    for i in 0..dose_count {
        doses.push(LoggedDose {
            dose_mg: mg_slice[i],
            time_hr: hr_slice[i],
        });
    }
    let params = if drug_id == 1 {
        BatemanDrugParams::IBUPROFEN
    } else {
        BatemanDrugParams::ACETAMINOPHEN
    };
    bateman_concentration_ug_ml(params, weight_kg, &doses, eval_time_hr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bilirubin_bateman_pk::BhutaniRiskZone;
    use core::f64::consts::PI;
    use cry_lpc_formants::{CryPhonationMode, InfantReflexClass};

    #[test]
    fn test_hyper_phonation_pain_detection() {
        let fs = 48_000.0;
        let n = 1200;
        let mut frame = Vec::with_capacity(n);
        for i in 0..n {
            let t = (i as f64) / fs;
            // 1,280 Hz hyper-phonation fundamental + harmonic stack
            let s = 0.45 * (2.0 * PI * 1280.0 * t).sin()
                + 0.22 * (2.0 * PI * 2560.0 * t).sin()
                + 0.12 * (2.0 * PI * 3840.0 * t).sin();
            frame.push(s);
        }
        let res = analyze_infant_cry_frame(&frame, fs, false, 0.72);
        assert!(res.f0_hz > 1100.0 && res.f0_hz < 1450.0);
        assert_eq!(res.phonation_mode, CryPhonationMode::HyperPhonationPain);
        assert_eq!(res.reflex_class, InfantReflexClass::AcutePainHyperPhonation);
    }

    #[test]
    fn test_aap_2022_bhutani_phototherapy_flag() {
        let eval = evaluate_aap_2022_bhutani(48.0, 16.4, 38, false, 11.2, 24.0);
        assert_eq!(eval.risk_zone, BhutaniRiskZone::ExceedsPhototherapy);
        assert!(eval.hemolysis_velocity_alert);
    }

    #[test]
    fn test_bateman_acetaminophen_peak() {
        let doses = [LoggedDose {
            dose_mg: 150.0,
            time_hr: 0.0,
        }];
        let c_peak = bateman_concentration_ug_ml(BatemanDrugParams::ACETAMINOPHEN, 10.0, &doses, 0.9);
        assert!(c_peak > 10.0 && c_peak < 18.0);
    }
}
