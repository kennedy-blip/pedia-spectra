# PEDIA-SPECTRA — Offline-First Pediatric & Neonatal Clinical Triage Workstation

**Day 26** · Dual-Target (**Vercel Web** + **Capacitor 6 Android `.APK`**) · **Champion Stack B (0.0% TypeScript)**

`PEDIA-SPECTRA` combines real bio-acoustic DSP, melanin-compensated dermal optical colorimetry, Eulerian thoraco-abdominal phase kinematics, pediatric `mg/kg` pharmacokinetic overdose guardrails, and AAP safe-sleep nursery dosimetry into one offline-first clinical workstation — paired with **1-Tap Built-In Mathematical Simulators** so every feature works immediately on desktop, mobile web, and offline Android `.APK`.

## 5 Core Clinical & Physics Modules

1. **Infant Cry 12-Pole LPC Formant & Hyper-Phonation Lab** (`InfantCryFormantClassifier.vue`)
   - 48 kHz raw microphone capture + 6 audible & mathematical presets (`Hunger "Neh"`, `Burp "Eh"`, `Colic "Eairh"`, `Overtired "Owh"`, `Acute Pain F0 > 1,000 Hz`, `Croup Stridor 680 Hz`).
   - 12-pole Levinson-Durbin LPC spectral envelope, scrolling waterfall spectrogram, $F_1\text{–}F_2$ neonatal formant triangle, CPP, HNR, jitter/shimmer, and Golub-Corwin phonation mode triage.
2. **Transcutaneous Bilirubin (`TcB`) & 2022 AAP Bhutani Nomogram** (`BilirubinBhutaniNomogramScanner.vue`)
   - 60 FPS WebGL2 Kubelka-Munk `460 nm / 550 nm` melanin-compensated shader (`Fitzpatrick I–VI`) with rear D65 camera support + synthetic dermal phantom.
   - Interactive 5-zone Kramer cephalocaudal body map + 2022 AAP `0–168h` Phototherapy & Exchange Transfusion splines (`35w–≥40w`, neurotoxicity risk toggle, `≥0.20 mg/dL/hr` hemolysis alert).
3. **Contact-Free Eulerian Respiratory (`WHO IMCI`) & Retraction Monitor** (`TachypneaRetractionMonitor.vue`)
   - Dual-ROI Thorax vs. Abdomen optical differential analyzer + 4 presets + manual breath tapper.
   - Konno-Mead Lissajous phase angle $\phi_{\text{TAA}}^\circ$ (`0°` synchronous vs. `≥110°` paradoxical seesaw retractions), central apnea timer (`≥15–20s`), and WHO IMCI age-tiered cutoffs (`<2m ≥60`, `2–11m ≥50`, `1–5y ≥40 bpm`).
4. **Pediatric `mg/kg` Overdose Shield, Bateman PK & Rehydration** (`PediatricMgKgPharmacokinetics.vue`)
   - `kg`/`lbs` unit normalization + WHO age-vs-weight sanity guard + hard clinical block on Ibuprofen `<6 months`.
   - `2.0×` Ibuprofen concentration trap warning (`50mg/1.25mL` infant drops vs. `100mg/5mL` children's suspension).
   - 1:1 Hooke's Law spring-animated (`stiffness: 180, damping: 22`) oral syringe (`1/5/10 mL`), 24h 1-compartment Bateman $C_p(t)$ plasma trajectory + lockout timer, Holliday-Segar `4-2-1` maintenance fluids, and WHO Plan B ORS (`75 mL/kg / 4h`).
5. **AAP Safe-Sleep Nursery Microclimate, `50 dBA` Dosimeter & `TOG` Architect** (`NurserySafeSleepTogArchitect.vue`)
   - Crib-side `dBA`/`dBC` dosimeter + 4 nursery scenarios + inverse-square safe speaker distance solver (`≤50.0 dBA`).
   - Pure Web Audio intrauterine `<500 Hz` womb/shush + `68 BPM` arterial pulse synthesizer with hard 50 dBA gain lock.
   - `TOG` (`0.2–3.5`) vs. temperature (`14–28°C`) SIDS balance + 1-Tap Full-Screen `630 nm` Zero-Blue Night-Feeding Lantern with dimmer & L/R feed stopwatch.

## Polyglot Architecture (0.0% TypeScript)

| Layer | Language | Files |
|---|---|---|
| Reactive UI & Canvases | **Vue 3.5** (Pure JS `<script setup>`) | `src/App.vue`, `src/components/*.vue` |
| Clinical DSP & PK Core | **Rust 2021** (`cdylib` WASM / FFI) | `rust-pediatrics/src/{lib,cry_lpc_formants,bilirubin_bateman_pk}.rs` |
| Offline Engines & Vault | **ES2024 JavaScript** | `src/engines/*.js`, `src/db/pediaVaultDb.js`, `src/composables/useSpringPhysics.js` |
| Native Android Bridge | **Java 17** (Capacitor 6) | `android/app/src/main/java/com/pediaspectra/plugins/*.java` |
| Serverless Triage API | **Go 1.22** (Vercel) | `api/pediatric_clinical_solver.go`, `go_pediatrics/imci_bhutani_pharmacokinetics.go` |
| Shaders & Glassmorphism | **WebGL2 GLSL 300 es + CSS3** | `src/shaders/*.glsl`, `src/style.css` |

## Development & Build

```bash
npm install
npm run dev       # Starts Vite 6 on http://0.0.0.0:5173
npm run build     # Produces production bundle in dist/
```

## Disclaimer

`PEDIA-SPECTRA` provides educational and bedside triage telemetry modeled on AAP 2022 Bhutani hyperbilirubinemia thresholds, WHO IMCI respiratory cutoffs, Holliday-Segar fluid rules, and standard pediatric pharmacokinetics. It is not an FDA-cleared medical device and never replaces emergency services or a licensed pediatrician.
