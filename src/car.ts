import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { textures } from './world/textures';

/**
 * Vehicles on Rapier's ray-cast vehicle controller, driven by data (VehicleSpec): mass and
 * inertia tensor, suspension, tyres, an engine torque curve through a torque converter and
 * automatic gearbox, a two-speed transfer case (4H/4L) to all four wheels, brakes, drag.
 *
 * Handling is tuned to feel like GTA IV: heavy and momentum-driven, soft and under-damped
 * suspension so the body visibly rolls, dives under braking and squats under power; no
 * stability control, lighter traction control, a slightly loose rear so slides are easy to
 * provoke and catch, and progressive understeer at the limit.
 */

// ── specs ────────────────────────────────────────────────────────────────────

export interface VehicleSpec {
  name: string;
  model: 'jimny' | 'fortuner';
  mass: number;
  /** Principal moments of inertia (pitch, yaw, roll) and centre of mass (chassis frame). */
  inertia: { x: number; y: number; z: number };
  com: { x: number; y: number; z: number };
  wheelbase: number;
  track: number;
  wheelRadius: number;
  wheelWidth: number;
  /** Suspension mount height above the wheel centre at rest (chassis frame). */
  mountY: number;
  restLength: number;
  maxTravel: number;
  stiffness: number; // Rapier scales by chassis mass: per wheel k·x·m
  compression: number;
  relaxation: number;
  frictionSlip: number; // ≈ tyre μ
  sideFront: number; // lateral stiffness (front lower → understeer at the limit)
  sideRear: number;
  rollDamping: number; // N·m·s
  maxSteer: number;
  steerFalloff: number; // speed (m/s) at which steering lock halves
  idleRpm: number;
  redline: number;
  stallRpm: number; // torque-converter stall rise at full throttle
  torque: [number, number][]; // Nm vs rpm
  gears: number[];
  reverse: number;
  finalDrive: number;
  transferHigh: number;
  transferLow: number;
  efficiency: number;
  drivelineScale: number;
  upshift: [number, number]; // rpm (full throttle, light throttle)
  downshift: [number, number];
  brakeForce: number;
  dragCoef: number;
  rollCoef: number;
  /** Traction-control cap as a multiple of available grip (>1 allows some wheelspin). */
  tcs: number;
  esp: boolean;
  reverseLimit: number; // m/s
  /** Shell colliders: [hx, hy, hz, cx, cy, cz]. */
  colliders: [number, number, number, number, number, number][];
  seats: THREE.Vector3[];
  /** Eye height above the driver's seat, chase camera distance, exit offset from centre. */
  eye: number;
  camDist: number;
  exitX: number;
  diesel: boolean;
  /** Sprung-body lean (rad per m/s²) — the visible GTA IV-style weight transfer. */
  bodyRoll: number;
  bodyPitch: number;
}

export const JIMNY: VehicleSpec = {
  name: 'Jimny',
  model: 'jimny',
  mass: 1090,
  inertia: { x: 1320, y: 1360, z: 460 },
  com: { x: 0, y: 0.12, z: 0.05 },
  wheelbase: 2.25,
  track: 1.4,
  wheelRadius: 0.345,
  wheelWidth: 0.2,
  mountY: 0.22,
  restLength: 0.36,
  maxTravel: 0.3,
  stiffness: 16,
  compression: 1.45,
  relaxation: 2.1,
  frictionSlip: 1.02,
  sideFront: 0.84,
  sideRear: 0.95,
  rollDamping: 650,
  maxSteer: THREE.MathUtils.degToRad(33),
  steerFalloff: 9,
  idleRpm: 800,
  redline: 6200,
  stallRpm: 1700,
  torque: [[800, 88], [1500, 104], [2500, 118], [3500, 127], [4000, 130], [5000, 126], [6000, 116], [6500, 95]],
  gears: [2.875, 1.568, 1.0, 0.697],
  reverse: 2.3,
  finalDrive: 4.3,
  transferHigh: 1.32,
  transferLow: 2.643,
  efficiency: 0.86,
  drivelineScale: 1.3,
  upshift: [5600, 3400],
  downshift: [2300, 1300],
  brakeForce: 44,
  dragCoef: 0.5 * 1.2 * 0.5 * 2.3,
  rollCoef: 0.016,
  tcs: 1.1,
  esp: false,
  reverseLimit: 7,
  colliders: [[0.8, 0.33, 1.68, 0, 0.22, 0], [0.74, 0.4, 1.05, 0, 0.95, -0.55], [0.74, 0.08, 0.6, 0, 0.6, 1.1]],
  seats: [
    new THREE.Vector3(-0.37, 0.16, -0.05), // driver (right-hand drive)
    new THREE.Vector3(0.37, 0.16, -0.05),
    new THREE.Vector3(-0.35, 0.2, -0.95),
    new THREE.Vector3(0.35, 0.2, -0.95),
  ],
  eye: 0.74,
  camDist: 6,
  exitX: 1.45,
  diesel: false,
  bodyRoll: 0.0085,
  bodyPitch: 0.0055,
};

/**
 * Toyota Fortuner-style SUV on a 2-inch lift with 285/70 R17 all-terrain tyres: 2.15 t,
 * 2.8 L diesel (500 Nm from 1,600 rpm), 6-speed automatic, low range; long-travel lifted
 * suspension that leans and wallows like a heavy GTA IV SUV.
 */
export const FORTUNER: VehicleSpec = {
  name: 'Fortuner',
  model: 'fortuner',
  mass: 2150,
  inertia: { x: 3900, y: 4200, z: 1150 },
  com: { x: 0, y: 0.24, z: 0.12 },
  wheelbase: 2.745,
  track: 1.62,
  wheelRadius: 0.4,
  wheelWidth: 0.29,
  mountY: 0.34,
  restLength: 0.5,
  maxTravel: 0.38,
  stiffness: 12.5,
  compression: 1.2,
  relaxation: 1.8,
  frictionSlip: 1.05,
  sideFront: 0.82,
  sideRear: 0.93,
  rollDamping: 900,
  maxSteer: THREE.MathUtils.degToRad(35),
  steerFalloff: 10,
  idleRpm: 750,
  redline: 4400,
  stallRpm: 1500,
  torque: [[750, 260], [1200, 400], [1600, 500], [2800, 500], [3400, 440], [4000, 380], [4600, 300]],
  gears: [3.6, 2.09, 1.49, 1.2, 1.0, 0.79],
  reverse: 3.3,
  finalDrive: 3.583,
  transferHigh: 1.0,
  transferLow: 2.566,
  efficiency: 0.85,
  drivelineScale: 0.92,
  upshift: [3900, 2200],
  downshift: [1500, 1000],
  brakeForce: 80,
  dragCoef: 0.5 * 1.2 * 0.44 * 2.95,
  rollCoef: 0.018,
  tcs: 1.15,
  esp: false,
  reverseLimit: 7,
  colliders: [[0.93, 0.42, 2.35, 0, 0.38, 0.05], [0.86, 0.38, 1.55, 0, 1.15, -0.45]],
  seats: [
    new THREE.Vector3(-0.42, 0.42, 0.05),
    new THREE.Vector3(0.42, 0.42, 0.05),
    new THREE.Vector3(-0.42, 0.46, -0.9),
    new THREE.Vector3(0.42, 0.46, -0.9),
  ],
  eye: 0.78,
  camDist: 7.5,
  exitX: 1.65,
  diesel: true,
  bodyRoll: 0.0115,
  bodyPitch: 0.0065,
};

function torqueAt(curve: [number, number][], rpm: number) {
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 0; i < curve.length - 1; i++) {
    const [r0, t0] = curve[i];
    const [r1, t1] = curve[i + 1];
    if (rpm <= r1) return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
  }
  return 0;
}

export interface CarInput {
  throttle: number; // 0..1 (W)
  brake: number; // 0..1 (S): brakes, or reverse when stopped
  steer: number; // -1..1 (A/D), + = left
  handbrake: boolean;
}

/** State sent over the network by the driver (and used for engine audio everywhere). */
export interface CarState {
  rpm: number;
  gear: number; // -1 reverse, 0 neutral, 1..4
  speed: number; // m/s, signed (forward +)
  steer: number; // radians
  throttle: number;
  braking: boolean;
  low: boolean;
}

// ── visuals ──────────────────────────────────────────────────────────────────

const mat = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.5, ...o });

function plateTexture(text: string) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f7f7f2';
  g.fillRect(0, 0, 256, 64);
  g.strokeStyle = '#111';
  g.lineWidth = 4;
  g.strokeRect(3, 3, 250, 58);
  g.fillStyle = '#111';
  g.font = '700 38px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function wheelMesh(R = JIMNY.wheelRadius, W = JIMNY.wheelWidth, offroad = false): THREE.Group {
  // Tyre: rounded-section lathe, axis along X.
  const prof: THREE.Vector2[] = [];
  const rr = offroad ? 0.075 : 0.05;
  const inner = offroad ? 0.22 : 0.2;
  prof.push(new THREE.Vector2(inner, -W / 2));
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    prof.push(new THREE.Vector2(R - rr + Math.cos(a) * rr, -W / 2 + rr + Math.sin(a) * rr));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    prof.push(new THREE.Vector2(R - rr + Math.cos(a) * rr, W / 2 - rr + Math.sin(a) * rr));
  }
  prof.push(new THREE.Vector2(inner, W / 2));
  const tyreGeo = new THREE.LatheGeometry(prof, 28);
  tyreGeo.rotateZ(Math.PI / 2);
  const tex = textures().tyre.clone();
  tex.needsUpdate = true;
  tex.repeat.set(1, 6);
  const tyre = new THREE.Mesh(tyreGeo, mat({ color: 0x1a1a1a, roughness: 0.92, map: tex }));
  const rimMat = offroad ? mat({ color: 0x1c1c1e, metalness: 0.7, roughness: 0.35 }) : mat({ color: 0x9aa0a6, metalness: 0.85, roughness: 0.3 });
  const rimR = inner;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, W * 0.7, 24).rotateZ(Math.PI / 2), mat({ color: 0x2a2c30, metalness: 0.6, roughness: 0.4 }));
  const g = new THREE.Group();
  g.add(tyre, rim);
  if (offroad) {
    // Chunky all-terrain tread blocks, staggered in two rows, and shoulder lugs.
    const lug = new THREE.BoxGeometry(W * 0.42, 0.03, 0.07);
    const lugMat = mat({ color: 0x161616, roughness: 0.95 });
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const m = new THREE.Mesh(lug, lugMat);
      m.position.set((k % 2 ? 1 : -1) * W * 0.22, Math.cos(a) * (R + 0.008), Math.sin(a) * (R + 0.008));
      m.rotation.x = -a;
      g.add(m);
    }
  }
  const spokes = offroad ? 6 : 5;
  for (let k = 0; k < spokes; k++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.04, rimR * 0.85, offroad ? 0.07 : 0.05), rimMat);
    spoke.position.y = rimR * 0.45;
    const arm = new THREE.Group();
    arm.rotation.x = (k / spokes) * Math.PI * 2;
    arm.add(spoke);
    arm.position.x = W * 0.36;
    g.add(arm);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12).rotateZ(Math.PI / 2), rimMat);
  hub.position.x = W * 0.37;
  g.add(hub);
  g.traverse((o) => (o as THREE.Mesh).isMesh && (o.castShadow = true));
  return g;
}

export interface Visual {
  root: THREE.Group;
  wheels: { steer: THREE.Group; spin: THREE.Group; side: number }[];
  steeringWheel: THREE.Object3D;
  brakeMat: THREE.MeshStandardMaterial;
  reverseMat: THREE.MeshStandardMaterial;
}

export function buildJimny(color: number, plate: string): Visual {
  const root = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.38, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.12, envMapIntensity: 0.55 });
  const black = mat({ color: 0x151515, roughness: 0.7 });
  const trim = mat({ color: 0x202020, roughness: 0.45, metalness: 0.2 });
  const chrome = mat({ color: 0xdedede, metalness: 1, roughness: 0.12 });
  const glass = mat({ color: 0x0f1a22, metalness: 0.4, roughness: 0.05, transparent: true, opacity: 0.72 });
  const add = (m: THREE.Mesh, x: number, y: number, z: number, cast = true) => {
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    root.add(m);
    return m;
  };

  // Lower body: boxy with crisp rounded edges.
  add(new THREE.Mesh(new RoundedBoxGeometry(1.6, 0.66, 3.36, 3, 0.07), paint), 0, 0.22, 0);
  // Clamshell bonnet.
  const hood = add(new THREE.Mesh(new RoundedBoxGeometry(1.54, 0.07, 1.12, 2, 0.03), paint), 0, 0.57, 1.1);
  hood.rotation.x = 0.035;
  // Greenhouse: extruded side profile (upright, short overhangs, raked screen).
  const s = new THREE.Shape();
  s.moveTo(-1.62, 0.52);
  s.lineTo(-1.6, 1.36);
  s.lineTo(0.22, 1.37);
  s.lineTo(0.6, 0.55);
  s.lineTo(-1.62, 0.52);
  const cabGeo = new THREE.ExtrudeGeometry(s, { depth: 1.46, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 });
  cabGeo.rotateY(-Math.PI / 2); // shape x → world z
  cabGeo.translate(0.73, 0, 0);
  add(new THREE.Mesh(cabGeo, paint), 0, 0, 0);
  // Glass: windscreen, side windows (split by the B pillar), rear window.
  const screen = add(new THREE.Mesh(new THREE.PlaneGeometry(1.34, 0.78), glass), 0, 0.97, 0.42);
  screen.rotation.x = -Math.atan2(0.38, 0.82);
  for (const sx of [-1, 1]) {
    const f = add(new THREE.Mesh(new THREE.PlaneGeometry(0.88, 0.62), glass), sx * 0.765, 1.02, -0.08, false);
    f.rotation.y = (sx * Math.PI) / 2;
    const r = add(new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.6), glass), sx * 0.765, 1.03, -1.17, false);
    r.rotation.y = (sx * Math.PI) / 2;
    // door shut lines + handle + mirror + drip rail
    add(new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.62, 0.012), trim), sx * 0.805, 0.24, 0.5, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.62, 0.012), trim), sx * 0.805, 0.24, -0.62, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.14), trim), sx * 0.81, 0.46, -0.45, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.18), black), sx * 0.86, 0.72, 0.42);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 1.85), trim), sx * 0.75, 1.38, -0.68, false);
  }
  const rear = add(new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.5), glass), 0, 1.06, -1.655, false);
  rear.rotation.y = Math.PI;

  // Front: 5-slot grille, round headlamps, indicators, bumper, plate.
  add(new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.3, 0.04), black), 0, 0.36, 1.69);
  for (let k = -2; k <= 2; k++) add(new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.22, 0.02), mat({ color: 0x050505 })), k * 0.17, 0.36, 1.71, false);
  const lamp = mat({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.6, roughness: 0.1 });
  for (const sx of [-1, 1]) {
    const h = add(new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.05, 24).rotateX(Math.PI / 2), lamp), sx * 0.6, 0.38, 1.69, false);
    h.renderOrder = 2;
    add(new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.018, 8, 24), chrome), sx * 0.6, 0.38, 1.715, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.03), mat({ color: 0xff9a1a, emissive: 0x552200 })), sx * 0.66, 0.13, 1.78, false);
  }
  add(new THREE.Mesh(new RoundedBoxGeometry(1.66, 0.22, 0.24, 2, 0.05), black), 0, 0.02, 1.71);
  const plateMat = mat({ map: plateTexture(plate), roughness: 0.6 });
  add(new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.12), plateMat), 0, 0.03, 1.835, false);

  // Rear: bumper with tail lamps, tailgate-mounted spare wheel, plate.
  add(new THREE.Mesh(new RoundedBoxGeometry(1.66, 0.22, 0.22, 2, 0.05), black), 0, 0.02, -1.71);
  const brakeMat = mat({ color: 0x5a0808, emissive: 0xff0000, emissiveIntensity: 0.15 });
  const reverseMat = mat({ color: 0xdddddd, emissive: 0xffffff, emissiveIntensity: 0 });
  for (const sx of [-1, 1]) {
    add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.03), brakeMat), sx * 0.7, 0.05, -1.825, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.03), reverseMat), sx * 0.55, 0.05, -1.825, false);
  }
  const spare = wheelMesh();
  spare.rotation.y = Math.PI / 2;
  spare.position.set(0, 0.55, -1.8);
  root.add(spare);
  const cover = add(new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.12, 28).rotateX(Math.PI / 2), black), 0, 0.55, -1.89);
  cover.castShadow = true;
  const plateR = add(new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.12), plateMat), 0, 0.05, -1.83, false);
  plateR.rotation.y = Math.PI;

  // Wheel-arch flares (black), over each wheel.
  const hz = JIMNY.wheelbase / 2;
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const flare = add(new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 6, 18, Math.PI), black), sx * 0.8, 0.02, sz * hz);
    flare.rotation.y = Math.PI / 2;
  }

  // Interior: seats, dash, steering wheel (driver on the right = −X).
  const fabric = mat({ color: 0x262626, roughness: 0.95 });
  for (const sx of [-1, 1]) {
    add(new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.12, 0.5), fabric), sx * 0.37, 0.13, -0.05, false);
    const back = add(new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.62, 0.1), fabric), sx * 0.37, 0.48, -0.33, false);
    back.rotation.x = -0.16;
  }
  add(new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.45), fabric), 0, 0.17, -0.98, false);
  add(new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.22, 0.32), black), 0, 0.62, 0.5, false);
  const sw = new THREE.Group();
  sw.position.set(-0.37, 0.72, 0.32);
  sw.rotation.x = -1.1;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.02, 8, 24), black);
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.02), black);
  sw.add(rim, spoke);
  const steeringWheel = new THREE.Group();
  steeringWheel.add(sw);
  root.add(steeringWheel);
  const swSpin = sw;

  // Road wheels.
  const wheels: Visual['wheels'] = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const steer = new THREE.Group();
    steer.position.set((sx * JIMNY.track) / 2, 0, sz * hz);
    const spin = wheelMesh();
    if (sx < 0) spin.scale.x = -1; // rim faces outward on both sides
    steer.add(spin);
    root.add(steer);
    wheels.push({ steer, spin, side: sx });
  }
  return { root, wheels, steeringWheel: swSpin, brakeMat, reverseMat };
}


/**
 * Loft a closed body through cross-sections along Z. Each station: z, bottom y, top y,
 * half-width at the bottom and at the top, corner radius. Gives tapered, curved shapes
 * (wedge beltlines, tumblehome) that boxes can't.
 */
function loft(st: { z: number; yb: number; yt: number; wb: number; wt: number; r: number }[], capEnds = true): THREE.BufferGeometry {
  const ring = (s: (typeof st)[number]) => {
    const pts: [number, number][] = [[-s.wb, s.yb]];
    const n = 4;
    for (let i = 0; i <= n; i++) {
      const a = Math.PI - (i / n) * (Math.PI / 2);
      pts.push([-s.wt + s.r + Math.cos(a) * s.r, s.yt - s.r + Math.sin(a) * s.r]);
    }
    for (let i = 0; i <= n; i++) {
      const a = Math.PI / 2 - (i / n) * (Math.PI / 2);
      pts.push([s.wt - s.r + Math.cos(a) * s.r, s.yt - s.r + Math.sin(a) * s.r]);
    }
    pts.push([s.wb, s.yb]);
    return pts;
  };
  const rings = st.map(ring);
  const R = rings[0].length;
  const pos: number[] = [];
  const idx: number[] = [];
  st.forEach((s, i) => rings[i].forEach(([x, y]) => pos.push(x, y, s.z)));
  for (let i = 0; i < st.length - 1; i++)
    for (let k = 0; k < R; k++) {
      const a = i * R + k;
      const b = i * R + ((k + 1) % R);
      const c = (i + 1) * R + k;
      const d = (i + 1) * R + ((k + 1) % R);
      idx.push(a, b, c, b, d, c);
    }
  if (capEnds)
    for (const [i, flip] of [[0, true], [st.length - 1, false]] as const) {
      const ctr = pos.length / 3;
      const s = st[i];
      pos.push(0, (s.yb + s.yt) / 2, s.z);
      for (let k = 0; k < R; k++) {
        const a = i * R + k;
        const b = i * R + ((k + 1) % R);
        if (flip) idx.push(ctr, b, a);
        else idx.push(ctr, a, b);
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Lifted Fortuner-style SUV: big grille, slim LED lamps, cladding, steps, rails, AT tyres. */
export function buildFortuner(color: number, plate: string): Visual {
  const F = FORTUNER;
  const root = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 0.6 });
  const black = mat({ color: 0x141414, roughness: 0.65 });
  const plastic = mat({ color: 0x202224, roughness: 0.8 });
  const chrome = mat({ color: 0xe2e2e2, metalness: 1, roughness: 0.1 });
  const silver = mat({ color: 0xa9adb2, metalness: 0.8, roughness: 0.3 });
  const glass = mat({ color: 0x0c151b, metalness: 0.5, roughness: 0.04, transparent: true, opacity: 0.78 });
  const add = (m: THREE.Mesh, x: number, y: number, z: number, cast = true) => {
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    root.add(m);
    return m;
  };
  // Lower body: a wedge — long bonnet falling to the nose, beltline rising to the tail.
  const lower = loft([
    { z: 2.38, yb: -0.02, yt: 0.6, wb: 0.86, wt: 0.8, r: 0.12 },
    { z: 2.28, yb: -0.06, yt: 0.68, wb: 0.92, wt: 0.88, r: 0.1 },
    { z: 1.9, yb: -0.08, yt: 0.73, wb: 0.93, wt: 0.9, r: 0.08 },
    { z: 1.2, yb: -0.08, yt: 0.79, wb: 0.93, wt: 0.9, r: 0.07 },
    { z: 0.0, yb: -0.08, yt: 0.82, wb: 0.93, wt: 0.9, r: 0.07 },
    { z: -1.6, yb: -0.08, yt: 0.86, wb: 0.93, wt: 0.9, r: 0.07 },
    { z: -2.25, yb: -0.04, yt: 0.88, wb: 0.92, wt: 0.88, r: 0.09 },
    { z: -2.34, yb: 0.0, yt: 0.84, wb: 0.86, wt: 0.82, r: 0.12 },
  ]);
  add(new THREE.Mesh(lower, paint), 0, 0, 0);
  // Greenhouse: raked screen, tumblehome, gently falling roofline — a wrapped glass band…
  const green = loft([
    { z: 1.22, yb: 0.78, yt: 0.83, wb: 0.89, wt: 0.86, r: 0.03 },
    { z: 0.62, yb: 0.8, yt: 1.47, wb: 0.9, wt: 0.73, r: 0.1 },
    { z: -0.6, yb: 0.83, yt: 1.5, wb: 0.9, wt: 0.74, r: 0.1 },
    { z: -1.75, yb: 0.86, yt: 1.48, wb: 0.9, wt: 0.74, r: 0.1 },
    { z: -2.24, yb: 0.88, yt: 1.42, wb: 0.88, wt: 0.72, r: 0.1 },
  ]);
  add(new THREE.Mesh(green, glass), 0, 0, 0);
  // …under a painted roof skin, with painted A/D pillars and black B/C pillars.
  const roof = loft([
    { z: 0.6, yb: 1.44, yt: 1.5, wb: 0.735, wt: 0.72, r: 0.03 },
    { z: -0.6, yb: 1.47, yt: 1.53, wb: 0.745, wt: 0.73, r: 0.03 },
    { z: -2.22, yb: 1.39, yt: 1.45, wb: 0.725, wt: 0.71, r: 0.03 },
  ]);
  add(new THREE.Mesh(roof, paint), 0, 0, 0);
  const ws = add(new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.9), glass), 0, 1.13, 0.93, false);
  ws.rotation.x = -Math.atan2(0.6, 0.67);
  for (const sx of [-1, 1]) {
    const aP = add(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.82, 0.08), paint), sx * 0.8, 1.14, 0.93, false);
    aP.rotation.set(-Math.atan2(0.6, 0.67), 0, -sx * 0.18);
    for (const [z, m] of [[-0.3, black], [-1.24, black], [-2.2, paint]] as const) {
      const p2 = add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.1), m), sx * 0.86, 1.16, z, false);
      p2.rotation.z = -sx * 0.25;
    }
    // door shut lines, handles, mirrors, cladding, flares, side steps, roof rails
    for (const z of [0.66, -0.3, -1.24]) add(new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.72, 0.012), black), sx * 0.935, 0.42, z, false);
    for (const z of [0.0, -0.95]) add(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.16), chrome), sx * 0.94, 0.62, z, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.24), black), sx * 0.99, 0.9, 0.66);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 4.4), plastic), sx * 0.935, 0.06, 0.02, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 2.1), silver), sx * 1.02, -0.12, -0.12);
    for (const z of [0.7, -0.9]) add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.06), black), sx * 0.95, -0.07, z, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 2.5), silver), sx * 0.7, 1.56, -0.85);
    for (const z of [0.3, -2.0]) add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.1), black), sx * 0.7, 1.52, z, false);
  }
  const rearGlass = add(new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.6), glass), 0, 1.15, -2.29, false);
  rearGlass.rotation.set(-0.16, Math.PI, 0);
  // Front: big trapezoid grille with chrome surround, slim LED lamps, bumper + skid plate.
  add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.42, 0.06), mat({ color: 0x0a0a0a, roughness: 0.5, metalness: 0.3 })), 0, 0.44, 2.37);
  for (let k = -4; k <= 4; k++) add(new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.012, 0.02), plastic), 0, 0.44 + k * 0.042, 2.405, false);
  for (const [x, y, w, h] of [[0, 0.66, 1.16, 0.035], [0, 0.22, 0.98, 0.035], [-0.56, 0.44, 0.035, 0.44], [0.56, 0.44, 0.035, 0.44]] as const)
    add(new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), chrome), x, y, 2.41, false);
  const led = mat({ color: 0xffffff, emissive: 0xeaf4ff, emissiveIntensity: 1.2, roughness: 0.1 });
  for (const sx of [-1, 1]) {
    const lampHouse = add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.1), mat({ color: 0x1a1d22, metalness: 0.6, roughness: 0.2 })), sx * 0.66, 0.6, 2.31, false);
    lampHouse.rotation.z = sx * 0.12;
    const strip = add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.02, 0.02), led), sx * 0.66, 0.635, 2.365, false);
    strip.rotation.z = sx * 0.12;
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16).rotateX(Math.PI / 2), led), sx * 0.7, 0.1, 2.43, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.03), mat({ color: 0xff9a1a, emissive: 0x552200 })), sx * 0.86, 0.5, 2.3, false);
  }
  add(new THREE.Mesh(new RoundedBoxGeometry(1.88, 0.3, 0.34, 2, 0.06), plastic), 0, 0.08, 2.3);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.05, 0.45), silver), 0, -0.07, 2.28);
  const plateMat = mat({ map: plateTexture(plate), roughness: 0.6 });
  add(new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.12), plateMat), 0, 0.12, 2.475, false);
  // Rear: vertical lamps, bumper, chrome tailgate strip, plate.
  const brakeMat = mat({ color: 0x5a0808, emissive: 0xff0000, emissiveIntensity: 0.15 });
  const reverseMat = mat({ color: 0xdddddd, emissive: 0xffffff, emissiveIntensity: 0 });
  for (const sx of [-1, 1]) {
    add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.05), brakeMat), sx * 0.84, 0.72, -2.33, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.04), reverseMat), sx * 0.6, 0.08, -2.36, false);
  }
  add(new THREE.Mesh(new RoundedBoxGeometry(1.88, 0.3, 0.3, 2, 0.06), plastic), 0, 0.06, -2.28);
  add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.02), chrome), 0, 0.56, -2.335, false);
  const plateR = add(new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.12), plateMat), 0, 0.36, -2.345, false);
  plateR.rotation.y = Math.PI;
  // Wheel-arch flares.
  const hz = F.wheelbase / 2;
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const flare = add(new THREE.Mesh(new THREE.TorusGeometry(F.wheelRadius + 0.1, 0.075, 6, 20, Math.PI), black), sx * 0.93, 0.02, sz * hz);
    flare.rotation.y = Math.PI / 2;
  }
  // Interior.
  const fabric = mat({ color: 0x2b2420, roughness: 0.9 });
  for (const sx of [-1, 1]) {
    add(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.14, 0.55), fabric), sx * 0.42, 0.38, 0.05, false);
    const back = add(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.7, 0.12), fabric), sx * 0.42, 0.78, -0.26, false);
    back.rotation.x = -0.15;
  }
  add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.14, 0.5), fabric), 0, 0.42, -0.9, false);
  add(new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.26, 0.4), black), 0, 0.92, 0.78, false);
  const sw = new THREE.Group();
  sw.position.set(-0.42, 1.0, 0.52);
  sw.rotation.x = -1.05;
  sw.add(new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 8, 24), black), new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.02), black));
  root.add(sw);
  // Road wheels: all-terrain tyres on black six-spoke rims.
  const wheels: Visual['wheels'] = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const steer = new THREE.Group();
    steer.position.set((sx * F.track) / 2, 0, sz * hz);
    const spin = wheelMesh(F.wheelRadius, F.wheelWidth, true);
    if (sx < 0) spin.scale.x = -1;
    steer.add(spin);
    root.add(steer);
    wheels.push({ steer, spin, side: sx });
  }
  return { root, wheels, steeringWheel: sw, brakeMat, reverseMat };
}

// ── the car ──────────────────────────────────────────────────────────────────

const FORWARD = new THREE.Vector3(0, 0, 1);

export class Car {
  readonly visual: Visual;
  readonly body: RAPIER.RigidBody;
  readonly ctrl: RAPIER.DynamicRayCastVehicleController;
  /** Occupant identity per seat (seat 0 drives). */
  readonly seats: (string | null)[] = [null, null, null, null];
  state: CarState = { rpm: 800, gear: 1, speed: 0, steer: 0, throttle: 0, braking: false, low: false };
  /** true while this client simulates it (we're driving, or it's still settling after we got out). */
  simulating = false;
  /** Identity of whoever drove it last (they keep re-broadcasting its parked pose). */
  lastDriver: string | null = null;
  private steer = 0;
  /** The sprung body (all visuals except the wheels). */
  readonly cabin = new THREE.Group();
  private lean = { roll: 0, rollV: 0, pitch: 0, pitchV: 0, prev: new THREE.Vector3(), acc: new THREE.Vector3(), init: false };
  /** Stability control is intervening (HUD light). */
  esp = false;
  private shiftTimer = 0;
  private settle = 0;
  private wheelSpin = [0, 0, 0, 0];
  // remote interpolation
  private buf: { t: number; p: THREE.Vector3; q: THREE.Quaternion }[] = [];
  private lastSeq = -1;
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  constructor(
    readonly id: number,
    private physics: RAPIER.World,
    scene: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    yaw: number,
    color: number,
    readonly spec: VehicleSpec = JIMNY,
  ) {
    const plate = `KL-07 ${spec.model === 'jimny' ? 'J' : 'BF'} ${(2187 + id * 1311) % 9000 + 1000}`;
    this.visual = spec.model === 'fortuner' ? buildFortuner(color, plate) : buildJimny(color, plate);
    // Everything but the wheels rides on the springs: move it into a cabin group we can lean.
    const steerGroups = new Set<THREE.Object3D>(this.visual.wheels.map((w) => w.steer));
    for (const child of [...this.visual.root.children]) if (!steerGroups.has(child)) this.cabin.add(child);
    this.visual.root.add(this.cabin);
    this.state.rpm = spec.idleRpm;
    scene.add(this.visual.root);

    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = physics.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x, y, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.02)
        .setAngularDamping(0.35)
        .setCanSleep(false)
        // Explicit mass properties: COM a little below the body's middle; box-like inertia.
        .setAdditionalMassProperties(spec.mass, spec.com, spec.inertia, { x: 0, y: 0, z: 0, w: 1 }),
    );
    // Shell colliders (mass comes from the explicit properties above).
    for (const [hx, hy, hz, cx, cy, cz] of spec.colliders)
      physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setDensity(0).setFriction(0.5), this.body);

    this.ctrl = physics.createVehicleController(this.body);
    this.ctrl.indexUpAxis = 1;
    this.ctrl.setIndexForwardAxis = 2;
    const hz = this.spec.wheelbase / 2;
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      this.ctrl.addWheel({ x: (sx * this.spec.track) / 2, y: this.spec.mountY, z: sz * hz }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, this.spec.restLength, this.spec.wheelRadius);
    }
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelSuspensionStiffness(i, this.spec.stiffness);
      this.ctrl.setWheelSuspensionCompression(i, this.spec.compression);
      this.ctrl.setWheelSuspensionRelaxation(i, this.spec.relaxation);
      this.ctrl.setWheelMaxSuspensionTravel(i, this.spec.maxTravel);
      this.ctrl.setWheelMaxSuspensionForce(i, 60000);
      this.ctrl.setWheelFrictionSlip(i, this.spec.frictionSlip);
      this.ctrl.setWheelSideFrictionStiffness(i, 1.0);
    }
    this.syncVisual();
  }

  get driver() {
    return this.seats[0];
  }

  position(out = new THREE.Vector3()) {
    const t = this.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  quaternion(out = new THREE.Quaternion()) {
    const r = this.body.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  /** World position of a seat (for the seated avatar). */
  seatWorld(i: number, out = new THREE.Vector3()) {
    this.cabin.updateWorldMatrix(true, false);
    return this.cabin.localToWorld(out.copy(this.spec.seats[i]));
  }

  /** Orientation of the (leaning) cabin, for seated occupants. */
  cabinQuaternion(out = new THREE.Quaternion()) {
    this.cabin.updateWorldMatrix(true, false);
    return this.cabin.getWorldQuaternion(out);
  }

  /** Start simulating locally (we're the driver). */
  takeControl() {
    if (this.simulating) return;
    this.simulating = true;
    this.settle = 3;
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.buf = [];
  }

  /** Driver left: keep simulating with the handbrake on until it comes to rest. */
  release() {
    this.settle = 3;
  }

  private stopSimulating() {
    this.simulating = false;
    this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  }

  /** Flip back onto its wheels (R). */
  resetUpright() {
    const p = this.position();
    const f = FORWARD.clone().applyQuaternion(this.quaternion());
    const yaw = Math.atan2(f.x, f.z);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x: p.x, y: p.y + 1.5, z: p.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** One fixed physics step of the drivetrain + vehicle controller. Call before world.step(). */
  fixedUpdate(dt: number, input: CarInput | null) {
    if (!this.simulating) return;
    const S = this.state;
    const inp: CarInput = input ?? { throttle: 0, brake: 0, steer: 0, handbrake: true };
    if (!input) {
      this.settle -= dt;
      const lv = this.body.linvel();
      if (this.settle <= 0 && Math.hypot(lv.x, lv.y, lv.z) < 0.08) {
        this.stopSimulating();
        return;
      }
    }

    const rot = this.quaternion(this.tmpQ);
    const fwd = this.tmpV.copy(FORWARD).applyQuaternion(rot);
    const lv = this.body.linvel();
    const v = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    const speed = Math.abs(v);
    S.speed = v;

    // ── gear selection (automatic) ──
    let throttle = inp.throttle;
    let brake = inp.brake;
    if (S.gear > 0 && inp.brake > 0.1 && v < 0.6 && inp.throttle < 0.1) S.gear = -1; // stopped + S → reverse
    else if (S.gear < 0 && inp.throttle > 0.1 && v > -0.6) S.gear = 1;
    if (S.gear < 0) [throttle, brake] = [inp.brake, inp.throttle]; // in reverse, S drives and W brakes

    const transfer = S.low ? this.spec.transferLow : this.spec.transferHigh;
    const ratio = (S.gear < 0 ? this.spec.reverse : this.spec.gears[S.gear - 1]) * this.spec.finalDrive * transfer;
    const wheelRpm = (speed / this.spec.wheelRadius) * (60 / (2 * Math.PI));
    const coupled = wheelRpm * ratio;
    // Torque converter: lets the engine flare toward its stall speed at low road speed.
    const stall = this.spec.idleRpm + throttle * this.spec.stallRpm;
    const rpmTarget = Math.max(coupled, stall * (1 - Math.min(1, coupled / stall) * 0.6), this.spec.idleRpm);
    S.rpm += (Math.min(rpmTarget, this.spec.redline + 200) - S.rpm) * Math.min(1, dt * 10);
    const slip = THREE.MathUtils.clamp(1 - coupled / Math.max(stall, 1), 0, 1);
    const tcMult = 1 + 0.55 * slip; // torque multiplication while the converter slips

    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    else if (S.gear > 0) {
      const up = throttle > 0.6 ? this.spec.upshift[0] : this.spec.upshift[1];
      if (S.gear < this.spec.gears.length && coupled > up) {
        S.gear++;
        this.shiftTimer = 0.32;
      } else if (S.gear > 1 && coupled < (throttle > 0.6 ? this.spec.downshift[0] : this.spec.downshift[1])) {
        S.gear--;
        this.shiftTimer = 0.25;
      }
    }

    // ── drive force: all four wheels ──
    let engineForce = 0;
    if (throttle > 0 && this.shiftTimer <= 0 && S.rpm < this.spec.redline) {
      const torque = torqueAt(this.spec.torque, S.rpm) * throttle * tcMult;
      engineForce = (torque * ratio * this.spec.efficiency * this.spec.drivelineScale) / this.spec.wheelRadius;
    }
    if (S.gear < 0) engineForce = speed > this.spec.reverseLimit ? 0 : -engineForce; // reverse is limited to ~25 km/h

    // ESP: if the car yaws much faster than the steering asks for, it's sliding → cut power.
    const av = this.body.angvel();
    const upW = new THREE.Vector3(0, 1, 0).applyQuaternion(rot);
    const yawRate = av.x * upW.x + av.y * upW.y + av.z * upW.z;
    const expected = (v * Math.tan(this.steer)) / this.spec.wheelbase;
    const lat = lv.x * Math.cos(Math.atan2(fwd.x, fwd.z)) - lv.z * Math.sin(Math.atan2(fwd.x, fwd.z));
    const slipAngle = Math.atan2(Math.abs(lat), Math.max(1, speed));
    const sliding = speed > 4 && (Math.abs(yawRate) > Math.abs(expected) * 1.25 + 0.25 || slipAngle > 0.14);
    this.esp = sliding && this.spec.esp;
    if (this.esp) engineForce *= 0.25;

    // Traction control: never ask a wheel for more drive than its tyre can transmit.
    for (let i = 0; i < 4; i++) {
      const load = this.ctrl.wheelSuspensionForce(i) ?? (this.spec.mass * 9.81) / 4;
      const grip = 0.8 * this.spec.tcs * this.spec.frictionSlip * Math.max(0, load);
      this.ctrl.setWheelEngineForce(i, THREE.MathUtils.clamp(engineForce / 4, -grip, grip));
    }

    // ── brakes ──
    const engineBrake = throttle < 0.05 ? 0.6 : 0;
    for (let i = 0; i < 4; i++) {
      let b = brake * this.spec.brakeForce + engineBrake;
      if (inp.handbrake && i >= 2) b = this.spec.brakeForce * 1.4;
      this.ctrl.setWheelBrake(i, b);
      // Handbrake: rear tyres lose lateral grip (lets the tail step out).
      // Fronts saturate first → safe, progressive understeer (like the real car).
      this.ctrl.setWheelSideFrictionStiffness(i, inp.handbrake && i >= 2 && speed > 3 ? 0.42 : i < 2 ? this.spec.sideFront : this.spec.sideRear);
    }
    S.braking = brake > 0.05 || (inp.handbrake && speed > 0.5);
    S.throttle = throttle;

    // ── steering: speed-sensitive, rate-limited (keyboard) ──
    const maxSteer = this.spec.maxSteer / (1 + speed / this.spec.steerFalloff);
    const target = inp.steer * maxSteer;
    const rate = (Math.abs(target) < Math.abs(this.steer) ? 4.5 : 2.6) * this.spec.maxSteer;
    this.steer += THREE.MathUtils.clamp(target - this.steer, -rate * dt, rate * dt);
    S.steer = this.steer;
    this.ctrl.setWheelSteering(0, this.steer);
    this.ctrl.setWheelSteering(1, this.steer);

    // ── resistive forces ──
    this.body.resetForces(true);
    this.body.resetTorques(true); // (resetForces leaves torques accumulating)
    const drag = this.spec.dragCoef * v * Math.abs(v) + Math.sign(v) * this.spec.rollCoef * this.spec.mass * 9.81 * Math.min(1, speed);
    this.body.addForce({ x: -fwd.x * drag, y: -fwd.y * drag, z: -fwd.z * drag }, true);

    this.ctrl.updateVehicle(dt);

    // ── roll damping (stands in for anti-roll bars: explicit anti-roll forces go unstable
    //    with Rapier's ray-cast vehicle at 60 Hz, so damp the roll rate instead) ──
    const contacts = [0, 1, 2, 3].filter((i) => this.ctrl.wheelIsInContact(i)).length;
    if (contacts >= 2) {
      const av = this.body.angvel();
      const rollRate = av.x * fwd.x + av.y * fwd.y + av.z * fwd.z;
      const tq = -this.spec.rollDamping * rollRate;
      this.body.addTorque({ x: fwd.x * tq, y: fwd.y * tq, z: fwd.z * tq }, true);
    }

    for (let i = 0; i < 4; i++) this.wheelSpin[i] = this.ctrl.wheelRotation(i) ?? 0;
  }

  /** Network: a pose from the remote driver (or the parked-pose heartbeat). */
  pushRemote(seq: number, p: THREE.Vector3, q: THREE.Quaternion, st: CarState, now: number) {
    if (this.simulating) return;
    if (this.lastSeq >= 0 && ((seq - this.lastSeq) | 0) <= 0) return;
    this.lastSeq = seq;
    this.buf.push({ t: now, p: p.clone(), q: q.clone() });
    if (this.buf.length > 20) this.buf.shift();
    this.state = { ...st };
  }

  resetRemoteSeq() {
    this.lastSeq = -1;
  }

  /** Per frame: interpolate remote cars, place wheels/steering, lights. */
  update(now: number, dt: number) {
    if (!this.simulating && this.buf.length) {
      const rt = now - 110;
      let i = this.buf.length - 1;
      while (i > 0 && this.buf[i].t > rt) i--;
      const a = this.buf[i];
      const b = this.buf[Math.min(i + 1, this.buf.length - 1)];
      const k = b.t > a.t ? THREE.MathUtils.clamp((rt - a.t) / (b.t - a.t), 0, 1) : 0;
      if (i > 0) this.buf.splice(0, i);
      const p = this.tmpV.copy(a.p).lerp(b.p, k);
      const q = this.tmpQ.copy(a.q).slerp(b.q, k);
      this.body.setNextKinematicTranslation(p);
      this.body.setNextKinematicRotation(q);
      // Wheels roll at the reported speed.
      for (let w = 0; w < 4; w++) this.wheelSpin[w] += (this.state.speed / this.spec.wheelRadius) * dt;
    }
    this.syncVisual();
    this.updateLean(dt);
  }

  /**
   * Sprung-body lean: a damped spring (≈1.6 Hz, ζ≈0.35) driven by the car-frame
   * acceleration — leans out of corners, dives under braking, squats under power, and
   * wobbles a little after quick direction changes.
   */
  private updateLean(dt: number) {
    if (dt <= 0) return;
    const L = this.lean;
    const pos = this.visual.root.position;
    if (!L.init) {
      L.prev.copy(pos);
      L.init = true;
      return;
    }
    const vel = pos.clone().sub(L.prev).divideScalar(dt);
    L.prev.copy(pos);
    const inv = this.visual.root.quaternion.clone().invert();
    const local = vel.applyQuaternion(inv);
    const prevLocal = L.acc; // (stores the previous local velocity)
    const ax = THREE.MathUtils.clamp((local.x - prevLocal.x) / dt, -15, 15);
    const az = THREE.MathUtils.clamp((local.z - prevLocal.z) / dt, -15, 15);
    prevLocal.copy(local);
    const k = 100;
    const c = 7;
    const rollT = THREE.MathUtils.clamp(ax * this.spec.bodyRoll, -0.14, 0.14);
    const pitchT = THREE.MathUtils.clamp(-az * this.spec.bodyPitch, -0.07, 0.07);
    const h = Math.min(dt, 1 / 30);
    L.rollV += (k * (rollT - L.roll) - c * L.rollV) * h;
    L.roll += L.rollV * h;
    L.pitchV += (k * (pitchT - L.pitch) - c * L.pitchV) * h;
    L.pitch += L.pitchV * h;
    this.cabin.rotation.set(L.pitch, 0, L.roll, 'YXZ');
    this.cabin.position.y = -Math.abs(L.pitch) * 0.6;
  }

  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  private syncVisual() {
    const v = this.visual;
    const t = this.body.translation();
    const r = this.body.rotation();
    v.root.position.set(t.x, t.y, t.z);
    v.root.quaternion.set(r.x, r.y, r.z, r.w);
    const rot = v.root.quaternion;
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(rot);
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      let len = this.simulating ? this.ctrl.wheelSuspensionLength(i) : null;
      if (len === null) {
        // Not simulated here: find the ground under each wheel for the suspension pose.
        const mount = new THREE.Vector3(w.steer.position.x, this.spec.mountY, w.steer.position.z).applyQuaternion(rot).add(v.root.position);
        this.ray.origin = mount;
        this.ray.dir = down;
        const hit = this.physics.castRay(this.ray, this.spec.restLength + this.spec.wheelRadius + 0.05, true, undefined, undefined, undefined, this.body);
        len = hit ? Math.min(this.spec.restLength, hit.timeOfImpact - this.spec.wheelRadius) : this.spec.restLength;
      }
      w.steer.position.y = this.spec.mountY - len;
      w.steer.rotation.y = i < 2 ? this.state.steer : 0;
      w.spin.rotation.x = this.wheelSpin[i];
    }
    v.steeringWheel.rotation.z = -this.state.steer * 9;
    v.brakeMat.emissiveIntensity = this.state.braking ? 2.2 : 0.15;
    v.reverseMat.emissiveIntensity = this.state.gear < 0 ? 1.5 : 0;
  }

  /** km/h, gear label, range — for the HUD. */
  hud() {
    const s = this.state;
    return { kmh: Math.round(Math.abs(s.speed) * 3.6), gear: s.gear < 0 ? 'R' : `D${s.gear}`, range: s.low ? '4L' : '4H', rpm: Math.round(s.rpm) };
  }
}
