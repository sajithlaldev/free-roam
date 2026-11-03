import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * A small toolkit for modelling vehicles in code.
 *
 * - `Kit` collects geometry per material key and merges it, so a whole vehicle body is a
 *   handful of draw calls (and the merged geometry is shared by every car of that model).
 * - `loft` builds smooth body shells from cross-sections along the car (z): each section is
 *   a rounded trapezoid (sill → side → shoulder radius → roof/bonnet crown). Wheel arches are
 *   cut out of the side walls, ends can be closed with a filleted face, and every grid cell
 *   is handed to a classifier that picks its material — so windows, pillars, cladding and
 *   shut lines all come out of the one surface and line up perfectly.
 * - `sweep` runs a 2D profile along a 3D path (bumpers, flares, trim strips, lamps, rails).
 */

export type Seg = 'sideR' | 'cornerR' | 'top' | 'cornerL' | 'sideL' | 'bottom';

export interface Sec {
  z: number;
  /** bottom of the side wall (sill) */
  yb: number;
  /** top (bonnet/roof/belt) height at the centre line, before crown */
  yt: number;
  /** half-width at the bottom and at the top (before the shoulder radius) */
  wb: number;
  wt: number;
  /** shoulder radius */
  r: number;
  /** extra height at the centre of the top (bonnet/roof camber) */
  crown?: number;
  /** outward bow of the side wall at mid height */
  bulge?: number;
}

export interface Arch {
  z: number;
  y: number;
  r: number;
}

export interface Cell {
  x: number;
  y: number;
  z: number;
  seg: Seg;
  /** 0..1 along the segment */
  t: number;
  /** on an end face; s = ring scale there (1 = edge of the face, 0 = centre) */
  face: 'front' | 'back' | null;
  s: number;
}

export type Classify = (c: Cell) => string | null;

export interface LoftOpts {
  step?: number;
  zBreaks?: number[];
  tBreaks?: Partial<Record<Seg, number[]>>;
  counts?: { side?: number; corner?: number; top?: number; bottom?: number };
  arches?: Arch[];
  capFront?: number; // fillet depth (m); undefined = open
  capBack?: number;
  closed?: boolean; // include the bottom segment (needed for capped ends)
  /** push cells of these keys in (−) or out (+) along the normal, metres */
  inset?: Record<string, number>;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Section at z (piecewise linear between the given sections). */
export function secAt(secs: Sec[], z: number): Sec {
  const s = [...secs].sort((a, b) => a.z - b.z);
  if (z <= s[0].z) return { ...s[0], z };
  if (z >= s[s.length - 1].z) return { ...s[s.length - 1], z };
  let i = 0;
  while (s[i + 1].z < z) i++;
  const a = s[i];
  const b = s[i + 1];
  const k = (z - a.z) / (b.z - a.z);
  return {
    z,
    yb: lerp(a.yb, b.yb, k),
    yt: lerp(a.yt, b.yt, k),
    wb: lerp(a.wb, b.wb, k),
    wt: lerp(a.wt, b.wt, k),
    r: lerp(a.r, b.r, k),
    crown: lerp(a.crown ?? 0, b.crown ?? 0, k),
    bulge: lerp(a.bulge ?? 0, b.bulge ?? 0, k),
  };
}

function archBottom(arches: Arch[] | undefined, z: number, yb: number) {
  if (!arches) return yb;
  let y = yb;
  for (const a of arches) {
    const dz = Math.abs(z - a.z);
    if (dz < a.r) y = Math.max(y, a.y + Math.sqrt(a.r * a.r - dz * dz));
  }
  return y;
}

/** Point on a section's ring. Right side is −X. */
function ringPoint(s: Sec, seg: Seg, t: number, yb: number): [number, number] {
  const crown = s.crown ?? 0;
  const bulge = s.bulge ?? 0;
  const r = Math.min(s.r, Math.max(1e-4, (s.yt - yb) * 0.95), s.wt * 0.95);
  const ys = Math.max(yb, s.yt - r);
  const side = (u: number): [number, number] => [s.wb + (s.wt - s.wb) * u + bulge * Math.sin(Math.PI * u), yb + (ys - yb) * u];
  switch (seg) {
    case 'sideR': {
      const [x, y] = side(t);
      return [-x, y];
    }
    case 'sideL': {
      const [x, y] = side(1 - t);
      return [x, y];
    }
    case 'cornerR': {
      const a = Math.PI - (t * Math.PI) / 2;
      return [-s.wt + r + Math.cos(a) * r, ys + Math.sin(a) * r];
    }
    case 'cornerL': {
      const a = Math.PI / 2 - (t * Math.PI) / 2;
      return [s.wt - r + Math.cos(a) * r, ys + Math.sin(a) * r];
    }
    case 'top': {
      const x = -s.wt + r + t * 2 * (s.wt - r);
      const c = s.wt - r > 1e-4 ? 1 - (x / (s.wt - r)) ** 2 : 1;
      return [x, ys + r + crown * c];
    }
    case 'bottom': {
      return [s.wb - t * 2 * s.wb, yb];
    }
  }
}

function tList(n: number, breaks: number[] = [], skipFirst = false): number[] {
  const v = new Set<number>();
  for (let i = 0; i <= n; i++) v.add(+(i / n).toFixed(5));
  for (const b of breaks) if (b > 0 && b < 1) v.add(+b.toFixed(5));
  const out = [...v].sort((a, b) => a - b);
  return skipFirst ? out.filter((t) => t > 0) : out;
}

/** Half-width of the body at height y (side wall or shoulder), for placing parts flush. */
export function widthAt(secs: Sec[], z: number, y: number, arches?: Arch[]): number {
  const s = secAt(secs, z);
  const yb = archBottom(arches, z, s.yb);
  const r = Math.min(s.r, (s.yt - yb) * 0.95);
  const ys = s.yt - r;
  if (y <= ys) {
    const u = THREE.MathUtils.clamp((y - yb) / Math.max(1e-4, ys - yb), 0, 1);
    return s.wb + (s.wt - s.wb) * u + (s.bulge ?? 0) * Math.sin(Math.PI * u);
  }
  const dy = Math.min(r, y - ys);
  return s.wt - r + Math.sqrt(Math.max(0, r * r - dy * dy));
}

/** Top surface height at (x, z) (bonnet / roof), for placing parts on it. */
export function topAt(secs: Sec[], z: number, x: number): number {
  const s = secAt(secs, z);
  const half = s.wt - s.r;
  if (Math.abs(x) <= half) return s.yt + (s.crown ?? 0) * (1 - (x / Math.max(half, 1e-4)) ** 2);
  const dx = Math.min(s.r, Math.abs(x) - half);
  return s.yt - s.r + Math.sqrt(Math.max(0, s.r * s.r - dx * dx));
}

/**
 * Build a lofted shell. Returns geometry per material key (as chosen by `classify`).
 */
export function loft(secsIn: Sec[], classify: Classify, o: LoftOpts = {}): Map<string, THREE.BufferGeometry> {
  const secs = [...secsIn].sort((a, b) => a.z - b.z);
  const z0 = secs[0].z;
  const z1 = secs[secs.length - 1].z;
  const step = o.step ?? 0.05;
  const zs = new Set<number>();
  for (let z = z0; z < z1; z += step) zs.add(+z.toFixed(4));
  zs.add(z1);
  for (const s of secs) zs.add(s.z);
  for (const b of o.zBreaks ?? []) if (b > z0 && b < z1) zs.add(+b.toFixed(4));
  for (const a of o.arches ?? []) for (let z = a.z - a.r - 0.02; z <= a.z + a.r + 0.02; z += 0.035) if (z > z0 && z < z1) zs.add(+z.toFixed(4));
  const zList = [...zs].sort((a, b) => a - b);

  // Rings: (scale, z, face) — end faces are made of shrinking rings.
  type Ring = { sec: Sec; s: number; face: Cell['face'] };
  const rings: Ring[] = [];
  const shrink = (s: Sec, k: number, z: number): Sec => {
    const yc = (s.yb + s.yt) / 2;
    return { ...s, z, yb: yc + (s.yb - yc) * k, yt: yc + (s.yt - yc) * k, wb: s.wb * k, wt: s.wt * k, r: s.r * k, crown: (s.crown ?? 0) * k, bulge: (s.bulge ?? 0) * k };
  };
  const faceK = [0, 0.3, 0.6, 0.8, 0.92, 0.97];
  const filletZ = [1, 0.995, 0.985, 0.95, 0.8, 0.5];
  if (o.capBack !== undefined) {
    const s = secAt(secs, z0);
    faceK.forEach((k, i) => rings.push({ sec: shrink(s, k, z0 - o.capBack! * filletZ[i]), s: k, face: 'back' }));
  }
  for (const z of zList) rings.push({ sec: secAt(secs, z), s: 1, face: null });
  if (o.capFront !== undefined) {
    const s = secAt(secs, z1);
    [...faceK].reverse().forEach((k, j) => {
      const i = faceK.length - 1 - j;
      rings.push({ sec: shrink(s, k, z1 + o.capFront! * filletZ[i]), s: k, face: 'front' });
    });
  }

  const c = o.counts ?? {};
  const tb = o.tBreaks ?? {};
  const segs: { seg: Seg; ts: number[] }[] = [
    { seg: 'sideR', ts: tList(c.side ?? 8, tb.sideR) },
    { seg: 'cornerR', ts: tList(c.corner ?? 5, tb.cornerR, true) },
    { seg: 'top', ts: tList(c.top ?? 12, tb.top, true) },
    { seg: 'cornerL', ts: tList(c.corner ?? 5, tb.cornerL, true) },
    { seg: 'sideL', ts: tList(c.side ?? 8, tb.sideL, true) },
  ];
  if (o.closed) segs.push({ seg: 'bottom', ts: tList(c.bottom ?? 8, tb.bottom, true).filter((t) => t < 1) });
  const pts: { seg: Seg; t: number }[] = [];
  for (const g of segs) for (const t of g.ts) pts.push({ seg: g.seg, t });
  const P = pts.length;
  const R = rings.length;
  const pos = new Float32Array(R * P * 3);
  rings.forEach((ring, ri) => {
    const s = ring.sec;
    const yb = ring.face ? s.yb : archBottom(o.arches, s.z, s.yb);
    pts.forEach((p, pi) => {
      const [x, y] = ringPoint(s, p.seg, p.t, p.seg === 'sideL' || p.seg === 'sideR' || p.seg === 'bottom' ? yb : yb);
      const k = (ri * P + pi) * 3;
      pos[k] = x;
      pos[k + 1] = y;
      pos[k + 2] = s.z;
    });
  });
  // Full indexed grid → smooth normals (winding: outward).
  const wrap = o.closed ? P : P - 1;
  const idx: number[] = [];
  for (let ri = 0; ri < R - 1; ri++)
    for (let pi = 0; pi < wrap; pi++) {
      const a = ri * P + pi;
      const b = ri * P + ((pi + 1) % P);
      const cc = (ri + 1) * P + pi;
      const d = (ri + 1) * P + ((pi + 1) % P);
      idx.push(a, cc, b, b, cc, d);
    }
  const full = new THREE.BufferGeometry();
  full.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  full.setIndex(idx);
  full.computeVertexNormals();
  const nrm = full.getAttribute('normal').array as Float32Array;

  const out = new Map<string, number[][]>(); // key → [positions, normals, uvs]
  for (let ri = 0; ri < R - 1; ri++) {
    const ring = rings[ri].face ? rings[ri] : rings[ri + 1];
    for (let pi = 0; pi < wrap; pi++) {
      const p0 = pts[pi];
      const p1 = pts[(pi + 1) % P];
      const seg = p1.seg === p0.seg || pi + 1 >= P ? p0.seg : p1.seg;
      const t = p1.seg === p0.seg ? (p0.t + p1.t) / 2 : p1.t / 2;
      const ids = [ri * P + pi, ri * P + ((pi + 1) % P), (ri + 1) * P + pi, (ri + 1) * P + ((pi + 1) % P)];
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (const v of ids) {
        mx += pos[v * 3] / 4;
        my += pos[v * 3 + 1] / 4;
        mz += pos[v * 3 + 2] / 4;
      }
      const face = rings[ri].face ?? rings[ri + 1].face;
      const sScale = face ? Math.min(rings[ri].s, rings[ri + 1].s) : 1;
      const cseg: Seg = pi + 1 >= P ? 'bottom' : seg;
      if (cseg === 'bottom' && !face) continue; // open underside
      const key = classify({ x: mx, y: my, z: mz, seg: cseg, t, face, s: sScale });
      void ring;
      if (!key) continue;
      let b = out.get(key);
      if (!b) out.set(key, (b = [[], [], []]));
      const ins = o.inset?.[key] ?? 0;
      for (const v of [ids[0], ids[2], ids[1], ids[1], ids[2], ids[3]]) {
        const nx = nrm[v * 3];
        const ny = nrm[v * 3 + 1];
        const nz = nrm[v * 3 + 2];
        b[0].push(pos[v * 3] + nx * ins, pos[v * 3 + 1] + ny * ins, pos[v * 3 + 2] + nz * ins);
        b[1].push(nx, ny, nz);
        b[2].push(pos[v * 3 + 2], pos[v * 3 + 1]);
      }
    }
  }
  const res = new Map<string, THREE.BufferGeometry>();
  for (const [k, [p, n, uv]] of out) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    res.set(k, g);
  }
  return res;
}

/**
 * Sweep a closed (or open) 2D profile along a path. Profile points are (a, b) in the plane
 * spanned by the side vector N = T × up and the up vector U; list them counter-clockwise
 * (seen with T pointing at you) for outward normals. `scale` tapers the profile along the path.
 */
export function sweep(
  path: THREE.Vector3[],
  profile: [number, number][],
  o: { up?: THREE.Vector3 | THREE.Vector3[]; closed?: boolean; caps?: boolean; scale?: (u: number) => number | [number, number] } = {},
): THREE.BufferGeometry {
  const n = path.length;
  const m = profile.length;
  const closed = o.closed ?? true;
  const pos: number[] = [];
  const uv: number[] = [];
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const U = new THREE.Vector3();
  let len = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) len += path[i].distanceTo(path[i - 1]);
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    T.subVectors(b, a).normalize();
    const up = Array.isArray(o.up) ? o.up[i] : (o.up ?? new THREE.Vector3(0, 1, 0));
    N.crossVectors(T, up).normalize();
    U.crossVectors(N, T).normalize();
    const sc = o.scale ? o.scale(i / (n - 1)) : 1;
    const [sa, sb] = Array.isArray(sc) ? sc : [sc, sc];
    for (let j = 0; j < m; j++) {
      const [pa, pb] = profile[j];
      const p = path[i].clone().addScaledVector(N, pa * sa).addScaledVector(U, pb * sb);
      pos.push(p.x, p.y, p.z);
      uv.push(len, j / (m - 1));
    }
  }
  const idx: number[] = [];
  const w = closed ? m : m - 1;
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < w; j++) {
      const a = i * m + j;
      const b = i * m + ((j + 1) % m);
      const c = (i + 1) * m + j;
      const d = (i + 1) * m + ((j + 1) % m);
      idx.push(a, c, b, b, c, d);
    }
  if (o.caps && closed) {
    for (const [ring, end] of [[0, false], [n - 1, true]] as const) {
      const ctr = pos.length / 3;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let j = 0; j < m; j++) {
        cx += pos[(ring * m + j) * 3] / m;
        cy += pos[(ring * m + j) * 3 + 1] / m;
        cz += pos[(ring * m + j) * 3 + 2] / m;
      }
      pos.push(cx, cy, cz);
      uv.push(0, 0);
      for (let j = 0; j < m; j++) {
        const a = ring * m + j;
        const b = ring * m + ((j + 1) % m);
        if (end) idx.push(ctr, a, b);
        else idx.push(ctr, b, a);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Rounded-rectangle profile (counter-clockwise), centred, for sweeps. */
export function rrect(w: number, h: number, r: number, seg = 3, cx = 0, cy = 0): [number, number][] {
  const p: [number, number][] = [];
  r = Math.min(r, w / 2, h / 2);
  const corners: [number, number, number][] = [
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, Math.PI / 2],
    [-w / 2 + r, -h / 2 + r, Math.PI],
    [w / 2 - r, -h / 2 + r, (3 * Math.PI) / 2],
  ];
  for (const [x, y, a0] of corners)
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      p.push([cx + x + Math.cos(a) * r, cy + y + Math.sin(a) * r]);
    }
  return p;
}

/** Circle profile (counter-clockwise). */
export function circle(r: number, n = 10): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r] as [number, number];
  });
}

/** Geometry collector: everything added under a key is merged into one geometry. */
export class Kit {
  private parts = new Map<string, THREE.BufferGeometry[]>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  add(key: string, g: THREE.BufferGeometry, matrix?: THREE.Matrix4) {
    let h = g.index ? g.toNonIndexed() : g.clone();
    for (const name of Object.keys(h.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') h.deleteAttribute(name);
    if (!h.getAttribute('normal')) h.computeVertexNormals();
    if (!h.getAttribute('uv')) h.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(h.getAttribute('position').count * 2), 2));
    h.clearGroups();
    if (matrix) h = h.applyMatrix4(matrix);
    let list = this.parts.get(key);
    if (!list) this.parts.set(key, (list = []));
    list.push(h);
    return this;
  }

  /** Add with a transform: position, Euler rotation (XYZ), scale. */
  at(key: string, g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s: number | [number, number, number] = 1) {
    const sc = Array.isArray(s) ? new THREE.Vector3(...s) : new THREE.Vector3(s, s, s);
    this.m.compose(new THREE.Vector3(x, y, z), this.q.setFromEuler(this.e.set(rx, ry, rz)), sc);
    if (sc.x * sc.y * sc.z < 0) {
      // mirrored: fix winding
      const h = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(this.m);
      const p = h.getAttribute('position');
      const nn = h.getAttribute('normal');
      for (let i = 0; i < p.count; i += 3) {
        for (const a of [p, nn, h.getAttribute('uv')]) {
          if (!a) continue;
          for (let c = 0; c < a.itemSize; c++) {
            const t = a.getComponent(i + 1, c);
            a.setComponent(i + 1, c, a.getComponent(i + 2, c));
            a.setComponent(i + 2, c, t);
          }
        }
      }
      return this.add(key, h);
    }
    return this.add(key, g, this.m);
  }

  /** Mirror-add (x → −x) of the given geometry too: for symmetric parts. */
  both(key: string, g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) {
    this.at(key, g, x, y, z, rx, ry, rz, s);
    this.at(key, g, -x, y, z, rx, -ry, -rz, [-s, s, s]);
    return this;
  }

  addMap(m: Map<string, THREE.BufferGeometry>) {
    for (const [k, g] of m) this.add(k, g);
    return this;
  }

  build(): Map<string, THREE.BufferGeometry> {
    const res = new Map<string, THREE.BufferGeometry>();
    for (const [k, list] of this.parts) {
      const g = mergeGeometries(list, false);
      if (g) {
        g.computeBoundingSphere();
        res.set(k, g);
      }
    }
    return res;
  }
}

/** A plain chrome oval ring (stand-in for a badge; no real brands). */
export function emblemRing(k: Kit, x: number, y: number, z: number, w: number, h: number) {
  const path = Array.from({ length: 33 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return new THREE.Vector3(x + Math.cos(a) * w, y + Math.sin(a) * h, z);
  });
  k.add('chrome', sweep(path, circle(0.008, 6), { up: new THREE.Vector3(0, 0, 1) }));
}

/** Add a left-side kit to `k` twice: as built, and mirrored to the right (−X). */
export function mirrored(k: Kit, left: Kit) {
  for (const [key, g] of left.build()) {
    k.add(key, g);
    k.at(key, g, 0, 0, 0, 0, 0, 0, [-1, 1, 1]);
  }
}

/** Meshes for a merged kit with a material lookup. */
export function meshes(geos: Map<string, THREE.BufferGeometry>, mat: (key: string) => THREE.Material, shadows: (key: string) => boolean = () => true): THREE.Group {
  const g = new THREE.Group();
  for (const [k, geo] of geos) {
    const m = new THREE.Mesh(geo, mat(k));
    m.castShadow = shadows(k);
    m.receiveShadow = true;
    m.name = k;
    g.add(m);
  }
  return g;
}
