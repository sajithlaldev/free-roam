import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { textures } from './world/textures';

/**
 * Suzuki Jimny-style 4x4 (JB74 proportions) on Rapier's ray-cast vehicle controller.
 *
 * Physics: 1,090 kg chassis with a realistic inertia tensor and low-ish centre of mass;
 * soft long-travel suspension; anti-roll bars; K15B-style torque curve through a
 * torque converter + 4-speed automatic + two-speed transfer case (4H / 4L) to all four
 * wheels; speed-sensitive steering; brakes, handbrake, rolling resistance and drag.
 */

// ── specs ────────────────────────────────────────────────────────────────────

export const JIMNY = {
  mass: 1090,
  wheelbase: 2.25,
  track: 1.4,
  wheelRadius: 0.345,
  wheelWidth: 0.2,
  /** Suspension mount height above the wheel centre at rest (chassis frame). */
  mountY: 0.22,
  restLength: 0.36,
  maxTravel: 0.3,
  stiffness: 21, // Rapier scales by chassis mass: k·x·m per wheel → ~1.45 Hz ride
  compression: 1.9,
  relaxation: 2.7,
  frictionSlip: 1.05, // ≈ tyre μ (all-terrain road tyres)
  rollDamping: 1400, // N·m·s, damps body-roll oscillation
  maxSteer: THREE.MathUtils.degToRad(33),
  idleRpm: 800,
  redline: 6200,
  gears: [2.875, 1.568, 1.0, 0.697],
  reverse: 2.3,
  finalDrive: 4.3,
  transferHigh: 1.32,
  transferLow: 2.643,
  efficiency: 0.86,
  /** Calibrates Rapier's wheel-force model to the real car (0–100 ≈ 13 s, ~140 km/h). */
  drivelineScale: 1.3,
  brakeForce: 44, // Rapier wheel brake units, per wheel (100→0 in ≈ 42 m)
  dragCoef: 0.5 * 1.2 * 0.5 * 2.3, // ½·ρ·Cd·A
  rollCoef: 0.016,
  seats: [
    new THREE.Vector3(-0.37, 0.16, -0.05), // driver (right-hand drive)
    new THREE.Vector3(0.37, 0.16, -0.05),
    new THREE.Vector3(-0.35, 0.2, -0.95),
    new THREE.Vector3(0.35, 0.2, -0.95),
  ],
};

/** K15B-ish torque curve (Nm vs rpm). */
const TORQUE: [number, number][] = [
  [800, 88], [1500, 104], [2500, 118], [3500, 127], [4000, 130], [5000, 126], [6000, 116], [6500, 95],
];
function torqueAt(rpm: number) {
  if (rpm <= TORQUE[0][0]) return TORQUE[0][1];
  for (let i = 0; i < TORQUE.length - 1; i++) {
    const [r0, t0] = TORQUE[i];
    const [r1, t1] = TORQUE[i + 1];
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

function wheelMesh(): THREE.Group {
  const R = JIMNY.wheelRadius;
  const W = JIMNY.wheelWidth;
  // Tyre: rounded-section lathe, axis along X.
  const prof: THREE.Vector2[] = [];
  const rr = 0.05;
  const inner = 0.2;
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
  const rimMat = mat({ color: 0x9aa0a6, metalness: 0.85, roughness: 0.3 });
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, W * 0.7, 20).rotateZ(Math.PI / 2), mat({ color: 0x2a2c30, metalness: 0.6, roughness: 0.4 }));
  const g = new THREE.Group();
  g.add(tyre, rim);
  for (let k = 0; k < 5; k++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.17, 0.05), rimMat);
    spoke.position.y = 0.09;
    const arm = new THREE.Group();
    arm.rotation.x = (k / 5) * Math.PI * 2;
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

interface Visual {
  root: THREE.Group;
  wheels: { steer: THREE.Group; spin: THREE.Group; side: number }[];
  steeringWheel: THREE.Object3D;
  brakeMat: THREE.MeshStandardMaterial;
  reverseMat: THREE.MeshStandardMaterial;
}

function buildJimny(color: number, plate: string): Visual {
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

// ── the car ──────────────────────────────────────────────────────────────────

const FORWARD = new THREE.Vector3(0, 0, 1);

export class Car {
  readonly visual: Visual;
  readonly body: RAPIER.RigidBody;
  readonly ctrl: RAPIER.DynamicRayCastVehicleController;
  /** Occupant identity per seat (seat 0 drives). */
  readonly seats: (string | null)[] = [null, null, null, null];
  state: CarState = { rpm: JIMNY.idleRpm, gear: 1, speed: 0, steer: 0, throttle: 0, braking: false, low: false };
  /** true while this client simulates it (we're driving, or it's still settling after we got out). */
  simulating = false;
  /** Identity of whoever drove it last (they keep re-broadcasting its parked pose). */
  lastDriver: string | null = null;
  private steer = 0;
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
  ) {
    this.visual = buildJimny(color, `KL-07 J ${(2187 + id * 1311) % 9000 + 1000}`);
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
        .setAdditionalMassProperties(JIMNY.mass, { x: 0, y: 0.12, z: 0.05 }, { x: 1320, y: 1360, z: 460 }, { x: 0, y: 0, z: 0, w: 1 }),
    );
    // Shell colliders (mass comes from the explicit properties above).
    physics.createCollider(RAPIER.ColliderDesc.cuboid(0.8, 0.33, 1.68).setTranslation(0, 0.22, 0).setDensity(0).setFriction(0.5), this.body);
    physics.createCollider(RAPIER.ColliderDesc.cuboid(0.74, 0.4, 1.05).setTranslation(0, 0.95, -0.55).setDensity(0).setFriction(0.5), this.body);
    physics.createCollider(RAPIER.ColliderDesc.cuboid(0.74, 0.08, 0.6).setTranslation(0, 0.6, 1.1).setDensity(0).setFriction(0.5), this.body);

    this.ctrl = physics.createVehicleController(this.body);
    this.ctrl.indexUpAxis = 1;
    this.ctrl.setIndexForwardAxis = 2;
    const hz = JIMNY.wheelbase / 2;
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      this.ctrl.addWheel({ x: (sx * JIMNY.track) / 2, y: JIMNY.mountY, z: sz * hz }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, JIMNY.restLength, JIMNY.wheelRadius);
    }
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelSuspensionStiffness(i, JIMNY.stiffness);
      this.ctrl.setWheelSuspensionCompression(i, JIMNY.compression);
      this.ctrl.setWheelSuspensionRelaxation(i, JIMNY.relaxation);
      this.ctrl.setWheelMaxSuspensionTravel(i, JIMNY.maxTravel);
      this.ctrl.setWheelMaxSuspensionForce(i, 60000);
      this.ctrl.setWheelFrictionSlip(i, JIMNY.frictionSlip);
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
    return out.copy(JIMNY.seats[i]).applyQuaternion(this.quaternion(this.tmpQ)).add(this.position(this.tmpV));
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

    const transfer = S.low ? JIMNY.transferLow : JIMNY.transferHigh;
    const ratio = (S.gear < 0 ? JIMNY.reverse : JIMNY.gears[S.gear - 1]) * JIMNY.finalDrive * transfer;
    const wheelRpm = (speed / JIMNY.wheelRadius) * (60 / (2 * Math.PI));
    const coupled = wheelRpm * ratio;
    // Torque converter: lets the engine flare toward its stall speed at low road speed.
    const stall = JIMNY.idleRpm + throttle * 1700;
    const rpmTarget = Math.max(coupled, stall * (1 - Math.min(1, coupled / stall) * 0.6), JIMNY.idleRpm);
    S.rpm += (Math.min(rpmTarget, JIMNY.redline + 200) - S.rpm) * Math.min(1, dt * 10);
    const slip = THREE.MathUtils.clamp(1 - coupled / Math.max(stall, 1), 0, 1);
    const tcMult = 1 + 0.55 * slip; // torque multiplication while the converter slips

    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    else if (S.gear > 0) {
      const up = throttle > 0.6 ? 5600 : 3400;
      if (S.gear < 4 && coupled > up) {
        S.gear++;
        this.shiftTimer = 0.32;
      } else if (S.gear > 1 && coupled < (throttle > 0.6 ? 2300 : 1300)) {
        S.gear--;
        this.shiftTimer = 0.25;
      }
    }

    // ── drive force: all four wheels ──
    let engineForce = 0;
    if (throttle > 0 && this.shiftTimer <= 0 && S.rpm < JIMNY.redline) {
      const torque = torqueAt(S.rpm) * throttle * tcMult;
      engineForce = (torque * ratio * JIMNY.efficiency * JIMNY.drivelineScale) / JIMNY.wheelRadius;
    }
    if (S.gear < 0) engineForce = speed > 7 ? 0 : -engineForce; // reverse is limited to ~25 km/h

    // ESP: if the car yaws much faster than the steering asks for, it's sliding → cut power.
    const av = this.body.angvel();
    const upW = new THREE.Vector3(0, 1, 0).applyQuaternion(rot);
    const yawRate = av.x * upW.x + av.y * upW.y + av.z * upW.z;
    const expected = (v * Math.tan(this.steer)) / JIMNY.wheelbase;
    const lat = lv.x * Math.cos(Math.atan2(fwd.x, fwd.z)) - lv.z * Math.sin(Math.atan2(fwd.x, fwd.z));
    const slipAngle = Math.atan2(Math.abs(lat), Math.max(1, speed));
    const sliding = speed > 4 && (Math.abs(yawRate) > Math.abs(expected) * 1.25 + 0.25 || slipAngle > 0.14);
    this.esp = sliding;
    if (sliding) engineForce *= 0.25;

    // Traction control: never ask a wheel for more drive than its tyre can transmit.
    for (let i = 0; i < 4; i++) {
      const load = this.ctrl.wheelSuspensionForce(i) ?? (JIMNY.mass * 9.81) / 4;
      const grip = 0.8 * JIMNY.frictionSlip * Math.max(0, load);
      this.ctrl.setWheelEngineForce(i, THREE.MathUtils.clamp(engineForce / 4, -grip, grip));
    }

    // ── brakes ──
    const engineBrake = throttle < 0.05 ? 0.6 : 0;
    for (let i = 0; i < 4; i++) {
      let b = brake * JIMNY.brakeForce + engineBrake;
      if (inp.handbrake && i >= 2) b = JIMNY.brakeForce * 1.4;
      this.ctrl.setWheelBrake(i, b);
      // Handbrake: rear tyres lose lateral grip (lets the tail step out).
      // Fronts saturate first → safe, progressive understeer (like the real car).
      this.ctrl.setWheelSideFrictionStiffness(i, inp.handbrake && i >= 2 && speed > 3 ? 0.45 : i < 2 ? 0.82 : 1.0);
    }
    S.braking = brake > 0.05 || (inp.handbrake && speed > 0.5);
    S.throttle = throttle;

    // ── steering: speed-sensitive, rate-limited (keyboard) ──
    const maxSteer = JIMNY.maxSteer / (1 + speed / 9);
    const target = inp.steer * maxSteer;
    const rate = (Math.abs(target) < Math.abs(this.steer) ? 4.5 : 2.6) * JIMNY.maxSteer;
    this.steer += THREE.MathUtils.clamp(target - this.steer, -rate * dt, rate * dt);
    S.steer = this.steer;
    this.ctrl.setWheelSteering(0, this.steer);
    this.ctrl.setWheelSteering(1, this.steer);

    // ── resistive forces ──
    this.body.resetForces(true);
    this.body.resetTorques(true); // (resetForces leaves torques accumulating)
    const drag = JIMNY.dragCoef * v * Math.abs(v) + Math.sign(v) * JIMNY.rollCoef * JIMNY.mass * 9.81 * Math.min(1, speed);
    this.body.addForce({ x: -fwd.x * drag, y: -fwd.y * drag, z: -fwd.z * drag }, true);

    this.ctrl.updateVehicle(dt);

    // ── roll damping (stands in for anti-roll bars: explicit anti-roll forces go unstable
    //    with Rapier's ray-cast vehicle at 60 Hz, so damp the roll rate instead) ──
    const contacts = [0, 1, 2, 3].filter((i) => this.ctrl.wheelIsInContact(i)).length;
    if (contacts >= 2) {
      const av = this.body.angvel();
      const rollRate = av.x * fwd.x + av.y * fwd.y + av.z * fwd.z;
      const tq = -JIMNY.rollDamping * rollRate;
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
      for (let w = 0; w < 4; w++) this.wheelSpin[w] += (this.state.speed / JIMNY.wheelRadius) * dt;
    }
    this.syncVisual();
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
        const mount = new THREE.Vector3(w.steer.position.x, JIMNY.mountY, w.steer.position.z).applyQuaternion(rot).add(v.root.position);
        this.ray.origin = mount;
        this.ray.dir = down;
        const hit = this.physics.castRay(this.ray, JIMNY.restLength + JIMNY.wheelRadius + 0.05, true, undefined, undefined, undefined, this.body);
        len = hit ? Math.min(JIMNY.restLength, hit.timeOfImpact - JIMNY.wheelRadius) : JIMNY.restLength;
      }
      w.steer.position.y = JIMNY.mountY - len;
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
