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
 * - Walking follows measured human gait: ~1.8 steps/s at 1.3 m/s, pelvic list (the swing
 *   side drops), lateral sway over the stance foot, modest arm swing with the elbow bending
 *   as the arm comes forward.
 * - Standing still: breathing (chest and shoulders), a slow balance sway, weight resting on
 *   one leg with the other knee relaxed (switching sides now and then), and random idle
 *   actions — look around, check the watch, scratch the head, stretch, hands on hips, arms
 *   crossed, yawn, neck roll — blended in and out.
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

export const IDLE_KINDS = ['look', 'watch', 'scratch', 'stretch', 'hips', 'cross', 'shift', 'yawn', 'neck'] as const;
export type IdleKind = (typeof IDLE_KINDS)[number];
/** How long each idle action lasts (s) and how likely it is to be picked. */
const IDLE_DEF: Record<IdleKind, { dur: [number, number]; p: number }> = {
  look: { dur: [4, 6.5], p: 3 },
  watch: { dur: [2.6, 3.6], p: 1.4 },
  scratch: { dur: [2.2, 3.2], p: 1 },
  stretch: { dur: [3.2, 4], p: 0.8 },
  hips: { dur: [5, 9], p: 1.4 },
  cross: { dur: [6, 11], p: 1.6 },
  shift: { dur: [1.4, 1.8], p: 2.4 },
  yawn: { dur: [3, 3.6], p: 0.5 },
  neck: { dur: [3, 4], p: 0.7 },
};

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
  /** Fired when a foot plants (side +1 left / −1 right, strength ≈ speed-scaled). */
  onStep?: (side: number, strength: number) => void;
  /** Fired on landing from a jump/fall (strength 0..1). */
  onLand?: (strength: number) => void;
  /** Fired at each swim stroke. */
  onStroke?: () => void;
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
  private breathPh = 0;
  private w = { crouch: 0, prone: 0, sit: 0, car: 0, drive: 0, swim: 0, swimMove: 0, air: 0, move: 0, run: 0, sprint: 0, turn: 0, idle: 0 };
  /** Idle behaviour: the current action (or none), its clock and blend weight; which leg the
   * weight rests on (+1 left / −1 right, smoothed); where the relaxed foot has been placed. */
  private idle = { kind: null as IdleKind | null, last: null as IdleKind | null, t: 0, dur: 0, w: 0, still: 0, gap: 2.5, lean: 0, leanTo: Math.random() < 0.5 ? 1 : -1, side: 1, foot: [0, 0] };
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

  /** Current idle action (for tests / debugging). */
  get idleAction(): IdleKind | null {
    return this.idle.kind;
  }

  /** Start an idle action now (anim lab). */
  forceIdle(kind: IdleKind) {
    const d = IDLE_DEF[kind];
    Object.assign(this.idle, { kind, t: 0, dur: (d.dur[0] + d.dur[1]) / 2, side: Math.random() < 0.5 ? 1 : -1 });
    if (kind === 'shift') this.idle.leanTo = -this.idle.leanTo;
  }

  private updateIdle(dt: number, ok: boolean) {
    const I = this.idle;
    I.still = ok ? I.still + dt : 0;
    if (I.kind) {
      I.t += dt;
      const on = ok && I.t < I.dur;
      I.w = approach(I.w, on ? 1 : 0, on ? 3 : 4.5, dt);
      if (!on && I.w < 0.02) {
        I.last = I.kind;
        I.kind = null;
        I.w = 0;
        I.gap = 2 + Math.random() * 6;
        I.still = 0;
      }
    } else if (ok && I.still > I.gap) {
      const kinds = IDLE_KINDS.filter((k) => k !== I.last);
      let r = Math.random() * kinds.reduce((a, k) => a + IDLE_DEF[k].p, 0);
      let pick: IdleKind = kinds[0];
      for (const k of kinds) if ((r -= IDLE_DEF[k].p) <= 0) { pick = k; break; }
      const d = IDLE_DEF[pick];
      I.kind = pick;
      I.t = 0;
      I.w = 0;
      I.dur = d.dur[0] + Math.random() * (d.dur[1] - d.dur[0]);
      I.side = Math.random() < 0.5 ? 1 : -1;
      if (pick === 'shift') I.leanTo = -I.leanTo;
    }
    // Weight moves across slowly (and only while standing still).
    I.lean = approach(I.lean, ok ? I.leanTo : 0, ok ? 1.4 : 6, dt);
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

  /** Head / spine offsets of an idle action at time t (radians, blended by the caller). */
  private idleAct(kind: IdleKind | null, t: number, dur: number, side: number) {
    const o = { yaw: 0, pitch: 0, roll: 0, spine: 0, twist: 0 };
    const u = dur > 0 ? t / dur : 0;
    switch (kind) {
      case 'look': {
        // glance one way, then the other, then back (with the shoulders following a little)
        const y = side * 0.62 * Math.sin(TAU * u) * sstep(0, 0.08, u) * (1 - sstep(0.92, 1, u));
        o.yaw = y;
        o.twist = y * 0.35;
        o.pitch = 0.04 * Math.sin(TAU * 2 * u);
        break;
      }
      case 'watch':
        o.yaw = 0.3;
        o.pitch = 0.5;
        o.spine = 0.05;
        break;
      case 'scratch':
        o.pitch = 0.15;
        o.roll = -0.12;
        break;
      case 'stretch': {
        const e = sstep(0.1, 0.4, u) * (1 - sstep(0.7, 0.95, u));
        o.pitch = -0.3 * e;
        o.spine = -0.12 * e;
        break;
      }
      case 'yawn': {
        const e = sstep(0.1, 0.35, u) * (1 - sstep(0.7, 0.95, u));
        o.pitch = -0.28 * e;
        o.spine = -0.05 * e;
        break;
      }
      case 'neck': {
        // slow head roll: tilt one side, forward, the other side
        const a = TAU * u * 1.0;
        o.roll = 0.3 * Math.sin(a) * side;
        o.pitch = 0.18 * (1 - Math.cos(a)) * 0.5 + 0.1;
        break;
      }
      case 'shift':
        o.pitch = 0.05 * Math.sin(Math.PI * u);
        break;
      case 'hips':
      case 'cross':
        o.pitch = -0.03;
        break;
    }
    return o;
  }

  /** Hand target (character frame) and elbow pole for an idle action, or null to leave the arm. */
  private idleHand(sd: Side, kind: IdleKind | null, t: number, dur: number, side: number): { hand: THREE.Vector3; pole: THREE.Vector3; w: number } | null {
    const sh = this.local(this.b[sd.arm]!, this.v1).clone();
    const head = this.local(this.b.Head!, this.v2).clone();
    const u = dur > 0 ? t / dur : 0;
    const sx = sd.sx;
    switch (kind) {
      case 'watch':
        if (sx < 0) return null; // left wrist
        return { hand: v3(0.04, sh.y - 0.24, sh.z + 0.3), pole: v3(1, -0.7, -0.2), w: 1 };
      case 'scratch': {
        if (sx !== side) return null;
        const r = 0.015;
        return { hand: v3(head.x + sx * 0.07 + r * Math.sin(t * 15), head.y + 0.1 + r * Math.cos(t * 15), head.z + 0.01), pole: v3(sx, 0.6, 0.15), w: 1 };
      }
      case 'stretch': {
        const e = sstep(0.05, 0.35, u) * (1 - sstep(0.72, 0.97, u));
        return { hand: v3(sx * 0.16, head.y + 0.55, head.z - 0.04), pole: v3(sx, 0, -0.4), w: e };
      }
      case 'yawn': {
        if (sx !== -1) return null;
        const e = sstep(0.05, 0.3, u) * (1 - sstep(0.72, 0.95, u));
        return { hand: v3(head.x - 0.01, head.y - 0.07, head.z + 0.13), pole: v3(-1, -0.6, 0.2), w: e };
      }
      case 'hips':
        return { hand: v3(sx * (Math.abs(sd.hip.x) + 0.08), this.pelvisY + 0.08, sd.hip.z - 0.01), pole: v3(sx, 0.05, -0.7), w: 1 };
      case 'cross':
        // forearms stacked (left above), wrists against the opposite upper arm
        return { hand: v3(-sx * 0.085, sh.y - (sx > 0 ? 0.21 : 0.26), sh.z + (sx > 0 ? 0.2 : 0.17)), pole: v3(sx * 0.9, -0.7, 0.2), w: 1 };
      default:
        return null;
    }
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
    const idleOk = inp.grounded && !sitting && !inp.swim && inp.stance === 0 && s < 0.12 && !turningInPlace && w.air < 0.05;
    w.idle = approach(w.idle, idleOk ? 1 : 0, idleOk ? 2.5 : 8, dt);
    this.updateIdle(dt, idleOk);
    const I = this.idle;
    const wLean = I.lean * w.idle; // + = weight on the left leg

    // Landing impact (absorbed by the knees), proportional to the fall speed.
    if (inp.grounded && !this.wasGrounded && this.lastVy < -2.2) this.impact = Math.min(1, -this.lastVy / 9);
    if (inp.grounded && !this.wasGrounded && this.lastVy < -1.2 && !sitting) this.onLand?.(Math.min(1, -this.lastVy / 7));
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
    // Walking cadence ≈ 1.0 + 0.62·v steps/s (≈1.8 steps/s at 1.3 m/s), scaled to leg length.
    const fWalk = (1.0 + (0.62 * s) / legScale) / 2; // cycles/s (two steps per cycle)
    const fRun = (2.5 + (0.14 * s) / legScale) / 2;
    let freq = THREE.MathUtils.lerp(fWalk, fRun, w.run) * (1 + 0.2 * w.crouch);
    if (turningInPlace) freq = 1.3;
    if (pitchW > 0.5) freq = 0.7 + 0.8 * s; // crawl
    const prevPhase = this.phase;
    this.phase = (this.phase + Math.min(1.9, freq) * dt) % 1;
    // Footfalls: the left foot plants as the cycle wraps, the right one at half-cycle.
    const stepping = (w.move > 0.35 || turningInPlace) && inp.grounded && !sitting && !inp.swim;
    const strength = (0.45 + 0.17 * s) * (inp.stance === 1 ? 0.55 : inp.stance === 2 ? 0.35 : 1);
    if (stepping && prevPhase > this.phase) this.onStep?.(1, strength);
    if (stepping && prevPhase < 0.5 && this.phase >= 0.5) this.onStep?.(-1, strength);
    if (inp.swim && s > 0.3 && prevPhase > this.phase) this.onStroke?.();
    const stride = turningInPlace ? 0 : s / Math.max(0.5, freq); // metres per cycle
    // Stance (duty) fraction: ~0.6 walking, ~0.34 running; capped so the contact length stays
    // within what the leg can reach (sprinting is short ground contacts).
    let beta = THREE.MathUtils.lerp(0.58, 0.34, w.run);
    if (stride > 0.01) beta = Math.max(0.2, Math.min(beta, (1.1 * Lleg) / stride));
    const half = ((beta * stride) / 2) * moveW;
    const lift = (Math.min(0.32, 0.05 + 0.035 * s) * (1 - 0.45 * w.crouch) + 0.05 * w.turn) * moveW;
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
      let pitch = 0;
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
      // Standing: the unloaded foot sits a little forward and out, its knee relaxed; when the
      // weight moves across, it lifts slightly as it's repositioned.
      if (w.idle > 0.01) {
        const i = sd.sx > 0 ? 0 : 1;
        const relaxed = Math.max(0, -sd.sx * wLean);
        const prev = I.foot[i];
        I.foot[i] = approach(prev, relaxed, 2.2, dt);
        A.z += 0.07 * I.foot[i] * w.idle;
        A.x += sd.sx * 0.025 * I.foot[i] * w.idle;
        A.y += Math.min(0.03, Math.abs(I.foot[i] - prev) * 3) * w.idle;
        pitch -= 0.08 * I.foot[i] * w.idle;
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
    // Standing: hips over the loaded leg (the loaded hip rides up), plus a slow balance sway.
    const swayX = (0.006 * Math.sin(this.t * 0.73) + 0.004 * Math.sin(this.t * 1.31 + 1)) * w.idle;
    this.pose.position.x += (0.06 * wLean + swayX) * standW;
    this.pose.rotation.z += (0.032 * wLean + 0.01 * Math.sin(this.t * 0.51) * w.idle) * standW;
    this.pose.position.z += 0.005 * Math.sin(this.t * 0.61 + 2) * w.idle;
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
    const breathRate = 0.22 + 0.15 * Math.min(1, this.speed / 5) + 0.1 * w.sprint;
    this.breathPh = (this.breathPh + breathRate * dt) % 1;
    const breathe = Math.sin(this.breathPh * TAU);
    const lean =
      (0.05 * moveW + 0.16 * w.run + 0.1 * w.sprint + 0.38 * w.crouch + THREE.MathUtils.clamp(this.accel * 0.03, -0.12, 0.15)) * standW +
      0.12 * kneelW - 0.06 * w.sit * (1 - w.car) + 0.08 * w.drive;
    const twist = 0.11 * moveW * Math.sin(TAU * this.phase) * standW;
    // Pelvic list: the swing-side hip drops ~4° during single support (walking only).
    const list = 0.065 * moveW * (1 - w.run) * Math.sin(TAU * this.phase) * standW;
    // Idle action: head yaw / pitch / roll and spine bend, from the current action's clock.
    const act = this.idleAct(I.kind, I.t, I.dur, I.side);
    const iw = I.w * w.idle;
    const spineBend = act.spine * iw;
    this.rot(b.Hips, this.qD.setFromEuler(new THREE.Euler(0, twist, list, 'YXZ')));
    this.rot(b.Spine, this.qD.setFromEuler(new THREE.Euler(lean * 0.45 + breathe * 0.012 + spineBend * 0.5, act.twist * iw * 0.4, -list * 0.6 - 0.045 * this.idle.lean * w.idle, 'YXZ')));
    this.rot(b.Spine1, this.qD.setFromEuler(new THREE.Euler(breathe * 0.01, -twist * 1.9 + act.twist * iw * 0.4, -list * 0.3, 'YXZ')));
    this.rot(b.Spine2, this.axisAngle(X, lean * 0.3 + breathe * 0.018 + spineBend * 0.5));
    const look = THREE.MathUtils.clamp(this.yawRate * 0.16, -0.45, 0.45) * (1 - w.sit) * (1 - pitchW);
    const headPitch = -lean * 0.6 - 1.05 * pitchW - 0.9 * w.swimMove * w.swim + act.pitch * iw;
    const headYaw = look * 0.5 + act.yaw * iw * 0.5;
    this.rot(b.Neck, this.qD.setFromEuler(new THREE.Euler(act.pitch * iw * 0.3, headYaw, act.roll * iw * 0.4, 'YXZ')));
    this.rot(b.Head, this.qD.setFromEuler(new THREE.Euler(headPitch * 0.7, headYaw, act.roll * iw * 0.6 + 0.02 * this.idle.lean * w.idle, 'YXZ')));

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
      // Walking: a relaxed swing that grows with speed, a bit further forward than back.
      const walkAmp = 0.09 + 0.075 * Math.min(this.speed, 2);
      const swing = (walkAmp * (1 - w.run) + (0.65 + 0.15 * w.sprint) * w.run) * moveW * sw * (sw > 0 ? 1 + 0.15 * (1 - w.run) - 0.35 * w.run : 1 - 0.1 * (1 - w.run) + 0.3 * w.run);
      const sway = 0.02 * Math.sin(this.t * 1.3 + sd.sx) * (1 - w.idle) + 0.012 * breathe * w.idle;
      const hang = THREE.MathUtils.degToRad(8 + 6 * w.run + 1.5 * breathe * w.idle);
      let upper = v3(sd.sx * Math.sin(hang), -Math.cos(hang), 0).applyAxisAngle(X, -(swing + sway) - 0.45 * w.crouch);
      let elbow = 0.2 + 0.18 * moveW + 0.16 * Math.max(0, sw) * moveW * (1 - w.run) + 1.05 * w.run + 0.15 * w.sprint + 0.7 * w.crouch + 0.4 * w.run * sw;
      // Airborne: arms come up and out for balance.
      if (w.air > 0.001) {
        upper.lerp(v3(sd.sx * 0.65, -0.35, inp.vy > 0 ? 0.45 : 0.2).normalize(), w.air).normalize();
        elbow = THREE.MathUtils.lerp(elbow, 0.7, w.air);
      }
      let fore = upper.clone().applyAxisAngle(X, -elbow).applyAxisAngle(Y, -sd.sx * 0.35 * w.run).normalize();
      // Idle action arm poses (two-bone IK to a hand target).
      const iwArm = this.idle.w * w.idle;
      if (iwArm > 0.001) {
        const tgt = this.idleHand(sd, this.idle.kind, this.idle.t, this.idle.dur, this.idle.side);
        if (tgt) {
          const sh = this.local(b[sd.arm]!, new THREE.Vector3());
          const [u2, f2] = this.ik(sh, tgt.hand, sd.A1, sd.A2, tgt.pole.normalize());
          upper.lerp(u2, iwArm * tgt.w).normalize();
          fore.lerp(f2, iwArm * tgt.w).normalize();
        }
      }

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
      // Crossed arms: hands curl back round the opposite arm instead of sticking out.
      if (this.idle.kind === 'cross' && this.idle.w * w.idle > 0.01) this.rot(b[sd.hand], this.axisAngle(Y, -sd.sx * 1.2 * this.idle.w * w.idle));
    }
  }
}
