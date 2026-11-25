import type { ScenarioCase, Vec3 } from '../types';
import { buildGeometry } from '../lib/geometry';
import { composeMatrix, lookAt, mat4Multiply, normalize, perspective, quatFromAxisAngle, quatFromEulerDeg, quatMultiply, rotateVec } from '../lib/math';
import { illuminationColor } from './sceneRenderer';

type SampleLike = { litFraction: number; totalWm2: number };
type Poly = { points: Vec3[]; normal: Vec3; color: [number, number, number, number]; cell?: boolean };

export class CanvasFallbackRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private scenario: ScenarioCase;
  private cellColors: Array<[number, number, number]> = [];
  private sun: Vec3 = [0.4, 0.6, 0.7];
  private yaw = 0.72;
  private pitch = 0.34;
  private distance = 8;
  private raf = 0;
  private destroyed = false;
  private drag: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, scenario: ScenarioCase) {
    this.canvas = canvas;
    this.scenario = scenario;
    this.ctx = canvas.getContext('2d');
    const built = buildGeometry(scenario.geometry);
    this.cellColors = built.cells.map(() => [0.12, 0.35, 0.75]);
    this.distance = Math.max(3.2, built.radiusM * 2.05);
    this.bind();
    this.loop();
  }

  setScenario(scenario: ScenarioCase) {
    this.scenario = scenario;
    const built = buildGeometry(scenario.geometry);
    this.cellColors = built.cells.map(() => [0.12, 0.35, 0.75]);
  }
  setSunDirection(v: Vec3) { this.sun = normalize(v); }
  updateCellColors(samples: SampleLike[]) {
    this.cellColors = samples.map((s) => illuminationColor(s.litFraction, s.totalWm2));
  }

  private bind() {
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }
  private onDown = (e: PointerEvent) => {
    this.drag = { x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture?.(e.pointerId);
  };
  private onMove = (e: PointerEvent) => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag = { x: e.clientX, y: e.clientY };
    this.yaw -= dx * 0.008;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - dy * 0.008));
  };
  private onUp = () => { this.drag = null; };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.distance = Math.max(1.5, Math.min(60, this.distance * Math.exp(e.deltaY * 0.001)));
  };

  private loop = () => {
    if (this.destroyed) return;
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  private objectPolys(model: Float32Array, color: [number, number, number, number]): Poly[] {
    const localCorners: Vec3[] = [
      [-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5],
      [-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]
    ];
    const corners = localCorners.map((p) => transformPoint(model, p));
    const faces: Array<{ idx: [number, number, number, number]; n: Vec3 }> = [
      { idx: [1, 2, 6, 5], n: [1, 0, 0] }, { idx: [0, 4, 7, 3], n: [-1, 0, 0] },
      { idx: [3, 7, 6, 2], n: [0, 1, 0] }, { idx: [0, 1, 5, 4], n: [0, -1, 0] },
      { idx: [4, 5, 6, 7], n: [0, 0, 1] }, { idx: [0, 3, 2, 1], n: [0, 0, -1] }
    ];
    const q = quatFromMatrix(model);
    return faces.map((f) => ({ points: f.idx.map((i) => corners[i]), normal: rotateVec(q, f.n), color }));
  }

  private render() {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0b1b33'); bg.addColorStop(1, '#050b16');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

    const cp = Math.cos(this.pitch);
    const eye: Vec3 = [this.distance * cp * Math.sin(this.yaw), this.distance * Math.sin(this.pitch), this.distance * cp * Math.cos(this.yaw)];
    const proj = perspective(45, w / h, 0.05, 200);
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const vp = mat4Multiply(proj, view);
    const project = (p: Vec3) => projectPoint(vp, p, w, h);

    const polys: Poly[] = [];
    for (const p of this.scenario.geometry.primitives) {
      const q = quatFromEulerDeg(p.rotationDeg);
      const dims = p.kind === 'cylinder' ? [p.dimensions[0] * 2, p.dimensions[1], p.dimensions[0] * 2] as Vec3 : p.dimensions;
      polys.push(...this.objectPolys(composeMatrix(p.position, q, dims), primitiveRgb(p.role)));
    }
    for (const a of this.scenario.geometry.arrays) {
      const qh = quatFromAxisAngle(a.hingeAxis, a.hingeAngleDeg * Math.PI / 180);
      const qd = quatFromAxisAngle(a.driveAxisLocal, a.driveAngleDeg * Math.PI / 180);
      const q = quatMultiply(qh, qd);
      const width = a.layout.cols * a.layout.cellWidth + Math.max(0, a.layout.cols - 1) * a.layout.gapX;
      const height = a.layout.rows * a.layout.cellHeight + Math.max(0, a.layout.rows - 1) * a.layout.gapY;
      const centerOffset = rotateVec(q, a.layout.centerOffset);
      const center: Vec3 = [a.rootPosition[0] + centerOffset[0], a.rootPosition[1] + centerOffset[1], a.rootPosition[2] + centerOffset[2]];
      polys.push(...this.objectPolys(composeMatrix(center, q, [width + .08, height + .08, a.panelThickness]), [.03, .05, .09, 1]));
    }

    const { cells } = buildGeometry(this.scenario.geometry);
    cells.forEach((c, i) => {
      const pts: Vec3[] = [
        [-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]
      ].map(([u, v]) => [
        c.centerBody[0] + c.tangentU[0] * u * c.width + c.tangentV[0] * v * c.height + c.normalBody[0] * .006,
        c.centerBody[1] + c.tangentU[1] * u * c.width + c.tangentV[1] * v * c.height + c.normalBody[1] * .006,
        c.centerBody[2] + c.tangentU[2] * u * c.width + c.tangentV[2] * v * c.height + c.normalBody[2] * .006
      ] as Vec3);
      polys.push({ points: pts, normal: c.normalBody, color: [...this.cellColors[i] ?? [.1, .4, .9], 1], cell: true });
    });

    const drawable = polys.map((poly) => {
      const center = average(poly.points);
      const toEye = normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
      const facing = poly.normal[0] * toEye[0] + poly.normal[1] * toEye[1] + poly.normal[2] * toEye[2];
      return { poly, center, facing, depth: Math.hypot(center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]) };
    }).filter((x) => x.poly.cell || x.facing > -0.02)
      .sort((a, b) => b.depth - a.depth);

    for (const item of drawable) {
      const poly = item.poly;
      const lit = .52 + Math.max(0, poly.normal[0] * this.sun[0] + poly.normal[1] * this.sun[1] + poly.normal[2] * this.sun[2]) * .55;
      const pts = poly.points.map(project);
      if (pts.some((p) => p.behind)) continue;
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath();
      const [r, g, b] = poly.color;
      ctx.fillStyle = `rgba(${Math.min(255, r * 255 * lit) | 0},${Math.min(255, g * 255 * lit) | 0},${Math.min(255, b * 255 * lit) | 0},${poly.color[3]})`;
      ctx.fill();
      ctx.strokeStyle = poly.cell ? 'rgba(180,220,255,.22)' : 'rgba(210,225,255,.28)';
      ctx.lineWidth = poly.cell ? .45 : .8;
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(219,234,254,.72)';
    ctx.font = '12px Segoe UI, Microsoft YaHei';
    ctx.fillText('Canvas2D 兼容预览（WebGPU 适配器不可用；推演仍可走 CPU 参考后端）', 14, h - 16);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }
}

function transformPoint(m: Float32Array, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
}
function projectPoint(m: Float32Array, p: Vec3, w: number, h: number) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (Math.abs(cw) < 1e-6) return { x: 0, y: 0, behind: true };
  const ndcX = x / cw, ndcY = y / cw, ndcZ = z / cw;
  return { x: (ndcX * .5 + .5) * w, y: (1 - (ndcY * .5 + .5)) * h, behind: cw <= 0 || ndcZ < -1 || ndcZ > 1 };
}
function average(points: Vec3[]): Vec3 {
  return [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length, points.reduce((s, p) => s + p[2], 0) / points.length];
}
function primitiveRgb(role: string): [number, number, number, number] {
  if (role === 'antenna') return [.72, .76, .82, 1];
  if (role === 'shield') return [.12, .13, .16, 1];
  if (role === 'mechanism') return [.55, .48, .28, 1];
  return [.48, .55, .66, 1];
}
function quatFromMatrix(m: Float32Array): [number, number, number, number] {
  // Reuse robust conversion through basis extraction.
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const m00 = m[0] / sx, m10 = m[1] / sx, m20 = m[2] / sx;
  const m01 = m[4] / sy, m11 = m[5] / sy, m21 = m[6] / sy;
  const m02 = m[8] / sz, m12 = m[9] / sz, m22 = m[10] / sz;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m12 - m21) / s, (m20 - m02) / s, (m01 - m10) / s, .25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [.25 * s, (m01 + m10) / s, (m20 + m02) / s, (m12 - m21) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, .25 * s, (m12 + m21) / s, (m20 - m02) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m20 + m02) / s, (m12 + m21) / s, .25 * s, (m01 - m10) / s];
}
