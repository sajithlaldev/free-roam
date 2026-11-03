import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { cloneAvatar, getAvatarTemplate } from './assets';
import { AVATAR, INTERP_DELAY_MS } from './config';
import { wireAvatarSounds } from './audio/index';
import type { Car } from './car';
import { ProceduralRig, findHumanoidBone, type AnimInput, type SitMode, type Stance } from './procedural';
import { SPAWN, WATER_Y } from './world/layout';
import { registry } from './world/registry';
import type { World } from './world/index';

// Capsule shapes per stance: [halfHeight, radius]; the capsule's centre sits half+radius above the feet.
const SHAPES: Record<Stance, [number, number]> = { 0: [0.5, 0.33], 1: [0.22, 0.33], 2: [0.06, 0.3] };
export const EYE: Record<Stance, number> = { 0: 1.6, 1: 1.1, 2: 0.45 };
const SPEED = { walk: 1.3, jog: 3.2, sprint: 6.4, crouch: 1.15, prone: 0.55, swim: 1.1, swimFast: 1.8 };
const GRAVITY = 9.81;
const JUMP_V = 3.4; // ≈ 0.6 m jump
const SWIM_DEPTH = 1.25; // deeper than this (at the player's position) → swimming
const SWIM_FEET = WATER_Y - 1.32; // feet height while floating

export type CamMode = 'normal' | 'far' | 'shoulder' | 'first';
export const CAM_MODES: CamMode[] = ['normal', 'far', 'shoulder', 'first'];
export const CAM_LABEL: Record<CamMode, string> = { normal: 'Normal', far: 'Zoomed out', shoulder: 'Over the shoulder', first: 'First person' };

function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 360) / 360;
}

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '600 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,.65)';
  g.strokeText(text, 128, 32);
  g.fillStyle = '#fff';
  g.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(2, 0.5, 1);
  s.position.y = 2.2;
  s.renderOrder = 10;
  return s;
}

/** A body: placeholder capsule until public/models/avatar.glb loads; procedural animation. */
export class Avatar {
  readonly group = new THREE.Group(); // character frame: feet at origin, +Z forward
  private body = new THREE.Group();
  private pose = new THREE.Group();
  private rig: ProceduralRig | null = null;
  /** Sound hooks (forwarded to the rig once the model has loaded). */
  onStep?: (side: number, strength: number) => void;
  onLand?: (strength: number) => void;
  onStroke?: () => void;
  private mixer?: THREE.AnimationMixer;
  private actions: Partial<Record<'idle' | 'walk' | 'run', THREE.AnimationAction>> = {};
  private current?: THREE.AnimationAction;
  private label: THREE.Sprite;
  private disposed = false;
  private materials: THREE.Material[] = [];
  private shadow = true;
  private headBone?: THREE.Object3D;
  private headHidden = false;

  constructor(name: string, identityForColour: string) {
    const color = new THREE.Color().setHSL(hueFor(identityForColour), 0.6, 0.55);
    const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 1.0, 6, 16), new THREE.MeshStandardMaterial({ color }));
    capsule.position.y = 0.83;
    capsule.castShadow = true;
    this.pose.add(capsule);
    this.body.add(this.pose);
    this.group.add(this.body);
    this.label = makeLabel(name);
    this.group.add(this.label);

    void getAvatarTemplate().then((t) => {
      if (!t || this.disposed) return;
      this.pose.clear();
      const model = cloneAvatar(t, color);
      model.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m && !Array.isArray(m) && m.name === AVATAR.tintMaterial) this.materials.push(m);
        if ((o as THREE.Mesh).isMesh) o.castShadow = this.shadow;
      });
      this.pose.add(model);
      this.headBone = findHumanoidBone(model, 'Head');
      this.setHeadHidden(this.headHidden);
      if (t.idle && t.walk) {
        this.mixer = new THREE.AnimationMixer(model);
        for (const g of ['idle', 'walk', 'run'] as const) if (t[g]) this.actions[g] = this.mixer.clipAction(t[g]!);
      } else {
        this.rig = ProceduralRig.create(model, this.pose, this.group);
        if (this.rig) {
          this.rig.onStep = (side, k) => this.onStep?.(side, k);
          this.rig.onLand = (k) => this.onLand?.(k);
          this.rig.onStroke = () => this.onStroke?.();
        }
      }
    });
  }

  setShadow(on: boolean) {
    if (on === this.shadow) return;
    this.shadow = on;
    this.body.traverse((o) => (o as THREE.Mesh).isMesh && (o.castShadow = on));
  }

  /** First person: collapse the head (and everything skinned to it) so it doesn't block the view. */
  setHeadHidden(h: boolean) {
    this.headHidden = h;
    this.headBone?.scale.setScalar(h ? 0.001 : 1);
  }

  /** World position of the eyes (follows the animated head bone when there is one). */
  eyes(out: THREE.Vector3, fallbackHeight: number): THREE.Vector3 {
    if (this.headBone) {
      this.headBone.getWorldPosition(out);
      return out.add(new THREE.Vector3(0, 0.07, 0));
    }
    return out.copy(this.group.position).add(new THREE.Vector3(0, fallbackHeight, 0));
  }

  setLabelVisible(v: boolean) {
    this.label.visible = v;
  }

  animate(dt: number, inp: AnimInput) {
    if (this.rig) {
      this.rig.update(dt, inp);
      return;
    }
    if (this.mixer) {
      const g = inp.speed > AVATAR.runAbove ? 'run' : inp.speed > AVATAR.walkAbove ? 'walk' : 'idle';
      const next = this.actions[g] ?? this.actions.walk ?? this.actions.idle;
      if (next && next !== this.current) {
        next.reset().fadeIn(0.2).play();
        this.current?.fadeOut(0.2);
        this.current = next;
      }
      this.mixer.update(dt);
    }
  }

  dispose() {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.materials.forEach((m) => m.dispose());
    const m = this.label.material as THREE.SpriteMaterial;
    m.map?.dispose();
    m.dispose();
    this.group.removeFromParent();
  }
}

// ── network state shared by local & remote players ──────────────────────────

export interface NetState {
  grounded: boolean;
  stance: Stance;
  swim: boolean;
  sprint: boolean;
  /** Chair seat id (registry.seats) or −1. */
  seat: number;
  /** car id × 4 + seat index, or −1. */
  carSeat: number;
}

export const packFlags = (s: NetState) => (s.grounded ? 1 : 0) | (s.stance << 1) | (s.swim ? 8 : 0) | (s.sprint ? 16 : 0);
export const unpackFlags = (f: number) => ({ grounded: !!(f & 1), stance: ((f >> 1) & 3) as Stance, swim: !!(f & 8), sprint: !!(f & 16) });

// ── remote players ────────────────────────────────────────────────────────────

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export class RemotePlayer {
  readonly avatar: Avatar;
  readonly pos = new THREE.Vector3();
  yaw = 0;
  state: NetState = { grounded: true, stance: 0, swim: false, sprint: false, seat: -1, carSeat: -1 };
  private buf: Snap[] = [];
  private lastSeq = -1;
  private speed = 0;
  private vy = 0;
  private yawRate = 0;
  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;

  constructor(
    readonly identity: string,
    readonly name: string,
    private world: World,
  ) {
    this.avatar = new Avatar(name, identity);
    wireAvatarSounds(this.avatar);
    this.avatar.group.visible = false;
    // Kinematic capsule so cars and the local player bump into remote players.
    this.body = world.physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, 0));
    this.collider = world.physics.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.33), this.body);
  }

  push(seq: number, x: number, y: number, z: number, yaw: number, state: NetState, now: number) {
    if (this.lastSeq >= 0 && ((seq - this.lastSeq) | 0) <= 0) return;
    this.lastSeq = seq;
    this.state = state;
    this.buf.push({ t: now, x, y, z, yaw });
    if (this.buf.length > 20) this.buf.shift();
  }

  update(now: number, dt: number, cars: Car[]) {
    if (!this.buf.length) return;
    const rt = now - INTERP_DELAY_MS;
    let ai = this.buf.length - 1;
    while (ai > 0 && this.buf[ai].t > rt) ai--;
    const a = this.buf[ai];
    const b = this.buf[Math.min(ai + 1, this.buf.length - 1)];
    const k = b.t > a.t ? THREE.MathUtils.clamp((rt - a.t) / (b.t - a.t), 0, 1) : 0;
    if (ai > 0) this.buf.splice(0, ai);

    const px = this.pos.x;
    const py = this.pos.y;
    const pz = this.pos.z;
    const pyaw = this.yaw;
    this.pos.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
    let dy = b.yaw - a.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw = a.yaw + dy * k;

    const g = this.avatar.group;
    const first = !g.visible;
    g.visible = true;
    if (!first && dt > 0) {
      this.speed += (Math.hypot(this.pos.x - px, this.pos.z - pz) / dt - this.speed) * Math.min(1, dt * 10);
      this.vy += ((this.pos.y - py) / dt - this.vy) * Math.min(1, dt * 12);
      let dyaw = this.yaw - pyaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      this.yawRate += (dyaw / dt - this.yawRate) * Math.min(1, dt * 10);
    }

    const s = this.state;
    let sit: SitMode = 0;
    let steer = 0;
    const car = s.carSeat >= 0 ? cars[s.carSeat >> 2] : undefined;
    if (car) {
      const seat = s.carSeat & 3;
      car.seatWorld(seat, g.position);
      car.cabinQuaternion(g.quaternion);
      sit = seat === 0 ? 2 : 3;
      steer = car.state.steer;
      this.speed = 0;
    } else if (s.seat >= 0 && registry.seats[s.seat]) {
      const st = registry.seats[s.seat];
      g.position.set(st.x, st.y, st.z);
      g.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), st.yaw);
      sit = 1;
      this.speed = 0;
    } else {
      g.position.copy(this.pos);
      g.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    }
    const onFoot = sit === 0;
    this.collider.setEnabled(onFoot);
    if (onFoot) this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + 0.83, z: this.pos.z });

    this.avatar.animate(dt, {
      speed: sit ? 0 : this.speed,
      vy: this.vy,
      grounded: s.grounded,
      stance: s.stance,
      sit,
      swim: s.swim,
      sprint: s.sprint,
      yawRate: sit ? 0 : this.yawRate,
      steer,
      ground: this.world.terrain.heightAt,
    });
  }

  head(out: THREE.Vector3): THREE.Vector3 {
    const g = this.avatar.group.position;
    const h = this.state.carSeat >= 0 || this.state.seat >= 0 ? 0.8 : this.state.swim ? 1.5 : EYE[this.state.stance];
    return out.set(g.x, g.y + h, g.z);
  }

  dispose() {
    this.avatar.dispose();
    this.world.physics.removeRigidBody(this.body);
  }
}

// ── the local player ──────────────────────────────────────────────────────────

export class LocalPlayer {
  readonly avatar: Avatar;
  readonly pos = new THREE.Vector3(...SPAWN); // feet
  yaw = Math.PI;
  camYaw = Math.PI;
  elev = 0.32;
  camDist = 3.6;
  enabled = true;
  camMode: CamMode = (() => {
    try {
      const m = localStorage.getItem('vw-cam') as CamMode | null;
      return m && CAM_MODES.includes(m) ? m : 'normal';
    } catch {
      return 'normal';
    }
  })();
  /** Called when V switches the camera (for the HUD). */
  onCamMode?: (m: CamMode) => void;
  /** Q toggles the default on-foot pace between walking and jogging. */
  jog = false;
  onJog?: (on: boolean) => void;

  stance: Stance = 0;
  sprint = false;
  swimming = false;
  grounded = true;
  vy = 0;
  /** Horizontal speed (m/s) and turn rate (rad/s), for animation + network. */
  speed = 0;
  yawRate = 0;
  seat = -1;
  car: { car: Car; seat: number } | null = null;

  private keys = new Set<string>();
  private pressed = new Set<string>();
  /** Touch stick (−1..1); overrides WASD when pushed. */
  analog = { x: 0, y: 0 };
  private vel = new THREE.Vector2();
  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private cc: RAPIER.KinematicCharacterController;
  private camTarget = new THREE.Vector3();
  private carCamYaw = 0;
  private lastMouse = 0;
  private tmp = new THREE.Vector3();

  constructor(
    private world: World,
    private canvas: HTMLCanvasElement,
    name: string,
  ) {
    this.avatar = new Avatar(name, name);
    wireAvatarSounds(this.avatar);
    this.avatar.setLabelVisible(false);
    world.scene.add(this.avatar.group);
    const p = world.physics;
    this.pos.y = world.terrain.heightAt(this.pos.x, this.pos.z) + 0.05;
    const [hh, r] = SHAPES[0];
    this.body = p.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pos.x, this.pos.y + hh + r, this.pos.z));
    this.collider = p.createCollider(RAPIER.ColliderDesc.capsule(hh, r), this.body);
    this.cc = p.createCharacterController(0.02);
    this.cc.setSlideEnabled(true);
    this.cc.setMaxSlopeClimbAngle((48 * Math.PI) / 180);
    this.cc.setMinSlopeSlideAngle((55 * Math.PI) / 180);
    this.cc.enableAutostep(0.34, 0.18, false);
    this.cc.enableSnapToGround(0.3);
    this.cc.setApplyImpulsesToDynamicBodies(true);
    this.cc.setCharacterMass(75);

    addEventListener('keydown', (e) => {
      if (!this.enabled || e.target instanceof HTMLInputElement) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.camYaw -= e.movementX * 0.0025;
      this.elev = THREE.MathUtils.clamp(this.elev + e.movementY * 0.0025, -0.35, 1.3);
      this.lastMouse = performance.now();
    });
    addEventListener('wheel', (e) => (this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * 0.004, 1.8, 9)), { passive: true });
    canvas.addEventListener('click', () => {
      if (this.enabled && document.pointerLockElement !== canvas) void canvas.requestPointerLock?.();
    });
  }

  /** Touch buttons press the same keys the keyboard does. */
  virtualKey(code: string, down: boolean) {
    if (down) {
      if (!this.keys.has(code)) this.pressed.add(code);
      this.keys.add(code);
    } else this.keys.delete(code);
  }

  /** Touch look (pixels dragged). */
  look(dx: number, dy: number) {
    this.camYaw -= dx * 0.0025;
    this.elev = THREE.MathUtils.clamp(this.elev + dy * 0.0025, -0.35, 1.3);
    this.lastMouse = performance.now();
  }

  isDown(code: string) {
    return this.keys.has(code);
  }
  /** True once per key press (consumed). */
  tapped(code: string) {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }
  get isLocked() {
    return document.pointerLockElement === this.canvas;
  }
  get onFoot() {
    return this.seat < 0 && !this.car;
  }

  netState(): NetState {
    return {
      grounded: this.grounded,
      stance: this.stance,
      swim: this.swimming,
      sprint: this.sprint,
      seat: this.seat,
      carSeat: this.car ? this.car.car.id * 4 + this.car.seat : -1,
    };
  }

  head(out: THREE.Vector3): THREE.Vector3 {
    const g = this.avatar.group.position;
    const h = this.onFoot ? (this.swimming ? 1.5 : EYE[this.stance]) : 0.8;
    return out.set(g.x, g.y + h, g.z);
  }

  // ── stance ──

  private setShape(st: Stance): boolean {
    const [hh, r] = SHAPES[st];
    const c = { x: this.pos.x, y: this.pos.y + hh + r + 0.01, z: this.pos.z };
    if (st < this.stance) {
      // Getting taller: is there headroom?
      const hit = this.world.physics.intersectionWithShape(c, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Capsule(hh, r), undefined, undefined, this.collider);
      if (hit) return false;
    }
    this.collider.setHalfHeight(hh);
    this.collider.setRadius(r);
    this.body.setTranslation(c, true);
    this.stance = st;
    return true;
  }

  // ── seats & cars ──

  sitOn(seatId: number) {
    const s = registry.seats[seatId];
    if (!s) return;
    if (this.stance !== 0) this.setShape(0);
    this.seat = seatId;
    this.collider.setEnabled(false);
    this.vel.set(0, 0);
  }

  standUp() {
    if (this.seat >= 0) {
      const s = registry.seats[this.seat];
      const fx = Math.sin(s.yaw);
      const fz = Math.cos(s.yaw);
      this.placeAt(s.x + fx * 0.6, s.y - 0.4, s.z + fz * 0.6, s.yaw);
      this.seat = -1;
    }
  }

  enterCar(car: Car, seat: number) {
    if (this.stance !== 0) this.setShape(0);
    this.car = { car, seat };
    this.collider.setEnabled(false);
    this.vel.set(0, 0);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion());
    this.carCamYaw = Math.atan2(f.x, f.z);
  }

  /** Step out on the seat's side; fall back to the other side, then the roof. */
  exitCar(): Car | null {
    if (!this.car) return null;
    const { car, seat } = this.car;
    const q = car.quaternion();
    const side = JIMNY_SIDE(seat);
    const tryAt = (sx: number) => {
      const p = new THREE.Vector3(sx * car.spec.exitX, 0.3, car.spec.seats[seat].z).applyQuaternion(q).add(car.position());
      const g = this.world.terrain.heightAt(p.x, p.z);
      const y = Math.max(g, p.y - 0.6);
      const hit = this.world.physics.intersectionWithShape({ x: p.x, y: y + 0.85, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Capsule(0.5, 0.33), undefined, undefined, this.collider);
      return hit ? null : new THREE.Vector3(p.x, y, p.z);
    };
    const spot = tryAt(side) ?? tryAt(-side) ?? car.position().add(new THREE.Vector3(0, 2.2, 0));
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    this.placeAt(spot.x, spot.y, spot.z, Math.atan2(f.x, f.z));
    this.car = null;
    return car;
  }

  private placeAt(x: number, y: number, z: number, yaw: number) {
    this.pos.set(x, y, z);
    const [hh, r] = SHAPES[this.stance];
    this.body.setTranslation({ x, y: y + hh + r + 0.02, z }, true);
    this.collider.setEnabled(true);
    this.yaw = yaw;
    this.vy = 0;
  }

  // ── simulation ──

  /** Fixed-step movement (on foot only). Call before world.physics.step(). */
  fixedUpdate(h: number) {
    if (!this.onFoot) return;
    const k = this.keys;

    if (this.tapped('KeyQ')) {
      this.jog = !this.jog;
      this.onJog?.(this.jog);
    }
    if (this.tapped('KeyC')) this.setShape(this.stance === 1 ? 0 : 1);
    if (this.tapped('KeyZ')) this.setShape(this.stance === 2 ? 0 : 2) || this.setShape(1);
    if (this.stance === 2 && this.pressed.has('Space')) {
      this.pressed.delete('Space');
      if (!this.setShape(0)) this.setShape(1);
    }

    const stick = Math.hypot(this.analog.x, this.analog.y);
    const useStick = stick > 0.12;
    const ix = useStick ? this.analog.x : (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const iz = useStick ? this.analog.y : (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const sy = Math.sin(this.camYaw);
    const cy = Math.cos(this.camYaw);
    let mx = sy * iz - cy * ix;
    let mz = cy * iz + sy * ix;
    const len = Math.hypot(mx, mz);
    if (len > 0) {
      mx /= len;
      mz /= len;
    }
    const wantSprint = (k.has('ShiftLeft') || k.has('ShiftRight') || (useStick && stick > 0.94)) && len > 0 && this.stance === 0;
    this.sprint = wantSprint && !this.swimming;
    // Stick: a gentle push walks (slower the less it's pushed), a firm push jogs, all the way
    // sprints (above). Keyboard: walk, or jog with Q toggled on; Shift sprints.
    const stickJog = useStick && stick > 0.62;
    const jogging = !this.sprint && this.stance === 0 && !this.swimming && (useStick ? stickJog : this.jog);
    const top = this.swimming
      ? wantSprint ? SPEED.swimFast : SPEED.swim
      : this.stance === 2 ? SPEED.prone : this.stance === 1 ? SPEED.crouch : this.sprint ? SPEED.sprint : jogging ? SPEED.jog : SPEED.walk;

    // Accelerate / decelerate like a person, not instantly.
    const throttle = useStick && !this.sprint && !jogging ? Math.min(1, stick / 0.55) : 1;
    const tx = mx * top * throttle;
    const tz = mz * top * throttle;
    const accel = len > 0 ? (this.sprint ? 7 : jogging ? 8 : 10) : 12;
    const a = 1 - Math.exp(-accel * h * 0.5);
    if (this.grounded || this.swimming) this.vel.set(this.vel.x + (tx - this.vel.x) * a, this.vel.y + (tz - this.vel.y) * a);

    // Turn toward the movement direction at a human rate (in first person: face the view).
    const prevYaw = this.yaw;
    if (this.camMode === 'first') {
      let d = this.camYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += THREE.MathUtils.clamp(d, -12 * h, 12 * h);
    } else if (len > 0) {
      const want = Math.atan2(mx, mz);
      let d = want - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const rate = this.stance === 2 ? 2.2 : this.sprint ? 7 : 9;
      this.yaw += THREE.MathUtils.clamp(d, -rate * h, rate * h);
    }
    let dyaw = this.yaw - prevYaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.yawRate += (dyaw / h - this.yawRate) * Math.min(1, h * 12);

    // Water: float when it's deeper than chest height.
    const depth = this.world.terrain.waterDepth(this.pos.x, this.pos.z);
    const wasSwimming = this.swimming;
    this.swimming = depth > SWIM_DEPTH || (wasSwimming && depth > SWIM_DEPTH - 0.2);
    if (this.swimming && this.stance !== 0) this.setShape(0);

    if (this.swimming) {
      this.vy += ((SWIM_FEET - this.pos.y) * 4 - this.vy) * Math.min(1, h * 5);
    } else {
      if (this.grounded && this.pressed.has('Space')) {
        this.pressed.delete('Space');
        if (this.stance === 1) this.setShape(0);
        else if (this.stance === 0) {
          this.vy = JUMP_V + Math.min(0.6, this.speed * 0.08);
          this.grounded = false;
        }
      }
      if (this.grounded && this.vy < 0) this.vy = -0.5;
      this.vy -= GRAVITY * h;
    }
    this.pressed.delete('Space');

    this.cc.computeColliderMovement(this.collider, { x: this.vel.x * h, y: this.vy * h, z: this.vel.y * h });
    const m = this.cc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.cc.computedGrounded();
    if (this.grounded && !wasGrounded && this.vy < 0) this.vy = 0;
    if (!this.grounded && m.y > this.vy * h + 1e-4 && this.vy > 0) this.vy = 0; // bumped a ceiling
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
    const [hh, r] = SHAPES[this.stance];
    this.speed = Math.hypot(m.x, m.z) / h;
    this.pos.set(t.x + m.x, t.y + m.y - hh - r, t.z + m.z);
  }

  /** Per-frame: avatar placement, animation, camera. */
  update(dt: number) {
    if (this.tapped('KeyV')) {
      this.camMode = CAM_MODES[(CAM_MODES.indexOf(this.camMode) + 1) % CAM_MODES.length];
      try {
        localStorage.setItem('vw-cam', this.camMode);
      } catch {
        /* private mode */
      }
      this.onCamMode?.(this.camMode);
    }
    const g = this.avatar.group;
    let sit: SitMode = 0;
    let steer = 0;
    if (this.car) {
      const { car, seat } = this.car;
      car.seatWorld(seat, g.position);
      car.cabinQuaternion(g.quaternion);
      sit = seat === 0 ? 2 : 3;
      steer = car.state.steer;
    } else if (this.seat >= 0) {
      const s = registry.seats[this.seat];
      g.position.set(s.x, s.y, s.z);
      g.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw);
      sit = 1;
    } else {
      g.position.copy(this.pos);
      g.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    }
    this.avatar.animate(dt, {
      speed: sit ? 0 : this.speed,
      vy: this.vy,
      grounded: this.grounded,
      stance: this.stance,
      sit,
      swim: this.swimming && this.onFoot,
      sprint: this.sprint,
      yawRate: sit ? 0 : this.yawRate,
      steer,
      ground: this.world.terrain.heightAt,
    });
    this.updateCamera(dt);
  }

  private updateCamera(dt: number) {
    const cam = this.world.camera;
    const mode = this.camMode;
    const first = mode === 'first';
    this.avatar.setHeadHidden(first);
    cam.near = first ? 0.04 : 0.1;
    cam.updateProjectionMatrix();
    const idle = performance.now() - this.lastMouse > 1800;
    const viewDir = (yaw: number, elev: number) => {
      const ce = Math.cos(elev);
      return new THREE.Vector3(-Math.sin(yaw) * ce, Math.sin(elev), -Math.cos(yaw) * ce); // target → camera
    };

    // ── in the driver's seat ──
    if (this.car && this.car.seat === 0) {
      const car = this.car.car;
      const cq = car.quaternion();
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(cq);
      const carYaw = Math.atan2(f.x, f.z);
      this.carCamYaw = approachAngle(this.carCamYaw, carYaw, dt * 3);
      if (idle) this.camYaw = approachAngle(this.camYaw, first ? carYaw : this.carCamYaw, dt * (first ? 4 : 2.5));
      if (first) {
        // Driver's eyes, looking out of the windscreen; the view tilts with the car.
        const eye = car.seatWorld(0, this.tmp).add(new THREE.Vector3(0, car.spec.eye, 0.03).applyQuaternion(cq));
        cam.position.copy(eye);
        let yawOff = this.camYaw - carYaw;
        yawOff = Math.atan2(Math.sin(yawOff), Math.cos(yawOff));
        const pitch = -THREE.MathUtils.clamp(this.elev - 0.12, -0.6, 0.6);
        cam.quaternion.copy(cq).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, Math.PI + yawOff, 0, 'YXZ')));
        return;
      }
      const base = car.spec.camDist;
      const dist = mode === 'far' ? base * 1.8 : mode === 'shoulder' ? base * 0.7 : Math.max(base, this.camDist + 2);
      const pivot = car.position(this.tmp).add(new THREE.Vector3(0, (mode === 'far' ? 2.0 : 1.35) + car.spec.eye - 0.74, 0));
      const elev = mode === 'far' ? Math.max(0.3, Math.min(this.elev, 0.8)) : Math.max(0.1, Math.min(this.elev, 0.6));
      this.camTarget.copy(pivot);
      this.placeOrbit(viewDir(this.camYaw, elev), dist, car.body);
      return;
    }

    // ── on foot / seated / passenger ──
    const eyeH = this.onFoot ? (this.swimming ? 1.5 : EYE[this.stance]) : 0.8;
    if (first) {
      const eye = this.avatar.eyes(this.tmp, eyeH);
      // Nudge forward of the face so the near plane never clips the skull.
      eye.add(new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw)).multiplyScalar(0.1));
      cam.position.copy(eye);
      cam.lookAt(eye.clone().sub(viewDir(this.camYaw, this.elev)));
      return;
    }
    const pivot = this.head(this.tmp);
    let dist = this.camDist * (this.stance === 2 ? 0.75 : this.stance === 1 ? 0.85 : 1);
    let elev = this.elev;
    if (mode === 'far') {
      dist = Math.max(8, this.camDist * 2.3);
      elev = Math.max(0.35, elev);
    } else if (mode === 'shoulder') {
      // Over the right shoulder, close in.
      const right = new THREE.Vector3(-Math.cos(this.camYaw), 0, Math.sin(this.camYaw));
      pivot.addScaledVector(right, 0.48).add(new THREE.Vector3(0, 0.08, 0));
      dist = 1.75;
    }
    this.camTarget.lerp(pivot, this.car ? 1 : Math.min(1, dt * 18));
    this.placeOrbit(viewDir(this.camYaw, elev), dist, this.car ? this.car.car.body : this.body);
  }

  /** Orbit camera: back off from camTarget along dir, pulled in by walls, kept above ground/water. */
  private placeOrbit(dir: THREE.Vector3, dist: number, exclude: RAPIER.RigidBody) {
    const cam = this.world.camera;
    const hit = this.world.physics.castRay(new RAPIER.Ray(this.camTarget, dir), dist, true, undefined, undefined, undefined, exclude);
    const d = hit ? Math.max(0.4, hit.timeOfImpact - 0.22) : dist;
    cam.position.copy(this.camTarget).addScaledVector(dir, d);
    const gy = this.world.terrain.heightAt(cam.position.x, cam.position.z) + 0.3;
    if (cam.position.y < gy) cam.position.y = gy;
    if (cam.position.y < WATER_Y + 0.15 && this.world.terrain.waterDepth(cam.position.x, cam.position.z) > 0) cam.position.y = WATER_Y + 0.15;
    cam.lookAt(this.camTarget);
  }
}

const JIMNY_SIDE = (seat: number) => (seat % 2 === 0 ? -1 : 1); // driver side is −X (right-hand drive)

function approachAngle(cur: number, target: number, k: number) {
  let d = target - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return cur + d * Math.min(1, k);
}
