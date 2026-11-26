import { ref, watch, onUnmounted } from 'vue';

/**
 * PEDIA-SPECTRA Hooke's Law Damped Harmonic Oscillator (Spring Physics ODE)
 *   a(t) = ( -k * (x - target) - c * v ) / m
 * Default clinical tuning: stiffness (k) = 180, damping (c) = 22, mass (m) = 1.
 * Used for 1:1 oral syringe plunger actuation, liquid gauge needles, and dock springs.
 */
export function useSpringPhysics(targetSource, options = {}) {
  const stiffness = options.stiffness ?? 180;
  const damping = options.damping ?? 22;
  const mass = options.mass ?? 1;
  const precision = options.precision ?? 0.001;

  const initialVal = typeof targetSource === 'function'
    ? targetSource()
    : (targetSource && typeof targetSource === 'object' && 'value' in targetSource ? targetSource.value : Number(targetSource) || 0);

  const current = ref(initialVal);
  const velocity = ref(0);
  let targetValue = initialVal;
  let rafId = null;
  let lastTimestamp = 0;

  function step(now) {
    if (!lastTimestamp) {
      lastTimestamp = now;
    }
    const dt = Math.min(0.032, Math.max(0.001, (now - lastTimestamp) / 1000));
    lastTimestamp = now;

    // Semi-implicit Euler integration (2 substeps for guaranteed stability at high stiffness)
    const subDt = dt * 0.5;
    let x = current.value;
    let v = velocity.value;

    for (let i = 0; i < 2; i++) {
      const springForce = -stiffness * (x - targetValue);
      const dampingForce = -damping * v;
      const accel = (springForce + dampingForce) / mass;
      v += accel * subDt;
      x += v * subDt;
    }

    current.value = x;
    velocity.value = v;

    const settled = Math.abs(targetValue - x) < precision && Math.abs(v) < precision;
    if (settled) {
      current.value = targetValue;
      velocity.value = 0;
      rafId = null;
      lastTimestamp = 0;
      return;
    }

    rafId = requestAnimationFrame(step);
  }

  function setTarget(nextTarget) {
    const numeric = Number(nextTarget);
    if (!Number.isFinite(numeric)) return;
    targetValue = numeric;
    if (rafId === null) {
      lastTimestamp = 0;
      rafId = requestAnimationFrame(step);
    }
  }

  if (typeof targetSource === 'function' || (targetSource && typeof targetSource === 'object' && 'value' in targetSource)) {
    watch(targetSource, (val) => {
      setTarget(val);
    }, { immediate: false });
  }

  onUnmounted(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  });

  return {
    current,
    velocity,
    setTarget,
  };
}
