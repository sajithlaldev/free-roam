import * as THREE from 'three';

/**
 * Procedural full-body animation for humanoid rigs without (enough) clips: Mixamo / Ready
 * Player Me / Sketchfab bone names. Everything is solved in the character frame
 * (avatar group: feet at the origin, +Y up, +Z forward):
 *
 * - Legs use analytic two-bone IK with planted feet: each foot stays put during stance
 *   and swings forward with lift, heel-off and toe-off; stride length, cadence and the
 *   stance/swing duty factor all change with speed (walk → run → sprint). Feet follow
 *   the ground slope via `ground()`.
 * - Pelvis bob, lateral sway and twist; shoulders counter-rotate; arms swing opposite to
 *   the legs and bend into a pumping run; lean into acceleration, bank into turns, the
 *   head stays level and looks into the turn; turning on the spot makes the feet step.
 * - Jump (take-off, tuck, land with impact absorption), crouch, kneel → lie prone
 *   (and crawl), swim (breaststroke / treading water), sit (chair, car seat, driving).
 */

const NAMES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
] as const;
type Name = (typeof NAMES)[number];

const matcher = (n: string) => new RegExp(`^(?:mixamorig:?)?${n}(?:_\\d+)?$`);

export function findHumanoidBone(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  const re = matcher(name);
  let hit: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!hit && re.test(o.name)) hit = o;
  });
  return hit;
}

export type Stance = 0 | 1 | 2; // stand, crouch, prone
export type SitMode = 0 | 1 | 2 | 3; // none, chair, driving, car passenger

export interface AnimInput {
  speed: number; // horizontal m/s
  vy: number;
  grounded: boolean;
  stance: Stance;
  sit: SitMode;
  swim: boolean;
  sprint: boolean;
  yawRate: number; // rad/s
  steer?: number; // car steering (radians) when driving
  /** World ground height, for foot placement on slopes. */
  ground?: (x: number, z: number) => number;
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const approach = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Side {
  sx: number; // +1 left (+X), −1 right
  up: Name; leg: Name; foot: Name; toe: Name;
  arm: Name; fore: Name; hand: Name;
  hip: THREE.Vector3; // rest positions (character frame)
  L1: number; L2: number; ankleH: number; footDir: THREE.Vector3;
  toeVec: THREE.Vector3; // ankle → toe joint at rest
  A1: number; A2: number;
  planted: THREE.Vector3; // current foot target (for smoothing)
}

export class ProceduralRig {
  private b: Partial<Record<Name, THREE.Object3D>> = {};
  private rest = new Map<THREE.Object3D, THREE.Quaternion>();
  private sides: Side[] = [];
  private pelvisY = 0.95;
  // state
  private phase = 0;
  private t = Math.random() * 10;
  private speed = 0;
  private prevSpeed = 0;
  private accel = 0;
  private yawRate = 0;
  private w = { crouch: 0, prone: 0, sit: 0, car: 0, drive: 0, swim: 0, swimMove: 0, air: 0, move: 0, run: 0, sprint: 0, turn: 0 };
  private impact = 0;
  private wasGrounded = true;
  private lastVy = 0;
  // scratch
  private qChar = new THREE.Quaternion();
  private qP = new THREE.Quaternion();
  private qD = new THREE.Quaternion();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private wp = new THREE.Vector3();

  /**
   * @param model  the normalised model root (faces +Z)
   * @param pose   group between the avatar body and the model (pelvis offset / pitch / bank)
   * @param char   the avatar group (character frame)
   */
  static create(model: THREE.Object3D, pose: THREE.Object3D, char: THREE.Object3D): ProceduralRig | null {
    const req: Name[] = ['Hips', 'Spine', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
    const rig = new ProceduralRig(model, pose, char);
    return req.every((n) => rig.b[n]) ? rig : null;
  }

  private constructor(
    model: THREE.Object3D,
    private pose: THREE.Object3D,
    private char: THREE.Object3D,
  ) {
    for (const n of NAMES) {
      const bone = findHumanoidBone(model, n);
      if (bone) {
        this.b[n] = bone;
        this.rest.set(bone, bone.quaternion.clone());
      }
    }
    char.updateWorldMatrix(true, true);
    const P = (n: Name) => (this.b[n] ? this.local(this.b[n]!) : v3(0, 0, 0));
    for (const sx of [1, -1]) {
      const L = sx > 0 ? 'Left' : 'Right';
      const s = {
        sx,
        up: `${L}UpLeg`, leg: `${L}Leg`, foot: `${L}Foot`, toe: `${L}ToeBase`,
        arm: `${L}Arm`, fore: `${L}ForeArm`, hand: `${L}Hand`,
      } as Side;
      s.hip = P(s.up);
      const knee = P(s.leg);
      const ankle = P(s.foot);
      s.L1 = s.hip.distanceTo(knee);
      s.L2 = knee.distanceTo(ankle);
      s.ankleH = ankle.y;
      s.toeVec = this.b[s.toe] ? P(s.toe).sub(ankle) : v3(0, -0.035, 0.1);
      s.footDir = s.toeVec.clone().normalize();
      s.A1 = P(s.arm).distanceTo(P(s.fore));
      s.A2 = P(s.fore).distanceTo(P(s.hand));
      s.planted = v3(s.hip.x * 0.85, s.ankleH, 0);
      this.sides.push(s);
    }
    this.pelvisY = (this.sides[0].hip.y + this.sides[1].hip.y) / 2;
  }

  private local(o: THREE.Object3D, out = new THREE.Vector3()) {
    return this.char.worldToLocal(o.getWorldPosition(out));
  }

  /** Unit direction bone → tip in the character frame (world matrices current). */
  private dir(bone: THREE.Object3D, tip: THREE.Object3D): THREE.Vector3 {
    const a = bone.getWorldPosition(this.v1);
    return tip.getWorldPosition(this.v2).sub(a).applyQuaternion(this.qChar).normalize();
  }

  /** Rotate `bone` by D (character frame) on top of its rest pose: local' = P⁻¹·D·P·rest. */
  private rot(bone: THREE.Object3D | undefined, D: THREE.Quaternion) {
    if (!bone?.parent) return;
    bone.parent.updateWorldMatrix(true, false);
    const P = bone.parent.getWorldQuaternion(this.qP).premultiply(this.qChar);
    bone.quaternion.copy(P).invert().multiply(D).multiply(P).multiply(this.rest.get(bone)!);
  }

  /** Point bone→tip along `target` (unit, character frame). */
  private aim(bone: THREE.Object3D | undefined, tip: THREE.Object3D | undefined, target: THREE.Vector3) {
    if (!bone || !tip) return;
    bone.quaternion.copy(this.rest.get(bone)!);
    tip.updateWorldMatrix(true, false);
    this.rot(bone, this.qD.setFromUnitVectors(this.dir(bone, tip), target));
  }

  private axisAngle(axis: THREE.Vector3, a: number) {
    return this.qD.setFromAxisAngle(axis, a);
  }

  /** Two-bone IK: thigh & shin directions so the ankle reaches F (knee bends towards `pole`). */
  private ik(H: THREE.Vector3, F: THREE.Vector3, L1: number, L2: number, pole: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
    const toF = F.clone().sub(H);
    const d = THREE.MathUtils.clamp(toF.length(), Math.abs(L1 - L2) + 0.02, (L1 + L2) * 0.999);
    const u = toF.normalize();
    const cosA = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    let axis = u.clone().cross(pole);
    if (axis.lengthSq() < 1e-6) axis = X.clone().negate();
    axis.normalize();
    const thigh = u.clone().applyAxisAngle(axis, Math.acos(cosA));
    const knee = H.clone().addScaledVector(thigh, L1);
    const shin = H.clone().addScaledVector(u, d).sub(knee).normalize();
    return [thigh, shin];
  }

  update(dt: number, inp: AnimInput) {
    if (dt <= 0) return;
    const w = this.w;
    this.t += dt;
    this.speed = approach(this.speed, inp.speed, 10, dt);
    this.accel = approach(this.accel, THREE.MathUtils.clamp((this.speed - this.prevSpeed) / dt, -8, 8), 6, dt);
    this.prevSpeed = this.speed;
    this.yawRate = approach(this.yawRate, inp.yawRate, 8, dt);
    const s = this.speed;

    // ── mode weights ──
    const sitting = inp.sit > 0;
    w.sit = approach(w.sit, sitting ? 1 : 0, 7, dt);
    w.car = approach(w.car, inp.sit >= 2 ? 1 : 0, 10, dt);
    w.drive = approach(w.drive, inp.sit === 2 ? 1 : 0, 10, dt);
    w.swim = approach(w.swim, inp.swim && !sitting ? 1 : 0, 4, dt);
    w.swimMove = approach(w.swimMove, inp.swim && s > 0.3 ? 1 : 0, 3, dt);
    w.crouch = approach(w.crouch, inp.stance === 1 && !sitting && !inp.swim ? 1 : 0, 9, dt);
    w.prone = approach(w.prone, inp.stance === 2 && !sitting && !inp.swim ? 1 : 0, 2.2, dt);
    const airTarget = !inp.grounded && !inp.swim && !sitting ? 1 : 0;
    w.air = approach(w.air, airTarget, airTarget ? 12 : 18, dt);
    w.move = approach(w.move, THREE.MathUtils.clamp(s / 0.6, 0, 1), 8, dt);
    w.run = approach(w.run, sstep(2.4, 4.6, s), 6, dt);
    w.sprint = approach(w.sprint, inp.sprint && s > 4.5 ? 1 : 0, 4, dt);
    const turningInPlace = s < 0.4 && Math.abs(this.yawRate) > 1.1 && inp.grounded && !sitting;
    w.turn = approach(w.turn, turningInPlace ? 1 : 0, 8, dt);

    // Landing impact (absorbed by the knees), proportional to the fall speed.
    if (inp.grounded && !this.wasGrounded && this.lastVy < -2.2) this.impact = Math.min(1, -this.lastVy / 9);
    this.impact = approach(this.impact, 0, 7, dt);
    this.wasGrounded = inp.grounded;
    this.lastVy = inp.vy;

    // Prone: kneel first, then lower the body forward.
    const pitchW = sstep(0.35, 1, w.prone);
    const kneelW = sstep(0, 0.45, w.prone) * (1 - pitchW);
    const standW = (1 - w.sit) * (1 - w.swim) * (1 - pitchW) * (1 - kneelW);

    // ── gait: cadence and stride from speed, scaled to this rig's leg length ──
    const Lleg = this.sides[0].L1 + this.sides[0].L2;
    const legScale = Lleg / 0.85;
    const moveW = Math.max(w.move, w.turn);
    const fWalk = (1.72 + (0.3 * s) / legScale) / 2; // cycles/s (two steps per cycle)
    const fRun = (2.5 + (0.14 * s) / legScale) / 2;
    let freq = THREE.MathUtils.lerp(fWalk, fRun, w.run) * (1 + 0.2 * w.crouch);
    if (turningInPlace) freq = 1.3;
    if (pitchW > 0.5) freq = 0.7 + 0.8 * s; // crawl
    this.phase = (this.phase + Math.min(1.9, freq) * dt) % 1;
    const stride = turningInPlace ? 0 : s / Math.max(0.5, freq); // metres per cycle
    // Stance (duty) fraction: ~0.6 walking, ~0.34 running; capped so the contact length stays
    // within what the leg can reach (sprinting is short ground contacts).
    let beta = THREE.MathUtils.lerp(0.58, 0.34, w.run);
    if (stride > 0.01) beta = Math.max(0.2, Math.min(beta, (1.1 * Lleg) / stride));
    const half = ((beta * stride) / 2) * moveW;
    const lift = (Math.min(0.32, 0.06 + 0.04 * s) * (1 - 0.45 * w.crouch) + 0.05 * w.turn) * moveW;
    const heelMax = THREE.MathUtils.lerp(0.9, 1.15, w.run) * moveW; // heel lift at toe-off (rad)
    const shift = 0.3 * half; // the foot lands just ahead and leaves well behind
    this.char.updateWorldMatrix(true, false);
    const here = this.char.getWorldPosition(new THREE.Vector3());
    const groundHere = inp.ground ? inp.ground(here.x, here.z) : 0;

    // Foot targets (character frame). The stance foot's toe joint is planted on the ground and
    // slides back under the body as it moves forward; late in stance the heel lifts, rotating the
    // foot about the toe, which raises and advances the ankle (heel-to-toe roll-off).
    const targets = this.sides.map((sd) => {
      const p = (this.phase + (sd.sx > 0 ? 0 : 0.5)) % 1;
      const tv = sd.toeVec;
      const x = sd.hip.x * THREE.MathUtils.lerp(0.95, 0.8, moveW);
      const ankleFor = (toeZ: number, heel: number) => {
        const d = tv.clone().applyAxisAngle(X, heel);
        return v3(x, sd.ankleH + tv.y - d.y, toeZ - d.z);
      };
      let A: THREE.Vector3;
      let pitch: number;
      let stanceU = -1;
      if (p < beta) {
        const u = p / beta;
        const heel = heelMax * sstep(0.45, 1, u);
        A = ankleFor(tv.z + half * (1 - 2 * u) - shift, heel);
        pitch = heel - 0.22 * (1 - sstep(0, 0.2, u)) * (1 - w.run) * moveW; // heel strike: toes up
        stanceU = u;
      } else {
        const q = (p - beta) / (1 - beta);
        const from = ankleFor(tv.z - half - shift, heelMax);
        const to = ankleFor(tv.z + half - shift, 0);
        const k = smoother(q);
        A = v3(x, THREE.MathUtils.lerp(from.y, to.y, q) + lift * Math.pow(Math.sin(Math.PI * q), 0.85), THREE.MathUtils.lerp(from.z, to.z, k));
        pitch = THREE.MathUtils.lerp(heelMax, -0.25 * moveW * (1 - 0.5 * w.run), k); // toes down after push-off → up before landing
      }
      if (inp.ground && inp.grounded && w.sit < 0.5) {
        const wpos = this.char.localToWorld(v3(A.x, 0, A.z));
        A.y += THREE.MathUtils.clamp(inp.ground(wpos.x, wpos.z) - groundHere, -0.35, 0.35);
      }
      return { A, pitch, stanceU };
    });

    // ── pose group: pelvis height, pitch (prone / swim), bank ──
    const pY = this.pelvisY;
    // Hip height the legs allow: the lowest of what each foot target can reach (the compass
    // gait: high over the stance leg at mid-stance, lower in double support).
    const R = 0.98 * Lleg;
    let allowed = Infinity;
    let midStance = 0;
    this.sides.forEach((sd, i) => {
      const { A, stanceU } = targets[i];
      const dx = A.x - sd.hip.x;
      const dz = A.z - sd.hip.z;
      // Late stance (heel off) and swing don't hold the hips down: that knee bends / the toe leaves.
      if (stanceU >= 0 && stanceU < 0.72) allowed = Math.min(allowed, A.y + Math.sqrt(Math.max(0, R * R - dx * dx - dz * dz)));
      if (stanceU >= 0) midStance = Math.max(midStance, Math.sin(Math.PI * stanceU));
    });
    let drop = Math.max(0, pY - allowed);
    drop += 0.05 * w.run * midStance; // running: the stance knee absorbs
    drop += 0.46 * w.crouch + 0.22 * this.impact;
    drop *= 1 - w.air * 0.9;
    drop += (pY - (this.sides[0].L1 + 0.1)) * kneelW;

    const swimPitch = w.swim * THREE.MathUtils.lerp(0.18, 1.25, w.swimMove);
    const pitch = (Math.PI / 2) * pitchW + swimPitch;
    // Rotate about the pelvis, then lower the pelvis to the ground (prone) / waterline (swim).
    this.pose.position.set(0, pY - pY * Math.cos(pitch), -pY * Math.sin(pitch));
    this.pose.position.y += -drop * standW - (pY - 0.17) * pitchW;
    this.pose.position.y += w.swim * 0.25;
    this.pose.position.x = 0.025 * Math.sin(TAU * this.phase) * moveW * (1 - w.run) * standW;
    this.pose.rotation.set(pitch, 0, THREE.MathUtils.clamp(-this.yawRate * s * 0.032, -0.3, 0.3) * standW, 'YXZ');
    // Sitting: pelvis onto the seat surface (avatar origin is the seat), slightly back.
    if (w.sit > 0) {
      this.pose.position.lerp(v3(0, 0.1 - pY, -0.08), w.sit);
      this.pose.rotation.x *= 1 - w.sit;
      this.pose.rotation.z *= 1 - w.sit;
    }

    this.char.updateWorldMatrix(true, false);
    this.char.getWorldQuaternion(this.qChar).invert();

    // ── torso ──
    const b = this.b;
    const breathe = Math.sin(this.t * TAU * 0.25);
    const lean =
      (0.05 * moveW + 0.16 * w.run + 0.1 * w.sprint + 0.38 * w.crouch + THREE.MathUtils.clamp(this.accel * 0.03, -0.12, 0.15)) * standW +
      0.12 * kneelW - 0.06 * w.sit * (1 - w.car) + 0.08 * w.drive;
    const twist = 0.11 * moveW * Math.sin(TAU * this.phase) * standW;
    this.rot(b.Hips, this.axisAngle(Y, twist));
    this.rot(b.Spine, this.axisAngle(X, lean * 0.45 + breathe * 0.015));
    this.rot(b.Spine1, this.axisAngle(Y, -twist * 1.9));
    this.rot(b.Spine2, this.axisAngle(X, lean * 0.3));
    const look = THREE.MathUtils.clamp(this.yawRate * 0.16, -0.45, 0.45) * (1 - w.sit) * (1 - pitchW);
    const headPitch = -lean * 0.6 - 1.05 * pitchW - 0.9 * w.swimMove * w.swim;
    this.rot(b.Neck, this.axisAngle(Y, look * 0.5));
    this.rot(b.Head, this.qD.setFromEuler(new THREE.Euler(headPitch * 0.7, look * 0.5, 0, 'YXZ')));

    // ── legs ──
    const pole = v3(0, 0, 1);
    this.sides.forEach((sd, i) => {
      const p = (this.phase + (sd.sx > 0 ? 0 : 0.5)) % 1;
      const hip = this.local(b[sd.up]!, this.wp);
      const F = targets[i].A.clone();
      let footPitch = targets[i].pitch;
      // Airborne: tuck (rising: trailing leg back; falling: both knees up for the landing).
      if (w.air > 0.01) {
        const rising = inp.vy > 0.5;
        const air = v3(sd.hip.x, hip.y - Lleg * (rising ? (sd.sx > 0 ? 0.92 : 0.72) : 0.74), rising ? (sd.sx > 0 ? -0.18 : 0.22) : sd.sx > 0 ? 0.12 : -0.02);
        F.lerp(air, w.air);
        footPitch = THREE.MathUtils.lerp(footPitch, 0.5, w.air);
      }
      sd.planted.copy(F);
      let [thigh, shin] = this.ik(hip, F, sd.L1, sd.L2, pole.clone().add(v3(sd.sx * 0.12, 0, 0)).normalize());
      let foot = sd.footDir.clone().applyAxisAngle(X, footPitch);

      // Kneel (transition into prone): thighs down, shins back along the ground.
      if (kneelW > 0.001) {
        thigh.lerp(v3(sd.sx * 0.06, -1, 0.12).normalize(), kneelW).normalize();
        shin.lerp(v3(0, -0.12, -1).normalize(), kneelW).normalize();
        foot.lerp(v3(0, -0.4, -1).normalize(), kneelW).normalize();
      }
      // Prone (and crawling when moving).
      if (pitchW > 0.001) {
        const crawl = Math.sin(TAU * p) * w.move;
        const pt = v3(sd.sx * (0.12 + 0.35 * Math.max(0, crawl)), -0.06, -1 + 0.4 * Math.max(0, crawl)).normalize();
        const ps = v3(sd.sx * 0.04, 0.06 + 0.5 * Math.max(0, crawl), -1).normalize();
        thigh.lerp(pt, pitchW).normalize();
        shin.lerp(ps, pitchW).normalize();
        foot.lerp(v3(0, -1, -0.25).normalize(), pitchW).normalize();
      }
      // Swimming: breaststroke frog-kick, or cycling legs while treading water.
      if (w.swim > 0.001) {
        // Body frame (before the swim pitch): legs run down the body (−Y); +Z is the belly
        // side, −Z the back. Recovery draws the heels up behind (−Z), then they kick out.
        const k = Math.max(0, Math.sin(TAU * this.phase));
        const frogT = v3(sd.sx * (0.12 + 0.35 * k), -1, 0.35 * k).normalize();
        const frogS = v3(sd.sx * 0.3 * k, -(1 - k) * 0.9 - 0.1, -0.95 * k).normalize();
        const treadT = v3(sd.sx * 0.15, -1, 0.25 * Math.sin(TAU * p)).normalize();
        const treadS = v3(0, -1, -0.3 + 0.3 * Math.cos(TAU * p)).normalize();
        // Frog-kick directions are in the pitched body frame; rotate into the character frame.
        const bodyQ = new THREE.Quaternion().setFromAxisAngle(X, swimPitch);
        const st = treadT.lerp(frogT.applyQuaternion(bodyQ), w.swimMove).normalize();
        const ss = treadS.lerp(frogS.applyQuaternion(bodyQ), w.swimMove).normalize();
        thigh.lerp(st, w.swim).normalize();
        shin.lerp(ss, w.swim).normalize();
        foot.lerp(v3(0, -1, -0.2).applyQuaternion(bodyQ).normalize(), w.swim).normalize();
      }
      // Sitting: chair (thighs level, shins down) / car (legs out to the pedals).
      if (w.sit > 0.001) {
        const ct = v3(sd.sx * 0.1, -0.05, 1).normalize().lerp(v3(sd.sx * 0.1, 0.12, 1).normalize(), w.car).normalize();
        const cs = v3(0, -1, 0.1).normalize().lerp(v3(0, -0.72, 0.7).normalize(), w.car).normalize();
        thigh = thigh.lerp(ct, w.sit).normalize();
        shin = shin.lerp(cs, w.sit).normalize();
        foot = foot.lerp(sd.footDir, w.sit).normalize();
      }
      this.aim(b[sd.up], b[sd.leg], thigh);
      this.aim(b[sd.leg], b[sd.foot], shin);
      if (b[sd.toe]) this.aim(b[sd.foot], b[sd.toe], foot);
    });

    // ── arms ──
    for (const sd of this.sides) {
      const p = (this.phase + (sd.sx > 0 ? 0.5 : 0)) % 1; // opposite to the same-side leg
      // Running arms swing further back than forward, and the elbow closes as the arm comes
      // forward (hand up towards the chin), opening again on the back-swing.
      const sw = Math.sin(TAU * p);
      const swing = (0.2 + 0.45 * w.run + 0.15 * w.sprint) * moveW * sw * (sw > 0 ? 1 - 0.35 * w.run : 1 + 0.3 * w.run);
      const sway = 0.025 * Math.sin(this.t * 1.3 + sd.sx);
      const hang = THREE.MathUtils.degToRad(9 + 6 * w.run);
      let upper = v3(sd.sx * Math.sin(hang), -Math.cos(hang), 0).applyAxisAngle(X, -(swing + sway) - 0.45 * w.crouch);
      let elbow = 0.22 + 0.25 * moveW + 1.05 * w.run + 0.15 * w.sprint + 0.7 * w.crouch + 0.4 * w.run * sw;
      // Airborne: arms come up and out for balance.
      if (w.air > 0.001) {
        upper.lerp(v3(sd.sx * 0.65, -0.35, inp.vy > 0 ? 0.45 : 0.2).normalize(), w.air).normalize();
        elbow = THREE.MathUtils.lerp(elbow, 0.7, w.air);
      }
      let fore = upper.clone().applyAxisAngle(X, -elbow).applyAxisAngle(Y, -sd.sx * 0.35 * w.run).normalize();

      if (kneelW > 0.001) {
        upper.lerp(v3(sd.sx * 0.2, -0.85, 0.5).normalize(), kneelW).normalize();
        fore.lerp(v3(0, -0.8, 0.6).normalize(), kneelW).normalize();
      }
      if (pitchW > 0.001) {
        // On the forearms; crawling alternates the reach.
        const reachF = 0.25 * Math.sin(TAU * p) * w.move;
        upper.lerp(v3(sd.sx * 0.38, -0.62, 0.68 + reachF).normalize(), pitchW).normalize();
        fore.lerp(v3(-sd.sx * 0.22, -0.12, 1).normalize(), pitchW).normalize();
      }
      if (w.swim > 0.001) {
        // Breaststroke: glide forward → sweep out → pull in under the chest → recover.
        const q = this.phase;
        const bodyQ = new THREE.Quaternion().setFromAxisAngle(X, swimPitch);
        const stroke = q < 0.35 ? v3(sd.sx * 0.15, 1, 0.05) : q < 0.65 ? v3(sd.sx * 1, 0.35, 0.1) : v3(sd.sx * 0.35, -0.1, 0.6);
        const strokeF = q < 0.35 ? v3(sd.sx * 0.05, 1, 0) : q < 0.65 ? v3(sd.sx * 0.6, 0.6, -0.3) : v3(-sd.sx * 0.6, 0.6, 0.2);
        const tread = v3(sd.sx * 0.9, -0.35, 0.25 + 0.25 * Math.sin(TAU * this.t * 0.9 + sd.sx));
        const treadF = v3(sd.sx * 0.2, -0.1, 1);
        upper.lerp(tread.lerp(stroke.normalize().applyQuaternion(bodyQ), w.swimMove).normalize(), w.swim).normalize();
        fore.lerp(treadF.lerp(strokeF.normalize().applyQuaternion(bodyQ), w.swimMove).normalize(), w.swim).normalize();
      }
      if (w.sit > 0.001) {
        // Chair / passenger: hands on the thighs. Driving: hands on the wheel.
        const st = inp.steer ?? 0;
        const restU = v3(sd.sx * 0.14, -0.92, 0.3).normalize();
        const restF = v3(-sd.sx * 0.12, -0.35, 0.95).normalize();
        const driveU = v3(sd.sx * 0.22, -0.55, 0.82).normalize();
        const driveF = v3(-sd.sx * 0.32, 0.32 + sd.sx * st * 1.6, 0.88).normalize();
        upper = upper.lerp(restU.lerp(driveU, w.drive).normalize(), w.sit).normalize();
        fore = fore.lerp(restF.lerp(driveF, w.drive).normalize(), w.sit).normalize();
      }
      this.aim(b[sd.arm], b[sd.fore], upper);
      this.aim(b[sd.fore], b[sd.hand], fore);
    }
  }
}
