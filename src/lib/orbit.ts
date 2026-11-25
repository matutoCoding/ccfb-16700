import type { OrbitalElements, OrbitState, Vec3 } from '../types';
import { TAU, clamp, deg2rad, normalize, quatIdentity, smoothstep } from './math';

const MU_KM3_S2 = 398600.4418;
const J2 = 1.08262668e-3;
const EARTH_RADIUS_KM = 6378.137;
const SOLAR_RADIUS_KM = 695700;
const AU_KM = 149597870.7;

export function mod2pi(x: number): number {
  return ((x % TAU) + TAU) % TAU;
}

export function orbitalPeriodSec(orbit: OrbitalElements): number {
  const a = orbit.semiMajorAxisKm;
  return TAU * Math.sqrt((a * a * a) / MU_KM3_S2);
}

/** Sun-synchronous inclination from J2 nodal regression. */
export function sunSynchronousInclinationDeg(aKm: number, eccentricity = 0): number {
  const a = aKm;
  const n = Math.sqrt(MU_KM3_S2 / (a * a * a));
  const p = a * (1 - eccentricity * eccentricity);
  const nodalRegressionCoefficient = 1.5 * J2 * n * Math.pow(EARTH_RADIUS_KM / p, 2);
  const target = TAU / (365.256 * 86400); // rad/s, mean solar progression
  const cosI = -target / nodalRegressionCoefficient;
  return Math.acos(clamp(cosI, -0.999999, 0.999999)) * 180 / Math.PI;
}

export function julianDate(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

/** Low-precision geocentric Sun unit vector in ECI, good enough for LEO lighting. */
export function sunECI(date: Date): Vec3 {
  const jd = julianDate(date);
  const T = (jd - 2_451_545.0) / 36_525;
  const mod360 = (x: number) => ((x % 360) + 360) % 360;
  const L0 = mod360(280.46646 + T * (36_000.76983 + T * 0.0003032));
  const M = mod360(357.52911 + T * (35_999.05029 - 0.0001537 * T));
  const Mrad = deg2rad(M);
  const C =
    Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mrad) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = deg2rad(trueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(omega)));
  const seconds = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
  const epsilon0 = 23 + (26 + seconds / 60) / 60;
  const epsilon = deg2rad(epsilon0 + 0.00256 * Math.cos(deg2rad(omega)));
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  return normalize([
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  ]);
}

function rotateECI(rPqw: Vec3, orbit: OrbitalElements): Vec3 {
  const O = deg2rad(orbit.raanDeg);
  const i = deg2rad(orbit.inclinationDeg);
  const w = deg2rad(orbit.argPerigeeDeg);
  // Rz(O) Rx(i) Rz(w) * r
  const cO = Math.cos(O), sO = Math.sin(O);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(w), sw = Math.sin(w);
  const [x, y, z] = rPqw;
  // Rz(w)
  const x1 = cw * x - sw * y;
  const y1 = sw * x + cw * y;
  // Rx(i)
  const x2 = x1;
  const y2 = ci * y1 - si * z;
  const z2 = si * y1 + ci * z;
  // Rz(O)
  return [cO * x2 - sO * y2, sO * x2 + cO * y2, z2];
}

export interface BaseOrbitState {
  tSec: number;
  dateISO: string;
  positionECI: Vec3;
  velocityECI: Vec3;
  sunECI: Vec3;
  nadirECI: Vec3;
  sunDotRadial: number;
  eclipseFactor: number;
  inEclipse: boolean;
  earthAngularRadiusRad: number;
  earthSunlitFactor: number;
}

export function orbitStateAt(orbit: OrbitalElements, startISO: string, tSec: number, earthRadiusKm = EARTH_RADIUS_KM): BaseOrbitState {
  const start = new Date(startISO);
  const epoch = new Date(orbit.epochISO);
  const totalSec = (start.getTime() - epoch.getTime()) / 1000 + tSec;
  const a = orbit.semiMajorAxisKm;
  const e = clamp(orbit.eccentricity, 0, 0.95);
  const n = Math.sqrt(MU_KM3_S2 / (a * a * a));
  const M = mod2pi(deg2rad(orbit.meanAnomaly0Deg) + n * totalSec);

  // Newton solution of Kepler equation.
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 12; k++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const sqrtOneE2 = Math.sqrt(1 - e * e);
  const nu = Math.atan2(sqrtOneE2 * sinE, cosE - e);
  const rMag = a * (1 - e * cosE);
  const rPqw: Vec3 = [rMag * Math.cos(nu), rMag * Math.sin(nu), 0];
  const p = a * (1 - e * e);
  const vFactor = Math.sqrt(MU_KM3_S2 / p);
  const vPqw: Vec3 = [-vFactor * Math.sin(nu), vFactor * (e + Math.cos(nu)), 0];
  const positionECI = rotateECI(rPqw, orbit);
  const velocityECI = rotateECI(vPqw, orbit);
  const radial = normalize(positionECI);
  const nadirECI: Vec3 = [-radial[0], -radial[1], -radial[2]];

  const date = new Date(start.getTime() + tSec * 1000);
  const s = sunECI(date);
  const R = Math.hypot(positionECI[0], positionECI[1], positionECI[2]);
  const rhoEarth = Math.asin(clamp(earthRadiusKm / R, -1, 1));
  const rhoSun = Math.asin(SOLAR_RADIUS_KM / AU_KM);
  const separation = Math.acos(clamp(dot(s, nadirECI), -1, 1));
  let eclipseFactor = 1;
  if (separation <= rhoEarth - rhoSun) eclipseFactor = 0;
  else if (separation < rhoEarth + rhoSun) {
    eclipseFactor = smoothstep(rhoEarth - rhoSun, rhoEarth + rhoSun, separation);
  }
  const sunDotRadial = dot(s, radial);
  const earthSunlitFactor = eclipseFactor * smoothstep(-0.25, 0.45, sunDotRadial);

  return {
    tSec,
    dateISO: date.toISOString(),
    positionECI,
    velocityECI,
    sunECI: s,
    nadirECI,
    sunDotRadial,
    eclipseFactor,
    inEclipse: eclipseFactor < 0.5,
    earthAngularRadiusRad: rhoEarth,
    earthSunlitFactor,
  };
}

// Local dot to avoid importing a second named cycle awkwardly.
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function buildOrbitStates(
  orbit: OrbitalElements,
  dateISO: string,
  stepSec: number,
  earthRadiusKm = EARTH_RADIUS_KM,
): { states: OrbitState[]; periodSec: number } {
  const periodSec = orbitalPeriodSec(orbit);
  const count = Math.max(2, Math.floor(periodSec / stepSec) + 1);
  const states: OrbitState[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(periodSec, i * stepSec);
    const base = orbitStateAt(orbit, dateISO, t, earthRadiusKm);
    states.push({
      ...base,
      bodyToECI: quatIdentity(),
      sunBody: base.sunECI,
      earthBody: base.nadirECI,
    });
  }
  return { states, periodSec };
}

export function findEclipseIntervals(states: OrbitState[]): Array<{ startSec: number; endSec: number; startIndex: number; endIndex: number }> {
  const intervals: Array<{ startSec: number; endSec: number; startIndex: number; endIndex: number }> = [];
  let start: number | null = null;
  let startIndex = -1;
  for (let i = 0; i < states.length; i++) {
    const ecl = states[i].eclipseFactor < 0.5;
    if (ecl && start === null) {
      start = states[i].tSec;
      startIndex = i;
    }
    if ((!ecl || i === states.length - 1) && start !== null) {
      const endIndex = ecl && i === states.length - 1 ? i : i - 1;
      intervals.push({ startSec: start, endSec: states[endIndex].tSec, startIndex, endIndex });
      start = null;
    }
  }
  return intervals;
}
