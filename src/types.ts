export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type ID = string;

export type PrimitiveKind = 'box' | 'cylinder' | 'plate';
export type ComponentRole = 'bus' | 'antenna' | 'shield' | 'solar-panel' | 'mechanism' | 'other';

export interface Primitive {
  id: ID;
  name: string;
  kind: PrimitiveKind;
  role: ComponentRole;
  position: Vec3;
  /** Euler XYZ angles in degrees, applied as Rz * Ry * Rx? Use quaternionFromEuler to one convention. */
  rotationDeg: Vec3;
  /** box/plate: [x,y,z] full dimensions; cylinder: [radius, length, unused]. */
  dimensions: Vec3;
  reflectivity: number;
  occluder: boolean;
}

export interface CellLayout {
  rows: number;
  cols: number;
  cellWidth: number;
  cellHeight: number;
  gapX: number;
  gapY: number;
  /** grid axis mapping in panel local frame */
  axisU: Vec3;
  axisV: Vec3;
  normal: Vec3;
  centerOffset: Vec3;
}

export interface StringSpec {
  id: ID;
  name: string;
  /** number of cells; cell assignment is sequential in the array's serpentine index order. */
  cellCount: number;
  /** consecutive cells protected by one bypass diode. */
  bypassGroupSize: number;
}

export interface SolarArrayConfig {
  id: ID;
  name: string;
  rootPosition: Vec3;
  hingeAxis: Vec3;
  /** Hinge deployment angle, degrees. 0 = stowed, 90 = deployed in presets. */
  hingeAngleDeg: number;
  /** Drive/SADA rotation after hinge, degrees. */
  driveAngleDeg: number;
  driveAxisLocal: Vec3;
  layout: CellLayout;
  strings: StringSpec[];
  panelThickness: number;
  reflectivity: number;
}

export interface SatelliteConfig {
  name: string;
  massKg: number;
  busPowerW: number;
  payloadPowerW: number;
  primitives: Primitive[];
  arrays: SolarArrayConfig[];
}

export interface OrbitElements {
  /** semi-major axis, km */
  aKm: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argPerigeeDeg: number;
  meanAnomalyDeg: number;
  epochISO: string;
}

export type AttitudeMode = 'nadir' | 'sun' | 'inertial';

export interface Maneuver {
  id: ID;
  kind: 'yaw' | 'roll' | 'quaternion';
  /** seconds from simulation start */
  startSec: number;
  durationSec: number;
  angleDeg: number;
  axis?: Vec3;
  targetQuat?: Quat;
}

export interface AttitudeConfig {
  mode: AttitudeMode;
  /** inertial mode body->ECI quaternion */
  inertialQuat: Quat;
  /** extra fixed body rotation, degrees XYZ */
  offsetDeg: Vec3;
  maneuvers: Maneuver[];
}

export interface ElectricalConfig {
  /** Standard test irradiance W/m2 */
  referenceIrradiance: number;
  /** Cell current at reference irradiance, A */
  referenceCurrentA: number;
  /** Effective MPP cell voltage used by the string-level MPPT model, V */
  mppCellVoltageV: number;
  bypassDiodeDropV: number;
  /** Temperature factor reserved for settings; validation uses 1 at reference temperature. */
  temperatureCoefficient: number;
}

export interface SimulationConfig {
  stepSec: number;
  samplesPerCellAxis: number;
  earthAlbedo: number;
  /** empirical fraction for body/panel multiple reflection */
  bounceCoefficient: number;
  enableEarthAlbedo: boolean;
  enableMultiBounce: boolean;
  enableSelfShadow: boolean;
}

export interface ScenarioCase {
  id: ID;
  name: string;
  description: string;
  builtIn?: boolean;
  createdAt: number;
  updatedAt: number;
  geometry: SatelliteConfig;
  orbit: OrbitElements;
  attitude: AttitudeConfig;
  electrical: ElectricalConfig;
  simulation: SimulationConfig;
}

export interface OccluderRuntime {
  sourceId: ID;
  name: string;
  /** 0 = oriented box/plate, 1 = cylinder */
  kind: 0 | 1;
  model: Float32Array;
  inverse: Float32Array;
  radius: number;
  length: number;
  reflectivity: number;
}

export interface CellRecord {
  cellId: ID;
  arrayId: ID;
  stringId: ID;
  indexInArray: number;
  row: number;
  col: number;
  centerBody: Vec3;
  normalBody: Vec3;
  tangentU: Vec3;
  tangentV: Vec3;
  width: number;
  height: number;
  areaM2: number;
  selfOccluder: number;
}

export interface StepEnvironment {
  tSec: number;
  sunDirectionBody: Vec3;
  earthDirectionBody: Vec3;
  earthAngularRadiusRad: number;
  sunDirectionEci: Vec3;
  inEarthShadow: boolean;
  eclipseFactor: number;
  betaAngleDeg: number;
}

export interface CellSample {
  litFraction: number;
  directWm2: number;
  albedoWm2: number;
  bounceWm2: number;
  totalWm2: number;
}

export interface StringPower {
  stringId: ID;
  name: string;
  currentA: number;
  voltageV: number;
  powerW: number;
  bypassedGroups: number;
  totalGroups: number;
  limitingCell: ID | null;
}

export interface PowerSample {
  tSec: number;
  totalW: number;
  solarW: number;
  busLoadW: number;
  payloadLoadW: number;
  netW: number;
  strings: StringPower[];
}

export interface SimResult {
  caseId: ID;
  startedAt: number;
  elapsedMs: number;
  backend: 'webgpu' | 'cpu-reference';
  steps: number;
  cells: number;
  environments: StepEnvironment[];
  /** [step][cell] */
  irradiance: CellSample[][];
  power: PowerSample[];
  eclipseIntervals: Array<{ startSec: number; endSec: number }>;
  minPower: { tSec: number; powerW: number };
  maxPower: { tSec: number; powerW: number };
  orbitPeriodSec: number;
  validation?: CosineValidation;
}

export interface CosineValidation {
  maxRelativeErrorPct: number;
  points: Array<{ angleDeg: number; simulatedW: number; analyticW: number; errorPct: number }>;
  passed: boolean;
}

export interface Settings {
  preferredBackend: 'webgpu' | 'auto';
  benchmarkSteps: number;
  unsafeCpuFallback: boolean;
}
