import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { cloneAvatar, getAvatarTemplate } from './assets';
import { ProceduralRig } from './procedural';
import { AVATAR, INTERP_DELAY_MS, SPAWN } from './config';
import type { World } from './world';

const CAP_HALF = 0.5;
const CAP_R = 0.35;
const CENTER_Y = CAP_HALF + CAP_R; // capsule centre height above the feet
export const EYE_HEIGHT = 1.6;

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
  s.position.y = 2.25;
  s.renderOrder = 10;
  return s;
}

type Gait = 'idle' | 'walk' | 'run';

/** A capsule placeholder, swapped for public/models/avatar.glb (idle/walk/run clips) if present. */
export class Avatar {
  readonly group = new THREE.Group(); // origin at the feet, +Z is forward
  private body = new THREE.Group();
  private mixer?: THREE.AnimationMixer;
  private actions: Partial<Record<Gait, THREE.AnimationAction>> = {};
  private gait: Gait = 'idle';
  private current?: THREE.AnimationAction;
  private disposed = false;
  private label: THREE.Sprite;
  private materials: THREE.Material[] = [];
  private rig: ProceduralRig | null = null;
  private speed = 0;

  constructor(name: string, identityForColour: string) {
    const color = new THREE.Color().setHSL(hueFor(identityForColour), 0.6, 0.55);
    const capsuleMat = new THREE.MeshStandardMaterial({ color });
    const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(CAP_R, CAP_HALF * 2, 6, 16), capsuleMat);
    capsule.position.y = CENTER_Y;
    capsule.castShadow = true;
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.12, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    nose.position.set(0, EYE_HEIGHT - 0.1, CAP_R);
    this.body.add(capsule, nose);
    this.group.add(this.body);

    this.label = makeLabel(name);
    this.group.add(this.label);

    void getAvatarTemplate().then((t) => {
      if (!t || this.disposed) return;
      this.body.clear();
      const model = cloneAvatar(t, color);
      model.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m && !Array.isArray(m) && m.name === AVATAR.tintMaterial) this.materials.push(m);
      });
      this.body.add(model);
      if (!this.shadow) model.traverse((o) => ((o as THREE.Mesh).isMesh ? (o.castShadow = false) : undefined));
      this.mixer = new THREE.AnimationMixer(model);
      for (const g of ['idle', 'walk', 'run'] as Gait[]) {
        const clip = t[g];
        if (clip) this.actions[g] = this.mixer.clipAction(clip);
      }
      this.play(this.gait, 0);
      // No usable clips? Animate humanoid rigs procedurally.
      if (!this.actions.idle && !this.actions.walk) this.rig = ProceduralRig.create(model);
    });
  }

  private shadow = true;

  /** Shadows cost a second pass over ~60k triangles per character; main.ts keeps them for nearby players only. */
  setShadow(on: boolean) {
    if (on === this.shadow) return;
    this.shadow = on;
    this.body.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = on;
    });
  }

  /** Pick idle / walk / run from horizontal speed (m/s). */
  setSpeed(speed: number) {
    this.speed = speed;
    const g: Gait = speed > AVATAR.runAbove ? 'run' : speed > AVATAR.walkAbove ? 'walk' : 'idle';
    if (g !== this.gait) {
      this.gait = g;
      this.play(g, 0.2);
    }
  }

  private play(g: Gait, fade: number) {
    // Fall back to walk if there's no run clip, and to idle if there's no walk clip.
    const next = this.actions[g] ?? (g === 'run' ? this.actions.walk : undefined) ?? this.actions.idle;
    if (!next || next === this.current) return;
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    this.current?.fadeOut(fade);
    this.current = next;
  }

  update(dt: number) {
    this.mixer?.update(dt);
    this.rig?.update(dt, this.speed);
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

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Another player: buffers network snapshots and renders ~100 ms in the past, interpolated. */
export class RemotePlayer {
  readonly avatar: Avatar;
  readonly pos = new THREE.Vector3();
  yaw = 0;
  private buf: Snap[] = [];
  private lastSeq = -1;
  private speed = 0;

  constructor(
    readonly identity: string,
    readonly name: string,
  ) {
    this.avatar = new Avatar(name, identity);
    this.avatar.group.visible = false; // until the first position arrives
  }

  push(seq: number, x: number, y: number, z: number, yaw: number, now: number) {
    // The lossy channel is unordered; drop stale packets (with wraparound tolerance).
    if (this.lastSeq >= 0 && ((seq - this.lastSeq) | 0) <= 0) return;
    this.lastSeq = seq;
    this.buf.push({ t: now, x, y, z, yaw });
    if (this.buf.length > 20) this.buf.shift();
  }

  update(now: number, dt: number) {
    if (!this.buf.length) return;
    const rt = now - INTERP_DELAY_MS;
    // a = newest snapshot at or before the render time, b = the one after it.
    let ai = this.buf.length - 1;
    while (ai > 0 && this.buf[ai].t > rt) ai--;
    const a = this.buf[ai];
    const b = this.buf[Math.min(ai + 1, this.buf.length - 1)];
    const k = b.t > a.t ? THREE.MathUtils.clamp((rt - a.t) / (b.t - a.t), 0, 1) : 0;
    if (ai > 0) this.buf.splice(0, ai); // drop what we've passed

    const px = this.pos.x;
    const pz = this.pos.z;
    this.pos.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
    let dy = b.yaw - a.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw = a.yaw + dy * k;

    if (!this.avatar.group.visible) {
      this.avatar.group.visible = true;
    } else if (dt > 0) {
      const v = Math.hypot(this.pos.x - px, this.pos.z - pz) / dt;
      this.speed += (v - this.speed) * Math.min(1, dt * 10);
      this.avatar.setSpeed(this.speed);
    }
    this.avatar.group.position.copy(this.pos);
    this.avatar.group.rotation.y = this.yaw;
    this.avatar.update(dt);
  }

  head(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
  }

  dispose() {
    this.avatar.dispose();
  }
}

/** WASD + mouse look, Rapier kinematic character controller, third-person camera. */
export class LocalPlayer {
  readonly avatar: Avatar;
  readonly pos = new THREE.Vector3(...SPAWN); // feet
  yaw = Math.PI; // facing -Z (towards the mic)
  camYaw = Math.PI;
  elev = 0.35;
  enabled = true; // false while typing in UI inputs

  private keys = new Set<string>();
  private vy = 0;
  private grounded = false;
  private camDist = 4.5;
  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private cc: RAPIER.KinematicCharacterController;
  private tmp = new THREE.Vector3();

  constructor(
    private world: World,
    private canvas: HTMLCanvasElement,
    name: string,
  ) {
    this.avatar = new Avatar(name, name);
    this.world.scene.add(this.avatar.group);

    const p = world.physics;
    this.body = p.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pos.x, CENTER_Y + 0.05, this.pos.z),
    );
    this.collider = p.createCollider(RAPIER.ColliderDesc.capsule(CAP_HALF, CAP_R), this.body);
    this.cc = p.createCharacterController(0.02);
    this.cc.setSlideEnabled(true);
    this.cc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.cc.enableAutostep(0.3, 0.15, false);
    this.cc.enableSnapToGround(0.25);
    this.cc.setApplyImpulsesToDynamicBodies(false);

    addEventListener('keydown', (e) => {
      if (!this.enabled || (e.target instanceof HTMLInputElement)) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.camYaw -= e.movementX * 0.0025;
      this.elev = THREE.MathUtils.clamp(this.elev + e.movementY * 0.0025, -0.25, 1.25);
    });
    canvas.addEventListener('click', () => {
      if (this.enabled && document.pointerLockElement !== canvas) void canvas.requestPointerLock?.();
    });
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  head(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
  }

  /** Horizontal speed this frame, for "is walking" and network keep-alive decisions. */
  speed = 0;

  update(dt: number) {
    const k = this.keys;
    const ix = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const iz = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);

    // Camera-relative movement. forward = (sin, 0, cos); screen-right = (-cos, 0, sin).
    const sy = Math.sin(this.camYaw);
    const cy = Math.cos(this.camYaw);
    let mx = sy * iz - cy * ix;
    let mz = cy * iz + sy * ix;
    const len = Math.hypot(mx, mz);
    const target = k.has('ShiftLeft') || k.has('ShiftRight') ? 7 : 4;
    if (len > 0) {
      mx = (mx / len) * target;
      mz = (mz / len) * target;
      const want = Math.atan2(mx, mz);
      let d = want - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 14);
    } else {
      mx = mz = 0;
    }

    if (this.grounded && k.has('Space')) this.vy = 6;
    else if (this.grounded && this.vy < 0) this.vy = -1;
    this.vy -= 18 * dt;

    this.cc.computeColliderMovement(this.collider, { x: mx * dt, y: this.vy * dt, z: mz * dt });
    const m = this.cc.computedMovement();
    this.grounded = this.cc.computedGrounded();
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
    this.world.physics.timestep = Math.max(dt, 1e-3);
    this.world.physics.step();
    const nt = this.body.translation();
    this.speed = Math.hypot(nt.x - this.pos.x, nt.z - this.pos.z) / Math.max(dt, 1e-3);
    this.pos.set(nt.x, nt.y - CENTER_Y, nt.z);
    if (this.grounded && this.vy < 0) this.vy = 0;

    this.avatar.group.position.copy(this.pos);
    this.avatar.group.rotation.y = this.yaw;
    this.avatar.setSpeed(len > 0 ? this.speed : 0);
    this.avatar.update(dt);

    this.updateCamera();
  }

  private updateCamera() {
    const head = this.head(this.tmp);
    const ce = Math.cos(this.elev);
    const dir = new THREE.Vector3(-Math.sin(this.camYaw) * ce, Math.sin(this.elev), -Math.cos(this.camYaw) * ce);
    // Pull the camera in if geometry is in the way.
    const hit = this.world.physics.castRay(
      new RAPIER.Ray(head, dir),
      this.camDist,
      true,
      undefined,
      undefined,
      undefined,
      this.body,
    );
    const dist = hit ? Math.max(0.6, hit.timeOfImpact - 0.25) : this.camDist;
    const cam = this.world.camera;
    cam.position.copy(head).addScaledVector(dir, dist);
    cam.position.y = Math.max(cam.position.y, 0.2);
    cam.lookAt(head);
  }
}
