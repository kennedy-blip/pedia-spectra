#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uMelaninIndex;     // 0.0 (Fitzpatrick I) .. 1.0 (Fitzpatrick VI)
uniform float uBilirubinTarget;  // Simulated/measured TcB reference (mg/dL) for calibration overlay
uniform float uOverlayAlpha;     // False-color Kubelka-Munk heatmap blend (0..1)
uniform float uUseCameraTexture; // 1.0 when real video frame bound, 0.0 for synthetic dermal phantom

// Convert linear sRGB to CIE b* yellow-blue chromaticity proxy
float computeCieBStar(vec3 rgb) {
    float y = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
    float z = 0.0193 * rgb.r + 0.1192 * rgb.g + 0.9505 * rgb.b;
    float fy = pow(max(y, 0.001), 0.33333);
    float fz = pow(max(z / 1.08883, 0.001), 0.33333);
    return 200.0 * (fy - fz);
}

// Kubelka-Munk optical density ratio: OD(460nm Blue) - alpha*OD(550nm Green) - beta*Melanin
float computeMelaninCompensatedTcb(vec3 rgb, float melaninIdx) {
    float r = max(rgb.r, 0.015);
    float g = max(rgb.g, 0.015);
    float b = max(rgb.b, 0.015);

    float od460 = -log(b) / 2.302585;
    float od550 = -log(g) / 2.302585;
    float od660 = -log(r) / 2.302585;

    float melaninSlope = max(0.0, od660 * (0.45 + 0.55 * melaninIdx));
    float bilirubinChromophore = max(0.0, (od460 - 0.72 * od550) - 0.34 * melaninSlope);
    float bStar = max(0.0, computeCieBStar(rgb) - 8.0 * melaninIdx);

    return clamp(bilirubinChromophore * 31.5 + bStar * 0.24, 0.5, 28.0);
}

vec3 bilirubinHeatmap(float tcb) {
    float norm = clamp(tcb / 22.0, 0.0, 1.0);
    vec3 low = vec3(0.08, 0.76, 0.62);    // Low Risk Cyan-Teal
    vec3 mid = vec3(0.98, 0.78, 0.18);    // Intermediate Amber
    vec3 high = vec3(0.96, 0.42, 0.12);   // Phototherapy Orange
    vec3 crit = vec3(0.92, 0.16, 0.28);   // Exchange Crimson

    if (norm < 0.38) {
        return mix(low, mid, norm / 0.38);
    } else if (norm < 0.70) {
        return mix(mid, high, (norm - 0.38) / 0.32);
    } else {
        return mix(high, crit, (norm - 0.70) / 0.30);
    }
}

void main() {
    vec3 skinRgb;

    if (uUseCameraTexture > 0.5) {
        skinRgb = texture(uTexture, vUv).rgb;
    } else {
        // Synthetic neonatal sternal/forehead dermal phantom modulated by Fitzpatrick I-VI & TcB
        vec2 centered = vUv - 0.5;
        float radial = length(centered);
        float microTexture = 0.018 * sin(vUv.x * 90.0 + uTime * 0.4) * cos(vUv.y * 85.0 - uTime * 0.3);

        // Baseline skin reflectance across Fitzpatrick I (0.0) -> VI (1.0)
        vec3 fitzLight = vec3(0.92, 0.79, 0.71);
        vec3 fitzDark = vec3(0.36, 0.24, 0.18);
        vec3 baseSkin = mix(fitzLight, fitzDark, uMelaninIndex);

        // Apply Beer-Lambert 460nm blue absorption proportional to dermal bilirubin concentration
        float localBili = uBilirubinTarget * (0.94 + 0.12 * exp(-radial * radial * 5.0));
        float blueAtten = exp(-localBili * 0.042);
        float greenAtten = exp(-localBili * 0.008);

        skinRgb = vec3(
            clamp(baseSkin.r * (1.0 + microTexture), 0.05, 0.98),
            clamp(baseSkin.g * greenAtten * (1.0 + microTexture * 0.8), 0.04, 0.96),
            clamp(baseSkin.b * blueAtten * (1.0 - microTexture * 0.5), 0.02, 0.94)
        );

        // Subtle curved sternal lighting gradient
        skinRgb *= (1.05 - radial * 0.28);
    }

    float estTcb = computeMelaninCompensatedTcb(skinRgb, uMelaninIndex);
    vec3 heatCol = bilirubinHeatmap(estTcb);

    // Central D65 Sternal / Forehead ROI reticle ring
    vec2 d = vUv - 0.5;
    float r = length(d);
    float roiMask = smoothstep(0.28, 0.25, r);
    float ring = smoothstep(0.268, 0.262, r) - smoothstep(0.256, 0.250, r);

    // Subtle 460nm cyan scanning sweep inside ROI
    float scanY = fract(uTime * 0.35) * 0.52 - 0.26;
    float scanLine = exp(-abs(d.y - scanY) * 140.0) * roiMask;

    vec3 blended = mix(skinRgb, mix(skinRgb, heatCol, uOverlayAlpha), roiMask);
    blended += vec3(0.20, 0.86, 0.98) * scanLine * 0.42;
    blended = mix(blended, vec3(0.92, 0.98, 1.0), clamp(ring, 0.0, 1.0) * 0.92);

    // Four D65 White-Balance calibration patches in corners
    vec2 cornerDist = abs(vUv - 0.5);
    if (cornerDist.x > 0.41 && cornerDist.y > 0.40) {
        blended = mix(blended, vec3(0.95, 0.96, 0.97), 0.72);
    }

    fragColor = vec4(blended, 1.0);
}
