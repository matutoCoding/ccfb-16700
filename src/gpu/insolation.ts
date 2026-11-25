import type { CellRecord, CellSample, OccluderRuntime, SimulationConfig, StepEnvironment } from '../types';
import { INSOLLATION_SHADER } from './insolationShader';
import { getGpuDevice } from './device';
import { SOLAR_CONSTANT_WM2 } from '../lib/orbit';

const CELL_STRIDE_F32 = 20;
const OCC_STRIDE_F32 = 44;
const STEP_STRIDE_F32 = 12;

export async function runGpuInsolation(
  cells: CellRecord[],
  occluders: OccluderRuntime[],
  environments: StepEnvironment[],
  simulation: SimulationConfig
): Promise<CellSample[][]> {
  const device = await getGpuDevice();
  if (!device) throw new Error('WebGPU device unavailable');

  const cellCount = cells.length;
  const stepCount = environments.length;
  const itemCount = cellCount * stepCount;

  const cellData = new ArrayBuffer(cellCount * CELL_STRIDE_F32 * 4);
  const cf = new Float32Array(cellData);
  const cu = new Uint32Array(cellData);
  cells.forEach((c, i) => {
    const b = i * CELL_STRIDE_F32;
    cf[b + 0] = c.centerBody[0]; cf[b + 1] = c.centerBody[1]; cf[b + 2] = c.centerBody[2]; cf[b + 3] = c.width;
    cf[b + 4] = c.normalBody[0]; cf[b + 5] = c.normalBody[1]; cf[b + 6] = c.normalBody[2]; cf[b + 7] = c.height;
    cf[b + 8] = c.tangentU[0]; cf[b + 9] = c.tangentU[1]; cf[b + 10] = c.tangentU[2]; cf[b + 11] = 0;
    cf[b + 12] = c.tangentV[0]; cf[b + 13] = c.tangentV[1]; cf[b + 14] = c.tangentV[2]; cf[b + 15] = 0;
    cu[b + 16] = c.selfOccluder >>> 0;
    cu[b + 17] = i >>> 0;
    cu[b + 18] = 0;
    cu[b + 19] = 0;
  });

  const occData = new ArrayBuffer(Math.max(1, occluders.length) * OCC_STRIDE_F32 * 4);
  const of = new Float32Array(occData);
  occluders.forEach((o, i) => {
    const b = i * OCC_STRIDE_F32;
    of.set(o.inverse, b);
    of.set(o.model, b + 16);
    of[b + 32] = o.kind;    of[b + 33] = o.radius;
    of[b + 34] = o.length;
    of[b + 35] = o.reflectivity;
    const cx = o.model[12], cy = o.model[13], cz = o.model[14];
    of[b + 36] = cx; of[b + 37] = cy; of[b + 38] = cz;
    let hx: number, hy: number, hz: number;
    if (o.kind === 1) {
      hx = o.radius; hz = o.radius; hy = o.length / 2;
    } else {
      hx = Math.hypot(o.model[0], o.model[1], o.model[2]) / 2;
      hy = Math.hypot(o.model[4], o.model[5], o.model[6]) / 2;
      hz = Math.hypot(o.model[8], o.model[9], o.model[10]) / 2;
    }
    of[b + 39] = Math.hypot(hx, hy, hz);
    of[b + 40] = hx; of[b + 41] = hy; of[b + 42] = hz; of[b + 43] = 0;
  });

  if (occluders.length === 0) of[32] = 999; // dummy kind: intersectOccluder returns -1
  const stepData = new Float32Array(Math.max(1, stepCount) * STEP_STRIDE_F32);
  environments.forEach((e, i) => {
    const b = i * STEP_STRIDE_F32;
    stepData[b + 0] = e.sunDirectionBody[0];
    stepData[b + 1] = e.sunDirectionBody[1];
    stepData[b + 2] = e.sunDirectionBody[2];
    stepData[b + 3] = SOLAR_CONSTANT_WM2;
    stepData[b + 4] = e.earthDirectionBody[0];
    stepData[b + 5] = e.earthDirectionBody[1];
    stepData[b + 6] = e.earthDirectionBody[2];
    stepData[b + 7] = e.earthAngularRadiusRad;
    stepData[b + 8] = simulation.earthAlbedo;
    stepData[b + 9] = simulation.bounceCoefficient;
    stepData[b + 10] = e.eclipseFactor;
    stepData[b + 11] = 0;
  });

  const uniformData = new Float32Array([
    simulation.samplesPerCellAxis,
    simulation.enableEarthAlbedo ? 1 : 0,
    simulation.enableMultiBounce ? 1 : 0,
    simulation.enableSelfShadow ? 1 : 0
  ]);

  const cellBuffer = device.createBuffer({ size: cellData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(cellBuffer, 0, cellData);
  const occBuffer = device.createBuffer({ size: occData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(occBuffer, 0, occData);
  const stepBuffer = device.createBuffer({ size: stepData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(stepBuffer, 0, stepData);
  const uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);
  const resultBytes = itemCount * 16;
  const resultBuffer = device.createBuffer({ size: resultBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: resultBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  const module = device.createShaderModule({ code: INSOLLATION_SHADER });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
    ]
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipeline = await device.createComputePipelineAsync({
    layout: pipelineLayout,
    compute: { module, entryPoint: 'main' }
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cellBuffer } },
      { binding: 1, resource: { buffer: occBuffer } },
      { binding: 2, resource: { buffer: stepBuffer } },
      { binding: 3, resource: { buffer: uniformBuffer } },
      { binding: 4, resource: { buffer: resultBuffer } }
    ]
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(itemCount / 64));
  pass.end();
  encoder.copyBufferToBuffer(resultBuffer, 0, readback, 0, resultBytes);
  device.queue.submit([encoder.finish()]);

  await readback.mapAsync(GPUMapMode.READ);
  const mapped = new Float32Array(readback.getMappedRange());
  const raw = new Float32Array(mapped.length);
  raw.set(mapped);
  readback.unmap();

  cellBuffer.destroy(); occBuffer.destroy(); stepBuffer.destroy(); uniformBuffer.destroy(); resultBuffer.destroy(); readback.destroy();

  const output: CellSample[][] = Array.from({ length: stepCount }, () => []);
  for (let s = 0; s < stepCount; s++) {
    for (let c = 0; c < cellCount; c++) {
      const i = (s * cellCount + c) * 4;
      const litFraction = raw[i + 0];
      const directWm2 = raw[i + 1];
      const albedoWm2 = raw[i + 2];
      const bounceWm2 = raw[i + 3];
      output[s].push({
        litFraction,
        directWm2,
        albedoWm2,
        bounceWm2,
        totalWm2: directWm2 + albedoWm2 + bounceWm2
      });
    }
  }
  return output;
}
