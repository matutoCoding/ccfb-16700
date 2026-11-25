export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x,y,z,w
export type ID = string;

export type PrimitiveKind = 'box' | 'cylinder' | 'plate';
export type ComponentRole = 'bus' | 'antenna' | 'shroud' | 'instrument' | 'other';

export interface EulerAngles {
  yaw: number;   // deg, about body Z
  pitch: number; // deg, about body Y
  roll: number;  // deg, about body X
}

export interface GeometricPrimitive {
  id: ID;
  name: string;
  kind: PrimitiveKind;
  role: ComponentRole;
  position: Vec3;
  rotation: EulerAngles;
  /** box/plate full dimensions [x,y,z] in m. Plate normally has a thin z. */
  size: Vec3;
  /** cylinder radius in m */
  radius: number;
  /** cylinder height in m, axis = local Y */
  height: number;
  color: string;
  reflectivity: number; // 0..1, used by multi-bounce approximation
  castsShadow: boolean;
}

export type StringDirection = 'column' | 'row';

export interface SolarWing {
  id: ID;
  name: string;
  position: Vec3;          // hinge position in body frame, m
  hingeAxis: Vec3;         // deployment rotation axis in body frame
  deploymentAngleDeg: number;
  driveAngleDeg: number;   // rotation about deployed span axis
  cols: number;            // cell count along local X / span
  rows: number;            // cell count along local Y / width
  cellLengthM: number;     // local X
  cellWidthM: number;      // local Y
  gapXM: number;
  gapYM: number;
  edgeMarginM: number;
  cellEfficiency: number;
  cellVmpV: number;
  cellVocV: number;
  /** Number of cells in one series string. 0 means one full column/row. */
  cellsPerString: number;
  /** Number of series cells covered by one bypass diode. */
  bypassGroupSize: number;
  bypassDiodeVoltageV: number;
  bypassEnabled: boolean;
  stringDirection: StringDirection;
  mpptPerString: boolean;
  substrateColor: string;
  cellColor: string;
}

export interface SatelliteModel {
  id: ID;
  name: string;
  massClassKg: number;
  description: string;
  primitives: GeometricPrimitive[];
  wings: SolarWing[];
  updatedAt: number;
  builtIn?: boolean;
}

export interface OrbitalElements {
  semiMajorAxisKm: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argPerigeeDeg: number;
  meanAnomaly0Deg: number;
  epochISO: string;
}

export type AttitudeMode = 'nadir' | 'sun' | 'inertial';
export type ManeuverAxis = 'yaw' | 'pitch' | 'roll';

export interface AttitudeManeuver {
  id: ID;
  name: string;
  startSec: number;
  enterDurationSec: number;
  holdDurationSec: number;
  exitDurationSec: number;
  axis: ManeuverAxis;
  angleDeg: number;
}

export interface AttitudeConfig {
  mode: AttitudeMode;
  inertialEuler: EulerAngles;
  sunTrackingAxis: 'normal' | 'x' | 'z';
  maneuvers: AttitudeManeuver[];
}

export interface SimulationSettings {
  stepSec: number;
  shadowSamplesPerAxis: number;
  solarConstantWm2: number;
  earthAlbedo: number;
  earthRadiusKm: number;
  multiBounceEnabled: boolean;
  bounceRaysPerCell: number;
  bounceCount: number;
  bodyReflectance: number;
  cellReflectance: number;
  nominalLoadW: number;
  useGpu: boolean;
  currentTablePoints: number;
}

export interface WorkspacePlan {
  id: ID;
  name: string;
  model: SatelliteModel;
  orbit: OrbitalElements;
  attitude: AttitudeConfig;
  dateISO: string;
  settings: SimulationSettings;
  updatedAt: number;
}

export interface CompareCase {
  id: ID;
  name: string;
  savedAt: number;
  model: SatelliteModel;
  attitude: AttitudeConfig;
  /** Cases are compared with the page's shared orbit/date. */
  orbitSnapshot?: OrbitalElements;
  dateSnapshot?: string;
  notes?: string;
}

export interface CellRecord {
  cellId: string;
  wingId: string;
  wingName: string;
  index: number;
  col: number;
  row: number;
  stringId: string;
  stringIndex: number;
  bypassGroupId: string;
  centerBody: Vec3;
  normalBody: Vec3;
  axisUBody: Vec3;
  axisVBody: Vec3;
  halfU: number;
  halfV: number;
  areaM2: number;
  ratedPowerW: number;
  ratedIscA: number;
}

export interface OrbitState {
  tSec: number;
  dateISO: string;
  positionECI: Vec3; // km
  velocityECI: Vec3; // km/s
  sunECI: Vec3;
  nadirECI: Vec3;
  sunDotRadial: number;
  eclipseFactor: number; // 1 full sun, 0 umbra, smooth penumbra
  inEclipse: boolean;
  earthAngularRadiusRad: number;
  earthSunlitFactor: number;
  bodyToECI: Quat;
  sunBody: Vec3;
  earthBody: Vec3;
}

export interface CellIllumination {
  litFraction: number;
  cosine: number;
  directWm2: number;
  albedoWm2: number;
  bounceWm2: number;
  totalWm2: number;
}

export interface StringPowerResult {
  stringId: string;
  wingId: string;
  currentA: number;
  voltageV: number;
  powerW: number;
  bypassedGroups: number;
  totalGroups: number;
  minIlluminationRatio: number;
}

export interface EpochPowerResult {
  index: number;
  tSec: number;
  dateISO: string;
  eclipseFactor: number;
  inEclipse: boolean;
  sunAngleDeg: number;
  directPowerW: number;
  albedoPowerW: number;
  bouncePowerW: number;
  totalPowerW: number;
  stringResults: StringPowerResult[];
  cellIllumination: CellIllumination[];
}

export interface SimulationResult {
  planId: string;
  ranAt: number;
  engine: 'webgpu' | 'cpu' | 'mixed';
  elapsedMs: number;
  epochCount: number;
  cellCount: number;
  orbitPeriodSec: number;
  epochs: EpochPowerResult[];
  orbitStates: OrbitState[];
  minTotal: { powerW: number; tSec: number; index: number; dateISO: string };
  minSunlit: { powerW: number; tSec: number; index: number; dateISO: string } | null;
  eclipseIntervals: Array<{ startSec: number; endSec: number; startIndex: number; endIndex: number }>;
  energyWh: number;
  cosineCheck: { maxErrorPct: number; passed: boolean; samples: number };
}

export interface ToastMessage {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}
