import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildVisual, type Visual } from './vehicles/index';

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
  horn?: boolean;
}

// ── visuals ──────────────────────────────────────────────────────────────────

export type { Visual } from './vehicles/index';

export function buildJimny(color: number, plate: string): Visual {
  return buildVisual('jimny', color, plate);
}

export function buildFortuner(color: number, plate: string): Visual {
  return buildVisual('fortuner', color, plate);
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
  /** 0..1 tyre slip (sideways slide or wheelspin), for skid sounds. */
  slip = 0;
  /** Strength of the latest suspension hit (consumed by the audio). */
  bumpHit = 0;
  private prevSusp = [0, 0, 0, 0];
  private prevYaw = 0;
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
    const steerGroups = new Set<THREE.Object3D>([...this.visual.wheels.map((w) => w.steer), ...this.visual.unsprung]);
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
  /** Put the car down at (x, y, z) facing `yaw`, at rest (race respawns). */
  teleport(x: number, y: number, z: number, yaw: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.state.speed = 0;
  }

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

    // Audio cues: sideways slide / handbrake / wheelspin, and sharp suspension hits.
    const spin = engineForce / 4 > 0.8 * this.spec.tcs * this.spec.frictionSlip * ((this.spec.mass * 9.81) / 4) ? 0.6 : 0;
    this.slip = Math.max(slipAngle * 3.2, inp.handbrake && speed > 3 ? 0.75 : 0, spin * (speed < 8 ? 1 : 0), brake > 0.9 && speed > 6 ? 0.45 : 0);
    for (let i = 0; i < 4; i++) {
      const L = this.ctrl.wheelSuspensionLength(i) ?? this.spec.restLength;
      const d = Math.abs(L - this.prevSusp[i]);
      if (d > 0.03) this.bumpHit = Math.max(this.bumpHit, d * 14);
      this.prevSusp[i] = L;
    }
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
      // Estimated slip from how hard it's turning (for skid sounds on other players' cars).
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const yaw = Math.atan2(f.x, f.z);
      const yr = Math.atan2(Math.sin(yaw - this.prevYaw), Math.cos(yaw - this.prevYaw)) / Math.max(dt, 1e-3);
      this.prevYaw = yaw;
      this.slip = THREE.MathUtils.clamp((Math.abs(yr * this.state.speed) / 9.81 - 0.65) * 2, 0, 1);
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
    v.updateRunningGear();
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
