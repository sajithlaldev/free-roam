import * as THREE from 'three';
import type { Car } from './car';
import type { SoundSystem } from './audio/sound';
import type { Terrain } from './world/terrain';
import { OFFROAD_TRACK } from './world/layout';

/**
 * Off-road Challenge: a two-lap time trial round the dirt trail in the off-road park —
 * through both mud pits, over the creek and along the flanks of the mounds. Drive any 4×4
 * onto the start line and press T. Gates must be taken in order; R puts you back on the
 * last gate you cleared. Best times are kept per vehicle; in multiplayer, finishes are
 * announced to the room.
 */

export const RACE_LAPS = 2;
/** Medal times (seconds, whole race). */
export const MEDALS: [string, string, number][] = [
  ['gold', '🥇', 58],
  ['silver', '🥈', 70],
  ['bronze', '🥉', 90],
];
const HALF_WIDTH = 5; // gate half-width (poles), metres
const CATCH = HALF_WIDTH + 1.5; // how far off-centre a crossing still counts
const START_RADIUS = 9;
const ABANDON_DIST = 140;

interface Gate {
  x: number;
  z: number;
  /** travel direction (unit, xz) */
  dx: number;
  dz: number;
  y: number;
  beam: THREE.Mesh;
  group: THREE.Group;
}

type Phase = 'idle' | 'countdown' | 'running' | 'finished';

export interface RaceResult {
  ms: number;
  model: Car['spec']['model'];
  medal: string | null;
  best: boolean;
}

export function fmtTime(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function bestKey(model: string) {
  return `vw-race-best-${model}`;
}
function loadBest(model: string): number | null {
  try {
    const v = Number(localStorage.getItem(bestKey(model)));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}
function saveBest(model: string, ms: number) {
  try {
    localStorage.setItem(bestKey(model), String(Math.round(ms)));
  } catch {
    /* no storage */
  }
}

// ── visuals ──────────────────────────────────────────────────────────────────

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function checker(g: CanvasRenderingContext2D, w: number, h: number, n: number) {
  const s = h / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x * s < w; x++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f0';
      g.fillRect(x * s, y * s, s, s);
    }
}

function bannerTex(title: string, sub: string, start: boolean): THREE.CanvasTexture {
  return canvasTex(1024, start ? 160 : 112, (g) => {
    const W = 1024;
    const H = start ? 160 : 112;
    if (start) {
      checker(g, W, H, 4);
      g.fillStyle = '#c62828';
      g.fillRect(150, 10, W - 300, H - 20);
    } else {
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#ff9f1c');
      grad.addColorStop(1, '#e07000');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#1b1b1b';
      g.fillRect(0, H - 10, W, 10);
      g.fillRect(0, 0, W, 6);
    }
    g.fillStyle = start ? '#fff' : '#1b1b1b';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${start ? 64 : 56}px system-ui, sans-serif`;
    g.fillText(title, W / 2, sub ? H * 0.4 : H / 2);
    if (sub) {
      g.font = `700 ${start ? 30 : 24}px system-ui, sans-serif`;
      g.fillText(sub, W / 2, H * 0.78);
    }
  });
}

let stripeTex: THREE.CanvasTexture | null = null;
function poleMaterial() {
  stripeTex ??= canvasTex(
    16,
    64,
    (g) => {
      g.fillStyle = '#f5f5f0';
      g.fillRect(0, 0, 16, 64);
      g.fillStyle = '#ff6d00';
      g.fillRect(0, 0, 16, 32);
    },
    true,
  );
  return new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.55 });
}

/** A soft vertical curtain of light between the poles of the gate you're heading for. */
function beamMaterial(color: number, intensity: number) {
  const alpha = canvasTex(4, 128, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#000');
    grad.addColorStop(0.6, '#555');
    grad.addColorStop(1, '#fff');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 128);
  });
  alpha.colorSpace = THREE.NoColorSpace;
  // The scene is lit in linear HDR (sunlit ground is several times brighter than 1), so the
  // glow needs an HDR colour to show up at all.
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), alphaMap: alpha, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
}

// ── the race ─────────────────────────────────────────────────────────────────

export class OffroadRace {
  readonly gates: Gate[] = [];
  private phase: Phase = 'idle';
  private car: Car | null = null;
  /** index into the race's gate sequence (0-based over all laps) */
  private next = 0;
  private time = 0;
  private count = 0;
  private lastBeep = 0;
  private finishedAt = 0;
  private lastSide = new Map<number, number>();
  private hud: HTMLDivElement;
  private big: HTMLDivElement;
  private bigTimer = 0;
  private roomBest: { name: string; ms: number; model: string } | null = null;
  /** Called once per finish (main broadcasts it and shows a toast). */
  onFinish: (r: RaceResult) => void = () => {};
  onMessage: (text: string) => void = () => {};

  constructor(
    scene: THREE.Object3D,
    private terrain: Terrain,
    private sound: () => SoundSystem | null,
  ) {
    // The loop: OFFROAD_TRACK[1] … [10] (the last point closes it). Start/finish sits a few
    // metres up the first straight, clear of the park's entrance sign.
    const loop = OFFROAD_TRACK.slice(1, -1).map(([x, z]) => new THREE.Vector2(x, z));
    const n = loop.length;
    const first = loop[1].clone().sub(loop[0]).normalize();
    const start = loop[0].clone().addScaledVector(first, 7);
    this.addGate(scene, start.x, start.y, first.x, first.y, 0);
    for (let i = 1; i < n; i++) {
      const t = loop[(i + 1) % n].clone().sub(loop[i - 1]).normalize();
      this.addGate(scene, loop[i].x, loop[i].y, t.x, t.y, i);
    }
    this.hud = document.createElement('div');
    this.hud.className = 'panel';
    this.hud.id = 'race';
    this.hud.hidden = true;
    this.big = document.createElement('div');
    this.big.id = 'raceBig';
    this.big.hidden = true;
    document.getElementById('hud')?.append(this.hud, this.big) ?? document.body.append(this.hud, this.big);
  }

  /** Gates per lap (the start/finish line is gate 0, taken last). */
  get perLap() {
    return this.gates.length;
  }
  get total() {
    return this.perLap * RACE_LAPS;
  }
  get running() {
    return this.phase === 'running';
  }
  /** The car must stay put during the countdown. */
  get frozen() {
    return this.phase === 'countdown';
  }
  get active() {
    return this.phase === 'countdown' || this.phase === 'running';
  }
  /** Gate the player is heading for (or the start line when idle). */
  get target(): Gate {
    return this.gates[this.active ? this.gateAt(this.next) : 0];
  }
  private gateAt(seq: number) {
    return (seq + 1) % this.perLap; // 1, 2, … perLap-1, 0, 1, …
  }

  private addGate(scene: THREE.Object3D, x: number, z: number, dx: number, dz: number, index: number) {
    const start = index === 0;
    const group = new THREE.Group();
    const t = this.terrain;
    // Poles to the left and right of the trail.
    const px = -dz;
    const pz = dx;
    const bases = [-1, 1].map((s) => t.heightAt(x + px * s * HALF_WIDTH, z + pz * s * HALF_WIDTH));
    const top = Math.max(...bases) + (start ? 5.2 : 4.6);
    const r = start ? 0.22 : 0.12;
    const mat = start ? new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5, metalness: 0.4 }) : poleMaterial();
    [-1, 1].forEach((s, k) => {
      const h = top - bases[k] + 0.4;
      const geo = new THREE.CylinderGeometry(r, r * 1.15, h, 12);
      if (!start) {
        const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * h * 1.25);
      }
      const pole = new THREE.Mesh(geo, mat);
      pole.position.set(x + px * s * HALF_WIDTH, bases[k] - 0.3 + h / 2, z + pz * s * HALF_WIDTH);
      pole.castShadow = true;
      group.add(pole);
      // weighted foot so the pole looks planted
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(r * 2.6, r * 3, 0.35, 12), new THREE.MeshStandardMaterial({ color: start ? 0x222222 : 0xe8e8e0, roughness: 0.8 }));
      foot.position.set(pole.position.x, bases[k] + 0.08, pole.position.z);
      foot.castShadow = true;
      group.add(foot);
    });
    const span = HALF_WIDTH * 2 + 0.6;
    const bh = start ? 1.5 : 1.0;
    // Two single-sided faces so the lettering reads correctly from both directions.
    const bannerMat = new THREE.MeshStandardMaterial({
      map: start ? bannerTex('OFF-ROAD CHALLENGE', `${RACE_LAPS} laps · press T at the line`, true) : bannerTex(`CHECKPOINT ${index}`, '', false),
      roughness: 0.75,
    });
    for (const flip of [0, Math.PI]) {
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(span, bh), bannerMat);
      banner.position.set(x, top - bh / 2, z);
      banner.rotation.y = Math.atan2(dx, dz) + flip;
      banner.castShadow = flip === 0;
      group.add(banner);
    }
    if (start) {
      // Chequered line painted across the ground, following the terrain.
      const seg = 24;
      const w = 1.2;
      const pos: number[] = [];
      const uvs: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= seg; i++) {
        const u = i / seg;
        const lx = x + px * (u * 2 - 1) * HALF_WIDTH;
        const lz = z + pz * (u * 2 - 1) * HALF_WIDTH;
        for (const e of [-1, 1]) {
          const gx = lx + dx * e * (w / 2);
          const gz = lz + dz * e * (w / 2);
          pos.push(gx, t.heightAt(gx, gz) + 0.04, gz);
          uvs.push(u * 10, e < 0 ? 0 : 1);
        }
        if (i < seg) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const tex = canvasTex(32, 64, (g) => checker(g, 32, 64, 4), true);
      const line = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      line.receiveShadow = true;
      group.add(line);
    }
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(span - 0.6, top - Math.min(...bases)), beamMaterial(start ? 0xffffff : 0x40ffb0, start ? 3 : 5));
    beam.position.set(x, (top + Math.min(...bases)) / 2, z);
    beam.rotation.y = Math.atan2(dx, dz);
    beam.visible = false;
    beam.renderOrder = 5;
    group.add(beam);
    scene.add(group);
    this.gates.push({ x, z, dx, dz, y: Math.min(...bases), beam, group });
  }

  /** Which side of gate `i` a point is on (signed metres along travel), and how far off-centre. */
  private side(i: number, p: THREE.Vector3): { s: number; lat: number } {
    const g = this.gates[i];
    const rx = p.x - g.x;
    const rz = p.z - g.z;
    return { s: rx * g.dx + rz * g.dz, lat: Math.abs(-rx * g.dz + rz * g.dx) };
  }

  /** True when the car just crossed gate `i` going the right way. */
  private crossed(i: number, p: THREE.Vector3): boolean {
    const { s, lat } = this.side(i, p);
    const prev = this.lastSide.get(i);
    this.lastSide.set(i, s);
    return prev !== undefined && prev < 0 && s >= 0 && lat < CATCH;
  }

  private beep(f: number, d = 0.14, g = 0.22) {
    this.sound()?.tone(f, d, g);
  }

  private flash(text: string, ms = 1100, cls = '') {
    this.big.textContent = text;
    this.big.className = cls;
    this.big.hidden = false;
    clearTimeout(this.bigTimer);
    if (ms > 0) this.bigTimer = window.setTimeout(() => (this.big.hidden = true), ms);
  }

  private start(car: Car) {
    this.car = car;
    this.phase = 'countdown';
    this.count = 3.6;
    this.lastBeep = 4;
    this.next = 0;
    this.time = 0;
    this.lastSide.clear();
    this.flash('Get ready…', 0);
  }

  /** Stop a race (quit, or left the car / wandered off). */
  abort(reason: string) {
    if (!this.active) return;
    this.phase = 'idle';
    this.car = null;
    this.flash(reason, 1600, 'dim');
    this.onMessage(reason);
  }

  private finish() {
    const car = this.car!;
    const ms = Math.round(this.time * 1000);
    const model = car.spec.model;
    const prev = loadBest(model);
    const best = prev === null || ms < prev;
    if (best) saveBest(model, ms);
    const medal = MEDALS.find(([, , t]) => this.time <= t) ?? null;
    this.phase = 'finished';
    this.finishedAt = performance.now();
    const s = this.sound();
    [523, 659, 784, 1047].forEach((f, i) => s?.tone(f, i === 3 ? 0.7 : 0.16, 0.22, i * 0.13));
    this.flash(`${medal ? medal[1] + ' ' : ''}FINISH ${fmtTime(ms)}${best ? ' · new best!' : ''}`, 4500, 'finish');
    this.onFinish({ ms, model, medal: medal?.[0] ?? null, best });
  }

  /** A finish time from someone else in the room. */
  remoteFinish(name: string, ms: number, model: string) {
    if (!this.roomBest || ms < this.roomBest.ms) this.roomBest = { name, ms, model };
  }

  /** Respawn on the last gate cleared (R during a race). */
  respawn() {
    if (!this.running || !this.car) return;
    const g = this.gates[this.next === 0 ? 0 : this.gateAt(this.next - 1)];
    // a couple of metres past the gate so it isn't crossed again
    const x = g.x + g.dx * 2;
    const z = g.z + g.dz * 2;
    const y = this.terrain.heightAt(x, z) + this.car.spec.wheelRadius + 0.6;
    this.car.teleport(x, y, z, Math.atan2(g.dx, g.dz));
    this.lastSide.clear();
    this.time += 2; // a small penalty
    this.flash('Reset · +2 s', 900, 'dim');
  }

  /**
   * Once per frame. `driving` is the car the local player drives (or null). Returns a hint for
   * the HUD when there's something to say.
   */
  update(dt: number, driving: Car | null, pressT: boolean, camera: THREE.Camera): string {
    const now = performance.now();
    let hint = '';
    // beams: only the gate you're heading for glows
    const tgt = this.active ? this.gateAt(this.next) : -1;
    this.gates.forEach((g, i) => {
      g.beam.visible = i === tgt;
      if (i === tgt) (g.beam.material as THREE.MeshBasicMaterial).opacity = 0.28 + 0.14 * Math.sin(now / 180);
    });

    if (this.phase === 'finished' && now - this.finishedAt > 5000) this.phase = 'idle';

    if (this.active) {
      const car = this.car!;
      if (driving !== car) return this.abort('Race abandoned — you left the car'), '';
      if (pressT) return this.abort('Race cancelled'), '';
      const p = car.position();
      const g = this.gates[tgt];
      if (Math.hypot(p.x - g.x, p.z - g.z) > ABANDON_DIST) return this.abort('Race abandoned — off course'), '';
    }

    if (this.phase === 'countdown') {
      this.count -= dt;
      const n = Math.ceil(this.count);
      if (n < this.lastBeep && n <= 3 && n >= 1) {
        this.lastBeep = n;
        this.beep(620);
        this.flash(String(n), 0, 'count');
      }
      if (this.count <= 0) {
        this.phase = 'running';
        this.beep(1240, 0.5, 0.26);
        this.flash('GO!', 800, 'count');
      }
    } else if (this.phase === 'running') {
      this.time += dt;
      const car = this.car!;
      const p = car.position();
      const gi = this.gateAt(this.next);
      if (this.crossed(gi, p)) {
        this.next++;
        if (this.next >= this.total) this.finish();
        else if (this.next % this.perLap === 0) {
          this.beep(880, 0.12);
          this.sound()?.tone(1320, 0.3, 0.22, 0.1);
          this.flash(`LAP ${this.next / this.perLap + 1}/${RACE_LAPS} · ${fmtTime(this.time * 1000)}`, 1500);
        } else {
          this.beep(988, 0.1, 0.18);
          this.sound()?.tone(1480, 0.16, 0.16, 0.08);
        }
      }
    } else if (driving) {
      // idle: offer a start when sitting on the line
      const s = this.gates[0];
      const p = driving.position();
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < START_RADIUS) {
        if (Math.abs(driving.state.speed) < 4) {
          hint = `T start the Off-road Challenge (${RACE_LAPS} laps)`;
          if (pressT) this.start(driving);
        } else hint = 'Stop on the line to start the race';
      }
    }

    this.renderHud(driving, camera);
    return hint;
  }

  private renderHud(driving: Car | null, camera: THREE.Camera) {
    const show = this.active || this.phase === 'finished';
    this.hud.hidden = !show;
    if (!show || !this.car) return;
    const model = this.car.spec.model;
    const best = loadBest(model);
    const lap = Math.min(RACE_LAPS, Math.floor(this.next / this.perLap) + 1);
    const cp = (this.next % this.perLap) + 1;
    // arrow towards the next gate, relative to where the camera looks
    let arrow = '';
    if (this.active && driving) {
      const g = this.target;
      const p = driving.position();
      const f = new THREE.Vector3();
      camera.getWorldDirection(f);
      const ang = Math.atan2(g.x - p.x, g.z - p.z) - Math.atan2(f.x, f.z);
      const dist = Math.hypot(g.x - p.x, g.z - p.z);
      // three.js yaw grows anticlockwise seen from above; CSS rotation is clockwise
      arrow = `<span class="arrow" style="transform:rotate(${(-ang * 180) / Math.PI}deg)">▲</span><span class="dist">${dist.toFixed(0)} m</span>`;
    }
    const time = this.phase === 'countdown' ? '0:00.0' : fmtTime(this.time * 1000);
    const room = this.roomBest ? `<div class="sub">Room best ${fmtTime(this.roomBest.ms)} · ${esc(this.roomBest.name)}</div>` : '';
    this.hud.innerHTML =
      `<div class="row"><b>${time}</b>${arrow}</div>` +
      `<div class="sub">Lap ${lap}/${RACE_LAPS} · Gate ${this.phase === 'finished' ? this.perLap : cp}/${this.perLap}${best ? ` · Best ${fmtTime(best)}` : ''}</div>` +
      room +
      (this.running ? '<div class="sub dim">R back to last gate (+2 s) · T quit</div>' : '');
  }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
