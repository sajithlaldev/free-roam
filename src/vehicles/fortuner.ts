import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Kit, circle, loft, mirrored, rrect, sweep, topAt, widthAt, type Arch, type Sec } from './kit';
import { bench, doorMirror, roundLamp, seat, strip, wiper, type WheelStyle } from './parts';
import type { ModelDef } from './index';

/**
 * Lifted Fortuner-style SUV (2nd generation shape): long bonnet, raked screen, big
 * trapezoid grille with a chrome bar into slim headlamps, rising beltline with the kinked
 * D-pillar, black B/C pillars and wide arch flares — built up for off-road: a 4-inch lift on
 * long-travel suspension, 35-inch mud-terrains on a wider track, steel winch bumper with a
 * hoop and LED pods, roof rack with light bar, spare, jerry can and recovery boards, snorkel,
 * and nothing hanging underneath (better approach, departure and breakover angles).
 *
 * Model frame: +Z forward, +X = left (driver sits at −X), y = 0 at the wheel centres
 * (ground at −0.40). Axles at z = ±1.3725, track 1.62.
 */

const HZ = 1.3725;
const TX = 0.84;
const belt = (z: number) => 0.8 + (0.95 - z) * 0.027;

const LOWER: Sec[] = [
  { z: -2.4, yb: 0.12, yt: 0.86, wb: 0.8, wt: 0.78, r: 0.1 },
  { z: -2.34, yb: 0.07, yt: 0.885, wb: 0.875, wt: 0.855, r: 0.08, bulge: 0.008 },
  { z: -2.15, yb: 0.02, yt: belt(-2.15), wb: 0.905, wt: 0.88, r: 0.055, bulge: 0.016 },
  { z: 0.95, yb: 0.0, yt: belt(0.95), wb: 0.905, wt: 0.88, r: 0.055, bulge: 0.016 },
  { z: 1.05, yb: 0.0, yt: 0.79, wb: 0.905, wt: 0.88, r: 0.075, crown: 0.02, bulge: 0.016 },
  { z: 1.8, yb: 0.0, yt: 0.74, wb: 0.905, wt: 0.875, r: 0.1, crown: 0.035, bulge: 0.014 },
  { z: 2.12, yb: 0.04, yt: 0.695, wb: 0.89, wt: 0.85, r: 0.11, crown: 0.03, bulge: 0.01 },
  { z: 2.26, yb: 0.1, yt: 0.645, wb: 0.84, wt: 0.79, r: 0.12, crown: 0.025 },
  { z: 2.32, yb: 0.18, yt: 0.605, wb: 0.76, wt: 0.71, r: 0.12, crown: 0.02 },
];
const ARCHES: Arch[] = [
  { z: HZ, y: -0.02, r: 0.535 },
  { z: -HZ, y: -0.02, r: 0.535 },
];
const gb = (z: number) => belt(z) - 0.012;
const GREEN: Sec[] = [
  { z: 1.0, yb: gb(1.0), yt: gb(1.0) + 0.03, wb: 0.865, wt: 0.85, r: 0.02 },
  { z: 0.16, yb: gb(0.16), yt: 1.425, wb: 0.87, wt: 0.735, r: 0.09, crown: 0.03 },
  { z: 0.04, yb: gb(0.04), yt: 1.455, wb: 0.872, wt: 0.742, r: 0.1, crown: 0.035 },
  { z: -1.2, yb: gb(-1.2), yt: 1.465, wb: 0.875, wt: 0.745, r: 0.1, crown: 0.035 },
  { z: -2.12, yb: gb(-2.12), yt: 1.44, wb: 0.875, wt: 0.74, r: 0.1, crown: 0.03 },
  { z: -2.28, yb: gb(-2.28), yt: 1.415, wb: 0.858, wt: 0.722, r: 0.1, crown: 0.025 },
];
const A_END = 0.16;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Bottom edge of the side glass (with the kink behind the rear door). */
const winBottom = (z: number) => belt(z) + 0.03 + 0.15 * smooth(-1.47, -1.63, z);

export function fortunerModel(): ModelDef {
  const k = new Kit();

  // ── lower body ──
  const gaps = [0.8, -0.44, -1.42];
  k.addMap(
    loft(
      LOWER,
      (c) => {
        if (c.face === 'front') return Math.abs(c.x) < 0.5 && c.y > 0.26 && c.y < 0.6 ? 'black' : 'paint';
        if (c.face === 'back') return 'paint';
        const side = c.seg === 'sideL' || c.seg === 'sideR';
        if (side && c.y < 0.115) return 'plastic';
        if (side && gaps.some((g) => Math.abs(c.z - g) < 0.004) && c.y < belt(c.z) - 0.02) return 'gap';
        const tt = c.seg === 'cornerR' ? 1 - c.t : c.t;
        if ((c.seg === 'cornerL' || c.seg === 'cornerR') && c.z > 1.02 && tt > 0.56 && tt < 0.6) return 'gap';
        return 'paint';
      },
      { arches: ARCHES, capFront: 0.022, capBack: 0.022, closed: true, zBreaks: gaps.flatMap((g) => [g - 0.004, g + 0.004]).concat([1.02]), tBreaks: { cornerL: [0.56, 0.6], cornerR: [0.4, 0.44] }, counts: { side: 10, corner: 5, top: 12, bottom: 6 }, step: 0.06 },
    ),
  );
  // (cornerR runs the other way round the ring, so its shut-line band is 0.40..0.44)

  // ── greenhouse: windscreen, side glass, pillars, roof, rear glass ──
  const zb = [A_END, -0.4, -0.48, -1.38, -1.46, -2.06];
  k.addMap(
    loft(
      GREEN,
      (c) => {
        if (c.face === 'back') return c.s < 0.86 ? 'glass' : 'paint';
        if (c.seg === 'top') return c.z > A_END ? 'glass' : 'paint';
        if (c.seg !== 'sideL' && c.seg !== 'sideR') return 'paint';
        if (c.y < winBottom(c.z)) return 'paint';
        if (c.z > -0.4) return 'glass';
        if (c.z > -0.48) return 'trim';
        if (c.z > -1.38) return 'glass';
        if (c.z > -1.46) return 'trim';
        if (c.z > -2.06) return 'glass';
        return 'paint';
      },
      { capBack: 0.014, closed: true, zBreaks: zb, counts: { side: 12, corner: 5, top: 12, bottom: 6 }, step: 0.05, inset: { glass: -0.007 } },
    ),
  );
  // Chrome belt line along the bottom of the side glass (and up the kink).
  for (const s of [1, -1]) {
    const path: THREE.Vector3[] = [];
    for (let z = 0.95; z >= -2.08; z -= 0.05) {
      const y = winBottom(z);
      path.push(new THREE.Vector3(s * (widthAt(GREEN, z, y) + 0.004), y, z));
    }
    strip(k, 'chrome', path, 0.012, 0.016);
  }
  // Glass seals along the roof edge (black)
  for (const s of [1, -1]) {
    const path: THREE.Vector3[] = [];
    for (let z = 0.14; z >= -2.06; z -= 0.08) {
      const y = topAt(GREEN, z, 0.6) - 0.1;
      path.push(new THREE.Vector3(s * (widthAt(GREEN, z, y) + 0.002), y, z));
    }
    strip(k, 'trim', path, 0.008, 0.014);
  }

  // ── steel winch bumper: high, angled-up wings, hoop, LED pods, fairlead, shackles ──
  const FB: Sec[] = [
    { z: 1.92, yb: 0.06, yt: 0.27, wb: 0.9, wt: 0.9, r: 0.03 },
    { z: 2.08, yb: -0.04, yt: 0.28, wb: 0.92, wt: 0.92, r: 0.03 },
    { z: 2.3, yb: -0.06, yt: 0.28, wb: 0.88, wt: 0.875, r: 0.035 },
    { z: 2.44, yb: -0.04, yt: 0.27, wb: 0.78, wt: 0.775, r: 0.04 },
  ];
  k.addMap(loft(FB, () => 'powder', { arches: [{ z: HZ, y: -0.02, r: 0.57 }], capFront: 0.015, closed: true, counts: { side: 6, corner: 4, top: 12, bottom: 6 }, step: 0.04 }));
  const zfb = 2.455;
  for (const s of [1, -1]) roundLamp(k, s * 0.66, 0.11, zfb - 0.004, 0.04, 'black');
  // winch fairlead + drum behind it
  k.at('satin', new RoundedBoxGeometry(0.26, 0.075, 0.04, 2, 0.015), 0, 0.045, zfb + 0.014);
  k.at('gap', new RoundedBoxGeometry(0.16, 0.022, 0.01, 1, 0.008), 0, 0.045, zfb + 0.034);
  k.at('steel', new THREE.CylinderGeometry(0.06, 0.06, 0.4, 16).rotateZ(Math.PI / 2), 0, 0.05, zfb - 0.06);
  k.at('hook', new RoundedBoxGeometry(0.035, 0.05, 0.03, 1, 0.01), 0, 0.045, zfb + 0.05);
  // red D-shackles
  for (const x of [-0.47, 0.47]) {
    k.at('powder', new RoundedBoxGeometry(0.05, 0.08, 0.06, 1, 0.01), x, 0.0, zfb + 0.02);
    k.at('hook', new THREE.TorusGeometry(0.035, 0.01, 8, 18, Math.PI * 1.25).rotateZ(-Math.PI * 0.62), x, -0.02, zfb + 0.05, 0, Math.PI / 2, 0);
  }
  // tubular hoop over the bumper, with two LED pods on it
  {
    const hoop = [
      [-0.5, 0.27, 2.43],
      [-0.47, 0.44, 2.47],
      [-0.4, 0.52, 2.49],
      [0.4, 0.52, 2.49],
      [0.47, 0.44, 2.47],
      [0.5, 0.27, 2.43],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    k.add('powder', sweep(new THREE.CatmullRomCurve3(hoop).getPoints(30), circle(0.026, 10), { caps: true }));
    for (const x of [-0.28, 0.28]) {
      k.at('black', new RoundedBoxGeometry(0.11, 0.09, 0.07, 2, 0.015), x, 0.575, 2.49);
      k.at('led', new RoundedBoxGeometry(0.09, 0.07, 0.01, 1, 0.01), x, 0.575, 2.526);
      k.at('powder', new THREE.BoxGeometry(0.03, 0.05, 0.03), x, 0.53, 2.49);
    }
  }
  // skid plate tucked up under the bumper
  k.at('satin', new RoundedBoxGeometry(0.9, 0.02, 0.45, 2, 0.008), 0, -0.07, 2.2, -0.28, 0, 0);

  // ── grille: hex insert, chrome surround + top bar into the lamps, two bars ──
  const zg = 2.346;
  const gt = 0.585;
  const gbm = 0.275;
  const gShape = new THREE.Shape();
  gShape.moveTo(-0.4, gbm);
  gShape.lineTo(0.4, gbm);
  gShape.lineTo(0.52, gt);
  gShape.lineTo(-0.52, gt);
  gShape.closePath();
  k.at('grille', new THREE.ShapeGeometry(gShape), 0, 0, zg);
  const outline = [[-0.4, gbm], [0.4, gbm], [0.52, gt], [-0.52, gt], [-0.4, gbm]].map(([x, y]) => new THREE.Vector3(x, y, zg + 0.012));
  strip(k, 'chrome', outline, 0.03, 0.025, new THREE.Vector3(0, 0, 1));
  strip(k, 'chrome', [new THREE.Vector3(-0.66, gt + 0.012, zg - 0.004), new THREE.Vector3(-0.52, gt, zg + 0.012), new THREE.Vector3(0.52, gt, zg + 0.012), new THREE.Vector3(0.66, gt + 0.012, zg - 0.004)], 0.05, 0.03, new THREE.Vector3(0, 0, 1));
  for (const [y, w] of [[0.49, 0.95], [0.385, 0.87]] as const) {
    k.at('trim', new RoundedBoxGeometry(w, 0.05, 0.03, 2, 0.012), 0, y, zg + 0.018);
    k.at('chrome', new RoundedBoxGeometry(w, 0.008, 0.008, 1, 0.003), 0, y + 0.022, zg + 0.034);
  }

  // ── headlamps: slim, swept round the nose corners (built on the left, mirrored) ──
  {
    const L = new Kit();
    const yl = 0.575;
    const p: THREE.Vector3[] = [];
    for (let x = 0.53; x < 0.7; x += 0.04) p.push(new THREE.Vector3(x, yl + (x - 0.53) * 0.05, 2.346));
    for (let z = 2.33; z >= 2.08; z -= 0.035) p.push(new THREE.Vector3(widthAt(LOWER, z, yl + 0.012) + 0.004, yl + 0.012 + (2.33 - z) * 0.1, z));
    const taper = (u: number) => [1, 1 - 0.35 * u] as [number, number];
    L.add('lens', sweep(p, [[0.0, -0.058], [0.012, -0.04], [0.017, 0], [0.012, 0.04], [0.0, 0.058], [-0.03, 0.052], [-0.03, -0.052]], { scale: taper, caps: true }));
    L.add('lampHouse', sweep(p, [[-0.004, -0.054], [-0.004, -0.03], [-0.035, -0.03], [-0.035, -0.054]], { scale: taper, caps: true }));
    L.add('reflector', sweep(p, [[-0.006, -0.03], [-0.004, 0.0], [-0.006, 0.052], [-0.036, 0.05], [-0.036, -0.03]], { scale: taper, caps: true }));
    L.add('led', sweep(p.slice(0, -1), rrect(0.006, 0.012, 0.004, 1, 0.004, -0.042), { scale: taper, caps: true }));
    for (const i of [1, 3]) {
      const q = p[i];
      L.at('bulb', new THREE.SphereGeometry(0.024, 16, 10), q.x, q.y + 0.012, q.z - 0.014);
      L.at('lampHouse', new THREE.TorusGeometry(0.03, 0.006, 6, 20), q.x, q.y + 0.012, q.z - 0.008);
    }
    const tip = p[p.length - 2];
    L.at('amber', new RoundedBoxGeometry(0.012, 0.03, 0.06, 1, 0.005), tip.x - 0.008, tip.y, tip.z);
    mirrored(k, L);
  }

  // ── bonnet details, wipers, washer jets ──
  for (const px of [-0.52, 0.0]) wiper(k, px, 0.815, 0.965, 0.58, 0.04, -0.62);
  for (const x of [-0.25, 0.25]) k.at('black', new RoundedBoxGeometry(0.03, 0.012, 0.02, 1, 0.004), x, topAt(LOWER, 1.12, x) + 0.004, 1.12);
  // cowl panel
  k.at('black', new RoundedBoxGeometry(1.5, 0.02, 0.1, 1, 0.008), 0, 0.81, 0.98, -0.15, 0, 0);

  // ── sides: cladding flares, handles, mirrors, steps, mud flaps, fuel lid ──
  {
    const L = new Kit();
    for (const a of ARCHES) {
      const path: THREE.Vector3[] = [];
      const ups: THREE.Vector3[] = [];
      const ra = a.r + 0.035;
      for (let i = 0; i <= 26; i++) {
        const ang = -0.28 + (i / 26) * (Math.PI + 0.56); // front-low → over → rear-low
        const z = a.z + Math.cos(ang) * ra;
        const y = a.y + Math.sin(ang) * ra;
        path.push(new THREE.Vector3(widthAt(LOWER, z, Math.max(0.12, y)) - 0.01, y, z));
        ups.push(new THREE.Vector3(0, Math.sin(ang), Math.cos(ang)));
      }
      L.add('plastic', sweep(path, [[0, -0.05], [0.06, -0.045], [0.092, -0.02], [0.098, 0.02], [0.075, 0.055], [0, 0.06]], { up: ups, caps: true }));
    }
    mirrored(k, L);
  }
  for (const s of [1, -1]) {
    // door handles
    for (const z of [0.12, -0.86]) k.at('chrome', new RoundedBoxGeometry(0.03, 0.036, 0.17, 2, 0.014), s * (widthAt(LOWER, z, 0.7) + 0.01), 0.7, z);
    // mirrors (body colour, indicator)
    const mz = 0.8;
    const mx = widthAt(GREEN, mz, 0.92);
    if (s > 0) doorMirror(k, mx - 0.03, 0.95, mz, 'paint', 1.15, true);
    // mud flaps (short, so they don't snag)
    for (const z of [HZ - 0.6, -HZ - 0.6]) k.at('rubber', new RoundedBoxGeometry(0.3, 0.22, 0.012, 1, 0.004), s * 0.84, -0.06, z);
  }
  // mirror on the right (driver) side
  {
    const mz = 0.8;
    const mx = widthAt(GREEN, mz, 0.92);
    const mk = new Kit();
    doorMirror(mk, mx - 0.03, 0.95, mz, 'paint', 1.15, true);
    for (const [key, g] of mk.build()) k.at(key, g, 0, 0, 0, 0, 0, 0, [-1, 1, 1]);
  }
  // fuel lid (left rear quarter)
  strip(k, 'gap', Array.from({ length: 25 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const z = -1.84 + Math.cos(a) * 0.085;
    const y = 0.68 + Math.sin(a) * 0.085;
    return new THREE.Vector3(widthAt(LOWER, z, y) + 0.002, y, z);
  }), 0.004, 0.006, new THREE.Vector3(1, 0, 0));

  // ── snorkel (left wing up the A-pillar) ──
  {
    const pts = [
      [0.9, 0.58, 1.24],
      [0.955, 0.7, 1.16],
      [0.965, 0.86, 1.04],
      [0.955, 1.06, 0.84],
      [0.92, 1.3, 0.57],
      [0.875, 1.48, 0.36],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const c = new THREE.CatmullRomCurve3(pts).getPoints(24);
    k.add('plastic', sweep(c, circle(0.048, 14), { caps: true }));
    k.at('plastic', new RoundedBoxGeometry(0.13, 0.13, 0.2, 3, 0.05), 0.875, 1.5, 0.4, 0.15, 0, 0);
    k.at('black', new THREE.BoxGeometry(0.09, 0.08, 0.01), 0.875, 1.5, 0.505);
    for (const y of [0.9, 1.25]) k.at('satin', new THREE.BoxGeometry(0.06, 0.03, 0.06), 0.93, y, y > 1 ? 0.64 : 1.0);
  }

  // ── roof: rails, spoiler with stop lamp, antenna ──
  for (const s of [1, -1]) {
    const path: THREE.Vector3[] = [];
    for (let z = 0.08; z >= -2.02; z -= 0.1) path.push(new THREE.Vector3(s * 0.6, topAt(GREEN, z, 0.6) + 0.055, z));
    strip(k, 'satin', path, 0.035, 0.035);
    for (const z of [0.08, -0.95, -2.02]) k.at('black', new RoundedBoxGeometry(0.05, 0.06, 0.12, 2, 0.015), s * 0.6, topAt(GREEN, z, 0.6) + 0.025, z);
  }
  // roof rack on the rails: tube frame, slats, light bar, spare, jerry can, recovery boards
  const RY = topAt(GREEN, -0.9, 0) + 0.15;
  {
    const z0 = 0.12;
    const z1 = -1.98;
    const xw = 0.68;
    const loop = [[-xw, z0], [xw, z0], [xw, z1], [-xw, z1], [-xw, z0]].map(([x, z]) => new THREE.Vector3(x, RY, z));
    strip(k, 'powder', loop, 0.035, 0.035);
    strip(k, 'powder', [[-xw, z0], [xw, z0], [xw, z1], [-xw, z1], [-xw, z0]].map(([x, z]) => new THREE.Vector3(x, RY + 0.07, z)), 0.025, 0.025);
    for (let z = z0 - 0.25; z > z1 + 0.1; z -= 0.3) k.at('powder', new RoundedBoxGeometry(xw * 2, 0.02, 0.05, 1, 0.008), 0, RY - 0.005, z);
    for (const s of [1, -1]) {
      for (const z of [z0 - 0.05, -0.95, z1 + 0.05]) {
        k.at('powder', new THREE.BoxGeometry(0.03, 0.07, 0.03), s * xw, RY + 0.035, z);
        k.at('powder', new THREE.BoxGeometry(0.1, 0.1, 0.05), s * 0.62, (RY + topAt(GREEN, z, 0.6) + 0.06) / 2, z);
      }
      // orange recovery boards strapped along the sides
      k.at('orange', new RoundedBoxGeometry(0.3, 0.025, 1.05, 2, 0.01), s * 0.48, RY + 0.025, -0.45);
      for (let i = 0; i < 9; i++) k.at('orange', new THREE.BoxGeometry(0.22, 0.012, 0.03), s * 0.48, RY + 0.044, -0.9 + i * 0.11);
    }
    // LED light bar across the front of the rack
    k.at('black', new RoundedBoxGeometry(1.1, 0.085, 0.08, 2, 0.02), 0, RY + 0.06, z0 + 0.06);
    k.at('led', new RoundedBoxGeometry(1.04, 0.05, 0.01, 1, 0.006), 0, RY + 0.06, z0 + 0.102);
    for (const x of [-0.5, 0.5]) k.at('powder', new THREE.BoxGeometry(0.03, 0.06, 0.06), x, RY + 0.02, z0 + 0.05);
    // jerry can
    k.at('powder', new RoundedBoxGeometry(0.34, 0.26, 0.17, 2, 0.02), 0.0, RY + 0.13, -0.6);
    k.at('satin', new THREE.CylinderGeometry(0.025, 0.025, 0.03, 10), 0.12, RY + 0.27, -0.6);
  }
  {
    const sp: THREE.Vector3[] = [];
    for (let x = -0.72; x <= 0.721; x += 0.08) sp.push(new THREE.Vector3(x, topAt(GREEN, -2.24, x) + 0.01, -2.26));
    k.add('paint', sweep(sp, [[-0.07, 0], [0.03, -0.005], [0.035, 0.025], [-0.06, 0.035]], { caps: true }));
    k.at('redLens', new RoundedBoxGeometry(0.3, 0.02, 0.012, 1, 0.005), 0, topAt(GREEN, -2.3, 0) - 0.005, -2.33);
    k.at('paint', new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, topAt(GREEN, -1.95, 0) - 0.005, -1.95, 0, 0, 0, [0.04, 0.06, 0.14]);
  }

  // ── rear: bumper, tail lamps, chrome garnish, tailgate lines, plate, wiper, step ──
  const RB: Sec[] = [
    { z: -2.46, yb: 0.02, yt: 0.29, wb: 0.8, wt: 0.795, r: 0.04 },
    { z: -2.3, yb: -0.01, yt: 0.3, wb: 0.9, wt: 0.895, r: 0.035 },
    { z: -2.08, yb: 0.04, yt: 0.3, wb: 0.92, wt: 0.92, r: 0.03 },
    { z: -1.9, yb: 0.1, yt: 0.29, wb: 0.91, wt: 0.91, r: 0.03 },
  ];
  k.addMap(loft(RB, () => 'powder', { arches: [{ z: -HZ, y: -0.02, r: 0.57 }], capBack: 0.015, closed: true, counts: { side: 6, corner: 4, top: 12, bottom: 6 }, step: 0.04 }));
  k.at('rubber', new RoundedBoxGeometry(0.8, 0.012, 0.16, 1, 0.005), 0, 0.302, -2.36);
  for (const x of [-0.5, 0.5]) {
    k.at('powder', new RoundedBoxGeometry(0.05, 0.08, 0.06, 1, 0.01), x, 0.07, -2.49);
    k.at('hook', new THREE.TorusGeometry(0.035, 0.01, 8, 18, Math.PI * 1.25).rotateZ(-Math.PI * 0.62), x, 0.05, -2.52, 0, Math.PI / 2, 0);
  }
  {
    // tail lamps: wrap from the side round the corner onto the tailgate (left, mirrored)
    const L = new Kit();
    const yl = 0.74;
    const p: THREE.Vector3[] = [];
    for (let z = -2.12; z > -2.37; z -= 0.035) p.push(new THREE.Vector3(widthAt(LOWER, z, yl) + 0.003, yl, z));
    for (let x = 0.8; x >= 0.62; x -= 0.045) p.push(new THREE.Vector3(x, yl, -2.425));
    const taper = (u: number) => [1, 1 - 0.45 * u] as [number, number];
    L.add('redLens', sweep(p, [[0, -0.15], [0.01, -0.12], [0.014, 0], [0.01, 0.12], [0, 0.15], [-0.03, 0.14], [-0.03, -0.14]], { scale: taper, caps: true }));
    L.add('brake', sweep(p.slice(1, -1), rrect(0.006, 0.05, 0.003, 1, 0.012, 0.06), { scale: taper, caps: true }));
    L.add('brake', sweep(p.slice(1, -1), rrect(0.006, 0.03, 0.003, 1, 0.012, -0.07), { scale: taper, caps: true }));
    const last = p[p.length - 2];
    L.at('reverse', new RoundedBoxGeometry(0.08, 0.035, 0.01, 1, 0.004), last.x, yl - 0.02, last.z - 0.012);
    L.at('amber', new RoundedBoxGeometry(0.08, 0.025, 0.01, 1, 0.004), last.x, yl + 0.035, last.z - 0.012);
    mirrored(k, L);
  }
  for (const s of [1, -1]) {
    k.at('reflectorRed', new RoundedBoxGeometry(0.12, 0.03, 0.01, 1, 0.004), s * 0.7, 0.2, -2.477);
    // tailgate shut lines
    strip(k, 'gap', [new THREE.Vector3(s * 0.615, 0.3, -2.424), new THREE.Vector3(s * 0.615, 0.88, -2.424)], 0.005, 0.004, new THREE.Vector3(0, 0, -1));
  }
  strip(k, 'gap', [new THREE.Vector3(-0.615, 0.3, -2.424), new THREE.Vector3(0.615, 0.3, -2.424)], 0.005, 0.004, new THREE.Vector3(0, 1, 0));
  k.at('chrome', new RoundedBoxGeometry(1.2, 0.035, 0.02, 2, 0.01), 0, 0.82, -2.43);
  k.at('chrome', new RoundedBoxGeometry(0.42, 0.03, 0.03, 2, 0.012), 0, 0.565, -2.428);
  k.at('plate', new THREE.PlaneGeometry(0.52, 0.114).rotateY(Math.PI), 0, 0.45, -2.434);
  k.at('black', new RoundedBoxGeometry(0.58, 0.16, 0.012, 2, 0.01), 0, 0.45, -2.425);
  {
    // rear wiper on the rear glass
    const wk = new Kit();
    wiper(wk, 0, 0, 0, 0.42, 0, 0);
    for (const [key, g] of wk.build()) k.at(key, g, 0.0, 1.0, -2.325, 0, Math.PI, 0.6);
  }
  // exhaust tip, tucked up behind the bumper
  k.at('steel', new THREE.CylinderGeometry(0.038, 0.038, 0.22, 16, 1, true).rotateX(Math.PI / 2), -0.6, 0.02, -2.34);

  // ── front plate ──
  k.at('plate', new THREE.PlaneGeometry(0.52, 0.114), 0, 0.185, zfb + 0.006);
  k.at('black', new RoundedBoxGeometry(0.56, 0.14, 0.012, 2, 0.01), 0, 0.185, zfb - 0.002);

  // ── wheel wells, chassis, underbody ──
  for (const a of ARCHES)
    for (const s of [1, -1]) {
      const liner = new THREE.CylinderGeometry(a.r + 0.01, a.r + 0.01, 0.42, 28, 1, true, -0.35, Math.PI + 0.7).rotateZ(Math.PI / 2);
      k.at('liner', liner, s * 0.7, a.y, a.z);
      k.at('liner', new THREE.RingGeometry(0.1, a.r + 0.01, 28, 1, -0.35, Math.PI + 0.7).rotateY(Math.PI / 2).rotateX(0), s * 0.49, a.y, a.z, 0, 0, 0);
    }
  // floor pan tucked up inside the sills: nothing hangs below the body line
  k.at('under', new THREE.BoxGeometry(1.0, 0.04, 4.4), 0, 0.04, -0.02);
  for (const s of [1, -1]) k.at('under', new THREE.BoxGeometry(0.34, 0.04, 1.6), s * 0.72, 0.04, -0.02);

  // ── interior ──
  k.at('dash', new THREE.BoxGeometry(1.56, 0.02, 3.0), 0, 0.12, -0.7); // carpet
  for (const s of [1, -1]) {
    k.at('dash', new THREE.BoxGeometry(0.03, 0.62, 2.2), s * 0.81, 0.48, -0.3); // door cards
    k.at('leather', new RoundedBoxGeometry(0.07, 0.05, 0.6, 2, 0.02), s * 0.775, 0.62, 0.25);
    k.at('leather', new RoundedBoxGeometry(0.07, 0.05, 0.5, 2, 0.02), s * 0.775, 0.62, -0.8);
  }
  k.at('dash', new RoundedBoxGeometry(1.6, 0.26, 0.42, 3, 0.08), 0, 0.77, 0.84);
  k.at('dash', new RoundedBoxGeometry(1.62, 0.07, 0.5, 2, 0.03), 0, 0.89, 0.82, 0.12, 0, 0);
  k.at('dash', new RoundedBoxGeometry(0.34, 0.09, 0.16, 3, 0.04), -0.42, 0.95, 0.68); // binnacle hood
  for (const dx of [-0.07, 0.07]) k.at('gauge', new THREE.CircleGeometry(0.05, 24).rotateY(Math.PI).rotateX(-0.3), -0.42 + dx, 0.905, 0.62);
  k.at('screen', new THREE.PlaneGeometry(0.24, 0.14).rotateY(Math.PI).rotateX(-0.25), 0, 0.93, 0.63);
  k.at('black', new RoundedBoxGeometry(0.28, 0.18, 0.03, 2, 0.01), 0, 0.93, 0.645, -0.25, 0, 0);
  for (const x of [-0.65, -0.13, 0.13, 0.65]) k.at('black', new RoundedBoxGeometry(0.11, 0.05, 0.02, 2, 0.01), x, 0.83, 0.625);
  k.at('dash', new RoundedBoxGeometry(0.22, 0.24, 0.95, 3, 0.05), 0, 0.27, 0.12); // centre console
  k.at('satin', new THREE.CylinderGeometry(0.012, 0.012, 0.12, 8), 0, 0.44, 0.3, -0.3, 0, 0);
  k.at('black', new THREE.SphereGeometry(0.03, 12, 8), 0, 0.5, 0.32);
  seat(k, 'leather', -0.42, 0.42, 0.15, 0.52);
  seat(k, 'leather', 0.42, 0.42, 0.15, 0.52);
  bench(k, 'leather', 0.46, -0.82, 1.42);
  k.at('headliner', new THREE.PlaneGeometry(1.44, 2.3).rotateX(Math.PI / 2), 0, 1.415, -0.95);
  k.at('dash', new THREE.BoxGeometry(1.5, 0.02, 0.9), 0, 0.42, -1.85); // cargo floor
  k.at('black', new RoundedBoxGeometry(0.04, 0.1, 0.2, 2, 0.015), 0, 1.36, 0.12); // rear-view mirror
  k.at('mirror', new THREE.PlaneGeometry(0.18, 0.07).rotateY(Math.PI), 0, 1.36, 0.098);

  const wheel: WheelStyle = { R: 0.44, W: 0.32, rimR: 0.216, spokes: 6, rim: 'rimBlack', lip: 'rimBlack', tread: 'mt', caliper: 'caliperRed', lugs: 6, dish: 0.022 };
  return {
    body: k.build(),
    wheel,
    track: TX * 2,
    wheelbase: HZ * 2,
    steering: { pos: new THREE.Vector3(-0.42, 1.0, 0.53), tilt: -1.05, R: 0.19 },
    spare: { pos: new THREE.Vector3(0, RY + 0.17, -1.4), rot: [0, 0, Math.PI / 2] },
    gear: {
      axles: [{ wheels: [2, 3], r: 0.048, diff: { x: 0.0, r: 0.13 } }],
      links: [
        // front double wishbones, coilovers, half-shafts
        ...[0, 1].flatMap((w) => {
          const s = w === 0 ? 1 : -1;
          return [
            { key: 'steel', r: 0.022, a: { body: [s * 0.36, -0.15, HZ + 0.05] }, b: { wheel: w, off: [-s * 0.13, -0.14, 0] } },
            { key: 'steel', r: 0.018, a: { body: [s * 0.42, 0.17, HZ - 0.02] }, b: { wheel: w, off: [-s * 0.12, 0.15, 0] } },
            { key: 'shockGold', r: 0.028, a: { body: [s * 0.5, 0.45, HZ - 0.05] }, b: { wheel: w, off: [-s * 0.16, -0.06, -0.02] } },
            { key: 'springRed', r: 0.065, coil: true, a: { body: [s * 0.5, 0.43, HZ - 0.05] }, b: { wheel: w, off: [-s * 0.17, 0.05, -0.02] } },
            { key: 'steel', r: 0.022, a: { body: [s * 0.13, -0.06, HZ] }, b: { wheel: w, off: [-s * 0.1, 0, 0] } },
          ];
        }),
        // rear: long shocks, coils, trailing links
        ...[2, 3].flatMap((w) => {
          const s = w === 2 ? 1 : -1;
          return [
            { key: 'shockGold', r: 0.028, a: { body: [s * 0.6, 0.4, -HZ - 0.12] }, b: { wheel: w, off: [-s * 0.2, -0.06, -0.12] } },
            { key: 'springRed', r: 0.07, coil: true, a: { body: [s * 0.5, 0.33, -HZ + 0.12] }, b: { wheel: w, off: [-s * 0.3, 0.06, 0.12] } },
            { key: 'steel', r: 0.025, a: { body: [s * 0.44, -0.08, -0.5] }, b: { wheel: w, off: [-s * 0.34, -0.06, 0] } },
          ];
        }),
      ],
    },
  };
}
