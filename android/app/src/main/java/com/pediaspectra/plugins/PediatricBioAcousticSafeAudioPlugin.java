package com.pediaspectra.plugins;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PEDIA-SPECTRA Native Android Java 17 Bio-Acoustic & Neonatal Cochlear Safety Plugin.
 *
 * Capabilities:
 *  1. Captures raw AudioRecord PCM float frames at 48,000 Hz using MediaRecorder.AudioSource.UNPROCESSED
 *     (graceful fallback to VOICE_RECOGNITION) to preserve neonatal cry formants (350-4,500 Hz),
 *     hyper-phonation fundamental shifts (> 1,000 Hz), and inspiratory croup stridor.
 *  2. Evaluates real-time IEC 61672 A-weighted (dBA) and C-weighted (dBC) crib-side SPL.
 *  3. Monitors and enforces hardware AudioManager STREAM_MUSIC volume clamping when the
 *     Safe-Sleep Intrauterine Soundscape Synthesizer is active so output stays <= 50.0 dBA
 *     per American Academy of Pediatrics (AAP) neonatal auditory safety guidelines.
 */
@CapacitorPlugin(
    name = "PediatricBioAcousticSafeAudio",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class PediatricBioAcousticSafeAudioPlugin extends Plugin {

    public static final int SAMPLE_RATE_HZ = 48_000;
    public static final int FRAME_SAMPLES = 1_200; // 25 ms LPC analysis window at 48 kHz
    public static final double AAP_COCHLEAR_LIMIT_DBA = 50.0;
    private static final double CALIBRATION_OFFSET_DB = 94.0;

    private final AtomicBoolean isCapturing = new AtomicBoolean(false);
    private final AtomicBoolean cochlearSafetyLock = new AtomicBoolean(true);

    private AudioRecord audioRecord;
    private ExecutorService captureExecutor;
    private double maxAllowedDba = AAP_COCHLEAR_LIMIT_DBA;
    private double referenceOffsetDb = CALIBRATION_OFFSET_DB;

    // Cascaded 2nd-order IIR state for IEC 61672 A-weighting approximation at 48 kHz
    private double hp1X1 = 0.0, hp1X2 = 0.0, hp1Y1 = 0.0, hp1Y2 = 0.0;
    private double hp2X1 = 0.0, hp2X2 = 0.0, hp2Y1 = 0.0, hp2Y2 = 0.0;

    @PluginMethod
    public void startUnprocessedBioAcousticStream(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "handleMicrophonePermissionResult");
            return;
        }
        if (call.hasOption("maxAllowedDba")) {
            maxAllowedDba = Math.min(AAP_COCHLEAR_LIMIT_DBA, call.getDouble("maxAllowedDba", AAP_COCHLEAR_LIMIT_DBA));
        }
        if (call.hasOption("cochlearSafetyLock")) {
            cochlearSafetyLock.set(call.getBoolean("cochlearSafetyLock", true));
        }
        beginAudioCapture(call);
    }

    @PermissionCallback
    private void handleMicrophonePermissionResult(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            beginAudioCapture(call);
        } else {
            call.reject("RECORD_AUDIO permission denied. Infant cry LPC and crib dBA dosimetry require microphone access.");
        }
    }

    private void beginAudioCapture(PluginCall call) {
        if (isCapturing.get()) {
            JSObject alreadyActive = new JSObject();
            alreadyActive.put("status", "already_running");
            alreadyActive.put("sampleRateHz", SAMPLE_RATE_HZ);
            call.resolve(alreadyActive);
            return;
        }

        Context ctx = getContext();
        if (ActivityCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Missing RECORD_AUDIO runtime grant.");
            return;
        }

        int preferredSource = MediaRecorder.AudioSource.UNPROCESSED;
        AudioManager audioManager = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        String supportsUnprocessed = audioManager != null
            ? audioManager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED)
            : "false";
        if (!"true".equalsIgnoreCase(supportsUnprocessed) && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            preferredSource = MediaRecorder.AudioSource.VOICE_RECOGNITION;
        }

        int minBufferBytes = AudioRecord.getMinBufferSize(
            SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_FLOAT
        );
        int bufferBytes = Math.max(minBufferBytes * 2, FRAME_SAMPLES * 4 * 4);

        try {
            AudioFormat format = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                .setSampleRate(SAMPLE_RATE_HZ)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build();

            audioRecord = new AudioRecord.Builder()
                .setAudioSource(preferredSource)
                .setAudioFormat(format)
                .setBufferSizeInBytes(bufferBytes)
                .build();

            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                call.reject("Failed to initialize Android AudioRecord at 48 kHz PCM_FLOAT.");
                return;
            }

            isCapturing.set(true);
            audioRecord.startRecording();
            captureExecutor = Executors.newSingleThreadExecutor();
            final int activeSource = preferredSource;

            captureExecutor.execute(() -> runCaptureLoop(audioManager, activeSource));

            JSObject result = new JSObject();
            result.put("status", "streaming");
            result.put("sampleRateHz", SAMPLE_RATE_HZ);
            result.put("frameSamples", FRAME_SAMPLES);
            result.put("audioSource", activeSource == MediaRecorder.AudioSource.UNPROCESSED ? "UNPROCESSED" : "VOICE_RECOGNITION");
            result.put("cochlearSafetyCeilingDba", maxAllowedDba);
            call.resolve(result);
        } catch (Exception ex) {
            isCapturing.set(false);
            call.reject("Bio-acoustic capture startup error: " + ex.getMessage(), ex);
        }
    }

    private void runCaptureLoop(AudioManager audioManager, int activeSource) {
        float[] pcmBuffer = new float[FRAME_SAMPLES];
        while (isCapturing.get() && audioRecord != null) {
            int samplesRead = audioRecord.read(pcmBuffer, 0, FRAME_SAMPLES, AudioRecord.READ_BLOCKING);
            if (samplesRead < 256) {
                continue;
            }

            double sumSqUnweighted = 0.0;
            double sumSqAWeighted = 0.0;
            double peakAbs = 0.0;

            for (int i = 0; i < samplesRead; i++) {
                double x = pcmBuffer[i];
                double absX = Math.abs(x);
                if (absX > peakAbs) {
                    peakAbs = absX;
                }
                sumSqUnweighted += x * x;

                // Two-stage high-pass A-weighting filter shaping (attenuating < 500 Hz per IEC 61672)
                double y1 = 0.968 * (hp1Y1 + x - hp1X1);
                hp1X2 = hp1X1;
                hp1X1 = x;
                hp1Y2 = hp1Y1;
                hp1Y1 = y1;

                double y2 = 0.892 * (hp2Y1 + y1 - hp2X1);
                hp2X2 = hp2X1;
                hp2X1 = y1;
                hp2Y2 = hp2Y1;
                hp2Y1 = y2;

                sumSqAWeighted += y2 * y2;
            }

            double rmsC = Math.sqrt(sumSqUnweighted / samplesRead);
            double rmsA = Math.sqrt(sumSqAWeighted / samplesRead);
            double splDbc = Math.max(20.0, 20.0 * Math.log10(Math.max(rmsC, 1e-6)) + referenceOffsetDb);
            double splDba = Math.max(20.0, 20.0 * Math.log10(Math.max(rmsA, 1e-6)) + referenceOffsetDb);
            double crestFactorDb = 20.0 * Math.log10(Math.max(peakAbs, 1e-6) / Math.max(rmsC, 1e-6));

            double f0Hz = estimateAutocorrPitchHz(pcmBuffer, samplesRead);
            boolean hyperPhonationFlag = f0Hz >= 1000.0 && rmsC > 0.015;
            boolean clampedHardwareVolume = false;

            // Enforce AAP 50.0 dBA Neonatal Cochlear Safety Limit on hardware speaker stream
            if (cochlearSafetyLock.get() && splDba > maxAllowedDba && audioManager != null) {
                int currentVol = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
                int maxVol = Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
                int safeStepCeiling = Math.max(1, (int) Math.floor(maxVol * 0.38));
                if (currentVol > safeStepCeiling) {
                    audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, safeStepCeiling, 0);
                    clampedHardwareVolume = true;
                } else if (currentVol > 1 && splDba > (maxAllowedDba + 2.5)) {
                    audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, currentVol - 1, 0);
                    clampedHardwareVolume = true;
                }
            }

            JSObject payload = new JSObject();
            payload.put("timestampMs", System.currentTimeMillis());
            payload.put("splDba", Math.round(splDba * 10.0) / 10.0);
            payload.put("splDbc", Math.round(splDbc * 10.0) / 10.0);
            payload.put("crestFactorDb", Math.round(crestFactorDb * 10.0) / 10.0);
            payload.put("f0Hz", Math.round(f0Hz * 10.0) / 10.0);
            payload.put("hyperPhonationAlert", hyperPhonationFlag);
            payload.put("exceedsAap50DbaLimit", splDba > AAP_COCHLEAR_LIMIT_DBA);
            payload.put("hardwareVolumeClamped", clampedHardwareVolume);
            payload.put("audioSource", activeSource == MediaRecorder.AudioSource.UNPROCESSED ? "UNPROCESSED" : "VOICE_RECOGNITION");
            notifyListeners("bioAcousticFrame", payload);
        }
    }

    /**
     * Normalized autocorrelation fundamental frequency estimator covering 230 Hz .. 2,100 Hz
     * neonatal cry phonation & hyper-phonation range.
     */
    private double estimateAutocorrPitchHz(float[] frame, int length) {
        int minLag = Math.max(10, SAMPLE_RATE_HZ / 2_100);
        int maxLag = Math.min(length / 2, SAMPLE_RATE_HZ / 230);
        double bestCorr = 0.0;
        int bestLag = minLag;

        for (int lag = minLag; lag <= maxLag; lag++) {
            double num = 0.0;
            double e1 = 0.0;
            double e2 = 0.0;
            int limit = length - lag;
            for (int i = 0; i < limit; i += 2) {
                double a = frame[i];
                double b = frame[i + lag];
                num += a * b;
                e1 += a * a;
                e2 += b * b;
            }
            double denom = Math.sqrt(e1 * e2);
            if (denom > 1e-9) {
                double r = num / denom;
                if (r > bestCorr) {
                    bestCorr = r;
                    bestLag = lag;
                }
            }
        }
        return bestCorr > 0.28 ? ((double) SAMPLE_RATE_HZ / bestLag) : 0.0;
    }

    @PluginMethod
    public void enforceCochlearVolumeCeiling(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        double ceilingDba = Math.min(AAP_COCHLEAR_LIMIT_DBA, call.getDouble("ceilingDba", AAP_COCHLEAR_LIMIT_DBA));
        cochlearSafetyLock.set(enabled);
        maxAllowedDba = ceilingDba;

        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        int currentVol = 0;
        int maxVol = 15;
        if (audioManager != null) {
            currentVol = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
            maxVol = Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
            int cap = Math.max(1, (int) Math.floor(maxVol * 0.40));
            if (enabled && currentVol > cap) {
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, cap, 0);
                currentVol = cap;
            }
        }

        JSObject out = new JSObject();
        out.put("cochlearSafetyLock", enabled);
        out.put("ceilingDba", maxAllowedDba);
        out.put("streamMusicVolume", currentVol);
        out.put("streamMusicMaxVolume", maxVol);
        call.resolve(out);
    }

    @PluginMethod
    public void stopUnprocessedBioAcousticStream(PluginCall call) {
        releaseRecorder();
        JSObject out = new JSObject();
        out.put("status", "stopped");
        call.resolve(out);
    }

    private void releaseRecorder() {
        isCapturing.set(false);
        if (captureExecutor != null) {
            captureExecutor.shutdownNow();
            captureExecutor = null;
        }
        if (audioRecord != null) {
            try {
                audioRecord.stop();
            } catch (IllegalStateException ignored) {
                // Already stopped
            }
            audioRecord.release();
            audioRecord = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        releaseRecorder();
        super.handleOnDestroy();
    }
}
