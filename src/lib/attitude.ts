import type { AttitudeConfig, OrbitState, Quat, Vec3 } from '../types';
import { clamp, cross, normalize, quatConjugate, quatFromAxisAngle, quatFromBasis, quatFromEuler, quatMultiply, quatRotateVec, quatSlerp, smoothstep } from './math';

const AXIS_VECTORS: Record<'yaw' | 'pitch' | 'roll', Vec3> = {
  yaw: [0, 0, 1],
  pitch: [0, 1, 0],
  roll: [1, 0, 0],
};

function quatFromUnitVectors(a: Vec3, b: Vec3): Quat {
  const av = normalize(a);
  const bv = normalize(b);
  const d = clamp(av[0] * bv[0] + av[1] * bv[1] + av[2] * bv[2], -1, 1);
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    let axis = cross([1, 0, 0], av);
    if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-6) axis = cross([0, 1, 0], av);
    return quatFromAxisAngle(normalize(axis), Math.PI);
  }
  const axis = normalize(cross(av, bv));
  // half-angle formula is more stable than acos(d)/2.
  const w = Math.sqrt((1 + d) / 2);
  const s = Math.sqrt((1 - d) / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, w];
}

export function baseAttitudeQuat(attitude: AttitudeConfig, state: OrbitState): Quat {
  if (attitude.mode === 'inertial') {
    return quatFromEuler(
      attitude.inertialEuler.yaw,
      attitude.inertialEuler.pitch,
      attitude.inertialEuler.roll,
    );
  }

  if (attitude.mode === 'nadir') {
    // Body +Z points to nadir; body +X follows the velocity projection.
    const zAxis = normalize(state.nadirECI);
    let xAxis: Vec3 = [state.velocityECI[0], state.velocityECI[1], state.velocityECI[2]];
    const projection = xAxis[0] * zAxis[0] + xAxis[1] * zAxis[1] + xAxis[2] * zAxis[2];
    xAxis = normalize([
      xAxis[0] - zAxis[0] * projection,
      xAxis[1] - zAxis[1] * projection,
      xAxis[2] - zAxis[2] * projection,
    ]);
    if (Math.hypot(xAxis[0], xAxis[1], xAxis[2]) < 1e-6) xAxis = [1, 0, 0];
    const yAxis = normalize(cross(zAxis, xAxis));
    return quatFromBasis(xAxis, yAxis, zAxis);
  }

  // Sun pointing. The selected body axis is aligned with the Sun vector.
  const targetAxis: Vec3 =
    attitude.sunTrackingAxis === 'x' ? [1, 0, 0] :
    attitude.sunTrackingAxis === 'z' ? [0, 0, 1] :
    [0, 0, 1];
  return quatFromUnitVectors(targetAxis, state.sunECI);
}

export function maneuverOffsetQuat(attitude: AttitudeConfig, tSec: number): Quat {
  let q: Quat = [0, 0, 0, 1];
  for (const m of attitude.maneuvers) {
    const enterEnd = m.startSec + Math.max(0, m.enterDurationSec);
    const holdEnd = enterEnd + Math.max(0, m.holdDurationSec);
    const exitEnd = holdEnd + Math.max(0, m.exitDurationSec);
    if (tSec < m.startSec || tSec > exitEnd + 1e-6) continue;
    const target = quatFromAxisAngle(AXIS_VECTORS[m.axis], (m.angleDeg * Math.PI) / 180);
    let local: Quat = [0, 0, 0, 1];
    if (tSec < enterEnd) {
      const u = smoothstep(m.startSec, enterEnd, tSec);
      local = quatSlerp([0, 0, 0, 1], target, u);
    } else if (tSec <= holdEnd) {
      local = target;
    } else {
      const u = smoothstep(holdEnd, exitEnd, tSec);
      local = quatSlerp(target, [0, 0, 0, 1], u);
    }
    // Body-frame maneuver offsets are composed in chronological list order.
    q = quatMultiply(q, local);
  }
  return q;
}

export function attitudeQuatAt(attitude: AttitudeConfig, state: OrbitState): Quat {
  const base = baseAttitudeQuat(attitude, state);
  const offset = maneuverOffsetQuat(attitude, state.tSec);
  return quatMultiply(base, offset);
}

export function bodyVectorsForState(q: Quat, state: OrbitState): { sunBody: Vec3; earthBody: Vec3 } {
  const inv = quatConjugate(q);
  return {
    sunBody: normalize(quatRotateVec(inv, state.sunECI)),
    earthBody: normalize(quatRotateVec(inv, state.nadirECI)),
  };
}
