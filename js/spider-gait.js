// Pure gait maths for the Spider-Man rig: no three.js, so the tests can run it directly (tests/spider-gait.test.cjs).
// A run cycle is driven by one phase (0..1). Each foot follows a stance path (planted on the ground, moving backwards relative to the hips
// at exactly the ground speed, so there is no foot sliding) and a swing path (lifted, travelling forward). Legs are then solved with a
// two-bone IK, which gives believable knee bend, hip height and foot placement at every speed instead of a fixed thigh swing.
// Units: metres, seconds. +z forward, +y up, +x the character's left.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Live tuning multipliers (spider-tuning.js): cadence scales the cycle frequency, lift the foot lift, lean is read by the rig.
const GAIT = { cadence: 1, lift: 1, lean: 1, armSwing: 1 };

// cycles per second at a given ground speed (walk .. jog .. run .. sprint)
const FREQ = [[0, 1.0], [1.5, 1.08], [4, 1.75], [8.5, 2.2], [15, 2.9]];
function cadence(speed) {
  if (speed <= FREQ[0][0]) return FREQ[0][1];
  for (let i = 1; i < FREQ.length; i++) {
    if (speed <= FREQ[i][0]) { const [s0, f0] = FREQ[i - 1], [s1, f1] = FREQ[i]; return lerp(f0, f1, (speed - s0) / (s1 - s0)); }
  }
  return FREQ[FREQ.length - 1][1];
}

/** Gait parameters for a ground speed: cycle frequency, stride length, stance span, duty factor (fraction of the cycle a foot is planted) and foot lift. */
function gaitParams(speed, out = {}) {
  const u = clamp(speed / 8.5, 0, 1), v = clamp((speed - 8.5) / 6.5, 0, 1);
  const freq = cadence(speed) * GAIT.cadence, stride = speed / freq;
  const span = Math.min(0.78 + 0.14 * v, stride * 0.55);
  out.freq = freq; out.stride = stride; out.span = span;
  out.duty = stride > 1e-3 ? clamp(span / stride, 0.14, 0.64) : 0.64;
  out.lift = (0.05 + 0.15 * u + 0.12 * v) * GAIT.lift;
  out.u = u; out.v = v;
  return out;
}

const easeInOut = (p) => p * p * (3 - 2 * p);

/**
 * One foot at a phase. z is relative to the hips (forward positive), y is the lift above the ground, pitch is the foot's world pitch
 * (positive = toes down, heel up) and fwd in about [-1, 1] says how far forward the foot is (used to counter-swing arms and twist the torso).
 */
function footTrajectory(phase, gp, out = {}) {
  const ph = phase - Math.floor(phase), duty = gp.duty, span = gp.span;
  if (ph < duty) { // stance: the foot is planted and travels backwards relative to the body
    const s = ph / duty;
    out.z = span * (0.5 - s);
    out.y = 0;
    out.pitch = -0.14 + 0.72 * s * s * s; // heel strike, flat, then the heel lifts for push-off
    out.stance = true;
  } else { // swing: lifted and carried forward; the heel recovers early (peak before the middle)
    const p = (ph - duty) / (1 - duty);
    out.z = lerp(-span * 0.5, span * 0.5, easeInOut(p));
    out.y = gp.lift * Math.sin(Math.PI * Math.pow(p, 0.78));
    out.pitch = lerp(0.58, -0.14, smoothstep(0.1, 1, p));
    out.stance = false;
  }
  out.fwd = clamp(out.z / (span * 0.5 || 1), -1.1, 1.1);
  return out;
}

/**
 * Two-bone IK in 3D. H = hip joint, F = wanted ankle position, a / b = thigh and shank lengths, pole = direction the knee should point
 * (it is projected perpendicular to the hip-foot line). Returns the knee position and the unit directions of both bones; the foot target is
 * pulled in if it is out of reach. All vectors are plain {x, y, z}.
 */
function twoBoneIK(H, F, a, b, pole, out = {}) {
  let dx = F.x - H.x, dy = F.y - H.y, dz = F.z - H.z;
  let L = Math.hypot(dx, dy, dz);
  if (L < 1e-6) { dx = 0; dy = -1; dz = 0; L = 1e-6; }
  dx /= L; dy /= L; dz /= L;
  const Lc = clamp(L, Math.abs(a - b) + 0.01, a + b - 0.004);
  const cosA = clamp((a * a + Lc * Lc - b * b) / (2 * a * Lc), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  let px = pole.x, py = pole.y, pz = pole.z;
  const d = px * dx + py * dy + pz * dz;
  px -= dx * d; py -= dy * d; pz -= dz * d;
  let pm = Math.hypot(px, py, pz);
  if (pm < 1e-5) { px = 0; py = 0; pz = 1; const d2 = dz; px -= dx * d2; py -= dy * d2; pz -= dz * d2; pm = Math.hypot(px, py, pz) || 1; }
  px /= pm; py /= pm; pz /= pm;
  const kx = H.x + dx * a * cosA + px * a * sinA, ky = H.y + dy * a * cosA + py * a * sinA, kz = H.z + dz * a * cosA + pz * a * sinA;
  const ax = H.x + dx * Lc, ay = H.y + dy * Lc, az = H.z + dz * Lc; // ankle actually reached
  let tx = kx - H.x, ty = ky - H.y, tz = kz - H.z, tm = Math.hypot(tx, ty, tz) || 1;
  let sx = ax - kx, sy = ay - ky, sz = az - kz, sm = Math.hypot(sx, sy, sz) || 1;
  out.knee = out.knee || { x: 0, y: 0, z: 0 };
  out.knee.x = kx; out.knee.y = ky; out.knee.z = kz;
  out.thigh = out.thigh || { x: 0, y: 0, z: 0 };
  out.thigh.x = tx / tm; out.thigh.y = ty / tm; out.thigh.z = tz / tm;
  out.shank = out.shank || { x: 0, y: 0, z: 0 };
  out.shank.x = sx / sm; out.shank.y = sy / sm; out.shank.z = sz / sm;
  out.reached = L <= a + b - 0.004;
  return out;
}

export { clamp, lerp, smoothstep, cadence, gaitParams, footTrajectory, twoBoneIK, GAIT };
