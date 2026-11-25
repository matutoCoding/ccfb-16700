import type { CellRecord, ScenarioCase, Vec3 } from '../types';
import { getGpuDevice } from './device';
import { composeMatrix, normalize, perspective, lookAt, quatFromEulerDeg, quatFromAxisAngle, quatMultiply, rotateVec } from '../lib/math';
import { buildGeometry } from '../lib/geometry';

const SCENE_SHADER = /* wgsl */ `
struct SceneUniforms {
  viewProj: mat4x4<f32>,
  sun: vec4<f32>,
  eye: vec4<f32>,
};
struct ObjectUniforms {
  model: mat4x4<f32>,
  color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(1) @binding(0) var<uniform> object: ObjectUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) worldPos: vec3<f32>,
};

@vertex
fn vsPrimitive(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>) -> VertexOut {
  var out: VertexOut;
  let world = object.model * vec4<f32>(position, 1.0);
  out.position = scene.viewProj * world;
  out.worldPos = world.xyz;
  out.normal = normalize((object.model * vec4<f32>(normal, 0.0)).xyz);
  return out;
}

@fragment
fn fsPrimitive(in: VertexOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let l = normalize(scene.sun.xyz);
  let key = max(dot(n, l), 0.0);
  let fill = max(dot(n, normalize(vec3<f32>(-l.x, 0.35, -l.z))), 0.0) * 0.22;
  let rim = pow(1.0 - max(dot(n, normalize(scene.eye.xyz - in.worldPos)), 0.0), 2.2) * 0.22;
  let light = 0.20 + key * 0.95 + fill + rim;
  return vec4<f32>(object.color.rgb * light, object.color.a);
}

struct CellOut {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec3<f32>,
  @location(2) worldPos: vec3<f32>,
};

@vertex
fn vsCell(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>
) -> CellOut {
  var out: CellOut;
  let world = object.model * vec4<f32>(position, 1.0);
  out.position = scene.viewProj * world;
  out.worldPos = world.xyz;
  out.normal = normalize((object.model * vec4<f32>(normal, 0.0)).xyz);
  out.color = color;
  return out;
}

@fragment
fn fsCell(in: CellOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let key = max(dot(n, normalize(scene.sun.xyz)), 0.0);
  let ambient = 0.62;
  let gridLine = 0.0;
  let light = ambient + key * 0.46;
  return vec4<f32>(in.color * light + vec3<f32>(gridLine), 1.0);
}
`;

interface MeshData {
  vertices: Float32Array;
  indices?: Uint16Array;
}

interface RenderObject {
  vertexBuffer: GPUBuffer;
  indexBuffer?: GPUBuffer;
  indexCount?: number;
  vertexCount: number;
  model: Float32Array;
  color: [number, number, number, number];
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

function boxMesh(): MeshData {
  const faces: Array<{ n: Vec3; corners: Vec3[] }> = [
    { n: [1, 0, 0], corners: [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]] },
    { n: [-1, 0, 0], corners: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]] },
    { n: [0, 1, 0], corners: [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]] },
    { n: [0, -1, 0], corners: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]] },
    { n: [0, 0, 1], corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { n: [0, 0, -1], corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] }
  ];
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const f of faces) {
    const base = vertices.length / 6;
    for (const p of f.corners) vertices.push(...p, ...f.n);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

function cylinderMesh(segments = 40): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a), z = Math.sin(a);
    v.push(x, -0.5, z, x, 0, z);
    v.push(x, 0.5, z, x, 0, z);
  }
  for (let i = 0; i < segments; i++) {
    const b = i * 4;
    idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
  }
  const topCenter = v.length / 6;
  v.push(0, 0.5, 0, 0, 1, 0);
  const topStart = v.length / 6;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    v.push(Math.cos(a), 0.5, Math.sin(a), 0, 1, 0);
  }
  for (let i = 0; i < segments; i++) idx.push(topCenter, topStart + i, topStart + i + 1);

  const bottomCenter = v.length / 6;
  v.push(0, -0.5, 0, 0, -1, 0);
  const bottomStart = v.length / 6;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    v.push(Math.cos(a), -0.5, Math.sin(a), 0, -1, 0);
  }
  for (let i = 0; i < segments; i++) idx.push(bottomCenter, bottomStart + i + 1, bottomStart + i);
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

export function illuminationColor(litFraction: number, totalWm2?: number): [number, number, number] {
  const f = Math.max(0, Math.min(1, litFraction));
  // Deep shadow -> blue -> cyan -> amber -> bright green-white.
  const stops: Array<[number, [number, number, number]]> = [
    [0, [0.025, 0.055, 0.16]],
    [0.25, [0.05, 0.32, 0.72]],
    [0.55, [0.05, 0.72, 0.72]],
    [0.8, [0.98, 0.68, 0.18]],
    [1, [0.42, 0.95, 0.55]]
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i++) {
    if (f <= stops[i][0]) { a = stops[i - 1]; b = stops[i]; break; }
  }
  const t = (f - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const rgb: [number, number, number] = [
    a[1][0] + (b[1][0] - a[1][0]) * t,
    a[1][1] + (b[1][1] - a[1][1]) * t,
    a[1][2] + (b[1][2] - a[1][2]) * t
  ];
  if (totalWm2 !== undefined && f > 0.99) {
    const boost = Math.min(0.35, totalWm2 / 5000);
    rgb[0] = Math.min(1, rgb[0] + boost);
    rgb[1] = Math.min(1, rgb[1] + boost);
    rgb[2] = Math.min(1, rgb[2] + boost * 0.7);
  }
  return rgb;
}

export class SatelliteSceneRenderer {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private primitivePipeline: GPURenderPipeline | null = null;
  private cellPipeline: GPURenderPipeline | null = null;
  private sceneBuffer: GPUBuffer | null = null;
  private sceneBindGroup: GPUBindGroup | null = null;
  private objectLayout: GPUBindGroupLayout | null = null;
  private depthView: GPUTextureView | null = null;
  private depthTexture: GPUTexture | null = null;
  private objects: RenderObject[] = [];
  private cellBuffer: GPUBuffer | null = null;
  private cellUniformBuffer: GPUBuffer | null = null;
  private cellData: Float32Array | null = null;
  private cellCount = 0;
  private cellBindGroup: GPUBindGroup | null = null;
  private boxMesh: MeshData = boxMesh();
  private cylinderMesh: MeshData = cylinderMesh();
  private yaw = 0.72;
  private pitch = 0.34;
  private distance = 8;
  private raf = 0;
  private sunDirection: Vec3 = [0.35, 0.55, 0.76];
  private destroyed = false;
  private resizeObserver?: ResizeObserver;
  private drag: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.bindControls();
  }

  async init(scenario: ScenarioCase): Promise<boolean> {
    this.device = await getGpuDevice();
    if (!this.device) return false;
    try {
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) return false;
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format, alphaMode: 'premultiplied' });

    const module = this.device.createShaderModule({ code: SCENE_SHADER });
    const sceneLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
    });
    this.objectLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
    });
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, this.objectLayout] });

    this.primitivePipeline = await this.device.createRenderPipelineAsync({
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint: 'vsPrimitive',
        buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
      },
      fragment: { module, entryPoint: 'fsPrimitive', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
    });

    this.cellPipeline = await this.device.createRenderPipelineAsync({
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint: 'vsCell',
        buffers: [{
          arrayStride: 36,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x3' }
          ]
        }]
      },
      fragment: { module, entryPoint: 'fsCell', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
    });

    this.sceneBuffer = this.device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sceneBindGroup = this.device.createBindGroup({ layout: sceneLayout, entries: [{ binding: 0, resource: { buffer: this.sceneBuffer } }] });
    this.setScenario(scenario);
    this.resizeObserver = new ResizeObserver(() => this.resizeDepth());
    this.resizeObserver.observe(this.canvas);
    this.loop();
    return true;
    } catch (err) {
      console.error('WebGPU scene renderer initialization failed:', err);
      return false;
    }
  }

  private bindControls() {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag = { x: e.clientX, y: e.clientY };
      this.yaw -= dx * 0.008;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - dy * 0.008));
    });
    this.canvas.addEventListener('pointerup', () => { this.drag = null; });
    this.canvas.addEventListener('pointercancel', () => { this.drag = null; });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = Math.max(1.4, Math.min(60, this.distance * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
  }

  setSunDirection(v: Vec3) {
    this.sunDirection = normalize(v);
  }

  fitRadius(r: number) {
    this.distance = Math.max(2.2, r * 2.15);
  }

  setScenario(scenario: ScenarioCase) {
    if (!this.device || !this.objectLayout) return;
    for (const o of this.objects) {
      o.vertexBuffer.destroy();
      o.indexBuffer?.destroy();
      o.uniformBuffer.destroy();
    }
    this.objects = [];
    const built = buildGeometry(scenario.geometry);
    this.fitRadius(built.radiusM);

    for (const p of scenario.geometry.primitives) {
      const q = quatFromEulerDeg(p.rotationDeg);
      let model: Float32Array;
      let mesh: MeshData;
      if (p.kind === 'cylinder') {
        model = composeMatrix(p.position, q, [p.dimensions[0], p.dimensions[1], p.dimensions[0]]);
        mesh = this.cylinderMesh;
      } else {
        const dims = p.kind === 'plate' ? [p.dimensions[0], p.dimensions[1], p.dimensions[2] || 0.04] as Vec3 : p.dimensions;
        model = composeMatrix(p.position, q, dims);
        mesh = this.boxMesh;
      }
      const roleColor = primitiveColor(p.role);
      this.addMeshObject(mesh, model, roleColor);
    }

    // Panel substrates.
    for (const a of scenario.geometry.arrays) {
      const qh = quatFromAxisAngle(a.hingeAxis, a.hingeAngleDeg * Math.PI / 180);
      const qd = quatFromAxisAngle(a.driveAxisLocal, a.driveAngleDeg * Math.PI / 180);
      const q = quatMultiply(qh, qd);
      const width = a.layout.cols * a.layout.cellWidth + Math.max(0, a.layout.cols - 1) * a.layout.gapX;
      const height = a.layout.rows * a.layout.cellHeight + Math.max(0, a.layout.rows - 1) * a.layout.gapY;
      const centerOffset = rotateVec(q, a.layout.centerOffset);
      const center: Vec3 = [
        a.rootPosition[0] + centerOffset[0],
        a.rootPosition[1] + centerOffset[1],
        a.rootPosition[2] + centerOffset[2]
      ];
      const model = composeMatrix(center, q, [width + 0.08, height + 0.08, a.panelThickness]);
      this.addMeshObject(this.boxMesh, model, [0.025, 0.035, 0.055, 1]);
    }

    this.rebuildCells(built.cells);
  }

  private addMeshObject(mesh: MeshData, model: Float32Array, color: [number, number, number, number]) {
    if (!this.device || !this.objectLayout) return;
    const vertexBuffer = this.device.createBuffer({ size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices);
    let indexBuffer: GPUBuffer | undefined;
    if (mesh.indices) {
      indexBuffer = this.device.createBuffer({ size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(indexBuffer, 0, mesh.indices);
    }
    const uniformBuffer = this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const data = new Float32Array(20);
    data.set(model, 0);
    data[16] = color[0]; data[17] = color[1]; data[18] = color[2]; data[19] = color[3];
    this.device.queue.writeBuffer(uniformBuffer, 0, data);
    const bindGroup = this.device.createBindGroup({ layout: this.objectLayout, entries: [{ binding: 0, resource: { buffer: uniformBuffer } }] });
    this.objects.push({ vertexBuffer, indexBuffer, indexCount: mesh.indices?.length, vertexCount: mesh.vertices.length / 6, model, color, uniformBuffer, bindGroup });
  }

  private rebuildCells(cells: CellRecord[]) {
    if (!this.device || !this.objectLayout) return;
    this.cellBuffer?.destroy();
    this.cellUniformBuffer?.destroy();
    this.cellCount = cells.length;
    this.cellData = new Float32Array(cells.length * 6 * 9);
    const defaultColor = illuminationColor(1);
    cells.forEach((c, ci) => {
      const corners: Vec3[] = [
        offset(c, -0.5, -0.5), offset(c, 0.5, -0.5), offset(c, 0.5, 0.5),
        offset(c, -0.5, -0.5), offset(c, 0.5, 0.5), offset(c, -0.5, 0.5)
      ];
      corners.forEach((p, vi) => {
        const b = (ci * 6 + vi) * 9;
        this.cellData![b] = p[0]; this.cellData![b + 1] = p[1]; this.cellData![b + 2] = p[2];
        this.cellData![b + 3] = c.normalBody[0]; this.cellData![b + 4] = c.normalBody[1]; this.cellData![b + 5] = c.normalBody[2];
        this.cellData![b + 6] = defaultColor[0] * 0.55; this.cellData![b + 7] = defaultColor[1] * 0.55; this.cellData![b + 8] = defaultColor[2] * 0.55;
      });
    });
    this.cellBuffer = this.device.createBuffer({ size: this.cellData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.cellBuffer, 0, this.cellData);
    this.cellUniformBuffer = this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const identity = new Float32Array(20);
    identity[0] = identity[5] = identity[10] = identity[15] = 1;
    identity[19] = 1;
    this.device.queue.writeBuffer(this.cellUniformBuffer, 0, identity);
    this.cellBindGroup = this.device.createBindGroup({ layout: this.objectLayout, entries: [{ binding: 0, resource: { buffer: this.cellUniformBuffer } }] });
  }

  updateCellColors(samples: Array<{ litFraction: number; totalWm2: number }>) {
    if (!this.device || !this.cellData || !this.cellBuffer) return;
    for (let i = 0; i < this.cellCount; i++) {
      const s = samples[i];
      const rgb = illuminationColor(s?.litFraction ?? 0, s?.totalWm2);
      for (let v = 0; v < 6; v++) {
        const b = (i * 6 + v) * 9 + 6;
        this.cellData[b] = rgb[0];
        this.cellData[b + 1] = rgb[1];
        this.cellData[b + 2] = rgb[2];
      }
    }
    this.device.queue.writeBuffer(this.cellBuffer, 0, this.cellData);
  }

  private resizeDepth() {
    if (!this.device || !this.context) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({ size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.depthView = this.depthTexture.createView();
    }
  }

  private loop = () => {
    if (this.destroyed) return;
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  private render() {
    if (!this.device || !this.context || !this.primitivePipeline || !this.cellPipeline || !this.sceneBuffer || !this.sceneBindGroup) return;
    this.resizeDepth();
    if (!this.depthView) return;
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const cp = Math.cos(this.pitch);
    const eye: Vec3 = [
      this.distance * cp * Math.sin(this.yaw),
      this.distance * Math.sin(this.pitch),
      this.distance * cp * Math.cos(this.yaw)
    ];
    const proj = perspective(45, aspect, 0.05, 200);
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const viewProj = new Float32Array(16);
    multiplyInto(proj, view, viewProj);
    const scene = new Float32Array(24);
    scene.set(viewProj, 0);
    scene[16] = this.sunDirection[0]; scene[17] = this.sunDirection[1]; scene[18] = this.sunDirection[2]; scene[19] = 1;
    scene[20] = eye[0]; scene[21] = eye[1]; scene[22] = eye[2]; scene[23] = 1;
    this.device.queue.writeBuffer(this.sceneBuffer, 0, scene);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.025, g: 0.035, b: 0.065, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }
    });
    pass.setPipeline(this.primitivePipeline);
    pass.setBindGroup(0, this.sceneBindGroup);
    for (const o of this.objects) {
      pass.setBindGroup(1, o.bindGroup);
      pass.setVertexBuffer(0, o.vertexBuffer);
      if (o.indexBuffer) {
        pass.setIndexBuffer(o.indexBuffer, 'uint16');
        pass.drawIndexed(o.indexCount!);
      } else {
        pass.draw(o.vertexCount);
      }
    }
    if (this.cellBuffer && this.cellBindGroup && this.cellCount) {
      pass.setPipeline(this.cellPipeline);
      pass.setBindGroup(0, this.sceneBindGroup);
      pass.setBindGroup(1, this.cellBindGroup);
      pass.setVertexBuffer(0, this.cellBuffer);
      pass.draw(this.cellCount * 6);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    for (const o of this.objects) {
      o.vertexBuffer.destroy();
      o.indexBuffer?.destroy();
      o.uniformBuffer.destroy();
    }
    this.cellBuffer?.destroy();
    this.cellUniformBuffer?.destroy();
    this.depthTexture?.destroy();
  }
}

function offset(c: CellRecord, fu: number, fv: number): Vec3 {
  return [
    c.centerBody[0] + c.tangentU[0] * fu * c.width + c.tangentV[0] * fv * c.height,
    c.centerBody[1] + c.tangentU[1] * fu * c.width + c.tangentV[1] * fv * c.height,
    c.centerBody[2] + c.tangentU[2] * fu * c.width + c.tangentV[2] * fv * c.height
  ];
}

function primitiveColor(role: string): [number, number, number, number] {
  if (role === 'antenna') return [0.72, 0.76, 0.82, 1];
  if (role === 'shield') return [0.12, 0.13, 0.16, 1];
  if (role === 'solar-panel') return [0.03, 0.08, 0.18, 1];
  if (role === 'mechanism') return [0.55, 0.48, 0.28, 1];
  return [0.48, 0.55, 0.66, 1];
}

function multiplyInto(a: Float32Array, b: Float32Array, out: Float32Array) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
}
