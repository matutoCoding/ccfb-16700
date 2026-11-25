import type { OrbitState, SimulationSettings } from '../types';
import type { PreparedGeometry } from '../lib/geometry';
import { ILLUMINATION_STRIDE, type IlluminationBatch } from '../lib/illumination';

const SHADER = /* wgsl */ `
struct CellGpu {
  centerHalfU: vec4<f32>,
  axisUHalfV: vec4<f32>,
  axisVPad: vec4<f32>,
  normalArea: vec4<f32>,
};

struct PrimGpu {
  model: mat4x4<f32>,
  invModel: mat4x4<f32>,
  p: vec4<f32>, // kind, sizeX, sizeY, sizeZ
  m: vec4<f32>, // radius, height, reflectivity, unused
};

struct EpochGpu {
  sunEclipse: vec4<f32>,
  earthLit: vec4<f32>,
  params: vec4<f32>, // sinEarthRho2, solarConstant, albedo, unused
};

struct SimParams {
  cellCount: u32,
  epochCount: u32,
  primCount: u32,
  samplesPerAxis: u32,
  bounceRays: u32,
  bounceCount: u32,
  multiBounce: u32,
  slabSize: u32,
};

struct Hit {
  valid: bool,
  t: f32,
  pos: vec3<f32>,
  normal: vec3<f32>,
  reflectivity: f32,
};

@group(0) @binding(0) var<storage, read> cells: array<CellGpu>;
@group(0) @binding(1) var<storage, read> prims: array<PrimGpu>;
@group(0) @binding(2) var<storage, read> epochs: array<EpochGpu>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;
@group(0) @binding(4) var<uniform> params: SimParams;

fn invalidHit() -> Hit {
  var h: Hit;
  h.valid = false;
  h.t = 1e30;
  h.pos = vec3<f32>(0.0);
  h.normal = vec3<f32>(0.0, 0.0, 1.0);
  h.reflectivity = 0.0;
  return h;
}

fn finalizeHit(h: Hit, primIndex: u32, localNormal: vec3<f32>) -> Hit {
  var out = h;
  out.valid = true;
  out.reflectivity = prims[primIndex].m.z;
  out.normal = normalize((prims[primIndex].model * vec4<f32>(localNormal, 0.0)).xyz);
  return out;
}

fn intersectBox(pi: u32, o: vec3<f32>, d: vec3<f32>) -> Hit {
  var hit = invalidHit();
  let size = prims[pi].p.yzw;
  let half = size * 0.5;
  var tmin = -1e30;
  var tmax = 1e30;

  if (abs(d.x) < 1e-8) {
    if (o.x < -half.x || o.x > half.x) { return hit; }
  } else {
    var t1 = (-half.x - o.x) / d.x;
    var t2 = ( half.x - o.x) / d.x;
    if (t1 > t2) { let tmp = t1; t1 = t2; t2 = tmp; }
    tmin = max(tmin, t1); tmax = min(tmax, t2);
    if (tmin > tmax) { return hit; }
  }
  if (abs(d.y) < 1e-8) {
    if (o.y < -half.y || o.y > half.y) { return hit; }
  } else {
    var t1 = (-half.y - o.y) / d.y;
    var t2 = ( half.y - o.y) / d.y;
    if (t1 > t2) { let tmp = t1; t1 = t2; t2 = tmp; }
    tmin = max(tmin, t1); tmax = min(tmax, t2);
    if (tmin > tmax) { return hit; }
  }
  if (abs(d.z) < 1e-8) {
    if (o.z < -half.z || o.z > half.z) { return hit; }
  } else {
    var t1 = (-half.z - o.z) / d.z;
    var t2 = ( half.z - o.z) / d.z;
    if (t1 > t2) { let tmp = t1; t1 = t2; t2 = tmp; }
    tmin = max(tmin, t1); tmax = min(tmax, t2);
    if (tmin > tmax) { return hit; }
  }

  var t = tmin;
  if (t <= 0.0) { t = tmax; }
  if (t < 0.002) { return hit; }
  let p = o + d * t;
  let eps = 0.0008;
  var n = vec3<f32>(0.0, 0.0, -1.0);
  if (abs(p.x - half.x) < eps) { n = vec3<f32>(1.0, 0.0, 0.0); }
  else if (abs(p.x + half.x) < eps) { n = vec3<f32>(-1.0, 0.0, 0.0); }
  else if (abs(p.y - half.y) < eps) { n = vec3<f32>(0.0, 1.0, 0.0); }
  else if (abs(p.y + half.y) < eps) { n = vec3<f32>(0.0, -1.0, 0.0); }
  else if (abs(p.z - half.z) < eps) { n = vec3<f32>(0.0, 0.0, 1.0); }
  else if (abs(p.z + half.z) < eps) { n = vec3<f32>(0.0, 0.0, -1.0); }

  hit.t = t;
  hit.pos = (prims[pi].model * vec4<f32>(p, 1.0)).xyz;
  return finalizeHit(hit, pi, n);
}

fn intersectCylinder(pi: u32, o: vec3<f32>, d: vec3<f32>) -> Hit {
  var best = invalidHit();
  let radius = prims[pi].m.x;
  let height = prims[pi].m.y;
  let halfH = height * 0.5;

  let a = d.x * d.x + d.z * d.z;
  let b = 2.0 * (o.x * d.x + o.z * d.z);
  let c = o.x * o.x + o.z * o.z - radius * radius;
  if (a > 1e-12) {
    let disc = b * b - 4.0 * a * c;
    if (disc >= 0.0) {
      let sq = sqrt(max(0.0, disc));
      let t1 = (-b - sq) / (2.0 * a);
      let t2 = (-b + sq) / (2.0 * a);
      for (var k = 0; k < 2; k++) {
        let t = select(t2, t1, k == 0);
        if (t > 0.002) {
          let y = o.y + d.y * t;
          if (y >= -halfH && y <= halfH && (!best.valid || t < best.t)) {
            let p = o + d * t;
            var h = invalidHit();
            h.valid = true; h.t = t;
            h.pos = (prims[pi].model * vec4<f32>(p, 1.0)).xyz;
            let nLocal = normalize(vec3<f32>(p.x, 0.0, p.z));
            best = finalizeHit(h, pi, nLocal);
          }
        }
      }
    }
  }

  if (abs(d.y) > 1e-10) {
    for (var cap = 0; cap < 2; cap++) {
      let yCap = select(-halfH, halfH, cap == 1);
      let t = (yCap - o.y) / d.y;
      if (t > 0.002) {
        let x = o.x + d.x * t;
        let z = o.z + d.z * t;
        if (x * x + z * z <= radius * radius + 1e-6 && (!best.valid || t < best.t)) {
          let p = o + d * t;
          var h = invalidHit();
          h.valid = true; h.t = t;
          h.pos = (prims[pi].model * vec4<f32>(p, 1.0)).xyz;
          let nLocal = select(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), cap == 1);
          best = finalizeHit(h, pi, nLocal);
        }
      }
    }
  }
  return best;
}

fn intersectPrim(pi: u32, originBody: vec3<f32>, dirBody: vec3<f32>) -> Hit {
  let o = (prims[pi].invModel * vec4<f32>(originBody, 1.0)).xyz;
  let d = (prims[pi].invModel * vec4<f32>(dirBody, 0.0)).xyz;
  if (prims[pi].p.x > 0.5) {
    return intersectCylinder(pi, o, d);
  }
  return intersectBox(pi, o, d);
}

fn anyShadow(origin: vec3<f32>, dir: vec3<f32>) -> bool {
  for (var i: u32 = 0u; i < params.primCount; i++) {
    let h = intersectPrim(i, origin, dir);
    if (h.valid && h.t > 0.002) { return true; }
  }
  return false;
}

fn nearestHit(origin: vec3<f32>, dir: vec3<f32>) -> Hit {
  var best = invalidHit();
  for (var i: u32 = 0u; i < params.primCount; i++) {
    let h = intersectPrim(i, origin, dir);
    if (h.valid && (!best.valid || h.t < best.t)) { best = h; }
  }
  return best;
}

fn fract01(x: f32) -> f32 {
  return fract(x);
}

fn cosineRay(n: vec3<f32>, rayIndex: f32, rayCount: f32, bounceIndex: f32) -> vec3<f32> {
  let helper = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(n.z) < 0.9);
  let t = normalize(cross(n, helper));
  let b = normalize(cross(n, t));
  let u1 = (rayIndex + 0.5) / max(1.0, rayCount);
  let u2 = fract01((rayIndex + 0.5) * 0.61803398875 + bounceIndex * 0.31830988618);
  let r = sqrt(u1);
  let phi = 6.2831853 * u2;
  let lx = r * cos(phi);
  let ly = r * sin(phi);
  let lz = sqrt(max(0.0, 1.0 - u1));
  return normalize(t * lx + b * ly + n * lz);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let total = params.epochCount * params.cellCount;
  let id = gid.x + gid.y * params.slabSize;
  if (id >= total) { return; }
  let epochIndex = id / params.cellCount;
  let cellIndex = id % params.cellCount;
  let cell = cells[cellIndex];
  let ep = epochs[epochIndex];
  let sun = ep.sunEclipse.xyz;
  let eclipse = ep.sunEclipse.w;
  let earth = ep.earthLit.xyz;
  let earthLit = ep.earthLit.w;
  let sinRho2 = ep.params.x;
  let solarConstant = ep.params.y;
  let albedoCoef = ep.params.z;
  let normal = cell.normalArea.xyz;

  let cosine = dot(normal, sun);
  var lit = 0.0;
  let nAxis = max(1u, params.samplesPerAxis);
  if (cosine > 1e-4 && eclipse > 0.001) {
    for (var iy: u32 = 0u; iy < nAxis; iy++) {
      for (var ix: u32 = 0u; ix < nAxis; ix++) {
        let u = ((f32(ix) + 0.5) / f32(nAxis)) * 2.0 - 1.0;
        let v = ((f32(iy) + 0.5) / f32(nAxis)) * 2.0 - 1.0;
        let p = cell.centerHalfU.xyz
          + cell.axisUHalfV.xyz * u * cell.centerHalfU.w
          + cell.axisVPad.xyz * v * cell.axisUHalfV.w
          + normal * 0.008;
        if (!anyShadow(p, sun)) { lit += 1.0; }
      }
    }
  }
  let sampleCount = f32(nAxis * nAxis);
  let litFraction = select(0.0, lit / sampleCount, cosine > 0.0);
  let direct = solarConstant * max(cosine, 0.0) * litFraction * eclipse;

  let cosEarth = max(dot(normal, earth), 0.0);
  let viewFactor = sinRho2 * cosEarth;
  let albedo = solarConstant * albedoCoef * earthLit * viewFactor;

  var bounce = 0.0;
  if (params.multiBounce != 0u && params.bounceCount > 0u && params.bounceRays > 0u) {
    var sum = 0.0;
    let rays = max(1u, params.bounceRays);
    for (var ri: u32 = 0u; ri < rays; ri++) {
      var origin = cell.centerHalfU.xyz + normal * 0.012;
      var surfNormal = normal;
      var throughput = 1.0;
      for (var bi: u32 = 0u; bi < params.bounceCount; bi++) {
        let dir = cosineRay(surfNormal, f32(ri), f32(rays), f32(bi));
        let hit = nearestHit(origin, dir);
        if (!hit.valid) { break; }
        throughput *= hit.reflectivity;
        let hitCos = max(dot(hit.normal, sun), 0.0);
        let shadowOrigin = hit.pos + hit.normal * 0.012;
        if (hitCos > 0.001 && !anyShadow(shadowOrigin, sun)) {
          sum += throughput * solarConstant * eclipse * hitCos;
        }
        origin = hit.pos + hit.normal * 0.014;
        surfNormal = hit.normal;
      }
    }
    bounce = sum / f32(rays);
  }

  let base = id * 8u;
  output[base] = litFraction;
  output[base + 1u] = cosine;
  output[base + 2u] = direct;
  output[base + 3u] = albedo;
  output[base + 4u] = bounce;
  output[base + 5u] = direct + albedo + bounce;
  output[base + 6u] = viewFactor;
  output[base + 7u] = 0.0;
}
`;

function packCells(prepared: PreparedGeometry): Float32Array {
  const data = new Float32Array(prepared.cells.length * 16);
  prepared.cells.forEach((c, i) => {
    const o = i * 16;
    data.set([c.centerBody[0], c.centerBody[1], c.centerBody[2], c.halfU], o);
    data.set([c.axisUBody[0], c.axisUBody[1], c.axisUBody[2], c.halfV], o + 4);
    data.set([c.axisVBody[0], c.axisVBody[1], c.axisVBody[2], 0], o + 8);
    data.set([c.normalBody[0], c.normalBody[1], c.normalBody[2], c.areaM2], o + 12);
  });
  return data;
}

function packPrimitives(prepared: PreparedGeometry): Float32Array {
  const stride = 40;
  const data = new Float32Array(prepared.occluders.length * stride);
  prepared.occluders.forEach((p, i) => {
    const o = i * stride;
    data.set(p.model, o);
    data.set(p.inv, o + 16);
    data[o + 32] = p.kind;
    data[o + 33] = p.size[0];
    data[o + 34] = p.size[1];
    data[o + 35] = p.size[2];
    data[o + 36] = p.radius;
    data[o + 37] = p.height;
    data[o + 38] = p.reflectivity;
    data[o + 39] = 1;
  });
  return data;
}

function packEpochs(states: OrbitState[], settings: SimulationSettings): Float32Array {
  const data = new Float32Array(states.length * 12);
  states.forEach((s, i) => {
    const o = i * 12;
    data.set([s.sunBody[0], s.sunBody[1], s.sunBody[2], s.eclipseFactor], o);
    data.set([s.earthBody[0], s.earthBody[1], s.earthBody[2], s.earthSunlitFactor], o + 4);
    const ratio = settings.earthRadiusKm / 6378.137;
    const sinRho2 = Math.sin(s.earthAngularRadiusRad) ** 2 * ratio ** 0; // state radius already uses configured km
    data.set([sinRho2, settings.solarConstantWm2, settings.earthAlbedo, 0], o + 8);
  });
  return data;
}

export async function computeIlluminationGPU(
  device: GPUDevice,
  prepared: PreparedGeometry,
  states: OrbitState[],
  settings: SimulationSettings,
): Promise<IlluminationBatch> {
  const cellCount = prepared.cells.length;
  const epochCount = states.length;
  const total = cellCount * epochCount;
  if (total === 0) return { epochCount, cellCount, data: new Float32Array(), engine: 'webgpu' };

  const cellData = packCells(prepared);
  const primData = packPrimitives(prepared);
  const epochData = packEpochs(states, settings);
  const outputByteLength = total * ILLUMINATION_STRIDE * Float32Array.BYTES_PER_ELEMENT;

  const cellBuffer = device.createBuffer({
    label: 'cell-gpu', size: cellData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(cellBuffer, 0, cellData);

  const primBuffer = device.createBuffer({
    label: 'prim-gpu', size: Math.max(160, primData.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  if (primData.length) device.queue.writeBuffer(primBuffer, 0, primData);

  const epochBuffer = device.createBuffer({
    label: 'epoch-gpu', size: epochData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(epochBuffer, 0, epochData);

  const outputBuffer = device.createBuffer({
    label: 'illumination-output', size: outputByteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const stagingBuffer = device.createBuffer({
    label: 'illumination-staging', size: outputByteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const paramsData = new Uint32Array(8);
  paramsData[0] = cellCount;
  paramsData[1] = epochCount;
  paramsData[2] = prepared.occluders.length;
  paramsData[3] = Math.max(1, settings.shadowSamplesPerAxis);
  paramsData[4] = Math.max(1, settings.bounceRaysPerCell);
  paramsData[5] = Math.max(0, settings.bounceCount);
  paramsData[6] = settings.multiBounceEnabled ? 1 : 0;
  const workgroupsX = Math.ceil(total / 64);
  const dispatchX = Math.min(65535, Math.max(1, workgroupsX));
  paramsData[7] = dispatchX * 64;
  const paramsBuffer = device.createBuffer({
    label: 'sim-params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  const module = device.createShaderModule({ label: 'illumination-wgsl', code: SHADER });
  const pipeline = await device.createComputePipelineAsync({
    label: 'illumination-pipeline',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: cellBuffer } },
      { binding: 1, resource: { buffer: primBuffer } },
      { binding: 2, resource: { buffer: epochBuffer } },
      { binding: 3, resource: { buffer: outputBuffer } },
      { binding: 4, resource: { buffer: paramsBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  const dispatchY = Math.max(1, Math.ceil(workgroupsX / dispatchX));
  pass.dispatchWorkgroups(dispatchX, dispatchY, 1);
  pass.end();
  encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputByteLength);
  device.queue.submit([encoder.finish()]);

  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const copy = new Float32Array(stagingBuffer.size / 4);
  copy.set(new Float32Array(stagingBuffer.getMappedRange()));
  stagingBuffer.unmap();

  cellBuffer.destroy();
  primBuffer.destroy();
  epochBuffer.destroy();
  outputBuffer.destroy();
  stagingBuffer.destroy();
  paramsBuffer.destroy();

  return { epochCount, cellCount, data: copy, engine: 'webgpu' };
}
