/**
 * Pure frame renderers for the interactive session's 3D indicators — a rotating torus (the classic donut projection)
 * for thinking, a spinning wireframe cube while a command runs, a rotating wireframe globe while a model or Jev is
 * being called, and a travelling wave while tests verify. Each returns a fixed, deterministic set of frames for a cell
 * size, so a caller precomputes once per terminal size (a 24×12 torus is 48 frames in a few milliseconds) and cycles
 * through them on a timer; no dependency, no I/O, no randomness. The luminance ramp is donut.c's `.,-~:;=!*#$@`.
 */

export type Frames = readonly string[][];

export const LUMINANCE = '.,-~:;=!*#$@';

/** Frames per second the indicators are cycled at (the caller's timer; 12 keeps the event-loop-lag gate untouched). */
export const ANIM_FPS = 12;

/**
 * The indicator box for a terminal: 24×12 at ≥ 100 columns and ≥ 24 rows, 16×8 at 80 columns, none below 60 columns
 * or 16 rows (the caller shows the glyph spinner instead).
 */
export function animSize(columns: number, rows: number): { w: number; h: number } | null {
  if (columns < 60 || rows < 16) return null;
  if (columns >= 100 && rows >= 24) return { w: 24, h: 12 };
  return { w: 16, h: 8 };
}

function grid(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));
}

function clampSize(w0: number, h0: number, n0: number): { w: number; h: number; n: number } {
  return { w: Math.max(8, Math.floor(w0)), h: Math.max(4, Math.floor(h0)), n: Math.max(2, Math.floor(n0)) };
}

/** The donut: a torus (R1 = 1 tube radius, R2 = 2 ring radius) spun about two axes, luminance from the surface normal. */
export function torusFrames(w0: number, h0: number, n0: number): Frames {
  const { w, h, n } = clampSize(w0, h0, n0);
  const out: string[][] = [];
  const R1 = 1, R2 = 2, K2 = 5;
  // K1 scales the projection to the cell box; cells are ~2× taller than wide, so the horizontal factor doubles
  const K1x = (w * K2 * 3) / (8 * (R1 + R2));
  const K1y = (h * K2 * 3) / (8 * (R1 + R2)) * 1.05;
  for (let f = 0; f < n; f++) {
    // both angles complete a whole revolution per cycle, so `tick % n` is seamless (a half turn on B popped the tilt once per loop)
    const A = (f / n) * Math.PI * 2 + 1.0;
    const B = (f / n) * Math.PI * 2 + 0.5;
    const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
    const cells = grid(w, h);
    const z = Array.from({ length: h }, () => new Float64Array(w));
    // sampling density follows the box: a 24×12 box needs far fewer surface points than a 60×30 one
    const thetaStep = Math.max(0.05, 2.4 / w), phiStep = Math.max(0.015, 0.8 / w);
    for (let theta = 0; theta < Math.PI * 2; theta += thetaStep) {
      const ct = Math.cos(theta), st = Math.sin(theta);
      for (let phi = 0; phi < Math.PI * 2; phi += phiStep) {
        const cp = Math.cos(phi), sp = Math.sin(phi);
        const cx = R2 + R1 * ct, cy = R1 * st;
        const x = cx * (cB * cp + sA * sB * sp) - cy * cA * sB;
        const y = cx * (sB * cp - sA * cB * sp) + cy * cA * cB;
        const zz = K2 + cA * cx * sp + cy * sA;
        const ooz = 1 / zz;
        const xp = Math.floor(w / 2 + K1x * ooz * x);
        const yp = Math.floor(h / 2 - K1y * ooz * y);
        if (xp < 0 || xp >= w || yp < 0 || yp >= h) continue;
        const L = cp * ct * sB - cA * ct * sp - sA * st + cB * (cA * st - ct * sA * sp);
        if (L <= 0) continue;
        if (ooz > z[yp]![xp]!) {
          z[yp]![xp] = ooz;
          const idx = Math.min(LUMINANCE.length - 1, Math.floor(L * 8));
          cells[yp]![xp] = LUMINANCE[idx]!;
        }
      }
    }
    out.push(cells.map((r) => r.join('')));
  }
  return out;
}

type V3 = readonly [number, number, number];

function rotate(v: V3, ax: number, ay: number, az: number): V3 {
  let [x, y, z] = v;
  // X
  let cy = Math.cos(ax), sy = Math.sin(ax);
  [y, z] = [y * cy - z * sy, y * sy + z * cy];
  // Y
  cy = Math.cos(ay); sy = Math.sin(ay);
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  // Z
  cy = Math.cos(az); sy = Math.sin(az);
  [x, y] = [x * cy - y * sy, x * sy + y * cy];
  return [x, y, z];
}

function project(v: V3, w: number, h: number, scale: number, d = 4): readonly [number, number, number] {
  const ooz = 1 / (v[2] + d);
  return [w / 2 + v[0] * ooz * scale * 2, h / 2 - v[1] * ooz * scale, ooz];
}

function line(cells: string[][], x0: number, y0: number, x1: number, y1: number, ch: string): void {
  const h = cells.length, w = cells[0]?.length ?? 0;
  let ax = Math.round(x0), ay = Math.round(y0);
  const bx = Math.round(x1), by = Math.round(y1);
  const dx = Math.abs(bx - ax), dy = -Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 4096; guard++) {
    if (ax >= 0 && ax < w && ay >= 0 && ay < h) cells[ay]![ax] = ch;
    if (ax === bx && ay === by) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; ax += sx; }
    if (e2 <= dx) { err += dx; ay += sy; }
  }
}

/** A wireframe cube spun about all three axes; nearer edges brighter. */
export function cubeFrames(w0: number, h0: number, n0: number): Frames {
  const { w, h, n } = clampSize(w0, h0, n0);
  const verts: V3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) verts.push([x, y, z]);
  const edges: [number, number][] = [];
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    const a = verts[i]!, b = verts[j]!;
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) === 2) edges.push([i, j]);
  }
  const scale = Math.min(w / 2.6, h * 1.05);
  const out: string[][] = [];
  for (let f = 0; f < n; f++) {
    const t = (f / n) * Math.PI * 2;
    const cells = grid(w, h);
    const p = verts.map((v) => project(rotate(v, t * 0.7 + 0.4, t, t * 0.3), w, h, scale));
    const sorted = [...edges].sort((e1, e2) => (p[e1[0]]![2] + p[e1[1]]![2]) - (p[e2[0]]![2] + p[e2[1]]![2]));
    for (const [i, j] of sorted) {
      const depth = (p[i]![2] + p[j]![2]) / 2;
      const ch = depth > 0.3 ? '#' : depth > 0.24 ? '=' : '-';
      line(cells, p[i]![0], p[i]![1], p[j]![0], p[j]![1], ch);
    }
    for (const v of p) { const x = Math.round(v[0]), y = Math.round(v[1]); if (x >= 0 && x < w && y >= 0 && y < h) cells[y]![x] = '@'; }
    out.push(cells.map((r) => r.join('')));
  }
  return out;
}

/** A rotating wireframe globe: six meridians and three parallels, the lit hemisphere brighter. */
export function globeFrames(w0: number, h0: number, n0: number): Frames {
  const { w, h, n } = clampSize(w0, h0, n0);
  // camera at 3 and a fuller scale: at 24×12 the sphere spans ~10 of the 12 rows, centred, like the torus and the cube
  const scale = Math.min(w / 1.6, h * 1.35);
  const out: string[][] = [];
  for (let f = 0; f < n; f++) {
    const spin = (f / n) * Math.PI * 2;
    const cells = grid(w, h);
    const z = Array.from({ length: h }, () => new Float64Array(w).fill(-1));
    const plot = (v: V3): void => {
      const r = rotate(v, 0.35, spin, 0);
      const [x, y, ooz] = project(r, w, h, scale, 3);
      const xp = Math.round(x), yp = Math.round(y);
      if (xp < 0 || xp >= w || yp < 0 || yp >= h) return;
      if (r[2] < -0.05) return; // back hemisphere hidden
      if (ooz > z[yp]![xp]!) {
        z[yp]![xp] = ooz;
        const lit = (r[0] * -0.5 + r[1] * 0.4 + r[2] * 0.75);
        cells[yp]![xp] = lit > 0.55 ? '@' : lit > 0.25 ? '*' : lit > 0 ? '=' : '-';
      }
    };
    for (let m = 0; m < 6; m++) {
      const lon = (m / 6) * Math.PI;
      for (let t = -Math.PI / 2; t <= Math.PI / 2; t += 0.04) plot([Math.cos(t) * Math.cos(lon), Math.sin(t), Math.cos(t) * Math.sin(lon)]);
    }
    for (const lat of [-0.9, 0, 0.9]) {
      const r = Math.cos(lat), y = Math.sin(lat);
      for (let t = 0; t < Math.PI * 2; t += 0.03) plot([r * Math.cos(t), y, r * Math.sin(t)]);
    }
    out.push(cells.map((r) => r.join('')));
  }
  return out;
}

/** A travelling wave: two superposed sines, crests brighter, for the verify state. */
export function waveFrames(w0: number, h0: number, n0: number): Frames {
  const { w, h, n } = clampSize(w0, h0, n0);
  const out: string[][] = [];
  for (let f = 0; f < n; f++) {
    const t = (f / n) * Math.PI * 2;
    const cells = grid(w, h);
    for (let x = 0; x < w; x++) {
      const v = Math.sin(x / 3 + t) * 0.6 + Math.sin(x / 7 - t * 1.3) * 0.4; // -1..1
      const y = Math.round((h - 1) / 2 - v * (h - 1) / 2.4);
      if (y >= 0 && y < h) cells[y]![x] = v > 0.5 ? '@' : v > 0 ? '*' : v > -0.5 ? '=' : '-';
      const y2 = Math.min(h - 1, y + 1);
      if (y2 >= 0 && y2 !== y && cells[y2]![x] === ' ') cells[y2]![x] = '.';
    }
    out.push(cells.map((r) => r.join('')));
  }
  return out;
}

export type IndicatorKind = 'thinking' | 'running' | 'calling' | 'verifying';

/** The renderer for each indicator state; a caller keys its frame cache on (kind, width, height). */
export function indicatorFrames(kind: IndicatorKind, w: number, h: number, n: number): Frames {
  switch (kind) {
    case 'thinking': return torusFrames(w, h, n);
    case 'running': return cubeFrames(w, h, n);
    case 'calling': return globeFrames(w, h, n);
    case 'verifying': return waveFrames(w, h, n);
  }
}
