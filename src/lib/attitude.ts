import type { AttitudeConfig, Quat, Vec3 } from '../types';
import {
  quatConjugate,
  quatFromAxisAngle,
  quatFromTo,
  quatMultiply,
  quatNormalize,
  quatSlerp,
  rotateVec,
  smoothstep,
  normalize,
  cross
} from './math';
import type { EciState } from './orbit';

function quatFromBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Quat {
  // Column-major rotation matrix; convert R (body->ECI) to quaternion.
  const m00 = xAxis[0], m10 = xAxis[1], m20 = xAxis[2];
  const m01 = yAxis[0], m11 = yAxis[1], m21 = yAxis[2];
  const m02 = zAxis[0], m12 = zAxis[1], m22 = zAxis[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return quatNormalize([(m12 - m21) / s, (m20 - m02) / s, (m01 - m10) / s, 0.25 * s]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return quatNormalize([0.25 * s, (m01 + m10) / s, (m20 + m02) / s, (m12 - m21) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return quatNormalize([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m20 - m02) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return quatNormalize([(m20 + m02) / s, (m12 + m21) / s, 0.25 * s, (m01 - m10) / s]);
}

export function nadirQuaternion(state: EciState): Quat {
  const z = normalize(state.positionKm.map((x) => -x) as Vec3);
  const h = normalize(cross(state.positionKm, state.velocityKmS));
  const y = [-h[0], -h[1], -h[2]] as Vec3;
  const x = normalize(cross(y, z));
  const yOrtho = cross(z, x);
  return quatFromBasis(x, yOrtho, z);
}

export function baseAttitudeQuaternion(
  config: AttitudeConfig,
  state: EciState,
  sunEci: Vec3
): Quat {
  if (config.mode === 'nadir') return nadirQuaternion(state);
  if (config.mode === 'sun') {
    // Preset convention: body +X is the Sun-tracking axis; +Z is kept near nadir/up reference.
    const nadir = normalize(state.positionKm.map((x) => -x) as Vec3);
    return quatFromTo([1, 0, 0], sunEci, nadir);
  }
  return quatNormalize(config.inertialQuat);
}

export function attitudeAt(
  config: AttitudeConfig,
  state: EciState,
  sunEci: Vec3,
  tSec: number
): Quat {
  let q = baseAttitudeQuaternion(config, state, sunEci);
  const offset = quatFromAxisAngle([0, 0, 1], 0); // placeholder to keep import grouping explicit
  void offset;
  // Fixed body offset XYZ.
  const rx = quatFromAxisAngle([1, 0, 0], (config.offsetDeg[0] * Math.PI) / 180);
  const ry = quatFromAxisAngle([0, 1, 0], (config.offsetDeg[1] * Math.PI) / 180);
  const rz = quatFromAxisAngle([0, 0, 1], (config.offsetDeg[2] * Math.PI) / 180);
  q = quatMultiply(q, quatMultiply(rz, quatMultiply(ry, rx)));

  for (const m of config.maneuvers) {
    const p = smoothstep((tSec - m.startSec) / Math.max(0.001, m.durationSec));
    if (p <= 0) continue;
    if (m.kind === 'quaternion' && m.targetQuat) {
      const dq = quatSlerp([0, 0, 0, 1], m.targetQuat, p);
      q = quatMultiply(q, dq);
    } else {
      const axis: Vec3 = m.kind === 'yaw' ? [0, 0, 1] : m.kind === 'roll' ? [1, 0, 0] : (m.axis ?? [0, 0, 1]);
      const angle = (m.angleDeg * Math.PI) / 180;
      q = quatMultiply(q, quatFromAxisAngle(axis, angle * p));
    }
  }
  return quatNormalize(q);
}

export function toBodyFrame(qBodyToEci: Quat, vectorEci: Vec3): Vec3 {
  return rotateVec(quatConjugate(qBodyToEci), vectorEci);
}
