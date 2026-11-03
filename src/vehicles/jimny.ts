import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Kit, loft, mirrored, sweep, topAt, widthAt, type Arch, type Sec } from './kit';
import { bench, doorMirror, roundLamp, seat, strip, wiper, type WheelStyle } from './parts';
import type { ModelDef } from './index';

/**
 * Five-door Jimny-style 4×4 (the long-wheelbase body): a tough box with an upright screen,
 * flat roof with drip rails, clamshell bonnet, chrome-ringed round lamps either side of a
 * five-slot grille, two-tone black roof and A-pillars, black sill strip, flat square-cut
 * black over-fenders, black bumpers with round fog lamps, side-hinged tailgate with the
 * spare — on a mild long-travel lift with all-terrains on gunmetal alloys, and nothing
 * hanging below the body.
 *
 * Model frame: +Z forward, +X = left (driver at −X), y = 0 at the wheel centres. Axles at
 * z = ±1.295 (2.59 m wheelbase), track 1.44.
 */

const HZ = 1.295;
const TX = 0.72;
const BELT = 0.64;

const LOWER: Sec[] = [
  { z: -1.87, yb: 0.12, yt: 0.62, wb: 0.745, wt: 0.735, r: 0.07 },
  { z: -1.83, yb: 0.08, yt: BELT, wb: 0.76, wt: 0.752, r: 0.045, bulge: 0.004 },
  { z: 0.59, yb: 0.07, yt: BELT, wb: 0.762, wt: 0.754, r: 0.045, bulge: 0.004 },
  { z: 0.67, yb: 0.07, yt: 0.628, wb: 0.762, wt: 0.752, r: 0.06, crown: 0.01, bulge: 0.004 },
  { z: 1.62, yb: 0.07, yt: 0.6, wb: 0.762, wt: 0.75, r: 0.07, crown: 0.012, bulge: 0.004 },
  { z: 1.79, yb: 0.12, yt: 0.585, wb: 0.755, wt: 0.735, r: 0.08, crown: 0.01 },
  { z: 1.85, yb: 0.18, yt: 0.565, wb: 0.74, wt: 0.72, r: 0.08 },
];
const ARCHES: Arch[] = [
  { z: HZ, y: 0.0, r: 0.45 },
  { z: -HZ, y: 0.0, r: 0.45 },
];
const GB = BELT - 0.012;
const GREEN: Sec[] = [
  { z: 0.61, yb: GB, yt: GB + 0.035, wb: 0.745, wt: 0.735, r: 0.02 },
  { z: 0.2, yb: GB, yt: 1.335, wb: 0.745, wt: 0.69, r: 0.07, crown: 0.015 },
  { z: 0.14, yb: GB, yt: 1.36, wb: 0.745, wt: 0.695, r: 0.08, crown: 0.02 },
  { z: -1.79, yb: GB, yt: 1.37, wb: 0.745, wt: 0.695, r: 0.08, crown: 0.02 },
  { z: -1.85, yb: GB, yt: 1.355, wb: 0.74, wt: 0.69, r: 0.08, crown: 0.02 },
];
const A_END = 0.2;
const WIN = 0.675;
const ZF = 1.872; // nose face
const ZR = -1.875; // tailgate face

export function jimnyModel(): ModelDef {
  const k = new Kit();
  const gaps = [0.65, -0.47, -1.24];

  // ── body: black sill strip, door shut lines, clamshell bonnet edge ──
  k.addMap(
    loft(
      LOWER,
      (c) => {
        if (c.face === 'front') return 'black';
        if (c.face === 'back') return 'paint';
        const side = c.seg === 'sideL' || c.seg === 'sideR';
        if (side && c.y < 0.13) return 'plastic';
        if (side && gaps.some((g) => Math.abs(c.z - g) < 0.004) && c.y < BELT - 0.015) return 'gap';
        const tt = c.seg === 'cornerR' ? 1 - c.t : c.t;
        if ((c.seg === 'cornerL' || c.seg === 'cornerR') && c.z > 0.67 && tt > 0.5 && tt < 0.56) return 'gap';
        return 'paint';
      },
      { arches: ARCHES, capFront: 0.02, capBack: 0.02, closed: true, zBreaks: gaps.flatMap((g) => [g - 0.004, g + 0.004]).concat([0.67]), tBreaks: { cornerL: [0.5, 0.56], cornerR: [0.44, 0.5] }, counts: { side: 9, corner: 5, top: 10, bottom: 6 }, step: 0.055 },
    ),
  );

  // ── greenhouse: black roof + A-pillars (two-tone), front/rear door glass, quarter glass ──
  k.addMap(
    loft(
      GREEN,
      (c) => {
        if (c.face === 'back') return c.s < 0.84 ? 'glass' : 'paint';
        if (c.seg === 'top') return c.z > A_END ? 'glass' : 'roof';
        if (c.seg !== 'sideL' && c.seg !== 'sideR') return 'roof';
        if (c.y < WIN) return 'paint';
        if (c.z > -0.45) return 'glass';
        if (c.z > -0.53) return 'trim';
        if (c.z > -1.2) return 'glass';
        if (c.z > -1.29) return 'trim';
        if (c.z > -1.7) return 'glass';
        return 'paint';
      },
      { capBack: 0.014, closed: true, zBreaks: [A_END, -0.45, -0.53, -1.2, -1.29, -1.7], counts: { side: 10, corner: 5, top: 10, bottom: 6 }, step: 0.05, inset: { glass: -0.007 } },
    ),
  );
  // window seals along the belt; black drip rails along the roof edges; antenna
  for (const s of [1, -1]) {
    const belt: THREE.Vector3[] = [];
    for (let z = 0.59; z >= -1.71; z -= 0.05) belt.push(new THREE.Vector3(s * (widthAt(GREEN, z, WIN) + 0.003), WIN, z));
    strip(k, 'trim', belt, 0.01, 0.014);
    const drip: THREE.Vector3[] = [];
    for (let z = 0.17; z >= -1.84; z -= 0.08) {
      const y = topAt(GREEN, z, 0.66) - 0.035;
      drip.push(new THREE.Vector3(s * (widthAt(GREEN, z, y) + 0.008), y, z));
    }
    strip(k, 'roof', drip, 0.022, 0.022);
  }
  k.at('black', new THREE.CylinderGeometry(0.004, 0.006, 0.36, 6), 0.6, topAt(GREEN, 0.12, 0.6) + 0.16, 0.06, -0.5, 0, 0);
  k.at('black', new RoundedBoxGeometry(0.04, 0.03, 0.06, 1, 0.01), 0.6, topAt(GREEN, 0.12, 0.6) + 0.01, 0.12);

  // ── front: piano-black grille with five slots, chrome-ringed round lamps ──
  k.at('trim', new RoundedBoxGeometry(0.84, 0.26, 0.03, 2, 0.012), 0, 0.395, ZF + 0.006);
  for (let i = -2; i <= 2; i++) k.at('gap', new RoundedBoxGeometry(0.105, 0.19, 0.01, 2, 0.02), i * 0.155, 0.395, ZF + 0.02);
  k.at('chrome', new RoundedBoxGeometry(0.1, 0.03, 0.012, 1, 0.005), 0, 0.5, ZF + 0.024);
  {
    const L = new Kit();
    L.at('lampHouse', new THREE.CylinderGeometry(0.118, 0.118, 0.07, 28).rotateX(Math.PI / 2), 0.585, 0.395, ZF - 0.01);
    roundLamp(L, 0.585, 0.395, ZF + 0.026, 0.1, 'chrome', true);
    // indicator in the bumper corner, side repeater on the wing
    L.at('amber', new RoundedBoxGeometry(0.09, 0.035, 0.02, 2, 0.01), 0.64, 0.19, 1.975);
    L.at('amber', new RoundedBoxGeometry(0.008, 0.025, 0.05, 1, 0.004), widthAt(LOWER, 0.95, 0.5) + 0.004, 0.5, 0.95);
    roundLamp(L, 0.6, 0.06, 1.99, 0.04, 'black');
    // flat, square-cut black over-fenders
    for (const a of ARCHES) {
      const path: THREE.Vector3[] = [];
      const ups: THREE.Vector3[] = [];
      const ra = a.r + 0.03;
      for (let i = 0; i <= 24; i++) {
        const ang = -0.12 + (i / 24) * (Math.PI + 0.24);
        const sq = 1 + 0.08 * Math.sin(ang) ** 6;
        const z = a.z + Math.cos(ang) * ra * sq;
        const y = a.y + Math.sin(ang) * ra * (sq - 0.04 * Math.sin(ang) ** 2);
        path.push(new THREE.Vector3(widthAt(LOWER, z, Math.max(0.1, y)) - 0.008, y, z));
        ups.push(new THREE.Vector3(0, Math.sin(ang), Math.cos(ang)));
      }
      L.add('plastic', sweep(path, [[0, -0.065], [0.06, -0.062], [0.08, -0.04], [0.082, 0.05], [0.066, 0.07], [0, 0.072]], { up: ups, caps: true }));
    }
    // door handles (front and rear doors)
    for (const z of [-0.33, -1.1]) L.at('black', new RoundedBoxGeometry(0.03, 0.035, 0.15, 2, 0.012), widthAt(LOWER, z, 0.55) + 0.012, 0.55, z);
    // tail lamps in the rear bumper corners
    L.at('redLens', new RoundedBoxGeometry(0.2, 0.1, 0.03, 2, 0.012), 0.6, 0.1, -1.99);
    L.at('brake', new RoundedBoxGeometry(0.09, 0.07, 0.01, 1, 0.006), 0.64, 0.1, -2.008);
    L.at('reverse', new RoundedBoxGeometry(0.05, 0.06, 0.01, 1, 0.006), 0.545, 0.1, -2.008);
    L.at('amber', new RoundedBoxGeometry(0.035, 0.06, 0.01, 1, 0.006), 0.69, 0.1, -2.004);
    mirrored(k, L);
  }
  // mirrors (black, on the doors)
  {
    const mk = new Kit();
    doorMirror(mk, widthAt(GREEN, 0.51, 0.72) - 0.02, 0.73, 0.51, 'black', 1.0, false);
    mirrored(k, mk);
  }
  // front bumper (black)
  const FB: Sec[] = [
    { z: 1.72, yb: -0.03, yt: 0.24, wb: 0.79, wt: 0.79, r: 0.04 },
    { z: 1.91, yb: -0.05, yt: 0.25, wb: 0.79, wt: 0.785, r: 0.05 },
    { z: 1.97, yb: -0.03, yt: 0.24, wb: 0.74, wt: 0.73, r: 0.06 },
  ];
  k.addMap(loft(FB, () => 'plastic', { arches: [{ z: HZ, y: 0, r: 0.48 }], capFront: 0.02, closed: true, counts: { side: 6, corner: 4, top: 10, bottom: 6 }, step: 0.04 }));
  k.at('plate', new THREE.PlaneGeometry(0.5, 0.11), 0, 0.12, 1.999);
  k.at('black', new RoundedBoxGeometry(0.54, 0.13, 0.012, 2, 0.01), 0, 0.12, 1.992);
  k.at('trim', new RoundedBoxGeometry(0.6, 0.05, 0.02, 2, 0.01), 0, 0.01, 1.988);
  // bonnet washers + wipers + cowl
  for (const x of [-0.2, 0.2]) k.at('black', new RoundedBoxGeometry(0.03, 0.012, 0.02, 1, 0.004), x, topAt(LOWER, 0.79, x) + 0.004, 0.79);
  for (const px of [-0.48, 0.0]) wiper(k, px, 0.655, 0.6, 0.48, 0.03, -1.0);
  k.at('black', new RoundedBoxGeometry(1.36, 0.018, 0.07, 1, 0.007), 0, 0.648, 0.62, -0.1, 0, 0);

  // ── rear: bumper, tailgate with hinges + spare, high stop lamp, wiper ──
  const RB: Sec[] = [
    { z: -1.97, yb: -0.02, yt: 0.22, wb: 0.74, wt: 0.73, r: 0.06 },
    { z: -1.92, yb: -0.04, yt: 0.23, wb: 0.79, wt: 0.785, r: 0.05 },
    { z: -1.72, yb: -0.02, yt: 0.22, wb: 0.79, wt: 0.79, r: 0.04 },
  ];
  k.addMap(loft(RB, () => 'plastic', { arches: [{ z: -HZ, y: 0, r: 0.48 }], capBack: 0.02, closed: true, counts: { side: 6, corner: 4, top: 10, bottom: 6 }, step: 0.04 }));
  k.at('plate', new THREE.PlaneGeometry(0.5, 0.11).rotateY(Math.PI), 0, 0.11, -1.999);
  k.at('black', new RoundedBoxGeometry(0.54, 0.13, 0.012, 2, 0.01), 0, 0.11, -1.992);
  for (const y of [0.32, 1.0]) k.at('black', new RoundedBoxGeometry(0.05, 0.1, 0.05, 2, 0.015), -0.715, y, ZR);
  for (const x of [-0.69, 0.69]) strip(k, 'gap', [new THREE.Vector3(x, 0.16, ZR - 0.018), new THREE.Vector3(x, 1.3, ZR)], 0.006, 0.004, new THREE.Vector3(0, 0, -1));
  k.at('black', new RoundedBoxGeometry(0.03, 0.15, 0.03, 2, 0.012), 0.64, 0.6, ZR - 0.03); // tailgate handle
  k.at('redLens', new RoundedBoxGeometry(0.3, 0.025, 0.012, 1, 0.005), 0, 1.33, ZR + 0.01);
  {
    const wk = new Kit();
    wiper(wk, 0, 0, 0, 0.36, 0, 0);
    for (const [key, g] of wk.build()) k.at(key, g, 0.2, 0.82, ZR - 0.007, 0, Math.PI, 0.4);
  }
  k.at('black', new THREE.CylinderGeometry(0.08, 0.08, 0.06, 16).rotateX(Math.PI / 2), 0, 0.64, ZR - 0.045); // spare carrier
  k.at('steel', new THREE.CylinderGeometry(0.03, 0.03, 0.2, 14, 1, true).rotateX(Math.PI / 2), -0.42, 0.08, -1.89);

  // ── wheel wells and floor (all tucked up inside the body) ──
  for (const a of ARCHES)
    for (const s of [1, -1]) {
      k.at('liner', new THREE.CylinderGeometry(a.r + 0.01, a.r + 0.01, 0.36, 28, 1, true, -0.25, Math.PI + 0.5).rotateZ(Math.PI / 2), s * 0.6, a.y, a.z);
      k.at('liner', new THREE.RingGeometry(0.1, a.r + 0.01, 28, 1, -0.25, Math.PI + 0.5).rotateY(Math.PI / 2), s * 0.42, a.y, a.z);
    }
  k.at('under', new THREE.BoxGeometry(0.82, 0.04, 3.7), 0, 0.09, -0.05);
  for (const s of [1, -1]) k.at('under', new THREE.BoxGeometry(0.3, 0.04, 1.6), s * 0.6, 0.09, 0.0);

  // ── interior ──
  k.at('dash', new THREE.BoxGeometry(1.42, 0.02, 2.8), 0, 0.085, -0.6);
  for (const s of [1, -1]) k.at('dash', new THREE.BoxGeometry(0.03, 0.56, 2.5), s * 0.725, 0.37, -0.62);
  k.at('dash', new RoundedBoxGeometry(1.42, 0.24, 0.32, 3, 0.06), 0, 0.53, 0.67);
  k.at('dash', new RoundedBoxGeometry(1.44, 0.05, 0.36, 2, 0.02), 0, 0.655, 0.67);
  k.at('dash', new RoundedBoxGeometry(0.3, 0.08, 0.14, 3, 0.035), -0.37, 0.7, 0.59);
  for (const dx of [-0.065, 0.065]) k.at('gauge', new THREE.CircleGeometry(0.048, 24).rotateY(Math.PI).rotateX(-0.25), -0.37 + dx, 0.66, 0.52);
  k.at('screen', new THREE.PlaneGeometry(0.2, 0.11).rotateY(Math.PI), 0, 0.6, 0.505);
  for (const x of [-0.6, -0.15, 0.15, 0.6]) k.at('black', new THREE.CylinderGeometry(0.04, 0.04, 0.02, 16).rotateX(Math.PI / 2), x, 0.55, 0.505);
  k.at('dash', new RoundedBoxGeometry(0.2, 0.14, 0.8, 2, 0.05), 0, 0.165, 0.22);
  k.at('satin', new THREE.CylinderGeometry(0.01, 0.01, 0.16, 8), 0, 0.2, 0.42, -0.25, 0, 0);
  k.at('black', new THREE.SphereGeometry(0.028, 12, 8), 0, 0.28, 0.44);
  k.at('satin', new THREE.CylinderGeometry(0.008, 0.008, 0.14, 8), 0.07, 0.18, 0.29, -0.3, 0, 0); // transfer lever
  seat(k, 'fabric', -0.37, 0.16, 0.23, 0.48, 0.18);
  seat(k, 'fabric', 0.37, 0.16, 0.23, 0.48, 0.18);
  bench(k, 'fabric', 0.2, -0.88, 1.2);
  k.at('headliner', new THREE.PlaneGeometry(1.32, 1.95).rotateX(Math.PI / 2), 0, 1.325, -0.8);
  k.at('black', new RoundedBoxGeometry(0.04, 0.09, 0.19, 2, 0.015), 0, 1.25, 0.17);

  const wheel: WheelStyle = { R: 0.37, W: 0.215, rimR: 0.19, spokes: 5, spokeW: 0.03, rim: 'rimGun', lip: 'rimLip', tread: 'at', caliper: 'caliperGrey', lugs: 5, dish: 0.03 };
  return {
    body: k.build(),
    wheel,
    track: TX * 2,
    wheelbase: HZ * 2,
    steering: { pos: new THREE.Vector3(-0.37, 0.72, 0.47), tilt: -1.1, R: 0.18 },
    spare: { pos: new THREE.Vector3(0, 0.64, ZR - 0.16), rot: [0, Math.PI / 2, 0] },
    gear: {
      axles: [
        { wheels: [0, 1], r: 0.042, diff: { x: 0.14, r: 0.11 } },
        { wheels: [2, 3], r: 0.042, diff: { x: 0.0, r: 0.11 } },
      ],
      links: [0, 1, 2, 3].flatMap((w) => {
        const s = w % 2 === 0 ? 1 : -1;
        const z = w < 2 ? HZ : -HZ;
        const f = w < 2 ? 1 : -1;
        return [
          { key: 'springBlack', r: 0.065, coil: true, a: { body: [s * 0.52, 0.3, z] }, b: { wheel: w, off: [-s * 0.18, 0.05, 0] } },
          { key: 'shockBlack', r: 0.022, a: { body: [s * 0.56, 0.3, z - f * 0.16] }, b: { wheel: w, off: [-s * 0.14, -0.05, -f * 0.12] } },
          { key: 'steel', r: 0.025, a: { body: [s * 0.42, 0.1, z - f * 0.7] }, b: { wheel: w, off: [-s * 0.28, -0.04, 0] } },
        ];
      }),
    },
  };
}
