package go_pediatrics

import (
	"math"
)

// MGdLToUmolL converts Total Serum / Transcutaneous Bilirubin from mg/dL to umol/L.
const MGdLToUmolL = 17.1

type knot struct {
	hour float64
	val  float64
}

// AAP 2022 Phototherapy thresholds for >=38w gestational age without neurotoxicity risk factors.
var aapPhotoBase38w = []knot{
	{0, 7.2}, {12, 9.6}, {24, 12.1}, {36, 14.3},
	{48, 16.0}, {72, 18.6}, {96, 20.1}, {168, 21.0},
}

// AAP 2022 Exchange Transfusion thresholds for >=38w gestational age without neurotoxicity risk factors.
var aapExchangeBase38w = []knot{
	{0, 14.5}, {12, 16.5}, {24, 19.0}, {36, 21.2},
	{48, 23.0}, {72, 25.0}, {96, 25.8}, {168, 26.0},
}

// Classical Bhutani hour-specific percentile curves (40th, 75th, 95th).
var bhutani40th = []knot{{0, 2.0}, {12, 3.8}, {24, 5.2}, {48, 8.6}, {72, 11.2}, {96, 12.4}, {168, 13.0}}
var bhutani75th = []knot{{0, 3.2}, {12, 5.4}, {24, 7.1}, {48, 11.4}, {72, 14.0}, {96, 15.2}, {168, 15.8}}
var bhutani95th = []knot{{0, 4.5}, {12, 6.8}, {24, 8.5}, {48, 13.4}, {72, 16.1}, {96, 17.5}, {168, 18.0}}

func interpKnots(knots []knot, hour float64) float64 {
	if hour <= knots[0].hour {
		return knots[0].val
	}
	last := len(knots) - 1
	if hour >= knots[last].hour {
		return knots[last].val
	}
	for i := 0; i < last; i++ {
		if hour >= knots[i].hour && hour <= knots[i+1].hour {
			t := (hour - knots[i].hour) / (knots[i+1].hour - knots[i].hour)
			return knots[i].val + t*(knots[i+1].val-knots[i].val)
		}
	}
	return knots[last].val
}

func round2(v float64) float64 {
	return math.Round(v*100.0) / 100.0
}

// BhutaniRequest represents a neonatal jaundice clinical triage request.
type BhutaniRequest struct {
	PostnatalHours       float64 `json:"postnatalHours"`
	TcbMgDl              float64 `json:"tcbMgDl"`
	GestationalWeeks     int     `json:"gestationalWeeks"`
	HasNeurotoxicityRisk bool    `json:"hasNeurotoxicityRisk"`
	PriorTcbMgDl         float64 `json:"priorTcbMgDl"`
	PriorHours           float64 `json:"priorHours"`
	KramerZone           int     `json:"kramerZone"`
}

// BhutaniAssessment provides 2022 AAP hour-specific hyperbilirubinemia risk stratification.
type BhutaniAssessment struct {
	PostnatalHours            float64 `json:"postnatalHours"`
	GestationalWeeks          int     `json:"gestationalWeeks"`
	TcbMgDl                   float64 `json:"tcbMgDl"`
	TcbUmolL                  float64 `json:"tcbUmolL"`
	PhototherapyThresholdMgDl float64 `json:"phototherapyThresholdMgDl"`
	ExchangeThresholdMgDl     float64 `json:"exchangeThresholdMgDl"`
	EscalationOfCareMgDl      float64 `json:"escalationOfCareMgDl"`
	Bhutani40thMgDl           float64 `json:"bhutani40thMgDl"`
	Bhutani75thMgDl           float64 `json:"bhutani75thMgDl"`
	Bhutani95thMgDl           float64 `json:"bhutani95thMgDl"`
	DeltaBelowPhotoMgDl       float64 `json:"deltaBelowPhotoMgDl"`
	RateOfRiseMgDlPerHr       float64 `json:"rateOfRiseMgDlPerHr"`
	HemolysisAlert            bool    `json:"hemolysisAlert"`
	RiskZone                  string  `json:"riskZone"`
	ClinicalAction            string  `json:"clinicalAction"`
}

// EvaluateBhutaniNomogram computes 2022 AAP hour-specific phototherapy & exchange thresholds.
func EvaluateBhutaniNomogram(req BhutaniRequest) BhutaniAssessment {
	h := math.Max(0, math.Min(168, req.PostnatalHours))
	ga := req.GestationalWeeks
	if ga < 35 {
		ga = 35
	} else if ga > 40 {
		ga = 40
	}

	var gaOffset float64
	switch ga {
	case 35:
		gaOffset = -3.6
	case 36:
		gaOffset = -2.4
	case 37:
		gaOffset = -1.2
	case 38:
		gaOffset = 0.0
	case 39:
		gaOffset = 0.5
	default:
		gaOffset = 0.9
	}

	riskPhotoOffset := 0.0
	riskExchangeOffset := 0.0
	if req.HasNeurotoxicityRisk {
		riskPhotoOffset = -2.3
		riskExchangeOffset = -2.8
	}

	photoThresh := math.Max(4.5, interpKnots(aapPhotoBase38w, h)+gaOffset+riskPhotoOffset)
	exchangeThresh := math.Max(10.0, interpKnots(aapExchangeBase38w, h)+gaOffset*0.9+riskExchangeOffset)
	escalation := math.Max(photoThresh+1.0, exchangeThresh-2.0)

	b40 := interpKnots(bhutani40th, h)
	b75 := interpKnots(bhutani75th, h)
	b95 := interpKnots(bhutani95th, h)

	rateOfRise := 0.0
	if req.PriorTcbMgDl > 0 && (h-req.PriorHours) >= 1.0 {
		rateOfRise = (req.TcbMgDl - req.PriorTcbMgDl) / (h - req.PriorHours)
	}
	hemolysis := rateOfRise >= 0.20

	zone := "LOW_RISK"
	action := "Routine newborn feeding (8-12x/day) and standard outpatient follow-up."
	if req.TcbMgDl >= exchangeThresh {
		zone = "EXCEEDS_EXCHANGE_TRANSFUSION"
		action = "EMERGENCY: Exceeds AAP exchange-transfusion threshold. Immediate NICU admission, intensive phototherapy, IV hydration, and serum TSB."
	} else if req.TcbMgDl >= escalation {
		zone = "ESCALATION_OF_CARE"
		action = "URGENT ESCALATION: Within 2 mg/dL of exchange threshold. Immediate hospital evaluation and intensive phototherapy."
	} else if req.TcbMgDl >= photoThresh {
		zone = "EXCEEDS_PHOTOTHERAPY"
		action = "ACTION REQUIRED: Exceeds 2022 AAP phototherapy threshold. Confirm immediately with serum TSB and initiate phototherapy."
	} else if req.TcbMgDl >= b95 || (photoThresh-req.TcbMgDl) <= 2.0 {
		zone = "HIGH_RISK_ABOVE_95TH"
		action = "HIGH RISK: Within 2 mg/dL of phototherapy threshold or >95th Bhutani track. Obtain serum TSB within 4-12 hours."
	} else if req.TcbMgDl >= b75 {
		zone = "HIGH_INTERMEDIATE"
		action = "INTERMEDIATE-HIGH: Re-measure TcB/TSB within 12-24 hours; support frequent nursing/hydration."
	} else if req.TcbMgDl >= b40 {
		zone = "LOW_INTERMEDIATE"
		action = "INTERMEDIATE-LOW: Monitor cephalocaudal progression and follow up with pediatrician in 24-48 hours."
	}

	if hemolysis {
		action += " WARNING: Rapid bilirubin rise (>= 0.20 mg/dL/hr) suggests active hemolysis (ABO/Rh/G6PD); urgent DAT/TSB required."
	}

	return BhutaniAssessment{
		PostnatalHours:            round2(h),
		GestationalWeeks:          ga,
		TcbMgDl:                   round2(req.TcbMgDl),
		TcbUmolL:                  round2(req.TcbMgDl * MGdLToUmolL),
		PhototherapyThresholdMgDl: round2(photoThresh),
		ExchangeThresholdMgDl:     round2(exchangeThresh),
		EscalationOfCareMgDl:      round2(escalation),
		Bhutani40thMgDl:           round2(b40),
		Bhutani75thMgDl:           round2(b75),
		Bhutani95thMgDl:           round2(b95),
		DeltaBelowPhotoMgDl:       round2(photoThresh - req.TcbMgDl),
		RateOfRiseMgDlPerHr:       round2(rateOfRise),
		HemolysisAlert:            hemolysis,
		RiskZone:                  zone,
		ClinicalAction:            action,
	}
}

// ImciRespiratoryRequest holds infant respiratory rate, retraction phase angle, and apnea telemetry.
type ImciRespiratoryRequest struct {
	AgeMonths         float64 `json:"ageMonths"`
	RespiratoryRate   float64 `json:"respiratoryRate"`
	TaaPhaseAngleDeg  float64 `json:"taaPhaseAngleDeg"`
	LongestApneaSec   float64 `json:"longestApneaSec"`
	HasStridorOrGrunt bool    `json:"hasStridorOrGrunt"`
}

// ImciRespiratoryAssessment returns WHO IMCI age-tiered tachypnea and chest-indrawing triage.
type ImciRespiratoryAssessment struct {
	AgeTierLabel        string  `json:"ageTierLabel"`
	WhoCutoffBpm        float64 `json:"whoCutoffBpm"`
	IsTachypneic        bool    `json:"isTachypneic"`
	RetractionSeverity  string  `json:"retractionSeverity"`
	CentralApneaAlert   bool    `json:"centralApneaAlert"`
	ImciClassification  string  `json:"imciClassification"`
	TriageUrgency       string  `json:"triageUrgency"`
	RecommendedGuidance string  `json:"recommendedGuidance"`
}

// EvaluateWhoImciRespiratory classifies infant respiratory status using WHO IMCI cutoffs.
func EvaluateWhoImciRespiratory(req ImciRespiratoryRequest) ImciRespiratoryAssessment {
	var tier string
	var cutoff float64
	if req.AgeMonths < 2.0 {
		tier = "Neonate / Young Infant (< 2 months)"
		cutoff = 60.0
	} else if req.AgeMonths < 12.0 {
		tier = "Infant (2 - 11 months)"
		cutoff = 50.0
	} else {
		tier = "Toddler / Child (1 - 5 years)"
		cutoff = 40.0
	}

	isTachypneic := req.RespiratoryRate >= cutoff
	apneaAlert := req.LongestApneaSec >= 15.0

	retraction := "SYNCHRONOUS_NORMAL"
	if req.TaaPhaseAngleDeg >= 110.0 {
		retraction = "SEVERE_PARADOXICAL_SEESAW"
	} else if req.TaaPhaseAngleDeg >= 55.0 {
		retraction = "MODERATE_CHEST_INDRAWING"
	} else if req.TaaPhaseAngleDeg >= 28.0 {
		retraction = "MILD_ASYNCHRONY"
	}

	classification := "NO_PNEUMONIA_NORMAL_BREATHING"
	urgency := "GREEN_ROUTINE"
	guidance := "Respiratory rate and thoraco-abdominal synchrony are within WHO IMCI age-specific norms."

	if apneaAlert || retraction == "SEVERE_PARADOXICAL_SEESAW" || req.HasStridorOrGrunt {
		classification = "SEVERE_PNEUMONIA_OR_VERY_SEVERE_DISEASE"
		urgency = "RED_EMERGENCY"
		guidance = "EMERGENCY DANGER SIGN: Paradoxical chest indrawing, central apnea (>=15s), or stridor/grunting detected. Seek urgent emergency medical care immediately."
	} else if isTachypneic && retraction == "MODERATE_CHEST_INDRAWING" {
		classification = "PNEUMONIA_WITH_CHEST_INDRAWING"
		urgency = "RED_URGENT"
		guidance = "WHO IMCI Tachypnea accompanied by chest indrawing. Same-day pediatric or emergency respiratory evaluation required."
	} else if isTachypneic {
		classification = "WHO_IMCI_FAST_BREATHING_TACHYPNEA"
		urgency = "AMBER_CLINICAL_EVAL"
		guidance = "Fast breathing meets or exceeds WHO IMCI age threshold. Re-count over a full calm 60s window (ensure fever is controlled) and contact your pediatrician promptly."
	}

	return ImciRespiratoryAssessment{
		AgeTierLabel:        tier,
		WhoCutoffBpm:        cutoff,
		IsTachypneic:        isTachypneic,
		RetractionSeverity:  retraction,
		CentralApneaAlert:   apneaAlert,
		ImciClassification:  classification,
		TriageUrgency:       urgency,
		RecommendedGuidance: guidance,
	}
}

// MedicationAuditRequest verifies pediatric weight-based dosing & Holliday-Segar hydration.
type MedicationAuditRequest struct {
	WeightKg           float64 `json:"weightKg"`
	AgeMonths          float64 `json:"ageMonths"`
	Drug               string  `json:"drug"` // "acetaminophen" | "ibuprofen" | "amoxicillin"
	ConcentrationMgPer float64 `json:"concentrationMgPer"`
	ConcentrationMl    float64 `json:"concentrationMl"`
	DosesGiven24hMg    float64 `json:"dosesGiven24hMg"`
	DehydrationPercent float64 `json:"dehydrationPercent"`
}

// MedicationAuditResponse provides verified mg/kg dosing, syringe mL, and Holliday-Segar fluids.
type MedicationAuditResponse struct {
	Allowed                   bool    `json:"allowed"`
	BlockReason               string  `json:"blockReason,omitempty"`
	SingleDoseMinMg           float64 `json:"singleDoseMinMg"`
	SingleDoseTargetMg        float64 `json:"singleDoseTargetMg"`
	SingleDoseMaxMg           float64 `json:"singleDoseMaxMg"`
	SyringeVolumeTargetMl     float64 `json:"syringeVolumeTargetMl"`
	MaxDaily24hMg             float64 `json:"maxDaily24hMg"`
	RemainingSafe24hMg        float64 `json:"remainingSafe24hMg"`
	ConcentrationMgPerMl      float64 `json:"concentrationMgPerMl"`
	HollidaySegarHourlyMl     float64 `json:"hollidaySegarHourlyMl"`
	HollidaySegarDailyMl      float64 `json:"hollidaySegarDailyMl"`
	WhoOrsPlanB4HrTotalMl     float64 `json:"whoOrsPlanB4HrTotalMl"`
	WhoOrsSyringePer3MinMl    float64 `json:"whoOrsSyringePer3MinMl"`
	MinExpectedUrineOutputMlH float64 `json:"minExpectedUrineOutputMlH"`
}

// AuditPediatricDosingAndFluids computes exact mg/kg dosing, concentration safety, and Holliday-Segar 4-2-1 fluids.
func AuditPediatricDosingAndFluids(req MedicationAuditRequest) MedicationAuditResponse {
	w := math.Max(1.5, math.Min(100.0, req.WeightKg))
	concMl := req.ConcentrationMl
	if concMl <= 0 {
		concMl = 5.0
	}
	mgPerMl := req.ConcentrationMgPer / concMl
	if mgPerMl <= 0 {
		mgPerMl = 32.0
	}

	// Holliday-Segar 4-2-1 Rule
	var hourlyMaint float64
	if w <= 10.0 {
		hourlyMaint = 4.0 * w
	} else if w <= 20.0 {
		hourlyMaint = 40.0 + 2.0*(w-10.0)
	} else {
		hourlyMaint = 60.0 + 1.0*(w-20.0)
	}
	dailyMaint := hourlyMaint * 24.0
	orsPlanB := 75.0 * w // WHO Plan B: 75 mL/kg over 4 hours
	orsPer3Min := orsPlanB / 80.0
	minUrine := 1.5 * w

	resp := MedicationAuditResponse{
		Allowed:                   true,
		ConcentrationMgPerMl:      round2(mgPerMl),
		HollidaySegarHourlyMl:     round2(hourlyMaint),
		HollidaySegarDailyMl:      round2(dailyMaint),
		WhoOrsPlanB4HrTotalMl:     round2(orsPlanB),
		WhoOrsSyringePer3MinMl:    round2(orsPer3Min),
		MinExpectedUrineOutputMlH: round2(minUrine),
	}

	switch req.Drug {
	case "ibuprofen":
		if req.AgeMonths < 6.0 {
			resp.Allowed = false
			resp.BlockReason = "CONTRAINDICATED UNDER 6 MONTHS: Ibuprofen poses neonatal renal prostaglandin and GI safety risks under 6 months of age."
			return resp
		}
		resp.SingleDoseMinMg = round2(math.Min(5.0*w, 400.0))
		resp.SingleDoseTargetMg = round2(math.Min(10.0*w, 400.0))
		resp.SingleDoseMaxMg = round2(math.Min(10.0*w, 400.0))
		resp.MaxDaily24hMg = round2(math.Min(40.0*w, 1200.0))
	case "amoxicillin":
		resp.SingleDoseMinMg = round2(math.Min(22.5*w, 500.0))
		resp.SingleDoseTargetMg = round2(math.Min(45.0*w, 1000.0))
		resp.SingleDoseMaxMg = round2(math.Min(45.0*w, 1000.0))
		resp.MaxDaily24hMg = round2(math.Min(90.0*w, 3000.0))
	default: // acetaminophen
		resp.SingleDoseMinMg = round2(math.Min(10.0*w, 650.0))
		resp.SingleDoseTargetMg = round2(math.Min(15.0*w, 650.0))
		resp.SingleDoseMaxMg = round2(math.Min(15.0*w, 1000.0))
		resp.MaxDaily24hMg = round2(math.Min(75.0*w, 4000.0))
	}

	resp.SyringeVolumeTargetMl = math.Round((resp.SingleDoseTargetMg/mgPerMl)*10.0) / 10.0
	resp.RemainingSafe24hMg = round2(math.Max(0.0, resp.MaxDaily24hMg-req.DosesGiven24hMg))
	return resp
}
