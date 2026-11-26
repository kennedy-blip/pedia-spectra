#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uPointer;
uniform float uAcousticEnergy;
uniform float uThemeMode; // 0.0: NICU Obsidian, 1.0: Clinic Daylight, 2.0: 3AM 630nm Night, 3.0: Eco-Glass

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
    for (int i = 0; i < 4; i++) {
        v += amp * valueNoise(p);
        p = rot * p * 2.02;
        amp *= 0.5;
    }
    return v;
}

void main() {
    vec2 uv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

    // Maternal intrauterine 68 BPM subtle hydrostatic breath modulation (1.133 Hz)
    float pulse68Bpm = 0.5 + 0.5 * sin(uTime * 3.56);
    float energy = clamp(uAcousticEnergy, 0.0, 1.5);

    vec2 flowUv = p * 2.1 + vec2(uTime * 0.045, -uTime * 0.032);
    float n1 = fbm(flowUv + vec2(fbm(flowUv * 1.4 - uTime * 0.04)));
    float waveBand = sin(p.y * 5.2 + n1 * 4.4 + uTime * (0.45 + energy * 0.9)) * 0.5 + 0.5;
    float harmonicWave = sin(p.x * 3.8 - p.y * 2.4 + n1 * 3.2 - uTime * 0.35) * 0.5 + 0.5;

    // Specular cursor / gyroscope catch-light orb
    vec2 ptr = (uPointer - 0.5) * vec2(aspect, 1.0);
    float distPtr = length(p - ptr);
    float catchLight = exp(-distPtr * distPtr * 5.2) * (0.24 + 0.14 * pulse68Bpm);

    vec3 baseA;
    vec3 baseB;
    vec3 accentA;
    vec3 accentB;

    if (uThemeMode < 0.5) {
        // NICU Obsidian (Deep Midnight Slate + Bioluminescent Cyan & Warm Rose Gold)
        baseA = vec3(0.024, 0.043, 0.086);
        baseB = vec3(0.055, 0.095, 0.165);
        accentA = vec3(0.11, 0.72, 0.88);
        accentB = vec3(0.92, 0.56, 0.66);
    } else if (uThemeMode < 1.5) {
        // Clinic Daylight (Warm Porcelain + Soft Pediatric Sky & Sage)
        baseA = vec3(0.935, 0.958, 0.985);
        baseB = vec3(0.865, 0.918, 0.968);
        accentA = vec3(0.24, 0.62, 0.86);
        accentB = vec3(0.18, 0.74, 0.64);
    } else if (uThemeMode < 2.5) {
        // 3AM 630nm Zero-Blue Night Mode (Strictly Red Channel Only - Melanopsin Safe)
        baseA = vec3(0.038, 0.0, 0.0);
        baseB = vec3(0.095, 0.002, 0.0);
        accentA = vec3(0.46, 0.008, 0.0);
        accentB = vec3(0.28, 0.004, 0.0);
    } else {
        // Eco-Glass (Low-Power Dark Emerald Forest Slate)
        baseA = vec3(0.025, 0.062, 0.054);
        baseB = vec3(0.048, 0.112, 0.096);
        accentA = vec3(0.14, 0.76, 0.58);
        accentB = vec3(0.28, 0.62, 0.78);
    }

    vec3 col = mix(baseA, baseB, smoothstep(0.1, 0.9, uv.y * 0.7 + n1 * 0.45));
    float ribbon = smoothstep(0.48, 0.94, waveBand * harmonicWave);
    col = mix(col, accentA, ribbon * (0.20 + energy * 0.14));
    col = mix(col, accentB, smoothstep(0.55, 0.96, n1) * (0.14 + pulse68Bpm * 0.05));
    col += mix(accentA, accentB, 0.45) * catchLight;

    // Gentle clinical vignette
    float vig = 1.0 - smoothstep(0.45, 1.35, length(p));
    col *= mix(0.84, 1.03, vig);

    // Strictly enforce zero green/blue emission in 3AM 630nm mode
    if (uThemeMode > 1.5 && uThemeMode < 2.5) {
        col.g = 0.0;
        col.b = 0.0;
    }

    fragColor = vec4(col, 1.0);
}
