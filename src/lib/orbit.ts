import type { OrbitElements, Vec3 } from '../types';
import { DEG, normalize } from './math';

export const EARTH_RADIUS_KM = 6378.137;
export const EARTH_MU_KM3_S2 = 398600.4418;
export const J2 = 0.0010826267;
export const SOLAR_CONSTANT_WM2 = 1361;

export interface EciState {
  positionKm: Vec3;
  velocityKmS: Vec3;
  altitudeKm: number;
  speedKmS: number;
}

export function orbitalPeriodSec(orbit: OrbitElements): number {
  return 2 * Math.PI * Math.sqrt((orbit.aKm ** 3) / EARTH_MU_KM3_S2);
}

export function meanMotionRadS(orbit: OrbitElements): number {
  return Math.sqrt(EARTH_MU_KM3_S2 / orbit.aKm ** 3);
}

function solveKepler(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 12; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return E;
}

function rotateZ(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}
function rotateX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}

export function propagateEci(orbit: OrbitElements, tSec: number): EciState {
  const n = meanMotionRadS(orbit);
  const M = orbit.meanAnomalyDeg * DEG + n * tSec;
  const e = orbit.eccentricity;
  const E = solveKepler(M, e);
  const sinE = Math.sin(E), cosE = Math.cos(E);
  const sqrtTerm = Math.sqrt(1 - e * e);

  let pos: Vec3 = [orbit.aKm * (cosE - e), orbit.aKm * sqrtTerm * sinE, 0];
  // Perifocal velocity factor.
  const factor = (n * orbit.aKm) / (1 - e * cosE);
  let vel: Vec3 = [-factor * sinE, factor * sqrtTerm * cosE, 0];

  const raan = orbit.raanDeg * DEG;
  const inc = orbit.inclinationDeg * DEG;
  const argp = orbit.argPerigeeDeg * DEG;
  pos = rotateZ(rotateX(rotateZ(pos, argp), inc), raan);
  vel = rotateZ(rotateX(rotateZ(vel, argp), inc), raan);

  const r = Math.hypot(...pos);
  return {
    positionKm: pos,
    velocityKmS: vel,
    altitudeKm: r - EARTH_RADIUS_KM,
    speedKmS: Math.hypot(...vel)
  };
}

/** Low-precision solar vector from Earth toward Sun in mean-equator ECI/J2000-like frame. */
export function sunDirectionEci(date: Date): Vec3 {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360;
  const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * DEG;
  const C =
    Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M) * 0.000289;
  const trueLongitude = (L0 + C) * DEG;
  const epsilon = (23.439291 - T * (0.0130042 + 0.00000016 * T)) * DEG;
  return normalize([
    Math.cos(trueLongitude),
    Math.cos(epsilon) * Math.sin(trueLongitude),
    Math.sin(epsilon) * Math.sin(trueLongitude)
  ]);
}

export function orbitDate(orbit: OrbitElements, tSec: number): Date {
  return new Date(new Date(orbit.epochISO).getTime() + tSec * 1000);
}

export function earthShadowFactor(positionKm: Vec3, sunEci: Vec3): number {
  const r = positionKm;
  const alongSun = r[0] * sunEci[0] + r[1] * sunEci[1] + r[2] * sunEci[2];
  if (alongSun >= 0) return 1;
  const projected: Vec3 = [
    r[0] - alongSun * sunEci[0],
    r[1] - alongSun * sunEci[1],
    r[2] - alongSun * sunEci[2]
  ];
  const perp = Math.hypot(...projected);
  // Soft penumbra over 25 km; core umbra radius is slightly smaller than Earth.
  const umbra = EARTH_RADIUS_KM - 18;
  if (perp < umbra) return 0;
  if (perp < EARTH_RADIUS_KM + 8) return (perp - umbra) / (EARTH_RADIUS_KM + 26 - umbra);
  return 1;
}

export function isInEarthShadow(positionKm: Vec3, sunEci: Vec3): boolean {
  return earthShadowFactor(positionKm, sunEci) < 0.5;
}

export function ssoInclinationDeg(aKm: number): number {
  const n = Math.sqrt(EARTH_MU_KM3_S2 / aKm ** 3);
  const desiredRadiansPerSec = (2 * Math.PI) / (365.2422 * 86400);
  const factor = 1.5 * J2 * n * (EARTH_RADIUS_KM / aKm) ** 2;
  const cosI = -desiredRadiansPerSec / factor;
  return Math.acos(Math.max(-1, Math.min(1, cosI))) / DEG;
}

export function betaAngleDeg(orbit: OrbitElements, sunEci: Vec3): number {
  // Orbit normal from circular-ish averaged elements.
  const inc = orbit.inclinationDeg * DEG;
  const raan = orbit.raanDeg * DEG;
  const h: Vec3 = [
    Math.sin(inc) * Math.sin(raan),
    -Math.sin(inc) * Math.cos(raan),
    Math.cos(inc)
  ];
  return Math.asin(Math.max(-1, Math.min(1, h[0] * sunEci[0] + h[1] * sunEci[1] + h[2] * sunEci[2]))) / DEG;
}

export function findEclipseIntervals(
  orbit: OrbitElements,
  sunEciAtEpoch: Vec3,
  periodSec: number
): Array<{ startSec: number; endSec: number }> {
  // Date sun vector changes negligibly across one LEO period.
  const samples = 720;
  const dt = periodSec / samples;
  const flags: boolean[] = [];
  for (let i = 0; i <= samples; i++) {
    const st = propagateEci(orbit, i * dt);
    flags.push(isInEarthShadow(st.positionKm, sunEciAtEpoch));
  }
  const intervals: Array<{ startSec: number; endSec: number }> = [];
  let start: number | null = null;
  const threshold = (t: number) => {
    const st = propagateEci(orbit, t);
    return earthShadowFactor(st.positionKm, sunEciAtEpoch) - 0.5;
  };
  const refine = (a: number, b: number, want: boolean) => {
    let lo = a, hi = b;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      const shadow = threshold(mid) < 0;
      if (shadow === want) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  for (let i = 1; i <= samples; i++) {
    if (flags[i] && !flags[i - 1]) {
      const root = refine((i - 1) * dt, i * dt, true);
      start = root;
    }
    if (!flags[i] && flags[i - 1] && start !== null) {
      const end = refine((i - 1) * dt, i * dt, false);
      intervals.push({ startSec: start, endSec: end });
      start = null;
    }
  }
  if (start !== null) intervals.push({ startSec: start, endSec: periodSec });
  return intervals;
}
