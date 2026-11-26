package com.pediaspectra.plugins;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.ColorSpaceTransform;
import android.hardware.camera2.params.RggbChannelVector;
import android.util.Rational;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * PEDIA-SPECTRA Native Android Java 17 D65 Bilirubin Camera2 & Nursery Microclimate Sensor Plugin.
 *
 * Capabilities:
 *  1. Interfaces with Android Camera2 to query rear sensor color-correction calibration,
 *     build D65 daylight-locked CaptureRequest parameters (CONTROL_AWB_LOCK = true,
 *     CONTROL_AWB_MODE_DAYLIGHT, COLOR_CORRECTION_MODE_TRANSFORM_MATRIX) for unbiased
 *     460 nm (blue) vs. 550 nm (green) Kubelka-Munk neonatal bilirubin chromophore scans,
 *     and control uniform torch illumination.
 *  2. Registers hardware SensorEventListeners on Sensor.TYPE_LIGHT (lux) to verify
 *     melanopsin-safe night-feeding darkness (< 5 lux) and Sensor.TYPE_AMBIENT_TEMPERATURE (°C)
 *     to audit AAP safe-sleep nursery thermal bounds (20.0 - 22.2 °C).
 */
@CapacitorPlugin(
    name = "D65BilirubinCameraLux",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class D65BilirubinCameraLuxPlugin extends Plugin implements SensorEventListener {

    private static final float AAP_IDEAL_TEMP_MIN_C = 20.0f;
    private static final float AAP_IDEAL_TEMP_MAX_C = 22.2f;
    private static final float NIGHT_FEED_MAX_LUX = 5.0f;

    // Standard D65 daylight RGGB channel correction vector for consistent blue/green bilirubin OD
    private static final RggbChannelVector D65_DAYLIGHT_GAINS =
        new RggbChannelVector(1.88f, 1.00f, 1.00f, 1.54f);

    private CameraManager cameraManager;
    private SensorManager sensorManager;
    private Sensor lightSensor;
    private Sensor ambientTempSensor;

    private String rearCameraId;
    private boolean awbLocked = false;
    private boolean torchActive = false;
    private float latestLux = -1.0f;
    private float latestAmbientTempC = Float.NaN;

    @Override
    public void load() {
        super.load();
        Context ctx = getContext();
        cameraManager = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
        sensorManager = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            lightSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT);
            ambientTempSensor = sensorManager.getDefaultSensor(Sensor.TYPE_AMBIENT_TEMPERATURE);
        }
        rearCameraId = findRearEnvironmentCameraId();
    }

    private String findRearEnvironmentCameraId() {
        if (cameraManager == null) {
            return null;
        }
        try {
            for (String id : cameraManager.getCameraIdList()) {
                CameraCharacteristics chars = cameraManager.getCameraCharacteristics(id);
                Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    return id;
                }
            }
        } catch (CameraAccessException ignored) {
            return null;
        }
        return null;
    }

    /**
     * Configures a Camera2 CaptureRequest.Builder with locked D65 daylight color correction
     * so automatic white-balance drift does not suppress yellow bilirubin reflectance.
     */
    public void applyD65BilirubinColorLock(CaptureRequest.Builder builder) {
        builder.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_DAYLIGHT);
        builder.set(CaptureRequest.CONTROL_AWB_LOCK, true);
        builder.set(CaptureRequest.COLOR_CORRECTION_MODE, CaptureRequest.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX);
        builder.set(CaptureRequest.COLOR_CORRECTION_GAINS, D65_DAYLIGHT_GAINS);
        builder.set(CaptureRequest.COLOR_CORRECTION_TRANSFORM, buildIdentityD65Transform());
        builder.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, 0);
    }

    private ColorSpaceTransform buildIdentityD65Transform() {
        Rational[] matrix = new Rational[] {
            new Rational(1000, 1000), new Rational(0, 1000), new Rational(0, 1000),
            new Rational(0, 1000), new Rational(1000, 1000), new Rational(0, 1000),
            new Rational(0, 1000), new Rational(0, 1000), new Rational(1000, 1000)
        };
        return new ColorSpaceTransform(matrix);
    }

    @PluginMethod
    public void lockD65BilirubinCalibration(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "handleCameraPermissionResult");
            return;
        }
        resolveD65CameraProfile(call);
    }

    @PermissionCallback
    private void handleCameraPermissionResult(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            resolveD65CameraProfile(call);
        } else {
            call.reject("CAMERA permission denied. D65 transcutaneous bilirubin colorimetry requires camera access.");
        }
    }

    private void resolveD65CameraProfile(PluginCall call) {
        if (cameraManager == null || rearCameraId == null) {
            rearCameraId = findRearEnvironmentCameraId();
        }
        if (cameraManager == null || rearCameraId == null) {
            call.reject("Rear Camera2 sensor unavailable on this device.");
            return;
        }

        if (ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Missing CAMERA permission grant.");
            return;
        }

        try {
            CameraCharacteristics chars = cameraManager.getCameraCharacteristics(rearCameraId);
            Boolean awbLockSupported = chars.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE);
            Boolean flashAvailable = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            Integer hardwareLevel = chars.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
            Integer refIlluminant1 = chars.get(CameraCharacteristics.SENSOR_REFERENCE_ILLUMINANT1);

            boolean requestedTorch = call.getBoolean("enableTorch", false);
            if (Boolean.TRUE.equals(flashAvailable)) {
                cameraManager.setTorchMode(rearCameraId, requestedTorch);
                torchActive = requestedTorch;
            }
            awbLocked = Boolean.TRUE.equals(awbLockSupported);

            JSObject gainsJson = new JSObject();
            gainsJson.put("red", D65_DAYLIGHT_GAINS.getRed());
            gainsJson.put("greenEven", D65_DAYLIGHT_GAINS.getGreenEven());
            gainsJson.put("greenOdd", D65_DAYLIGHT_GAINS.getGreenOdd());
            gainsJson.put("blue", D65_DAYLIGHT_GAINS.getBlue());

            JSObject out = new JSObject();
            out.put("cameraId", rearCameraId);
            out.put("awbMode", "CONTROL_AWB_MODE_DAYLIGHT");
            out.put("awbLockAvailable", awbLocked);
            out.put("awbLocked", awbLocked);
            out.put("torchActive", torchActive);
            out.put("hardwareLevel", hardwareLevel != null ? hardwareLevel : -1);
            out.put("referenceIlluminant", refIlluminant1 != null ? refIlluminant1 : 21);
            out.put("d65Gains", gainsJson);
            call.resolve(out);
        } catch (CameraAccessException ex) {
            call.reject("Camera2 D65 calibration error: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void setTorchState(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        if (cameraManager == null || rearCameraId == null) {
            call.reject("Rear camera torch unavailable.");
            return;
        }
        try {
            cameraManager.setTorchMode(rearCameraId, enabled);
            torchActive = enabled;
            JSObject out = new JSObject();
            out.put("torchActive", torchActive);
            call.resolve(out);
        } catch (CameraAccessException ex) {
            call.reject("Torch toggle failed: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void startNurseryLuxTempSensors(PluginCall call) {
        if (sensorManager == null) {
            call.reject("Android SensorManager unavailable.");
            return;
        }
        boolean hasLight = false;
        boolean hasTemp = false;
        if (lightSensor != null) {
            sensorManager.registerListener(this, lightSensor, SensorManager.SENSOR_DELAY_UI);
            hasLight = true;
        }
        if (ambientTempSensor != null) {
            sensorManager.registerListener(this, ambientTempSensor, SensorManager.SENSOR_DELAY_NORMAL);
            hasTemp = true;
        }

        JSObject out = new JSObject();
        out.put("lightSensorAvailable", hasLight);
        out.put("ambientTemperatureSensorAvailable", hasTemp);
        out.put("nightFeedMaxLux", NIGHT_FEED_MAX_LUX);
        out.put("aapTempRangeC", AAP_IDEAL_TEMP_MIN_C + "-" + AAP_IDEAL_TEMP_MAX_C);
        call.resolve(out);
    }

    @PluginMethod
    public void stopNurseryLuxTempSensors(PluginCall call) {
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        JSObject out = new JSObject();
        out.put("status", "stopped");
        call.resolve(out);
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event == null || event.values == null || event.values.length == 0) {
            return;
        }
        if (event.sensor.getType() == Sensor.TYPE_LIGHT) {
            latestLux = event.values[0];
        } else if (event.sensor.getType() == Sensor.TYPE_AMBIENT_TEMPERATURE) {
            latestAmbientTempC = event.values[0];
        }

        JSObject frame = new JSObject();
        frame.put("timestampMs", System.currentTimeMillis());
        if (latestLux >= 0.0f) {
            frame.put("lux", Math.round(latestLux * 100.0) / 100.0);
            frame.put("melanopsinDarkroomCompliant", latestLux <= NIGHT_FEED_MAX_LUX);
        }
        if (!Float.isNaN(latestAmbientTempC)) {
            frame.put("ambientTempC", Math.round(latestAmbientTempC * 10.0) / 10.0);
            frame.put("aapThermalSafeZone",
                latestAmbientTempC >= AAP_IDEAL_TEMP_MIN_C && latestAmbientTempC <= AAP_IDEAL_TEMP_MAX_C);
        }
        notifyListeners("nurseryMicroclimateFrame", frame);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // Not required for continuous lux/temperature telemetry
    }

    @Override
    protected void handleOnDestroy() {
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        if (torchActive && cameraManager != null && rearCameraId != null) {
            try {
                cameraManager.setTorchMode(rearCameraId, false);
            } catch (CameraAccessException ignored) {
                // Ignore cleanup failure
            }
        }
        super.handleOnDestroy();
    }
}
