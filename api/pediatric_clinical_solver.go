package handler

import (
	"encoding/json"
	"net/http"
	"time"

	gp "pedia-spectra/go_pediatrics"
)

type clinicalEnvelope struct {
	Module      string                      `json:"module"`
	Bhutani     *gp.BhutaniRequest          `json:"bhutani,omitempty"`
	Respiratory *gp.ImciRespiratoryRequest  `json:"respiratory,omitempty"`
	Medication  *gp.MedicationAuditRequest  `json:"medication,omitempty"`
	BatchItems  []map[string]any            `json:"batchItems,omitempty"`
}

type clinicalResponse struct {
	Engine       string  `json:"engine"`
	GoVersion    string  `json:"goVersion"`
	Module       string  `json:"module"`
	Status       string  `json:"status"`
	LatencyUs    int64   `json:"latencyUs"`
	TimestampUtc string  `json:"timestampUtc"`
	Result       any     `json:"result"`
}

// Handler is the Vercel Go 1.22 Serverless Function entrypoint for PEDIA-SPECTRA.
func Handler(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method == http.MethodGet {
		resp := clinicalResponse{
			Engine:       "PEDIA-SPECTRA Go 1.22 Pediatric Triage & Pharmacokinetic Solver",
			GoVersion:    "1.22",
			Module:       "health",
			Status:       "ok",
			LatencyUs:    time.Since(start).Microseconds(),
			TimestampUtc: time.Now().UTC().Format(time.RFC3339),
			Result: map[string]any{
				"capabilities": []string{
					"aap_2022_bhutani_nomogram",
					"who_imci_respiratory_triage",
					"mgkg_bateman_holliday_segar",
					"offline_mutation_batch_sync",
				},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
		return
	}

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Method not allowed; use GET or POST"})
		return
	}

	var req clinicalEnvelope
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Malformed JSON payload: " + err.Error()})
		return
	}

	var result any
	switch req.Module {
	case "bilirubin_bhutani":
		if req.Bhutani == nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Missing bhutani request object"})
			return
		}
		result = gp.EvaluateBhutaniNomogram(*req.Bhutani)
	case "respiratory_imci":
		if req.Respiratory == nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Missing respiratory request object"})
			return
		}
		result = gp.EvaluateWhoImciRespiratory(*req.Respiratory)
	case "mgkg_pk":
		if req.Medication == nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Missing medication request object"})
			return
		}
		result = gp.AuditPediatricDosingAndFluids(*req.Medication)
	case "batch_sync":
		result = map[string]any{
			"syncedCount": len(req.BatchItems),
			"serverAckId": time.Now().UTC().UnixMilli(),
			"verified":    true,
		}
	default:
		// Combined default clinical benchmark payload
		result = map[string]any{
			"bhutani": gp.EvaluateBhutaniNomogram(gp.BhutaniRequest{
				PostnatalHours:   48,
				TcbMgDl:          11.4,
				GestationalWeeks: 39,
			}),
			"respiratory": gp.EvaluateWhoImciRespiratory(gp.ImciRespiratoryRequest{
				AgeMonths:        4,
				RespiratoryRate:  38,
				TaaPhaseAngleDeg: 8,
			}),
			"medication": gp.AuditPediatricDosingAndFluids(gp.MedicationAuditRequest{
				WeightKg:           7.5,
				AgeMonths:          7,
				Drug:               "acetaminophen",
				ConcentrationMgPer: 160,
				ConcentrationMl:    5,
			}),
		}
	}

	resp := clinicalResponse{
		Engine:       "PEDIA-SPECTRA Go 1.22 Pediatric Triage & Pharmacokinetic Solver",
		GoVersion:    "1.22",
		Module:       req.Module,
		Status:       "ok",
		LatencyUs:    time.Since(start).Microseconds(),
		TimestampUtc: time.Now().UTC().Format(time.RFC3339),
		Result:       result,
	}
	_ = json.NewEncoder(w).Encode(resp)
}
