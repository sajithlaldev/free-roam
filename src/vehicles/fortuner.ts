import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Kit, circle, emblemRing, loft, mirrored, rrect, secAt, sweep, topAt, widthAt, type Arch, type Sec } from './kit';
import { bench, doorMirror, roundLamp, seat, strip, wiper, type WheelStyle } from './parts';
import type { ModelDef } from './index';

/**
 * Lifted Fortuner-style SUV (1st generation, facelift shape): tall upright nose with a
 * bonnet scoop, black horizontal-bar grille, large clear headlamps with projectors swept
 * back into the wings, body-colour bumper with round fog lamps, straight beltline, blacked
 * B/C pillars, wind deflectors, black roof rails, wide bolt-on arch flares, a snorkel and a
 * 4-inch long-travel lift on 33-inch all-terrains and black 10-spoke rims — with nothing
 * hanging below the body.
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
  { z: 1.05, yb: 0.0, yt: 0.8, wb: 0.905, wt: 0.88, r: 0.07, crown: 0.015, bulge: 0.016 },
  { z: 1.8, yb: 0.0, yt: 0.765, wb: 0.905, wt: 0.88, r: 0.08, crown: 0.025, bulge: 0.014 },
  { z: 2.12, yb: 0.1, yt: 0.735, wb: 0.895, wt: 0.865, r: 0.09, crown: 0.025, bulge: 0.01 },
  { z: 2.24, yb: 0.26, yt: 0.705, wb: 0.86, wt: 0.83, r: 0.1, crown: 0.02 },
  { z: 2.3, yb: 0.3, yt: 0.675, wb: 0.8, wt: 0.77, r: 0.1, crown: 0.015 },
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
/** Bottom edge of the side glass (a straight beltline on this generation). */
const winBottom = (z: number) => belt(z) + 0.03;

export function fortunerModel(): ModelDef {
  const k = new Kit();

  // ── lower body ──
  const gaps = [0.8, -0.44, -1.42];
  k.addMap(
    loft(
      LOWER,
      (c) => {
        if (c.face === 'front') return Math.abs(c.x) < 0.5 && c.y > 0.3 ? 'black' : 'paint';
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
  // Black window line along the bottom of the side glass.
  for (const s of [1, -1]) {
    const path: THREE.Vector3[] = [];
    for (let z = 0.95; z >= -2.08; z -= 0.05) {
      const y = winBottom(z);
      path.push(new THREE.Vector3(s * (widthAt(GREEN, z, y) + 0.004), y, z));
    }
    strip(k, 'trim', path, 0.012, 0.016);
  }
  // Wind deflectors over the four door windows
  for (const s of [1, -1]) {
    const path: THREE.Vector3[] = [];
    for (let z = 0.7; z >= -1.37; z -= 0.06) {
      const sec = secAt(GREEN, z);
      const y = sec.yt - sec.r - 0.015;
      path.push(new THREE.Vector3(s * (widthAt(GREEN, z, y) + 0.02), y, z));
    }
    strip(k, 'trim', path, 0.006, 0.06);
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

  // ── front bumper: body colour, black lower lip, wide intake, round fog lamps ──
  const FB: Sec[] = [
    { z: 1.87, yb: -0.02, yt: 0.33, wb: 0.925, wt: 0.92, r: 0.05 },
    { z: 2.05, yb: -0.06, yt: 0.34, wb: 0.93, wt: 0.925, r: 0.06 },
    { z: 2.25, yb: -0.07, yt: 0.34, wb: 0.9, wt: 0.89, r: 0.07 },
    { z: 2.36, yb: -0.06, yt: 0.33, wb: 0.84, wt: 0.83, r: 0.08 },
    { z: 2.405, yb: -0.03, yt: 0.31, wb: 0.76, wt: 0.75, r: 0.09, crown: -0.01 },
  ];
  k.addMap(loft(FB, (c) => (!c.face && c.y < 0.0 ? 'plastic' : 'paint'), { arches: [{ z: HZ, y: -0.02, r: 0.57 }], capFront: 0.022, closed: true, counts: { side: 8, corner: 5, top: 14, bottom: 8 }, step: 0.04 }));
  const zfb = 2.428;
  const intake = new THREE.Shape();
  intake.moveTo(-0.42, -0.01);
  intake.lineTo(0.42, -0.01);
  intake.lineTo(0.46, 0.1);
  intake.lineTo(-0.46, 0.1);
  intake.closePath();
  k.at('grille', new THREE.ShapeGeometry(intake), 0, 0, zfb + 0.002);
  strip(k, 'plastic', [[-0.42, -0.01], [0.42, -0.01], [0.46, 0.1], [-0.46, 0.1], [-0.42, -0.01]].map(([x, y]) => new THREE.Vector3(x, y, zfb + 0.004)), 0.025, 0.02, new THREE.Vector3(0, 0, 1));
  for (const s of [1, -1]) {
    k.at('black', new RoundedBoxGeometry(0.2, 0.14, 0.04, 2, 0.03), s * 0.65, 0.07, 2.39, 0, s * 0.4, 0);
    roundLamp(k, s * 0.655, 0.07, 2.412, 0.042, 'chrome');
  }

  // ── grille: black, three thick horizontal bars in a black frame, plain chrome oval ──
  const zg = 2.328;
  const gt = 0.66;
  const gbm = 0.35;
  const gShape = new THREE.Shape();
  gShape.moveTo(-0.41, gbm);
  gShape.lineTo(0.41, gbm);
  gShape.quadraticCurveTo(0.47, gbm + 0.02, 0.48, gt - 0.03);
  gShape.lineTo(0.46, gt);
  gShape.lineTo(-0.46, gt);
  gShape.lineTo(-0.48, gt - 0.03);
  gShape.quadraticCurveTo(-0.47, gbm + 0.02, -0.41, gbm);
  k.at('grille', new THREE.ShapeGeometry(gShape), 0, 0, zg);
  strip(k, 'trim', [[-0.41, gbm], [0.41, gbm], [0.475, gbm + 0.06], [0.48, gt - 0.03], [0.46, gt], [-0.46, gt], [-0.48, gt - 0.03], [-0.475, gbm + 0.06], [-0.41, gbm]].map(([x, y]) => new THREE.Vector3(x, y, zg + 0.012)), 0.035, 0.03, new THREE.Vector3(0, 0, 1));
  for (const y of [0.425, 0.505, 0.585]) k.at('trim', new RoundedBoxGeometry(0.9 - (0.6 - y) * 0.25, 0.042, 0.03, 2, 0.012), 0, y, zg + 0.02);
  emblemRing(k, 0, 0.535, zg + 0.04, 0.075, 0.05);

  // ── headlamps: big clear units with a projector, swept back and up into the wings ──
  {
    const L = new Kit();
    const p: THREE.Vector3[] = [];
    const ys: number[] = [];
    for (let x = 0.5; x < 0.74; x += 0.04) {
      const yc = 0.53 + (x - 0.5) * 0.12;
      p.push(new THREE.Vector3(x, yc, 2.327));
    }
    for (let z = 2.3; z >= 2.0; z -= 0.04) {
      const yc = 0.56 + (2.3 - z) * 0.2;
      p.push(new THREE.Vector3(widthAt(LOWER, z, yc) + 0.004, yc, z));
    }
    void ys;
    const half = (u: number) => [1, 0.13 - 0.085 * u] as [number, number];
    L.add('lens', sweep(p, [[0, -1], [0.012, -0.85], [0.018, 0], [0.012, 0.85], [0, 1], [-0.035, 0.92], [-0.035, -0.92]], { scale: half, caps: true }));
    L.add('chrome', sweep(p, [[-0.006, -0.92], [-0.004, 0.0], [-0.006, 0.92], [-0.036, 0.88], [-0.036, -0.88]], { scale: half, caps: true }));
    L.add('lampHouse', sweep(p, rrect(0.012, 0.25, 0.004, 1, -0.004, 0.25), { scale: half, caps: true }));
    // projector + main reflector bowl
    const q = p[1];
    L.at('lampHouse', new THREE.CylinderGeometry(0.05, 0.05, 0.02, 24).rotateX(Math.PI / 2), q.x, q.y - 0.02, q.z - 0.02);
    L.at('reflector', new THREE.SphereGeometry(0.038, 18, 12), q.x, q.y - 0.02, q.z - 0.01);
    L.at('chrome', new THREE.TorusGeometry(0.044, 0.006, 6, 24), q.x, q.y - 0.02, q.z - 0.004);
    const q2 = p[4];
    L.at('bulb', new THREE.SphereGeometry(0.02, 12, 8), q2.x, q2.y + 0.01, q2.z - 0.02);
    // amber indicator in the swept-back tail of the lamp
    L.add('amber', sweep(p.slice(7, 12), rrect(0.008, 0.9, 0.003, 1, -0.008, -0.1), { scale: (u) => [1, 0.13 - 0.085 * (0.55 + u * 0.4)] as [number, number], caps: true }));
    mirrored(k, L);
  }

  // ── bonnet scoop ──
  {
    const zs = 1.5;
    const path: THREE.Vector3[] = [];
    for (let x = -0.26; x <= 0.261; x += 0.052) path.push(new THREE.Vector3(x, topAt(LOWER, zs, x) - 0.006, zs));
    k.add('paint', sweep(path, [[-0.32, 0], [0.12, 0], [0.12, 0.058], [0.08, 0.062], [-0.32, 0.008]], { caps: true }));
    const top = topAt(LOWER, zs + 0.12, 0);
    k.at('gap', new RoundedBoxGeometry(0.46, 0.036, 0.01, 1, 0.008), 0, top + 0.03, zs + 0.123);
    for (let i = -3; i <= 3; i++) k.at('black', new THREE.BoxGeometry(0.008, 0.034, 0.012), i * 0.06, top + 0.03, zs + 0.125);
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
    for (const z of [0.12, -0.86]) k.at('paint', new RoundedBoxGeometry(0.03, 0.036, 0.17, 2, 0.014), s * (widthAt(LOWER, z, 0.7) + 0.01), 0.7, z);
    // mirrors (body colour, indicator)
    const mz = 0.8;
    const mx = widthAt(GREEN, mz, 0.92);
    if (s > 0) doorMirror(k, mx - 0.03, 0.95, mz, 'paint', 1.15, true);
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
    strip(k, 'black', path, 0.035, 0.035);
    for (const z of [0.08, -0.95, -2.02]) k.at('black', new RoundedBoxGeometry(0.05, 0.06, 0.12, 2, 0.015), s * 0.6, topAt(GREEN, z, 0.6) + 0.025, z);
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
    { z: -2.44, yb: 0.0, yt: 0.31, wb: 0.8, wt: 0.79, r: 0.07 },
    { z: -2.38, yb: -0.03, yt: 0.32, wb: 0.87, wt: 0.86, r: 0.07 },
    { z: -2.2, yb: -0.02, yt: 0.32, wb: 0.92, wt: 0.915, r: 0.06 },
    { z: -1.88, yb: 0.02, yt: 0.31, wb: 0.925, wt: 0.92, r: 0.05 },
  ];
  k.addMap(loft(RB, (c) => (!c.face && c.y < 0.06 ? 'plastic' : 'paint'), { arches: [{ z: -HZ, y: -0.02, r: 0.57 }], capBack: 0.02, closed: true, counts: { side: 8, corner: 5, top: 14, bottom: 8 }, step: 0.04 }));
  k.at('rubber', new RoundedBoxGeometry(0.8, 0.012, 0.16, 1, 0.005), 0, 0.326, -2.36);
  {
    // tail lamps: wrap from the side round the corner onto the tailgate (left, mirrored)
    const L = new Kit();
    const yl = 0.8;
    const p: THREE.Vector3[] = [];
    for (let z = -2.16; z > -2.37; z -= 0.035) p.push(new THREE.Vector3(widthAt(LOWER, z, yl) + 0.003, yl, z));
    for (let x = 0.8; x >= 0.68; x -= 0.04) p.push(new THREE.Vector3(x, yl, -2.425));
    const taper = (u: number) => [1, 1.15 - 0.3 * u] as [number, number];
    L.add('redLens', sweep(p, [[0, -0.15], [0.01, -0.12], [0.014, 0], [0.01, 0.12], [0, 0.15], [-0.03, 0.14], [-0.03, -0.14]], { scale: taper, caps: true }));
    L.add('brake', sweep(p.slice(1, -1), rrect(0.006, 0.05, 0.003, 1, 0.012, 0.06), { scale: taper, caps: true }));
    L.add('brake', sweep(p.slice(1, -1), rrect(0.006, 0.03, 0.003, 1, 0.012, -0.07), { scale: taper, caps: true }));
    const last = p[p.length - 2];
    L.at('reverse', new RoundedBoxGeometry(0.08, 0.035, 0.01, 1, 0.004), last.x, yl - 0.02, last.z - 0.012);
    L.at('amber', new RoundedBoxGeometry(0.08, 0.025, 0.01, 1, 0.004), last.x, yl + 0.035, last.z - 0.012);
    mirrored(k, L);
  }
  for (const s of [1, -1]) {
    k.at('reflectorRed', new RoundedBoxGeometry(0.12, 0.03, 0.01, 1, 0.004), s * 0.68, 0.2, -2.463);
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
  k.at('plate', new THREE.PlaneGeometry(0.52, 0.114), 0, 0.2, zfb + 0.008);
  k.at('black', new RoundedBoxGeometry(0.56, 0.14, 0.012, 2, 0.01), 0, 0.2, zfb);

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

  const wheel: WheelStyle = { R: 0.42, W: 0.3, rimR: 0.216, spokes: 10, spokeW: 0.011, rim: 'rimBlack', lip: 'rimBlack', tread: 'at', caliper: 'caliperGrey', lugs: 6, dish: 0.03 };
  return {
    body: k.build(),
    wheel,
    track: TX * 2,
    wheelbase: HZ * 2,
    steering: { pos: new THREE.Vector3(-0.42, 1.0, 0.53), tilt: -1.05, R: 0.19 },
    gear: {
      axles: [{ wheels: [2, 3], r: 0.048, diff: { x: 0.0, r: 0.13 } }],
      links: [
        // front double wishbones, coilovers, half-shafts
        ...[0, 1].flatMap((w) => {
          const s = w === 0 ? 1 : -1;
          return [
            { key: 'steel', r: 0.022, a: { body: [s * 0.36, -0.15, HZ + 0.05] }, b: { wheel: w, off: [-s * 0.13, -0.14, 0] } },
            { key: 'steel', r: 0.018, a: { body: [s * 0.42, 0.17, HZ - 0.02] }, b: { wheel: w, off: [-s * 0.12, 0.15, 0] } },
            { key: 'shockBlack', r: 0.028, a: { body: [s * 0.5, 0.45, HZ - 0.05] }, b: { wheel: w, off: [-s * 0.16, -0.06, -0.02] } },
            { key: 'springBlack', r: 0.065, coil: true, a: { body: [s * 0.5, 0.43, HZ - 0.05] }, b: { wheel: w, off: [-s * 0.17, 0.05, -0.02] } },
            { key: 'steel', r: 0.022, a: { body: [s * 0.13, -0.06, HZ] }, b: { wheel: w, off: [-s * 0.1, 0, 0] } },
          ];
        }),
        // rear: long shocks, coils, trailing links
        ...[2, 3].flatMap((w) => {
          const s = w === 2 ? 1 : -1;
          return [
            { key: 'shockBlack', r: 0.028, a: { body: [s * 0.6, 0.4, -HZ - 0.12] }, b: { wheel: w, off: [-s * 0.2, -0.06, -0.12] } },
            { key: 'springBlack', r: 0.07, coil: true, a: { body: [s * 0.5, 0.33, -HZ + 0.12] }, b: { wheel: w, off: [-s * 0.3, 0.06, 0.12] } },
            { key: 'steel', r: 0.025, a: { body: [s * 0.44, 0.06, -0.55] }, b: { wheel: w, off: [-s * 0.34, -0.03, 0] } },
          ];
        }),
      ],
    },
  };
}
