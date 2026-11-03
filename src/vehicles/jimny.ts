import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Kit, loft, mirrored, rrect, sweep, topAt, widthAt, type Arch, type Sec } from './kit';
import { bench, doorMirror, roundLamp, seat, strip, wiper, type WheelStyle } from './parts';
import type { ModelDef } from './index';

/**
 * Jimny-style compact 4×4 (4th generation shape): a tough little box — upright screen, flat
 * roof with drip rails, clamshell bonnet, round lamps either side of a five-slot grille,
 * black square-cut over-fenders and bumpers, side-hinged tailgate with the spare wheel.
 *
 * Model frame: +Z forward, +X = left (driver at −X), y = 0 at the wheel centres (ground at
 * −0.345). Axles at z = ±1.125, track 1.40.
 */

const HZ = 1.125;
const TX = 0.7;
const BELT = 0.64;

const LOWER: Sec[] = [
  { z: -1.7, yb: 0.12, yt: 0.62, wb: 0.745, wt: 0.735, r: 0.07 },
  { z: -1.66, yb: 0.08, yt: BELT, wb: 0.76, wt: 0.752, r: 0.045, bulge: 0.004 },
  { z: 0.42, yb: 0.07, yt: BELT, wb: 0.762, wt: 0.754, r: 0.045, bulge: 0.004 },
  { z: 0.5, yb: 0.07, yt: 0.628, wb: 0.762, wt: 0.752, r: 0.06, crown: 0.01, bulge: 0.004 },
  { z: 1.45, yb: 0.07, yt: 0.6, wb: 0.762, wt: 0.75, r: 0.07, crown: 0.012, bulge: 0.004 },
  { z: 1.62, yb: 0.12, yt: 0.585, wb: 0.755, wt: 0.735, r: 0.08, crown: 0.01 },
  { z: 1.68, yb: 0.18, yt: 0.565, wb: 0.74, wt: 0.72, r: 0.08 },
];
const ARCHES: Arch[] = [
  { z: HZ, y: 0.0, r: 0.42 },
  { z: -HZ, y: 0.0, r: 0.42 },
];
const GB = BELT - 0.012;
const GREEN: Sec[] = [
  { z: 0.44, yb: GB, yt: GB + 0.035, wb: 0.745, wt: 0.735, r: 0.02 },
  { z: 0.03, yb: GB, yt: 1.335, wb: 0.745, wt: 0.69, r: 0.07, crown: 0.015 },
  { z: -0.03, yb: GB, yt: 1.36, wb: 0.745, wt: 0.695, r: 0.08, crown: 0.02 },
  { z: -1.62, yb: GB, yt: 1.37, wb: 0.745, wt: 0.695, r: 0.08, crown: 0.02 },
  { z: -1.68, yb: GB, yt: 1.355, wb: 0.74, wt: 0.69, r: 0.08, crown: 0.02 },
];
const A_END = 0.03;
const WIN = 0.675;

export function jimnyModel(): ModelDef {
  const k = new Kit();
  const gaps = [0.48, -0.66];

  k.addMap(
    loft(
      LOWER,
      (c) => {
        if (c.face === 'front') return 'black';
        if (c.face === 'back') return 'paint';
        const side = c.seg === 'sideL' || c.seg === 'sideR';
        if (side && gaps.some((g) => Math.abs(c.z - g) < 0.004) && c.y < BELT - 0.015) return 'gap';
        const tt = c.seg === 'cornerR' ? 1 - c.t : c.t;
        if ((c.seg === 'cornerL' || c.seg === 'cornerR') && c.z > 0.5 && tt > 0.5 && tt < 0.56) return 'gap';
        return 'paint';
      },
      { arches: ARCHES, capFront: 0.02, capBack: 0.02, closed: true, zBreaks: gaps.flatMap((g) => [g - 0.004, g + 0.004]).concat([0.5]), tBreaks: { cornerL: [0.5, 0.56], cornerR: [0.44, 0.5] }, counts: { side: 9, corner: 5, top: 10, bottom: 6 }, step: 0.055 },
    ),
  );

  k.addMap(
    loft(
      GREEN,
      (c) => {
        if (c.face === 'back') return c.s < 0.84 ? 'glass' : 'paint';
        if (c.seg === 'top') return c.z > A_END ? 'glass' : 'paint';
        if (c.seg !== 'sideL' && c.seg !== 'sideR') return c.z > A_END ? 'trim' : 'paint';
        if (c.y < WIN) return 'paint';
        if (c.z > -0.62) return 'glass';
        if (c.z > -0.7) return 'trim';
        if (c.z > -1.52) return 'glass';
        return 'paint';
      },
      { capBack: 0.014, closed: true, zBreaks: [A_END, -0.62, -0.7, -1.52], counts: { side: 10, corner: 5, top: 10, bottom: 6 }, step: 0.05, inset: { glass: -0.007 } },
    ),
  );
  // window seals along the belt; drip rails along the roof edges
  for (const s of [1, -1]) {
    const belt: THREE.Vector3[] = [];
    for (let z = 0.42; z >= -1.53; z -= 0.05) belt.push(new THREE.Vector3(s * (widthAt(GREEN, z, WIN) + 0.003), WIN, z));
    strip(k, 'trim', belt, 0.01, 0.014);
    const drip: THREE.Vector3[] = [];
    for (let z = 0.0; z >= -1.67; z -= 0.08) {
      const y = topAt(GREEN, z, 0.66) - 0.035;
      drip.push(new THREE.Vector3(s * (widthAt(GREEN, z, y) + 0.008), y, z));
    }
    strip(k, 'paint', drip, 0.022, 0.022);
  }

  // ── front: grille with five slots, round lamps, clamshell bonnet edge ──
  const zf = 1.702;
  k.at('plastic', new RoundedBoxGeometry(0.84, 0.26, 0.03, 2, 0.012), 0, 0.395, zf + 0.006);
  for (let i = -2; i <= 2; i++) {
    k.at('gap', new RoundedBoxGeometry(0.105, 0.19, 0.01, 2, 0.02), i * 0.155, 0.395, zf + 0.02);
  }
  k.at('satin', new RoundedBoxGeometry(0.1, 0.03, 0.012, 1, 0.005), 0, 0.5, zf + 0.024);
  {
    const L = new Kit();
    L.at('lampHouse', new THREE.CylinderGeometry(0.118, 0.118, 0.07, 28).rotateX(Math.PI / 2), 0.585, 0.395, zf - 0.01);
    roundLamp(L, 0.585, 0.395, zf + 0.026, 0.1, 'chrome', false);
    // indicator + side repeater
    L.at('amber', new RoundedBoxGeometry(0.1, 0.05, 0.03, 2, 0.012), 0.64, 0.115, 1.79);
    L.at('amber', new RoundedBoxGeometry(0.008, 0.025, 0.05, 1, 0.004), widthAt(LOWER, 0.78, 0.5) + 0.004, 0.5, 0.78);
    roundLamp(L, 0.6, 0.015, 1.805, 0.04, 'black');
    // black square-cut over-fenders
    for (const a of ARCHES) {
      const path: THREE.Vector3[] = [];
      const ups: THREE.Vector3[] = [];
      const ra = a.r + 0.03;
      for (let i = 0; i <= 24; i++) {
        const ang = -0.12 + (i / 24) * (Math.PI + 0.24);
        // squarish arch: flatten the top a little
        const sq = 1 + 0.08 * Math.sin(ang) ** 6;
        const z = a.z + Math.cos(ang) * ra * sq;
        const y = a.y + Math.sin(ang) * ra * (sq - 0.04 * Math.sin(ang) ** 2);
        path.push(new THREE.Vector3(widthAt(LOWER, z, Math.max(0.1, y)) - 0.008, y, z));
        ups.push(new THREE.Vector3(0, Math.sin(ang), Math.cos(ang)));
      }
      L.add('plastic', sweep(path, [[0, -0.05], [0.045, -0.048], [0.062, -0.025], [0.064, 0.04], [0.05, 0.06], [0, 0.062]], { up: ups, caps: true }));
    }
    // door handle, rear lamps in the bumper
    L.at('black', new RoundedBoxGeometry(0.03, 0.035, 0.15, 2, 0.012), widthAt(LOWER, -0.5, 0.55) + 0.012, 0.55, -0.5);
    L.at('redLens', new RoundedBoxGeometry(0.2, 0.1, 0.03, 2, 0.012), 0.6, 0.095, -1.79);
    L.at('brake', new RoundedBoxGeometry(0.09, 0.07, 0.01, 1, 0.006), 0.64, 0.095, -1.806);
    L.at('reverse', new RoundedBoxGeometry(0.05, 0.06, 0.01, 1, 0.006), 0.545, 0.095, -1.806);
    L.at('amber', new RoundedBoxGeometry(0.035, 0.06, 0.01, 1, 0.006), 0.69, 0.095, -1.802);
    mirrored(k, L);
  }
  // mirrors (black, on the doors)
  {
    const mk = new Kit();
    doorMirror(mk, widthAt(GREEN, 0.34, 0.72) - 0.02, 0.73, 0.34, 'black', 1.0, false);
    mirrored(k, mk);
  }
  // front bumper
  const FB: Sec[] = [
    { z: 1.55, yb: -0.07, yt: 0.2, wb: 0.79, wt: 0.79, r: 0.04 },
    { z: 1.74, yb: -0.08, yt: 0.21, wb: 0.79, wt: 0.785, r: 0.05 },
    { z: 1.8, yb: -0.06, yt: 0.2, wb: 0.74, wt: 0.73, r: 0.06 },
  ];
  k.addMap(loft(FB, () => 'plastic', { arches: [{ z: HZ, y: 0, r: 0.45 }], capFront: 0.02, closed: true, counts: { side: 6, corner: 4, top: 10, bottom: 6 }, step: 0.04 }));
  k.at('plate', new THREE.PlaneGeometry(0.5, 0.11), 0, 0.07, 1.831);
  k.at('black', new RoundedBoxGeometry(0.54, 0.13, 0.012, 2, 0.01), 0, 0.07, 1.82);
  k.at('plastic', new RoundedBoxGeometry(0.22, 0.05, 0.08, 2, 0.02), 0, -0.07, 1.78); // tow eye cover
  // bonnet washers + wipers + cowl
  for (const x of [-0.2, 0.2]) k.at('black', new RoundedBoxGeometry(0.03, 0.012, 0.02, 1, 0.004), x, topAt(LOWER, 0.62, x) + 0.004, 0.62);
  for (const px of [-0.48, 0.0]) wiper(k, px, 0.655, 0.43, 0.48, 0.03, -1.0);
  k.at('black', new RoundedBoxGeometry(1.36, 0.018, 0.07, 1, 0.007), 0, 0.648, 0.45, -0.1, 0, 0);

  // ── rear: bumper, tailgate with hinges + spare, high stop lamp, wiper ──
  const RB: Sec[] = [
    { z: -1.8, yb: -0.05, yt: 0.2, wb: 0.74, wt: 0.73, r: 0.06 },
    { z: -1.75, yb: -0.07, yt: 0.21, wb: 0.79, wt: 0.785, r: 0.05 },
    { z: -1.55, yb: -0.06, yt: 0.2, wb: 0.79, wt: 0.79, r: 0.04 },
  ];
  k.addMap(loft(RB, () => 'plastic', { arches: [{ z: -HZ, y: 0, r: 0.45 }], capBack: 0.02, closed: true, counts: { side: 6, corner: 4, top: 10, bottom: 6 }, step: 0.04 }));
  k.at('plate', new THREE.PlaneGeometry(0.5, 0.11).rotateY(Math.PI), 0, 0.09, -1.831);
  k.at('black', new RoundedBoxGeometry(0.54, 0.13, 0.012, 2, 0.01), 0, 0.09, -1.82);
  for (const y of [0.32, 1.0]) k.at('black', new RoundedBoxGeometry(0.05, 0.1, 0.05, 2, 0.015), -0.715, y, -1.705);
  strip(k, 'gap', [new THREE.Vector3(-0.69, 0.16, -1.723), new THREE.Vector3(-0.69, 1.3, -1.705)], 0.006, 0.004, new THREE.Vector3(0, 0, -1));
  strip(k, 'gap', [new THREE.Vector3(0.69, 0.16, -1.723), new THREE.Vector3(0.69, 1.3, -1.705)], 0.006, 0.004, new THREE.Vector3(0, 0, -1));
  k.at('black', new RoundedBoxGeometry(0.03, 0.15, 0.03, 2, 0.012), 0.64, 0.6, -1.735); // tailgate handle
  k.at('redLens', new RoundedBoxGeometry(0.3, 0.025, 0.012, 1, 0.005), 0, 1.33, -1.695);
  {
    const wk = new Kit();
    wiper(wk, 0, 0, 0, 0.36, 0, 0);
    for (const [key, g] of wk.build()) k.at(key, g, 0.2, 0.82, -1.712, 0, Math.PI, 0.4);
  }
  // spare-wheel carrier + black hard cover
  k.at('black', new THREE.CylinderGeometry(0.08, 0.08, 0.1, 16).rotateX(Math.PI / 2), 0, 0.6, -1.78);
  k.at('plastic', new THREE.CylinderGeometry(0.36, 0.36, 0.08, 40).rotateX(Math.PI / 2), 0, 0.6, -2.0);
  k.at('plastic', new THREE.TorusGeometry(0.34, 0.035, 8, 40), 0, 0.6, -2.04);
  k.at('satin', new THREE.TorusGeometry(0.16, 0.008, 6, 32), 0, 0.6, -2.042);
  // exhaust tip (right, under the bumper)
  k.at('steel', new THREE.CylinderGeometry(0.03, 0.03, 0.26, 14, 1, true).rotateX(Math.PI / 2), -0.42, -0.1, -1.68);

  // ── wheel wells, frame, underbody ──
  for (const a of ARCHES)
    for (const s of [1, -1]) {
      k.at('liner', new THREE.CylinderGeometry(a.r + 0.01, a.r + 0.01, 0.36, 28, 1, true, -0.25, Math.PI + 0.5).rotateZ(Math.PI / 2), s * 0.6, a.y, a.z);
      k.at('liner', new THREE.RingGeometry(0.1, a.r + 0.01, 28, 1, -0.25, Math.PI + 0.5).rotateY(Math.PI / 2), s * 0.42, a.y, a.z);
    }
  k.at('under', new THREE.BoxGeometry(0.82, 0.04, 3.4), 0, 0.09, -0.05);
  for (const s of [1, -1]) {
    k.at('under', new THREE.BoxGeometry(0.34, 0.04, 1.4), s * 0.6, 0.09, 0.0);
    k.at('under', new THREE.BoxGeometry(0.07, 0.13, 3.3), s * 0.42, -0.02, 0.0);
  }
  for (const z of [-1.5, -0.5, 0.5, 1.5]) k.at('under', new THREE.BoxGeometry(0.8, 0.06, 0.07), 0, -0.02, z);
  k.at('steel', new THREE.BoxGeometry(0.4, 0.16, 0.5), 0.15, -0.06, -0.85);
  k.at('steel', new THREE.CylinderGeometry(0.03, 0.03, 2.8, 10).rotateX(Math.PI / 2), -0.42, -0.08, -0.3);
  k.at('steel', new THREE.CylinderGeometry(0.035, 0.035, 0.9, 10).rotateX(Math.PI / 2), 0.05, -0.1, -0.5);

  // ── interior ──
  k.at('dash', new THREE.BoxGeometry(1.42, 0.02, 2.4), 0, -0.04, -0.55);
  for (const s of [1, -1]) k.at('dash', new THREE.BoxGeometry(0.03, 0.66, 2.1), s * 0.725, 0.32, -0.6);
  k.at('dash', new RoundedBoxGeometry(1.42, 0.24, 0.32, 3, 0.06), 0, 0.53, 0.5);
  k.at('dash', new RoundedBoxGeometry(1.44, 0.05, 0.36, 2, 0.02), 0, 0.655, 0.5);
  k.at('dash', new RoundedBoxGeometry(0.3, 0.08, 0.14, 3, 0.035), -0.37, 0.7, 0.42);
  for (const dx of [-0.065, 0.065]) k.at('gauge', new THREE.CircleGeometry(0.048, 24).rotateY(Math.PI).rotateX(-0.25), -0.37 + dx, 0.66, 0.35);
  k.at('screen', new THREE.PlaneGeometry(0.2, 0.11).rotateY(Math.PI), 0, 0.6, 0.335);
  for (const x of [-0.6, -0.15, 0.15, 0.6]) k.at('black', new THREE.CylinderGeometry(0.04, 0.04, 0.02, 16).rotateX(Math.PI / 2), x, 0.55, 0.335);
  k.at('dash', new RoundedBoxGeometry(0.2, 0.2, 0.8, 3, 0.05), 0, 0.05, 0.05);
  k.at('satin', new THREE.CylinderGeometry(0.01, 0.01, 0.16, 8), 0, 0.2, 0.25, -0.25, 0, 0);
  k.at('black', new THREE.SphereGeometry(0.028, 12, 8), 0, 0.28, 0.27);
  k.at('satin', new THREE.CylinderGeometry(0.008, 0.008, 0.14, 8), 0.07, 0.18, 0.12, -0.3, 0, 0); // transfer lever
  seat(k, 'fabric', -0.37, 0.16, 0.06, 0.48, 0.18);
  seat(k, 'fabric', 0.37, 0.16, 0.06, 0.48, 0.18);
  bench(k, 'fabric', 0.2, -0.88, 1.2);
  k.at('headliner', new THREE.PlaneGeometry(1.32, 1.6).rotateX(Math.PI / 2), 0, 1.325, -0.82);
  k.at('black', new RoundedBoxGeometry(0.04, 0.09, 0.19, 2, 0.015), 0, 1.25, 0.0);

  const wheel: WheelStyle = { R: 0.345, W: 0.2, rimR: 0.19, spokes: 5, rim: 'rimGun', lip: 'rimLip', tread: 'ht', caliper: 'caliperGrey', lugs: 5, dish: 0.035 };
  void rrect;
  return {
    body: k.build(),
    wheel,
    track: TX * 2,
    wheelbase: HZ * 2,
    steering: { pos: new THREE.Vector3(-0.37, 0.72, 0.3), tilt: -1.1, R: 0.18 },
    spare: { pos: new THREE.Vector3(0, 0.6, -1.89), cover: true },
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
          { key: 'steel', r: 0.025, a: { body: [s * 0.42, -0.04, z - f * 0.75] }, b: { wheel: w, off: [-s * 0.28, -0.07, 0] } },
        ];
      }),
    },
  };
}
