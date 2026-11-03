import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Kit, circle, rrect, sweep } from './kit';

/** Shared bits: wheels (tyre, tread, rim, brakes), seats, steering wheel, mirrors, wipers. */

export interface WheelStyle {
  R: number;
  W: number;
  rimR: number;
  spokes: number;
  rim: 'rimGun' | 'rimBlack';
  lip: 'rimLip' | 'rimBlack';
  tread: 'at' | 'ht';
  caliper: 'caliperRed' | 'caliperGrey';
  lugs: number;
  /** how far in from the tyre's outer face the spoke face sits (dish) */
  dish: number;
}

export interface WheelGeos {
  spin: Map<string, THREE.BufferGeometry>;
  fixed: Map<string, THREE.BufferGeometry>;
}

const wheelCache = new Map<string, WheelGeos>();

export function wheelGeos(st: WheelStyle): WheelGeos {
  const key = JSON.stringify(st);
  const hit = wheelCache.get(key);
  if (hit) return hit;
  const { R, W, rimR } = st;
  const spin = new Kit();
  const fixed = new Kit();

  // ── tyre carcass (lathe around X), bulging sidewalls, rounded shoulders ──
  const rb = rimR + 0.012;
  const h = R - rb;
  const half: [number, number][] = [
    [rb, W / 2 - 0.012],
    [rb + 0.18 * h, W / 2 + 0.002],
    [rb + 0.45 * h, W / 2 + 0.012],
    [rb + 0.75 * h, W / 2 + 0.008],
    [R - 0.035, W / 2 - 0.006],
    [R - 0.012, W / 2 - 0.026],
    [R - 0.002, W / 2 - 0.05],
  ];
  const prof = [...half.map(([r, a]) => new THREE.Vector2(r, a)), ...[...half].reverse().map(([r, a]) => new THREE.Vector2(r, -a))];
  const tyre = new THREE.LatheGeometry(prof, 56);
  tyre.rotateZ(Math.PI / 2);
  spin.add('tyre', tyre);

  // ── tread blocks ──
  const at = st.tread === 'at';
  const nb = at ? 30 : 42;
  const pitch = (Math.PI * 2) / nb;
  const circ = (Math.PI * 2 * R) / nb;
  const dep = at ? 0.012 : 0.007;
  const centre = new THREE.BoxGeometry(at ? W * 0.3 : W * 0.22, dep * 2, circ * (at ? 0.6 : 0.66));
  const shoulder = new THREE.BoxGeometry(at ? 0.04 : 0.03, dep * 1.6, circ * (at ? 0.5 : 0.55));
  const rows = at ? [-0.19, 0.19] : [-0.3, 0, 0.3];
  for (let k = 0; k < nb; k++) {
    rows.forEach((row, ri) => {
      const a = (k + (ri % 2 ? 0.5 : 0)) * pitch;
      const rr = R - dep * 0.25;
      spin.at('tread', centre, row * W, Math.cos(a) * rr, Math.sin(a) * rr, a + (at ? (ri % 2 ? 0.12 : -0.12) : 0), 0, 0);
    });
    for (const s of [-1, 1]) {
      const a = (k + (s > 0 ? 0.25 : 0.75)) * pitch;
      const rr = R - 0.016;
      spin.at('tread', shoulder, s * (W / 2 - 0.026), Math.cos(a) * rr, Math.sin(a) * rr, a, 0, s * -0.35);
    }
  }

  // ── rim: barrel, lips, spoked face, centre cap, lug nuts ──
  const barrel = new THREE.CylinderGeometry(rimR, rimR, W - 0.03, 40, 1, true).rotateZ(Math.PI / 2);
  spin.add('rimInner', barrel);
  spin.at('rimInner', new THREE.TorusGeometry(rimR + 0.004, 0.009, 6, 40).rotateY(Math.PI / 2), -W / 2 + 0.016, 0, 0);
  spin.at(st.lip, new THREE.TorusGeometry(rimR + 0.002, 0.012, 8, 48).rotateY(Math.PI / 2), W / 2 - 0.016, 0, 0);
  const face = new THREE.Shape();
  const rf = rimR - 0.004;
  face.absarc(0, 0, rf, 0, Math.PI * 2, false);
  const r1 = 0.088;
  const r2 = rimR - 0.03;
  const N = st.spokes;
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * Math.PI * 2;
    const a1 = ((k + 1) / N) * Math.PI * 2;
    const sw = (r: number) => (0.026 + 0.018 * ((r - r1) / (r2 - r1))) / r; // spoke half-width (rad)
    const hole = new THREE.Path();
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const a = a0 + sw(r2) + (i / n) * (a1 - a0 - 2 * sw(r2));
      const p = [Math.cos(a) * r2, Math.sin(a) * r2];
      if (i === 0) hole.moveTo(p[0], p[1]);
      else hole.lineTo(p[0], p[1]);
    }
    for (let i = n; i >= 0; i--) {
      const a = a0 + sw(r1) + (i / n) * (a1 - a0 - 2 * sw(r1));
      hole.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    }
    face.holes.push(hole);
  }
  const faceGeo = new THREE.ExtrudeGeometry(face, { depth: 0.024, bevelEnabled: true, bevelThickness: 0.007, bevelSize: 0.006, bevelSegments: 1, curveSegments: 20 });
  faceGeo.rotateY(Math.PI / 2);
  const xf = W / 2 - st.dish;
  spin.at(st.rim, faceGeo, xf - 0.024, 0, 0);
  // spokes taper back into the barrel (a shallow cone behind the face)
  const cone = new THREE.CylinderGeometry(r2 + 0.004, rimR, st.dish * 0.9, 40, 1, true).rotateZ(-Math.PI / 2);
  spin.at(st.rim, cone, xf + st.dish * 0.45, 0, 0);
  spin.at(st.rim, new THREE.CylinderGeometry(0.062, 0.07, 0.03, 28).rotateZ(Math.PI / 2), xf + 0.012, 0, 0);
  spin.at('satin', new THREE.SphereGeometry(0.05, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-Math.PI / 2).scale(0.35, 1, 1), xf + 0.026, 0, 0);
  const lug = new THREE.CylinderGeometry(0.011, 0.011, 0.024, 6).rotateZ(Math.PI / 2);
  for (let k = 0; k < st.lugs; k++) {
    const a = (k / st.lugs) * Math.PI * 2 + Math.PI / st.lugs;
    spin.at('satin', lug, xf + 0.03, Math.cos(a) * 0.074, Math.sin(a) * 0.074);
  }
  // brake disc (spins) and calliper (doesn't)
  const dr = rimR * 0.8;
  spin.at('disc', new THREE.CylinderGeometry(dr, dr, 0.026, 40).rotateZ(Math.PI / 2), -0.01, 0, 0);
  spin.at('disc', new THREE.CylinderGeometry(0.095, 0.095, 0.05, 24).rotateZ(Math.PI / 2), 0.012, 0, 0);
  const cal = new RoundedBoxGeometry(0.075, 0.07, 0.15, 2, 0.015);
  const ca = 0.65;
  const cr = dr - 0.03;
  fixed.at(st.caliper, cal, -0.01, Math.cos(ca) * cr, -Math.sin(ca) * cr, -ca, 0, 0);
  fixed.at('under', new THREE.CylinderGeometry(dr + 0.012, dr + 0.012, 0.01, 32).rotateZ(Math.PI / 2), -0.045, 0, 0);

  const g = { spin: spin.build(), fixed: fixed.build() };
  wheelCache.set(key, g);
  return g;
}

/** Bucket seat (cushion, bolstered backrest, headrest) facing +Z, cushion top at y. */
export function seat(k: Kit, key: string, x: number, y: number, z: number, w = 0.5, recline = 0.2) {
  k.at(key, new RoundedBoxGeometry(w, 0.13, 0.52, 2, 0.05), x, y - 0.065, z);
  for (const s of [-1, 1]) k.at(key, new RoundedBoxGeometry(0.09, 0.09, 0.48, 2, 0.035), x + s * (w / 2 - 0.04), y + 0.01, z);
  const by = y + 0.34;
  const bz = z - 0.27;
  k.at(key, new RoundedBoxGeometry(w * 0.94, 0.64, 0.12, 2, 0.05), x, by, bz, -recline, 0, 0);
  for (const s of [-1, 1]) k.at(key, new RoundedBoxGeometry(0.08, 0.5, 0.15, 2, 0.035), x + s * (w / 2 - 0.05), by - 0.02, bz + 0.02, -recline, 0, s * 0.08);
  const hy = by + 0.42;
  const hz = bz - Math.sin(recline) * 0.42;
  k.at(key, new RoundedBoxGeometry(w * 0.52, 0.19, 0.1, 2, 0.04), x, hy, hz, -recline * 0.6, 0, 0);
  for (const s of [-1, 1]) k.at('satin', new THREE.CylinderGeometry(0.006, 0.006, 0.08, 6), x + s * 0.07, hy - 0.12, hz + 0.01, -recline, 0, 0);
}

/** Rear bench (two places) facing +Z. */
export function bench(k: Kit, key: string, y: number, z: number, w: number) {
  k.at(key, new RoundedBoxGeometry(w, 0.14, 0.5, 2, 0.05), 0, y - 0.07, z);
  k.at(key, new RoundedBoxGeometry(w, 0.6, 0.13, 2, 0.05), 0, y + 0.32, z - 0.27, -0.18, 0, 0);
  for (const s of [-1, 1]) k.at(key, new RoundedBoxGeometry(0.26, 0.17, 0.09, 2, 0.04), s * w * 0.27, y + 0.72, z - 0.35, -0.12, 0, 0);
}

/** Steering wheel (rim along local XY, column along −Z). */
export function steeringWheel(R = 0.185): Kit {
  const k = new Kit();
  k.add('dash', new THREE.TorusGeometry(R, 0.021, 10, 40));
  k.add('dash', new RoundedBoxGeometry(0.11, 0.09, 0.05, 2, 0.02));
  for (const a of [-0.2, Math.PI + 0.2, -Math.PI / 2]) {
    const sp = new THREE.BoxGeometry(R * 0.85, 0.026, 0.018).translate(R * 0.45, 0, 0);
    k.at('dash', sp, 0, 0, 0, 0, 0, a);
  }
  k.at('satin', new THREE.CircleGeometry(0.018, 16), 0, 0, 0.027);
  k.at('dash', new THREE.CylinderGeometry(0.03, 0.035, 0.3, 12).rotateX(Math.PI / 2), 0, 0, -0.17);
  return k;
}

/** Door mirror on the +X side at (x, y, z): arm, housing, glass facing back. */
export function doorMirror(k: Kit, x: number, y: number, z: number, housing: string, size = 1, indicator = false) {
  const s = size;
  const hx = x + 0.13 * s;
  k.at(housing, new RoundedBoxGeometry(0.14 * s, 0.05 * s, 0.1 * s, 2, 0.02 * s), x + 0.05 * s, y - 0.04 * s, z, 0, 0, -0.15);
  const shell = new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  shell.rotateX(-Math.PI / 2); // dome bulging forward (+Z)
  k.at(housing, shell, hx, y + 0.02 * s, z, 0, -0.12, 0, [0.13 * s, 0.085 * s, 0.09 * s]);
  k.at(housing, new THREE.CylinderGeometry(1, 1, 1, 20, 1, true).rotateX(Math.PI / 2), hx, y + 0.02 * s, z - 0.012 * s, 0, -0.12, 0, [0.13 * s, 0.085 * s, 0.025 * s]);
  const glass = new THREE.CircleGeometry(1, 24).rotateY(Math.PI);
  k.at('mirror', glass, hx, y + 0.02 * s, z - 0.022 * s, 0, -0.12, 0, [0.12 * s, 0.077 * s, 1]);
  if (indicator) k.at('amber', new RoundedBoxGeometry(0.11 * s, 0.012 * s, 0.03 * s, 1, 0.005), hx + 0.01, y - 0.05 * s, z + 0.055 * s, 0, -0.12, 0);
}

/** A wiper blade + arm lying along +X from (x, y, z) on a surface of the given slope. */
export function wiper(k: Kit, x: number, y: number, z: number, len: number, yaw: number, slope: number) {
  const arm = new THREE.BoxGeometry(len, 0.012, 0.018).translate(len / 2, 0, 0);
  k.at('black', arm, x, y + 0.012, z, slope, yaw, 0);
  const blade = new THREE.BoxGeometry(len * 0.92, 0.022, 0.012).translate(len * 0.5, 0, 0);
  k.at('rubber', blade, x, y + 0.004, z - 0.012, slope, yaw, 0);
  k.at('black', new THREE.CylinderGeometry(0.018, 0.02, 0.03, 10), x, y, z);
}

/** Round lamp (reflector bowl, bulb, clear lens) facing +Z, for headlamps and fog lamps. */
export function roundLamp(k: Kit, x: number, y: number, z: number, r: number, bezel: string | null, ringLed = false) {
  const bowl = new THREE.SphereGeometry(r, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2.6).rotateX(-Math.PI / 2).scale(1, 1, 0.6);
  k.at('reflector', bowl, x, y, z - 0.005, 0, Math.PI, 0);
  k.at('bulb', new THREE.SphereGeometry(r * 0.28, 14, 8), x, y, z - r * 0.25);
  k.at('chrome', new THREE.CylinderGeometry(r * 0.42, r * 0.42, 0.006, 20).rotateX(Math.PI / 2), x, y, z - r * 0.15);
  const lens = new THREE.SphereGeometry(r * 1.6, 28, 6, 0, Math.PI * 2, 0, 0.66).rotateX(Math.PI / 2);
  k.at('lens', lens, x, y, z - r * 1.6 * Math.cos(0.66) + 0.006);
  if (bezel) k.at(bezel, new THREE.TorusGeometry(r + 0.006, 0.012, 8, 32), x, y, z + 0.004);
  if (ringLed) k.at('led', new THREE.TorusGeometry(r * 0.78, 0.006, 6, 32), x, y, z - 0.004);
}

/** Text badge / emblem shapes are avoided on purpose (no real brands). A plain chrome oval. */
export function emblem(k: Kit, x: number, y: number, z: number, w: number, h: number) {
  const ring = sweep(
    Array.from({ length: 33 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return new THREE.Vector3(x + Math.cos(a) * w, y + Math.sin(a) * h, z);
    }),
    circle(0.007, 6),
    { up: new THREE.Vector3(0, 0, 1) },
  );
  k.add('chrome', ring);
}

/** Thin rounded strip along a path (trim lines, seals, chrome strips). */
export function strip(k: Kit, key: string, path: THREE.Vector3[], w: number, h: number, up?: THREE.Vector3 | THREE.Vector3[]) {
  k.add(key, sweep(path, rrect(w, h, Math.min(w, h) * 0.45, 2), { up, caps: true }));
}
