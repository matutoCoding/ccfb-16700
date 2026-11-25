import type { SatelliteModel, Vec3, Quat } from '../types';
import { prepareGeometry, type Occluder } from '../lib/geometry';
import { getWebGPUDevice } from './device';
import {
  clamp, hexToRgb01, lookAt, mat4FromQuat, mat4Multiply, perspective, transformDirection, transformPoint,
} from '../lib/math';

const VERTEX_FLOATS = 9;
const VERTEX_STRIDE = VERTEX_FLOATS * 4;

const SHADER = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4<f32>,
  model: mat4x4<f32>,
  light: vec4<f32>,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec3<f32>,
};

@vertex
fn vsMain(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.position = uniforms.mvp * vec4<f32>(input.position, 1.0);
  out.normal = normalize((uniforms.model * vec4<f32>(input.normal, 0.0)).xyz);
  out.color = input.color;
  return out;
}

@fragment
fn fsMain(input: VertexOut) -> @location(0) vec4<f32> {
  let n = normalize(input.normal);
  let l = normalize(uniforms.light.xyz);
  let key = max(dot(n, l), 0.0);
  let fill = max(dot(n, normalize(vec3<f32>(-0.4, 0.25, 0.8))), 0.0) * 0.18;
  let light = 0.48 + 0.58 * key + fill;
  let color = input.color * light;
  return vec4<f32>(pow(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.92)), 1.0);
}
`;

interface BuiltMesh {
  data: Float32Array;
  vertexCount: number;
}

function pushVertex(arr: number[], p: Vec3, n: Vec3, c: [number, number, number]): void {
  arr.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2]);
}

function transformed(occ: Occluder, p: Vec3, n: Vec3): { p: Vec3; n: Vec3 } {
  return { p: transformPoint(occ.model, p), n: transformDirection(occ.model, n) };
}

function addBox(arr: number[], occ: Occluder): void {
  const [sx, sy, sz] = occ.size;
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const c = occ.color;
  const faces: Array<{ n: Vec3; q: Vec3[] }> = [
    { n: [1, 0, 0], q: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
    { n: [-1, 0, 0], q: [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]] },
    { n: [0, 1, 0], q: [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [0, -1, 0], q: [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]] },
    { n: [0, 0, 1], q: [[hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz]] },
    { n: [0, 0, -1], q: [[-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz]] },
  ];
  for (const f of faces) {
    const q = f.q.map((p) => transformed(occ, p, f.n));
    const tri = [q[0], q[1], q[2], q[0], q[2], q[3]];
    for (const v of tri) pushVertex(arr, v.p, v.n, c);
  }
}

function addCylinder(arr: number[], occ: Occluder): void {
  const r = occ.radius;
  const h = occ.height;
  const segments = 28;
  const c = occ.color;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const n0: Vec3 = [Math.cos(a0), 0, Math.sin(a0)];
    const n1: Vec3 = [Math.cos(a1), 0, Math.sin(a1)];
    const b0 = transformed(occ, [r * Math.cos(a0), -h / 2, r * Math.sin(a0)], n0);
    const t0 = transformed(occ, [r * Math.cos(a0), h / 2, r * Math.sin(a0)], n0);
    const b1 = transformed(occ, [r * Math.cos(a1), -h / 2, r * Math.sin(a1)], n1);
    const t1 = transformed(occ, [r * Math.cos(a1), h / 2, r * Math.sin(a1)], n1);
    for (const v of [b0, t0, t1, b0, t1, b1]) pushVertex(arr, v.p, v.n, c);

    const topN = transformDirection(occ.model, [0, 1, 0]);
    const bottomN = transformDirection(occ.model, [0, -1, 0]);
    const topC = transformed(occ, [0, h / 2, 0], [0, 1, 0]);
    const bottomC = transformed(occ, [0, -h / 2, 0], [0, -1, 0]);
    const ti = transformed(occ, [r * Math.cos(a0), h / 2, r * Math.sin(a0)], [0, 1, 0]);
    const tj = transformed(occ, [r * Math.cos(a1), h / 2, r * Math.sin(a1)], [0, 1, 0]);
    const bi = transformed(occ, [r * Math.cos(a0), -h / 2, r * Math.sin(a0)], [0, -1, 0]);
    const bj = transformed(occ, [r * Math.cos(a1), -h / 2, r * Math.sin(a1)], [0, -1, 0]);
    void topN; void bottomN;
    for (const v of [topC, tj, ti]) pushVertex(arr, v.p, topC.n, c);
    for (const v of [bottomC, bi, bj]) pushVertex(arr, v.p, bottomC.n, c);
  }
}

function buildStaticMesh(model: SatelliteModel): BuiltMesh {
  const prepared = prepareGeometry(model);
  const arr: number[] = [];
  for (const occ of prepared.occluders) {
    if (occ.kind === 1 && occ.radius > 0 && occ.height > 0) addCylinder(arr, occ);
    else addBox(arr, occ);
  }
  return { data: new Float32Array(arr), vertexCount: arr.length / VERTEX_FLOATS };
}

function valueColor(t: number): [number, number, number] {
  const x = clamp(t, 0, 1);
  const stops: Array<[number, [number, number, number]]> = [
    [0, [0.025, 0.055, 0.16]],
    [0.25, [0.06, 0.28, 0.75]],
    [0.52, [0.05, 0.72, 0.62]],
    [0.78, [0.98, 0.78, 0.18]],
    [1, [0.95, 0.28, 0.16]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (x >= a && x <= b) {
      const u = (x - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u];
    }
  }
  return stops[stops.length - 1][1];
}

export class SatelliteRenderer {
  private canvas: HTMLCanvasElement;
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private pipeline!: GPURenderPipeline;
  private uniformBuffer!: GPUBuffer;
  private staticBuffer: GPUBuffer | null = null;
  private cellBuffer: GPUBuffer | null = null;
  private depthTexture: GPUTexture | null = null;
  private staticCount = 0;
  private cellCountVertices = 0;
  private cellCpu: Float32Array = new Float32Array();
  private cellCount = 0;
  private bindGroup!: GPUBindGroup;
  private observer: ResizeObserver | null = null;
  private raf = 0;
  private disposed = false;
  private yaw = 0.72;
  private pitch = 0.42;
  private distance = 5.2;
  private drag: { x: number; y: number } | null = null;
  private attitudeQ: Quat = [0, 0, 0, 1];
  private sunECI: Vec3 = [0.35, 0.6, 0.72];
  private model: SatelliteModel | null = null;
  private currentValues: Float32Array | number[] = [];

  private constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  static async create(canvas: HTMLCanvasElement, model: SatelliteModel): Promise<SatelliteRenderer | null> {
    const r = new SatelliteRenderer(canvas);
    const device = await getWebGPUDevice();
    if (!device) return null;
    r.device = device;
    const context = canvas.getContext('webgpu');
    if (!context) return null;
    r.context = context;
    r.context.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'premultiplied',
    });
    r.createPipeline();
    r.uniformBuffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    r.bindGroup = device.createBindGroup({
      layout: r.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: r.uniformBuffer } }],
    });
    r.attachControls();
    r.observer = new ResizeObserver(() => r.resize());
    r.observer.observe(canvas);
    r.resize();
    r.setModel(model);
    r.loop();
    return r;
  }

  private createPipeline(): void {
    const module = this.device.createShaderModule({ code: SHADER });
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vsMain',
        buffers: [{
          arrayStride: VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fsMain',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
  }

  setModel(model: SatelliteModel): void {
    this.model = model;
    const staticMesh = buildStaticMesh(model);
    this.staticCount = staticMesh.vertexCount;
    this.staticBuffer?.destroy();
    this.staticBuffer = this.device.createBuffer({ size: staticMesh.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.staticBuffer, 0, staticMesh.data);

    const prepared = prepareGeometry(model);
    this.cellCount = prepared.cells.length;
    const verticesPerCell = 6;
    this.cellCountVertices = this.cellCount * verticesPerCell;
    this.cellCpu = new Float32Array(this.cellCountVertices * VERTEX_FLOATS);
    prepared.cells.forEach((cell, ci) => {
      const corners: Vec3[] = [
        [-1, -1], [1, -1], [1, 1],
        [-1, -1], [1, 1], [-1, 1],
      ].map(([u, v]) => [
        cell.centerBody[0] + cell.axisUBody[0] * u * cell.halfU + cell.axisVBody[0] * v * cell.halfV,
        cell.centerBody[1] + cell.axisUBody[1] * u * cell.halfU + cell.axisVBody[1] * v * cell.halfV,
        cell.centerBody[2] + cell.axisUBody[2] * u * cell.halfU + cell.axisVBody[2] * v * cell.halfV,
      ] as Vec3);
      const color = valueColor(this.currentValues[ci] ?? 0.85);
      for (let vi = 0; vi < 6; vi++) {
        const o = (ci * 6 + vi) * VERTEX_FLOATS;
        const p = corners[vi];
        this.cellCpu[o] = p[0]; this.cellCpu[o + 1] = p[1]; this.cellCpu[o + 2] = p[2];
        this.cellCpu[o + 3] = cell.normalBody[0]; this.cellCpu[o + 4] = cell.normalBody[1]; this.cellCpu[o + 5] = cell.normalBody[2];
        this.cellCpu[o + 6] = color[0]; this.cellCpu[o + 7] = color[1]; this.cellCpu[o + 8] = color[2];
      }
    });
    this.cellBuffer?.destroy();
    this.cellBuffer = this.device.createBuffer({ size: Math.max(4, this.cellCpu.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.cellBuffer, 0, this.cellCpu);

    const radius = Math.max(2.2, ...prepared.cells.map((c) => Math.hypot(...c.centerBody) + 0.4));
    this.distance = radius * 2.35;
    this.setCellValues(this.currentValues.length ? this.currentValues : prepared.cells.map(() => 0.9));
  }

  setCellValues(values: ArrayLike<number> | number[]): void {
    this.currentValues = Array.from(values as ArrayLike<number>);
    if (!this.cellBuffer || !this.model) return;
    const prepared = prepareGeometry(this.model);
    for (let ci = 0; ci < this.cellCount; ci++) {
      const col = valueColor(values[ci] ?? 0);
      for (let vi = 0; vi < 6; vi++) {
        const o = (ci * 6 + vi) * VERTEX_FLOATS + 6;
        this.cellCpu[o] = col[0];
        this.cellCpu[o + 1] = col[1];
        this.cellCpu[o + 2] = col[2];
      }
    }
    this.device.queue.writeBuffer(this.cellBuffer, 0, this.cellCpu);
    void prepared;
  }

  setFrame(q: Quat, sunECI: Vec3, values?: ArrayLike<number>): void {
    this.attitudeQ = q;
    this.sunECI = sunECI;
    if (values) this.setCellValues(values);
  }

  private attachControls(): void {
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDblClick);
  }

  private onDown = (e: PointerEvent): void => {
    this.drag = { x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture?.(e.pointerId);
  };
  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag = { x: e.clientX, y: e.clientY };
    this.yaw -= dx * 0.008;
    this.pitch = clamp(this.pitch + dy * 0.008, -1.35, 1.35);
  };
  private onUp = (): void => { this.drag = null; };
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.distance = clamp(this.distance * Math.exp(e.deltaY * 0.001), 1.4, 18);
  };
  private onDblClick = (): void => { this.yaw = 0.72; this.pitch = 0.42; if (this.model) this.setModel(this.model); };

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  private render(): void {
    if (!this.device || !this.context || !this.depthTexture || !this.staticBuffer) return;
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const proj = perspective(42, aspect, 0.04, 100);
    const cp = Math.cos(this.pitch);
    const eye: Vec3 = [
      this.distance * cp * Math.sin(this.yaw),
      this.distance * Math.sin(this.pitch),
      this.distance * cp * Math.cos(this.yaw),
    ];
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const model = mat4FromQuat(this.attitudeQ);
    const pv = mat4Multiply(proj, view);
    const mvp = mat4Multiply(pv, model);
    const uniform = new Float32Array(64);
    uniform.set(mvp, 0);
    uniform.set(model, 16);
    uniform[32] = this.sunECI[0]; uniform[33] = this.sunECI[1]; uniform[34] = this.sunECI[2]; uniform[35] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniform);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.035, g: 0.055, b: 0.095, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.staticBuffer);
    pass.draw(this.staticCount);
    if (this.cellBuffer && this.cellCountVertices > 0) {
      pass.setVertexBuffer(0, this.cellBuffer);
      pass.draw(this.cellCountVertices);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    this.staticBuffer?.destroy();
    this.cellBuffer?.destroy();
    this.depthTexture?.destroy();
    try { this.context?.unconfigure(); } catch { /* noop */ }
  }
}

export async function mountRenderer(canvas: HTMLCanvasElement, model: SatelliteModel): Promise<SatelliteRenderer | null> {
  return SatelliteRenderer.create(canvas, model);
}

export { hexToRgb01 };
