export const INSOLLATION_SHADER = /* wgsl */ `
struct CellGpu {
  center: vec4<f32>,
  normal: vec4<f32>,
  tangentU: vec4<f32>,
  tangentV: vec4<f32>,
  ids: vec4<u32>,
};

struct OccluderGpu {
  invModel: mat4x4<f32>,
  model: mat4x4<f32>,
  data0: vec4<f32>, // kind, radius, length, reflectivity
  data1: vec4<f32>, // center.xyz, boundingRadius
  data2: vec4<f32>, // halfExtents.xyz, patchArea
};

struct StepGpu {
  sun: vec4<f32>,    // xyz direction in body frame, w solar constant
  earth: vec4<f32>,  // xyz direction sat->Earth, w angular radius
  params: vec4<f32>, // earth albedo, bounce coefficient, eclipse factor, unused
};

struct SettingsGpu {
  values: vec4<f32>, // samples per axis, albedo enable, bounce enable, shadow enable
};

@group(0) @binding(0) var<storage, read> cells: array<CellGpu>;
@group(0) @binding(1) var<storage, read> occluders: array<OccluderGpu>;
@group(0) @binding(2) var<storage, read> steps: array<StepGpu>;
@group(0) @binding(3) var<uniform> settings: SettingsGpu;
@group(0) @binding(4) var<storage, read_write> results: array<vec4<f32>>;

fn intersectOccluder(origin: vec3<f32>, dir: vec3<f32>, oc: OccluderGpu) -> f32 {
  let lo = (oc.invModel * vec4<f32>(origin, 1.0)).xyz;
  let ld = (oc.invModel * vec4<f32>(dir, 0.0)).xyz;
  let kind = u32(oc.data0.x);

  if (kind == 0u) {
    let inv = 1.0 / ld;
    let t0 = (-0.5 - lo) * inv;
    let t1 = (0.5 - lo) * inv;
    let tvmin = min(t0, t1);
    let tvmax = max(t0, t1);
    let tmin = max(max(tvmin.x, tvmin.y), tvmin.z);
    let tmax = min(min(tvmax.x, tvmax.y), tvmax.z);
    if (tmax < max(tmin, 0.002)) { return -1.0; }
    var t = tmin;
    if (t < 0.002) { t = tmax; }
    if (t < 0.002) { return -1.0; }
    return t;
  } else if (kind == 1u) {
    let radius = oc.data0.y;
    let halfLength = oc.data0.z * 0.5;

    // Y end-cap slab.
    var slabNear = -1.0e20;
    var slabFar = 1.0e20;
    if (abs(ld.y) < 1.0e-8) {
      if (lo.y < -halfLength || lo.y > halfLength) { return -1.0; }
    } else {
      var ta = (-halfLength - lo.y) / ld.y;
      var tb = (halfLength - lo.y) / ld.y;
      if (ta > tb) { let tmp = ta; ta = tb; tb = tmp; }
      slabNear = ta;
      slabFar = tb;
    }

    let a = ld.x * ld.x + ld.z * ld.z;
    if (a > 1.0e-10) {
      let b = 2.0 * (lo.x * ld.x + lo.z * ld.z);
      let c = lo.x * lo.x + lo.z * lo.z - radius * radius;
      let disc = b * b - 4.0 * a * c;
      if (disc >= 0.0) {
        let root = sqrt(max(disc, 0.0));
        let t1 = (-b - root) / (2.0 * a);
        let t2 = (-b + root) / (2.0 * a);
        let candidates = array<f32, 2>(t1, t2);
        for (var i = 0u; i < 2u; i = i + 1u) {
          let t = candidates[i];
          if (t > 0.002 && t >= slabNear - 0.002 && t <= slabFar + 0.002) {
            let y = lo.y + t * ld.y;
            if (y >= -halfLength - 0.002 && y <= halfLength + 0.002) { return t; }
          }
        }
      }
    }

    // Cap hits.
    let capYs = array<f32, 2>(-halfLength, halfLength);
    for (var i = 0u; i < 2u; i = i + 1u) {
      let y = capYs[i];
      if (abs(ld.y) > 1.0e-8) {
        let t = (y - lo.y) / ld.y;
        if (t > 0.002 && t >= slabNear - 0.01 && t <= slabFar + 0.01) {
          let x = lo.x + t * ld.x;
          let z = lo.z + t * ld.z;
          if (x * x + z * z <= radius * radius) { return t; }
        }
      }
    }
  }
  return -1.0;
}

fn anyShadow(origin: vec3<f32>, dir: vec3<f32>, skipIndex: u32) -> bool {
  if (settings.values.w < 0.5) { return false; }
  for (var i = 0u; i < arrayLength(&occluders); i = i + 1u) {
    if (i == skipIndex) { continue; }
    if (intersectOccluder(origin, dir, occluders[i]) > 0.0) { return true; }
  }
  return false;
}

fn multiBounce(center: vec3<f32>, normal: vec3<f32>, sunDir: vec3<f32>, selfIndex: u32, bounceCoeff: f32, eclipse: f32, solarConstant: f32) -> f32 {
  if (settings.values.z < 0.5 || bounceCoeff <= 0.0 || eclipse <= 0.001) { return 0.0; }
  var firstBounce = 0.0;
  var enclosure = 0.0;

  for (var j = 0u; j < arrayLength(&occluders); j = j + 1u) {
    if (j == selfIndex) { continue; }
    let oc = occluders[j];
    let delta = center - oc.data1.xyz;
    let dist2 = max(dot(delta, delta), 0.04);
    let localDelta = (oc.invModel * vec4<f32>(delta, 0.0)).xyz;
    let ax = abs(localDelta.x);
    let ay = abs(localDelta.y);
    let az = abs(localDelta.z);
    var localNormal = vec3<f32>(0.0, 0.0, 1.0);
    var halfOffset = oc.data2.z;
    var faceArea = 4.0 * oc.data2.x * oc.data2.y;
    if (ax >= ay && ax >= az) {
      localNormal = vec3<f32>(sign(localDelta.x), 0.0, 0.0);
      halfOffset = oc.data2.x;
      faceArea = 4.0 * oc.data2.y * oc.data2.z;
    } else if (ay >= ax && ay >= az) {
      localNormal = vec3<f32>(0.0, sign(localDelta.y), 0.0);
      halfOffset = oc.data2.y;
      faceArea = 4.0 * oc.data2.x * oc.data2.z;
    } else {
      localNormal = vec3<f32>(0.0, 0.0, sign(localDelta.z));
      halfOffset = oc.data2.z;
      faceArea = 4.0 * oc.data2.x * oc.data2.y;
    }

    let reflectorNormal = normalize((oc.model * vec4<f32>(localNormal, 0.0)).xyz);
    let sunCos = max(dot(reflectorNormal, sunDir), 0.0);
    if (sunCos <= 0.001) { continue; }
    let facePoint = oc.data1.xyz + reflectorNormal * (halfOffset + 0.006);
    if (anyShadow(facePoint, sunDir, j)) { continue; }

    let toReceiver = normalize(center - facePoint);
    let cosReflector = max(dot(reflectorNormal, toReceiver), 0.0);
    let cosCell = max(dot(normal, -toReceiver), 0.0);
    let formFactor = clamp(faceArea * cosReflector * cosCell / (3.14159265 * dist2), 0.0, 0.75);
    enclosure += formFactor;
    firstBounce += solarConstant * eclipse * oc.data0.w * sunCos * formFactor;
  }

  // Second/higher-order closure: empirical radiosity feedback.
  return firstBounce * (1.0 + bounceCoeff * clamp(enclosure, 0.0, 0.85));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let totalCells = arrayLength(&cells);
  let item = gid.x;
  let stepCount = arrayLength(&steps);
  if (item >= totalCells * stepCount) { return; }

  let stepIndex = item / totalCells;
  let cellIndex = item % totalCells;
  let cell = cells[cellIndex];
  let step = steps[stepIndex];

  let center = cell.center.xyz;
  let normal = normalize(cell.normal.xyz);
  let tangentU = normalize(cell.tangentU.xyz);
  let tangentV = normalize(cell.tangentV.xyz);
  let width = cell.center.w;
  let height = cell.normal.w;
  let selfIndex = cell.ids.x;

  let sunDir = normalize(step.sun.xyz);
  let earthDir = normalize(step.earth.xyz);
  let s0 = step.sun.w;
  let eclipse = step.params.z;
  let samplesAxis = max(1u, u32(settings.values.x + 0.5));

  var lit = 0.0;
  var sampleCount = 0u;
  for (var ix = 0u; ix < samplesAxis; ix = ix + 1u) {
    for (var iy = 0u; iy < samplesAxis; iy = iy + 1u) {
      let fx = (f32(ix) + 0.5) / f32(samplesAxis) - 0.5;
      let fy = (f32(iy) + 0.5) / f32(samplesAxis) - 0.5;
      let p = center + tangentU * (fx * width) + tangentV * (fy * height) + normal * 0.012;
      if (!anyShadow(p, sunDir, selfIndex)) { lit += 1.0; }
      sampleCount += 1u;
    }
  }
  let litFraction = lit / f32(sampleCount);
  let incidenceCos = max(dot(normal, sunDir), 0.0);
  let direct = s0 * eclipse * incidenceCos * litFraction;

  var albedo = 0.0;
  if (settings.values.y > 0.5) {
    let angularRadius = step.earth.w;
    let earthView = max(dot(normal, earthDir), 0.0) * pow(sin(angularRadius), 2.0);
    let earthDayPhase = max(dot(-earthDir, sunDir), 0.08);
    albedo = s0 * step.params.x * earthDayPhase * earthView;
  }

  let bounce = multiBounce(center, normal, sunDir, selfIndex, step.params.y, eclipse, s0);
  results[item] = vec4<f32>(litFraction, direct, albedo, bounce);
}
`;
