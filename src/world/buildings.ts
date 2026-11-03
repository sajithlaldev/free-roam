import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Batcher } from './batch';
import {
  BUILDINGS, FISHING_NET_Z, HOUSEBOATS, JETTY, LIGHTHOUSE, MAIDAN, ROAD_WIDTH, TEMPLE, TEMPLE_GATE,
  TEMPLE_POND, WATER_Y, coastX, inRect, rect, type BuildingDef, type Side,
} from './layout';
import { mulberry32 } from './noise';
import { addPA, addRoom, addSeat, registry } from './registry';
import { polyAt, type Terrain } from './terrain';
import { pbr, type Surface } from './pbr';
import { buildProps } from './props';
import { signTexture, textures } from './textures';

const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...o });

export function registerMaterials(b: Batcher) {
  const t = textures();
  const P = pbr();
  const pb = (sf: Surface, o: THREE.MeshStandardMaterialParameters = {}) => std({ ...sf, roughness: 1, ...o });
  b.material('plaster', () => pb(P.plaster, { color: 0xffffff }))
    .material('laterite', () => pb(P.laterite))
    .material('roof', () => pb(P.roof, { side: THREE.DoubleSide, normalScale: new THREE.Vector2(1.2, 1.2) }))
    .material('wood', () => pb(P.wood))
    .material('woodLight', () => pb(P.wood, { color: 0xe8b47a }))
    .material('floor', () => std({ map: t.redFloor, roughness: 0.28, metalness: 0.05 }))
    .material('stone', () => pb(P.concrete, { color: 0xd8cfbf }))
    .material('gopuram', () => pb(P.carved, { color: 0xe6d6b8 }))
    .material('gopuramDark', () => pb(P.carved, { color: 0x8a7a62 }))
    .material('gold', () => std({ color: 0xd8a93b, metalness: 1, roughness: 0.28 }))
    .material('copper', () => std({ color: 0x8c5636, metalness: 0.75, roughness: 0.45 }))
    .material('brass', () => std({ color: 0xc09a3a, metalness: 1, roughness: 0.35 }))
    .material('white', () => std({ color: 0xf3f2ec, roughness: 0.6 }))
    .material('red', () => std({ color: 0xb02a1f, roughness: 0.6 }))
    .material('black', () => std({ color: 0x1d1d1f, roughness: 0.6 }))
    .material('concrete', () => pb(P.concrete))
    .material('metal', () => std({ color: 0x7f868e, metalness: 0.7, roughness: 0.4 }))
    .material('plasticBlue', () => std({ color: 0x1e5bbf, roughness: 0.45 }))
    .material('plasticRed', () => std({ color: 0xc0262b, roughness: 0.45 }))
    .material('road', () => pb(P.road), false)
    .material('windowGlass', () => std({ color: 0x1b2a33, metalness: 0.85, roughness: 0.07 }), false)
    .material('lamp', () => new THREE.MeshBasicMaterial({ color: 0xfff6dd }), false)
    .material('thatch', () => std({ map: t.thatch, roughness: 0.95, side: THREE.DoubleSide }))
    .material('fabric', () => std({ color: 0x9b2335, roughness: 0.95 }))
    .material('banana', () => std({ color: 0xe4c53a, roughness: 0.7 }))
    .material('glass', () => std({ color: 0xcfe6ee, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.4 }), false);
}

// ── geometry helpers ─────────────────────────────────────────────────────────

/** Kerala hip roof: eaves at y=0 around (w+2o)×(d+2o), ridge at height h. UVs in metres. */
function hipRoof(w: number, d: number, h: number, o: number): THREE.BufferGeometry {
  if (d > w) return hipRoof(d, w, h, o).rotateY(Math.PI / 2);
  const W = w / 2 + o;
  const D = d / 2 + o;
  const r = (w - d) / 2; // ridge half-length along X
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const pos: number[] = [];
  const uv: number[] = [];
  const S = 1.6; // texture metres
  const face = (pts: THREE.Vector3[]) => {
    const a = pts[0];
    const e = pts[1].clone().sub(a).normalize();
    const c = pts[2].clone().sub(a);
    const up = c.sub(e.clone().multiplyScalar(c.dot(e))).normalize();
    const tri = (p: THREE.Vector3[]) => {
      for (const q of p) {
        const dq = q.clone().sub(a);
        pos.push(q.x, q.y, q.z);
        uv.push(dq.dot(e) / S, -dq.dot(up) / S);
      }
    };
    tri([pts[0], pts[1], pts[2]]);
    if (pts.length === 4) tri([pts[0], pts[2], pts[3]]);
  };
  face([V(-W, 0, D), V(W, 0, D), V(r, h, 0), V(-r, h, 0)]); // south
  face([V(W, 0, -D), V(-W, 0, -D), V(-r, h, 0), V(r, h, 0)]); // north
  face([V(W, 0, D), V(W, 0, -D), V(r, h, 0)]); // east
  face([V(-W, 0, -D), V(-W, 0, D), V(-r, h, 0)]); // west
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Local building frame: front (door) faces local +Z. Returns the world yaw for a door side. */
const sideYaw = (s: Side) => ({ s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 })[s];

class Frame {
  readonly cos: number;
  readonly sin: number;
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly yaw: number,
  ) {
    this.cos = Math.cos(yaw);
    this.sin = Math.sin(yaw);
  }
  /** local (lx, lz) → world (x, z): rotation by yaw about +Y. */
  p(lx: number, lz: number): [number, number] {
    return [this.x + lx * this.cos + lz * this.sin, this.z - lx * this.sin + lz * this.cos];
  }
  box(b: Batcher, key: string, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, o: { collide?: boolean; uv?: number; ry?: number; rx?: number; rz?: number } = {}) {
    const [x, z] = this.p(lx, lz);
    b.box(key, x, this.y + ly, z, sx, sy, sz, { ...o, ry: this.yaw + (o.ry ?? 0) });
  }
  cyl(b: Batcher, key: string, lx: number, ly: number, lz: number, rt: number, rb: number, h: number, o: { seg?: number; collide?: boolean } = {}) {
    const [x, z] = this.p(lx, lz);
    b.cyl(key, x, this.y + ly, z, rt, rb, h, o);
  }
  geo(b: Batcher, key: string, g: THREE.BufferGeometry, lx: number, ly: number, lz: number, ry = 0) {
    const [x, z] = this.p(lx, lz);
    b.add(key, g, b.tf(x, this.y + ly, z, this.yaw + ry));
  }
}

/**
 * Four walls around a local rect (front = +Z). Doorway in the front wall at `doorX`.
 * Wooden window frames are added on the outside faces.
 */
function walls(b: Batcher, f: Frame, key: string, W: number, D: number, h: number, t: number, door: { x: number; w: number; h: number }, windows = true) {
  const hw = W / 2;
  const hd = D / 2;
  // back + sides
  f.box(b, key, 0, h / 2, -hd + t / 2, W, h, t, { collide: true, uv: 2 });
  f.box(b, key, -hw + t / 2, h / 2, 0, t, h, D - 2 * t, { collide: true, uv: 2 });
  f.box(b, key, hw - t / 2, h / 2, 0, t, h, D - 2 * t, { collide: true, uv: 2 });
  // front, split around the door
  const l0 = -hw;
  const l1 = door.x - door.w / 2;
  const r0 = door.x + door.w / 2;
  const r1 = hw;
  if (l1 - l0 > 0.05) f.box(b, key, (l0 + l1) / 2, h / 2, hd - t / 2, l1 - l0, h, t, { collide: true, uv: 2 });
  if (r1 - r0 > 0.05) f.box(b, key, (r0 + r1) / 2, h / 2, hd - t / 2, r1 - r0, h, t, { collide: true, uv: 2 });
  f.box(b, key, door.x, (door.h + h) / 2, hd - t / 2, door.w, h - door.h, t, { collide: true, uv: 2 });
  // door frame
  f.box(b, 'wood', door.x - door.w / 2 - 0.05, door.h / 2, hd - t / 2, 0.1, door.h, t + 0.04);
  f.box(b, 'wood', door.x + door.w / 2 + 0.05, door.h / 2, hd - t / 2, 0.1, door.h, t + 0.04);
  f.box(b, 'wood', door.x, door.h + 0.05, hd - t / 2, door.w + 0.2, 0.1, t + 0.04);

  if (!windows) return;
  const win = (lx: number, lz: number, ry: number) => {
    const [x, z] = f.p(lx, lz);
    const yaw = f.yaw + ry;
    const fx = Math.sin(yaw) * 0.02;
    const fz = Math.cos(yaw) * 0.02;
    b.box('wood', x + fx, f.y + 1.55, z + fz, 1.0, 1.15, 0.06, { ry: yaw });
    b.box('windowGlass', x + fx * 2, f.y + 1.55, z + fz * 2, 0.82, 0.97, 0.04, { ry: yaw });
    for (let k = -1; k <= 1; k++) {
      const ox = Math.cos(yaw) * k * 0.22;
      const oz = -Math.sin(yaw) * k * 0.22;
      b.box('metal', x + fx * 3 + ox, f.y + 1.55, z + fz * 3 + oz, 0.03, 0.95, 0.03, { ry: yaw });
    }
  };
  for (let lx = -hw + 1.6; lx <= hw - 1.6; lx += 2.6) {
    win(lx, -hd - 0.01, Math.PI);
    if (Math.abs(lx - door.x) > door.w / 2 + 0.9) win(lx, hd + 0.01, 0);
  }
  for (let lz = -hd + 1.8; lz <= hd - 1.8; lz += 2.8) {
    win(-hw - 0.01, lz, -Math.PI / 2);
    win(hw + 0.01, lz, Math.PI / 2);
  }
}

/** Plastic chair (Kerala meeting-hall classic). Origin at floor, facing local +Z. */
function chair(b: Batcher, f: Frame, key: string, lx: number, lz: number, ry: number) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const at = (ox: number, oz: number): [number, number] => [lx + ox * c + oz * s, lz - ox * s + oz * c];
  let [x, z] = at(0, 0);
  f.box(b, key, x, 0.45, z, 0.44, 0.045, 0.42, { ry });
  [x, z] = at(0, -0.22);
  f.box(b, key, x, 0.72, z, 0.44, 0.42, 0.04, { ry, rx: -0.12 });
  for (const [ox, oz] of [[-0.19, 0.18], [0.19, 0.18], [-0.19, -0.18], [0.19, -0.18]]) {
    [x, z] = at(ox, oz);
    f.cyl(b, key, x, 0.22, z, 0.018, 0.018, 0.45, { seg: 6 });
  }
}

/** Wooden bench, origin at floor, facing local +Z. Registers seats. */
function bench(b: Batcher, f: Frame, lx: number, lz: number, ry: number, len: number, seats: number) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  f.box(b, 'woodLight', lx, 0.44, lz, c * len + Math.abs(s) * 0.42, 0.06, Math.abs(s) * len + Math.abs(c) * 0.42, { collide: true });
  for (const k of [-1, 1]) f.box(b, 'wood', lx + c * k * (len / 2 - 0.12), 0.21, lz - s * k * (len / 2 - 0.12), 0.08, 0.42, 0.08, { ry });
  for (let i = 0; i < seats; i++) {
    const o = (i - (seats - 1) / 2) * (len / seats);
    const [x, z] = f.p(lx + c * o, lz - s * o);
    addSeat(x, f.y + 0.47, z, f.yaw + ry);
  }
}

function signBoard(scene: THREE.Object3D, text: string, sub: string | undefined, x: number, y: number, z: number, yaw: number, w = 4, bg?: string, fg?: string) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), new THREE.MeshStandardMaterial({ map: signTexture(text, bg, fg, sub), roughness: 0.7 }));
  m.position.set(x, y, z);
  m.rotation.y = yaw;
  scene.add(m);
}

// ── buildings ─────────────────────────────────────────────────────────────────

function house(b: Batcher, t: Terrain, def: BuildingDef) {
  const yaw = sideYaw(def.door);
  const W = def.door === 'e' || def.door === 'w' ? def.d : def.w;
  const D = def.door === 'e' || def.door === 'w' ? def.w : def.d;
  const g = t.heightAt(def.x, def.z);
  const plinth = 0.42;
  const f = new Frame(def.x, g, def.z, yaw);
  const fl = new Frame(def.x, g + plinth, def.z, yaw);
  const ver = 2.4; // verandah (poomukham) depth at the front
  const coreD = D - ver;
  const coreZ = -ver / 2;
  const h = 2.9;

  f.box(b, 'laterite', 0, plinth / 2, 0, W, plinth, D, { collide: true, uv: 1.5 });
  f.box(b, 'laterite', 0, 0.11, D / 2 + 0.35, 1.8, 0.22, 0.7, { collide: true }); // step
  fl.box(b, 'floor', 0, 0.01, 0, W - 0.1, 0.02, D - 0.1, { uv: 2 });

  const [ccx, ccz] = fl.p(0, coreZ);
  const core = new Frame(ccx, fl.y, ccz, yaw);
  walls(b, core, 'plaster', W, coreD, h, 0.24, { x: 0, w: 1.1, h: 2.15 });
  // Open door leaf, swung inside.
  core.box(b, 'wood', 0.55 - 0.03, 1.07, coreD / 2 - 0.62, 0.05, 2.1, 1.0);

  // Verandah pillars and half wall.
  for (const lx of [-W / 2 + 0.25, -W / 6, W / 6, W / 2 - 0.25]) {
    fl.box(b, 'laterite', lx, 0.2, D / 2 - 0.25, 0.34, 0.4, 0.34);
    fl.cyl(b, 'wood', lx, 0.4 + (h - 0.4) / 2, D / 2 - 0.25, 0.09, 0.11, h - 0.4, { seg: 10, collide: true });
  }
  bench(b, fl, -W / 2 + 1.6, coreZ + coreD / 2 + 0.55, 0, 1.6, 2);

  // Roof with the front gable (mukhappu).
  const rh = Math.min(W, D) * 0.48;
  fl.geo(b, 'roof', hipRoof(W, D, rh, 0.75), 0, h - 0.05, 0);
  const gw = 2.6;
  const gable = new THREE.BufferGeometry();
  gable.setAttribute('position', new THREE.Float32BufferAttribute([-gw / 2, 0, 0, gw / 2, 0, 0, 0, 1.3, 0], 3));
  gable.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
  const gy = h + 0.5;
  fl.geo(b, 'wood', gable, 0, gy, D / 2 + 0.3);
  const ga = Math.atan2(1.3, gw / 2);
  const gl = Math.hypot(1.3, gw / 2) + 0.25;
  for (const sx of [-1, 1]) fl.box(b, 'roof', sx * (gw / 4 + 0.05), gy + 0.62, D / 2 - 0.55, gl, 0.07, 1.9, { rz: -sx * ga });

  // Interior: cot, table, almirah.
  core.box(b, 'wood', -W / 2 + 1.3, 0.25, -coreD / 2 + 1.2, 1.9, 0.5, 1.0, { collide: true });
  core.box(b, 'fabric', -W / 2 + 1.3, 0.53, -coreD / 2 + 1.2, 1.8, 0.06, 0.9);
  core.box(b, 'wood', W / 2 - 1.2, 1.0, -coreD / 2 + 0.5, 1.6, 2.0, 0.55, { collide: true });
  core.box(b, 'woodLight', 0.8, 0.38, -0.3, 1.2, 0.05, 0.7, { collide: true });
  for (const [ox, oz] of [[-0.5, -0.3], [0.5, -0.3], [-0.5, 0.3], [0.5, 0.3]]) core.box(b, 'wood', 0.8 + ox, 0.18, -0.3 + oz * 0.9, 0.05, 0.36, 0.05);

  const [ix0, iz0] = core.p(-W / 2 + 0.24, -coreD / 2 + 0.24);
  const [ix1, iz1] = core.p(W / 2 - 0.24, coreD / 2 - 0.24);
  addRoom({ name: def.id, r: { x0: Math.min(ix0, ix1), z0: Math.min(iz0, iz1), x1: Math.max(ix0, ix1), z1: Math.max(iz0, iz1) }, y0: fl.y, y1: fl.y + h, soundproof: false });
  compoundWall(b, t, def, W, D, yaw, 0);
}

function meetingHall(b: Batcher, scene: THREE.Object3D, t: Terrain, def: BuildingDef) {
  const yaw = sideYaw(def.door);
  const W = def.door === 'e' || def.door === 'w' ? def.d : def.w;
  const D = def.door === 'e' || def.door === 'w' ? def.w : def.d;
  const g = t.heightAt(def.x, def.z);
  const plinth = 0.45;
  const h = 4.6;
  const f = new Frame(def.x, g, def.z, yaw);
  const fl = new Frame(def.x, g + plinth, def.z, yaw);

  f.box(b, 'laterite', 0, plinth / 2, 0, W + 0.4, plinth, D + 0.4, { collide: true, uv: 1.5 });
  f.box(b, 'laterite', 0, 0.12, D / 2 + 0.6, 3.4, 0.24, 0.8, { collide: true });
  fl.box(b, 'floor', 0, 0.01, 0, W, 0.02, D, { uv: 2 });
  walls(b, fl, 'plaster', W, D, h, 0.3, { x: 0, w: 2.4, h: 2.7 });
  // Double doors, swung open.
  fl.box(b, 'wood', -1.17, 1.33, D / 2 - 0.9, 0.06, 2.6, 1.15);
  fl.box(b, 'wood', 1.17, 1.33, D / 2 - 0.9, 0.06, 2.6, 1.15);
  // Ceiling + roof.
  fl.box(b, 'plaster', 0, h + 0.04, 0, W, 0.08, D);
  fl.geo(b, 'roof', hipRoof(W, D, W * 0.42, 0.9), 0, h + 0.05, 0);

  // Stage at the back, with steps.
  const stageD = 3.6;
  const sz = -D / 2 + 0.3 + stageD / 2;
  fl.box(b, 'woodLight', 0, 0.3, sz, W - 0.6, 0.6, stageD, { collide: true, uv: 1 });
  fl.box(b, 'woodLight', 0, 0.15, sz + stageD / 2 + 0.3, 2.2, 0.3, 0.6, { collide: true });
  fl.box(b, 'fabric', 0, 2.6, -D / 2 + 0.34, W * 0.55, 1.8, 0.04); // backdrop cloth
  const [bx, bz] = fl.p(0, -D / 2 + 0.37);
  signBoard(scene, 'GRAMA SABHA', 'Welcome to the meeting', bx, fl.y + 3.95, bz, yaw, 4.6, '#7a1f2b', '#ffe8a8');

  // Lectern with the hall mic.
  const lz = sz + 0.4;
  fl.box(b, 'wood', 0, 0.6 + 0.55, lz, 0.8, 1.1, 0.5, { collide: true });
  fl.box(b, 'wood', 0, 0.6 + 1.15, lz - 0.05, 0.9, 0.06, 0.6, { rx: -0.25 });
  fl.cyl(b, 'black', 0.25, 0.6 + 1.4, lz + 0.12, 0.008, 0.008, 0.45, { seg: 5 });
  fl.cyl(b, 'black', 0.25, 0.6 + 1.64, lz + 0.18, 0.025, 0.02, 0.09, { seg: 8 });
  const [mx, mz] = fl.p(0, lz - 0.6);
  // Table with chairs for dignitaries.
  fl.box(b, 'fabric', 2.6, 0.6 + 0.38, sz - 0.6, 2.4, 0.76, 0.8, { collide: true });
  const stageF = new Frame(fl.x, fl.y + 0.6, fl.z, yaw);
  for (const ox of [1.9, 2.6, 3.3]) chair(b, stageF, 'plasticRed', ox, sz - 1.35, 0);

  const hallRoom = addRoom({ name: 'Meeting hall', r: (() => {
    const [x0, z0] = fl.p(-W / 2 + 0.3, -D / 2 + 0.3);
    const [x1, z1] = fl.p(W / 2 - 0.3, D / 2 - 0.3);
    return { x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1) };
  })(), y0: fl.y, y1: fl.y + h, soundproof: true });
  const pa = addPA({ name: 'Hall mic', mic: [mx, fl.y + 0.6, mz], micRadius: 1.3, room: hallRoom, ref: 4, max: 26 });

  // Hall speakers: on stands at the stage front, and high on the back wall.
  for (const sx of [-1, 1]) {
    const lx = sx * (W / 2 - 1.0);
    const lzS = sz + stageD / 2 - 0.4;
    fl.cyl(b, 'black', lx, 0.6 + 0.8, lzS, 0.025, 0.04, 1.6, { seg: 6 });
    fl.box(b, 'black', lx, 0.6 + 1.95, lzS, 0.45, 0.7, 0.38);
    const [x, z] = fl.p(lx, lzS);
    registry.speakers.push({ pa, x, y: fl.y + 2.5, z });
    const bz = D / 2 - 0.5;
    fl.box(b, 'black', lx, h - 0.6, bz, 0.4, 0.55, 0.35);
    const [x2, z2] = fl.p(lx, bz);
    registry.speakers.push({ pa, x: x2, y: fl.y + h - 0.6, z: z2 });
  }

  // Rows of plastic chairs facing the stage, with a centre aisle.
  for (let r = 0; r < 8; r++) {
    const lzr = sz + stageD / 2 + 2.2 + r * 1.08;
    if (lzr > D / 2 - 1.6) break;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const lx = side * (0.95 + i * 0.7);
        chair(b, fl, r % 2 ? 'plasticRed' : 'plasticBlue', lx, lzr, Math.PI);
        const [x, z] = fl.p(lx, lzr);
        addSeat(x, fl.y + 0.47, z, yaw + Math.PI);
      }
    }
  }

  // Tube lights on the side walls (emissive) and ceiling fans (animated).
  for (const lzT of [-D / 4, D / 4]) {
    fl.box(b, 'lamp', -W / 2 + 0.33, h - 1.0, lzT, 0.05, 0.05, 1.2);
    fl.box(b, 'lamp', W / 2 - 0.33, h - 1.0, lzT, 0.05, 0.05, 1.2);
  }
  const fanMat = std({ color: 0xe8e4da, roughness: 0.5 });
  for (const lzF of [-D / 4 + 1, D / 6, D / 2 - 3]) {
    const [x, z] = fl.p(0, lzF);
    const fan = new THREE.Group();
    fan.position.set(x, fl.y + h - 0.75, z);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 6), fanMat);
    rod.position.y = 0.38;
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.12, 16), fanMat);
    const blades = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const bl = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.012, 0.11), fanMat);
      bl.position.x = 0.42;
      const arm = new THREE.Group();
      arm.rotation.y = (k * 2 * Math.PI) / 3;
      arm.add(bl);
      blades.add(arm);
    }
    fan.add(rod, motor, blades);
    scene.add(fan);
    const speed = 7 + k3(lzF);
    registry.animators.push((_t, dt) => (blades.rotation.y += dt * speed));
  }

  // Sign above the door outside.
  const [sx, szs] = fl.p(0, D / 2 + 0.2);
  signBoard(scene, 'COMMUNITY HALL', 'Panchayat Meeting Hall', sx, fl.y + 3.4, szs, yaw, 4.2);
}
const k3 = (v: number) => (Math.abs(Math.sin(v * 12.9898)) * 2) | 0;

function teaShop(b: Batcher, scene: THREE.Object3D, t: Terrain, def: BuildingDef) {
  const yaw = sideYaw(def.door);
  const W = def.w;
  const D = def.d;
  const g = t.heightAt(def.x, def.z);
  const fl = new Frame(def.x, g + 0.3, def.z, yaw);
  const f = new Frame(def.x, g, def.z, yaw);
  const h = 2.7;
  f.box(b, 'concrete', 0, 0.15, 0, W, 0.3, D, { collide: true });
  // Back and side walls only; the front is open with a counter.
  fl.box(b, 'plaster', 0, h / 2, -D / 2 + 0.12, W, h, 0.24, { collide: true, uv: 2 });
  fl.box(b, 'plaster', -W / 2 + 0.12, h / 2, 0, 0.24, h, D, { collide: true, uv: 2 });
  fl.box(b, 'plaster', W / 2 - 0.12, h / 2, 0, 0.24, h, D, { collide: true, uv: 2 });
  fl.box(b, 'woodLight', -0.8, 0.5, D / 2 - 0.8, W - 2.4, 1.0, 0.55, { collide: true });
  fl.geo(b, 'roof', hipRoof(W, D, 1.4, 0.9), 0, h, 0);
  // Glass jars of snacks + a brass samovar on the counter.
  for (let i = 0; i < 5; i++) fl.cyl(b, 'glass', -2.6 + i * 0.55, 1.17, D / 2 - 0.8, 0.14, 0.14, 0.32, { seg: 10 });
  fl.cyl(b, 'brass', 0.6, 1.3, D / 2 - 0.9, 0.18, 0.22, 0.6, { seg: 14 });
  fl.cyl(b, 'brass', 0.6, 1.68, D / 2 - 0.9, 0.05, 0.16, 0.18, { seg: 14 });
  // Banana bunches hanging at the front.
  for (const lx of [-2.2, -1.2]) {
    fl.cyl(b, 'wood', lx, h - 0.35, D / 2 - 0.3, 0.02, 0.02, 0.7, { seg: 5 });
    for (let k = 0; k < 14; k++) {
      const a = k * 1.9;
      const cap = new THREE.CapsuleGeometry(0.035, 0.16, 3, 6);
      fl.geo(b, 'banana', cap, lx + Math.cos(a) * 0.12, h - 0.75 - (k % 5) * 0.07, D / 2 - 0.3 + Math.sin(a) * 0.12, a);
    }
  }
  // Benches outside.
  bench(b, f, -1.3, D / 2 + 1.1, Math.PI, 2.2, 3);
  bench(b, f, 1.6, D / 2 + 1.1, Math.PI, 2.2, 3);
  const [x, z] = fl.p(0, D / 2 + 0.4);
  signBoard(scene, 'CHAYA • KAAPI', 'Tea · Coffee · Pazham pori', x, fl.y + 2.5, z, yaw, 3.6, '#f2d33b', '#2a2310');
}

function temple(b: Batcher, t: Terrain) {
  const T = TEMPLE;
  const g = t.heightAt(T.x, T.z);
  const half = T.size / 2;
  const wallH = 3;
  const wt = 0.8;
  const gateW = 7;
  // Compound wall (mathilakam), gate opening on the east side.
  b.box('laterite', T.x, g + wallH / 2, T.z - half, T.size, wallH, wt, { collide: true, uv: 1.5 });
  b.box('laterite', T.x, g + wallH / 2, T.z + half, T.size, wallH, wt, { collide: true, uv: 1.5 });
  b.box('laterite', T.x - half, g + wallH / 2, T.z, wt, wallH, T.size, { collide: true, uv: 1.5 });
  const seg = (T.size - gateW) / 2;
  b.box('laterite', T.x + half, g + wallH / 2, T.z - gateW / 2 - seg / 2, wt, wallH, seg, { collide: true, uv: 1.5 });
  b.box('laterite', T.x + half, g + wallH / 2, T.z + gateW / 2 + seg / 2, wt, wallH, seg, { collide: true, uv: 1.5 });
  for (const [x, z, sx, sz] of [[T.x, T.z - half, T.size, wt], [T.x, T.z + half, T.size, wt], [T.x - half, T.z, wt, T.size]] as const)
    b.box('white', x, g + wallH + 0.12, z, sx + 0.1, 0.24, sz + 0.1);

  // Gopuram over the east gate: Padmanabhaswamy-style seven-tier tower.
  const gx = TEMPLE_GATE.x;
  const gz = TEMPLE_GATE.z;
  const baseH = 7;
  const depth = 9;
  const width = 17;
  const pass = 4.4;
  const sideW = (width - pass) / 2;
  b.box('gopuram', gx, g + baseH / 2, gz - pass / 2 - sideW / 2, depth, baseH, sideW, { collide: true, uv: 2 });
  b.box('gopuram', gx, g + baseH / 2, gz + pass / 2 + sideW / 2, depth, baseH, sideW, { collide: true, uv: 2 });
  b.box('gopuram', gx, g + 5.6 + (baseH - 5.6) / 2, gz, depth, baseH - 5.6, pass, { collide: true, uv: 2 });
  b.box('gold', gx + depth / 2 + 0.02, g + 5.3, gz, 0.04, 0.5, pass); // brass-clad lintel
  let y = g + baseH;
  let d = depth * 0.92;
  let w = width * 0.92;
  for (let tier = 0; tier < 7; tier++) {
    const th = 2.45;
    b.box('gopuram', gx, y + th / 2, gz, d, th, w, { uv: 2 });
    b.box('gopuramDark', gx, y + 0.12, gz, d + 0.5, 0.24, w + 0.5); // cornice
    // niches on the east and west faces, and the corner pavilions
    const n = 7 - Math.floor(tier / 2);
    for (let k = 0; k < n; k++) {
      const oz = -w / 2 + ((k + 0.5) * w) / n;
      b.box('gopuramDark', gx + d / 2 + 0.04, y + th * 0.55, gz + oz, 0.12, th * 0.55, (w / n) * 0.45);
      b.box('gopuramDark', gx - d / 2 - 0.04, y + th * 0.55, gz + oz, 0.12, th * 0.55, (w / n) * 0.45);
    }
    for (const [ox, oz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) b.box('gopuram', gx + ox * (d / 2), y + th * 0.75, gz + oz * (w / 2), 0.7, 0.7, 0.7);
    y += th;
    d *= 0.9;
    w *= 0.86;
  }
  // Wagon-vault crown (shala) with seven golden kalasams.
  const vault = new THREE.CylinderGeometry(d / 2, d / 2, w, 16, 1, false, -Math.PI / 2, Math.PI);
  b.add('gopuram', vault, b.tf(gx, y, gz, 0, Math.PI / 2, 0));
  for (let k = 0; k < 7; k++) {
    const oz = -w / 2 + 0.5 + (k * (w - 1)) / 6;
    b.cyl('gold', gx, y + d / 2 + 0.35, gz + oz, 0.05, 0.22, 0.7, { seg: 10 });
    b.add('gold', new THREE.SphereGeometry(0.2, 10, 8), b.tf(gx, y + d / 2 + 0.25, gz + oz));
  }

  // Round sreekovil (sanctum) with a conical copper roof.
  const sx = T.x - 7;
  b.cyl('stone', sx, g + 0.35, T.z, 5.2, 5.4, 0.7, { seg: 32, collide: true });
  b.cyl('plaster', sx, g + 0.7 + 1.7, T.z, 4.2, 4.2, 3.4, { seg: 32, collide: true });
  b.cyl('laterite', sx, g + 0.7 + 0.5, T.z, 4.25, 4.25, 1.0, { seg: 32 });
  b.cyl('copper', sx, g + 4.1 + 2.4, T.z, 0.2, 6.2, 4.8, { seg: 32 });
  b.cyl('gold', sx, g + 9.1, T.z, 0.06, 0.32, 1.2, { seg: 12 });
  b.box('wood', sx + 4.2, g + 0.7 + 1.1, T.z, 0.2, 2.2, 1.3); // sanctum door
  b.box('stone', sx + 5.7, g + 0.17, T.z, 1.0, 0.35, 2.2, { collide: true });

  // Namaskara mandapam: pillared pavilion with a pyramid roof.
  const mx = T.x + 7;
  b.box('stone', mx, g + 0.3, T.z, 6, 0.6, 6, { collide: true });
  for (const ox of [-2.6, -0.9, 0.9, 2.6])
    for (const oz of [-2.6, 2.6]) {
      b.cyl('wood', mx + ox, g + 0.6 + 1.5, T.z + oz, 0.12, 0.14, 3, { seg: 10 });
      b.cyl('wood', mx + oz, g + 0.6 + 1.5, T.z + ox, 0.12, 0.14, 3, { seg: 10 });
    }
  b.add('copper', hipRoof(6, 6, 2.8, 0.7), b.tf(mx, g + 3.6, T.z));
  b.cyl('gold', mx, g + 6.6, T.z, 0.05, 0.22, 0.7, { seg: 10 });

  // Kodimaram (golden flagstaff) and balikkallu.
  const fx = T.x + 15;
  b.box('stone', fx, g + 0.6, T.z, 2, 1.2, 2, { collide: true });
  b.cyl('gold', fx, g + 1.2 + 7, T.z, 0.12, 0.22, 14, { seg: 14 });
  for (let k = 0; k < 14; k++) b.cyl('gold', fx, g + 2 + k * 0.9, T.z, 0.3, 0.3, 0.06, { seg: 14 });
  b.box('gold', fx, g + 15.4, T.z, 0.15, 0.6, 0.9);
  b.box('stone', T.x + 11, g + 0.4, T.z, 1.2, 0.8, 1.2, { collide: true });

  // Deepasthambam: brass tiered lamp tower outside the gate.
  const dx = gx + 8;
  b.box('stone', dx, g + 0.4, gz, 1.6, 0.8, 1.6, { collide: true });
  b.cyl('brass', dx, g + 0.8 + 3.2, gz, 0.12, 0.25, 6.4, { seg: 14 });
  for (let k = 0; k < 11; k++) b.cyl('brass', dx, g + 1.4 + k * 0.52, gz, 0.95 - k * 0.07, 0.95 - k * 0.07, 0.05, { seg: 20 });
  b.cyl('brass', dx, g + 7.4, gz, 0.02, 0.18, 0.5, { seg: 10 });

  // Padma theertham: the stepped temple pond.
  const P = TEMPLE_POND;
  const top = t.heightAt(P.x0 - 3, (P.z0 + P.z1) / 2);
  const bottom = -2.2;
  const step = 0.3;
  const tread = 0.55;
  const n = Math.ceil((top - (WATER_Y - 1.6)) / step);
  for (let k = 0; k < n; k++) {
    const inset = k * tread;
    const yTop = top - k * step;
    const hgt = yTop - bottom;
    const cy = bottom + hgt / 2;
    const x0 = P.x0 + inset;
    const x1 = P.x1 - inset;
    const z0 = P.z0 + inset;
    const z1 = P.z1 - inset;
    if (x1 - x0 < 2 || z1 - z0 < 2) break;
    b.box('laterite', (x0 + x1) / 2, cy, z0 + tread / 2, x1 - x0, hgt, tread, { collide: true, uv: 1.2 });
    b.box('laterite', (x0 + x1) / 2, cy, z1 - tread / 2, x1 - x0, hgt, tread, { collide: true, uv: 1.2 });
    b.box('laterite', x0 + tread / 2, cy, (z0 + z1) / 2, tread, hgt, z1 - z0 - 2 * tread, { collide: true, uv: 1.2 });
    b.box('laterite', x1 - tread / 2, cy, (z0 + z1) / 2, tread, hgt, z1 - z0 - 2 * tread, { collide: true, uv: 1.2 });
  }
}

function lighthouse(b: Batcher, scene: THREE.Object3D, t: Terrain) {
  const { x, z } = LIGHTHOUSE;
  const g = t.heightAt(x, z) - 0.3;
  const H = 30;
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const y0 = (i * H) / bands;
    const r0 = 3.3 - (1.2 * y0) / H;
    const r1 = 3.3 - (1.2 * (y0 + H / bands)) / H;
    b.cyl(i % 2 ? 'red' : 'white', x, g + y0 + H / bands / 2, z, r1, r0, H / bands, { seg: 28, collide: i === 0 });
  }
  b.cyl('black', x, g + H + 0.2, z, 3.0, 3.0, 0.4, { seg: 28 });
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    b.box('black', x + Math.cos(a) * 2.85, g + H + 0.9, z + Math.sin(a) * 2.85, 0.06, 1.0, 0.06);
  }
  b.add('black', new THREE.TorusGeometry(2.85, 0.05, 6, 40), b.tf(x, g + H + 1.4, z, 0, Math.PI / 2));
  b.add('red', new THREE.SphereGeometry(1.75, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), b.tf(x, g + H + 2.7, z));
  b.cyl('black', x, g + H + 4.6, z, 0.05, 0.15, 0.8, { seg: 8 });
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(1.6, 1.6, 2.2, 20, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffd27a, emissiveIntensity: 1.5, transparent: true, opacity: 0.75 }),
  );
  glass.position.set(x, g + H + 1.6, z);
  scene.add(glass);
  // Rotating beams.
  const beams = new THREE.Group();
  beams.position.set(x, g + H + 1.6, z);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff1b8, transparent: true, opacity: 0.035, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true });
  for (const s of [1, -1]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(3, 46, 20, 1, true), beamMat);
    cone.rotation.z = (s * Math.PI) / 2;
    cone.position.x = s * 23;
    beams.add(cone);
  }
  scene.add(beams);
  registry.animators.push((_t, dt) => (beams.rotation.y += dt * 0.5));
  // Keeper's cottage.
  const f = new Frame(x + 9, t.heightAt(x + 9, z + 4), z + 4, Math.PI / 2);
  f.box(b, 'white', 0, 1.4, 0, 6, 2.8, 4.5, { collide: true });
  f.geo(b, 'roof', hipRoof(6, 4.5, 1.8, 0.5), 0, 2.8, 0);
}

function fishingNets(scene: THREE.Object3D, b: Batcher) {
  const t = textures();
  const netMat = new THREE.MeshStandardMaterial({ map: t.net, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9, color: 0x6a6a5a });
  const teak = std({ map: t.wood, roughness: 0.8 });
  const ropeMat = std({ color: 0x9b8a62 });
  const stoneMat = std({ color: 0x6f6a62 });
  FISHING_NET_Z.forEach((z, i) => {
    const sx = coastX(z);
    const deckY = 1.3;
    // Platform out into the sea, on piles.
    b.box('woodLight', sx - 3, deckY - 0.1, z, 14, 0.2, 3.2, { collide: true, uv: 1 });
    for (let px = sx + 3; px >= sx - 9; px -= 2.4)
      for (const oz of [-1.4, 1.4]) b.cyl('wood', px, deckY - 2.5, z + oz, 0.11, 0.13, 5, { seg: 6 });
    // A-frame pivot.
    const pivotX = sx - 7.5;
    const pivotY = deckY + 3.4;
    for (const oz of [-0.9, 0.9]) b.cyl('wood', pivotX, deckY + 1.7, z + oz, 0.08, 0.12, 3.6, { seg: 6 });

    const boom = new THREE.Group();
    boom.position.set(pivotX, pivotY, z);
    const pole = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, mat = teak) => {
      const a = new THREE.Vector3(ax, ay, az);
      const c = new THREE.Vector3(bx, by, bz);
      const len = a.distanceTo(c);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r, len, 6), mat);
      m.position.copy(a).add(c).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize());
      m.castShadow = true;
      boom.add(m);
    };
    // Main spar: long arm over the sea (−X), short arm with counterweights over the deck (+X).
    pole(-12, 2.2, 0, 6, -1.6, 0, 0.16);
    // Net frame: four spars fanning from the tip down to the net corners.
    const tip = new THREE.Vector3(-12, 2.2, 0);
    const corners = [[-17, -4.8, -4.5], [-17, -4.8, 4.5], [-8, -4.8, -4.5], [-8, -4.8, 4.5]];
    for (const [cx, cy, cz] of corners) pole(tip.x, tip.y, tip.z, cx, cy, cz, 0.07);
    const netGeo = new THREE.PlaneGeometry(9, 9, 8, 8);
    netGeo.rotateX(-Math.PI / 2);
    const pos = netGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const u = pos.getX(k) / 4.5;
      const v = pos.getZ(k) / 4.5;
      pos.setY(k, -1.2 * (1 - u * u) * (1 - v * v)); // sags in the middle
    }
    netGeo.computeVertexNormals();
    const net = new THREE.Mesh(netGeo, netMat);
    net.position.set(-12.5, -4.8, 0);
    boom.add(net);
    // Ropes with stone counterweights.
    for (let k = 0; k < 6; k++) {
      const rx = 1.2 + k * 0.85;
      const ry = -0.4 - k * 0.21;
      pole(rx, ry, 0, rx, ry - 1.6 - (k % 3) * 0.3, 0, 0.015, ropeMat);
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22), stoneMat);
      st.position.set(rx, ry - 1.8 - (k % 3) * 0.3, 0);
      boom.add(st);
    }
    scene.add(boom);
    const phase = i * 1.7;
    registry.animators.push((time) => {
      // Slowly lower the net into the water, wait, haul it up.
      const c = 0.5 + 0.5 * Math.sin(time * 0.16 + phase);
      boom.rotation.z = -0.32 + 0.4 * c * c;
    });
  });
}

function houseboat(scene: THREE.Object3D, b: Batcher, x: number, z: number, yaw: number, docked: boolean) {
  const t = textures();
  const L = 18;
  const halfW = 2.1;
  const deckY = 0.85;
  const group = new THREE.Group();
  group.position.set(x, WATER_Y, z);
  group.rotation.y = yaw;

  // Hull: lofted cross-sections; the ends sweep up into the classic kettuvallam prow.
  const M = 40;
  const K = 10;
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i <= M; i++) {
    const s = i / M;
    const zz = (s - 0.5) * L;
    const e = Math.abs(s - 0.5) * 2;
    const wid = halfW * Math.sqrt(Math.max(0.02, 1 - e ** 3.2));
    const sheer = deckY + 1.6 * e ** 7;
    const keel = -0.55 * (1 - e ** 4) + 0.6 * e ** 7;
    for (let j = 0; j <= K; j++) {
      const a = (j / K) * Math.PI; // port top → keel → starboard top
      const xx = -Math.cos(a) * wid;
      const yy = sheer - Math.sin(a) * (sheer - keel);
      pos.push(xx, yy, zz);
      uv.push((s * L) / 2, j / K);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < M; i++)
    for (let j = 0; j < K; j++) {
      const a = i * (K + 1) + j;
      const c = a + K + 1;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  const hull = new THREE.BufferGeometry();
  hull.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hull.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  hull.setIndex(idx);
  hull.computeVertexNormals();
  const woodMat = std({ map: t.wood, color: 0x8a5a30, side: THREE.DoubleSide, roughness: 0.6 });
  const hullMesh = new THREE.Mesh(hull, woodMat);
  hullMesh.castShadow = true;
  group.add(hullMesh);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(halfW * 1.75, 0.08, L * 0.72), std({ map: t.wood, color: 0xc49a6a }));
  deck.position.y = deckY;
  group.add(deck);
  // Barrel thatch roof on wooden posts.
  const roofLen = L * 0.58;
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.95, roofLen, 20, 1, true, -Math.PI / 2, Math.PI), std({ map: t.thatch, side: THREE.DoubleSide, roughness: 0.95 }));
  roof.rotation.x = Math.PI / 2;
  roof.rotation.z = Math.PI / 2;
  roof.position.set(0, deckY + 1.15, -0.6);
  roof.scale.set(1, 1, 0.85);
  roof.castShadow = true;
  group.add(roof);
  for (let k = 0; k <= 6; k++) {
    const zz = -0.6 - roofLen / 2 + (k * roofLen) / 6;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 6), woodMat);
      post.position.set(s * 1.62, deckY + 0.65, zz);
      group.add(post);
    }
  }
  // Cabin (rear half): woven panels.
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.25, roofLen * 0.5), std({ map: t.thatch, color: 0xd9c49a }));
  cabin.position.set(0, deckY + 0.62, -0.6 - roofLen * 0.25);
  group.add(cabin);
  // Front sit-out: cushioned seats.
  for (const s of [-1, 1]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 2.4), std({ color: 0x9b2335 }));
    seat.position.set(s * 1.25, deckY + 0.2, 3.4);
    group.add(seat);
  }
  scene.add(group);
  const phase = x * 0.1 + z * 0.07;
  registry.animators.push((time) => {
    group.position.y = WATER_Y + 0.035 * Math.sin(time * 0.9 + phase);
    group.rotation.z = 0.012 * Math.sin(time * 0.7 + phase);
    group.rotation.x = 0.006 * Math.sin(time * 0.5 + phase * 2);
  });

  if (docked) {
    // Walkable: deck collider (static; the visual bob is only a few cm).
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    b.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(halfW * 0.88, 0.1, L * 0.36).setTranslation(x, WATER_Y + deckY - 0.06, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    // Seats on the front sit-out.
    for (const s of [-1, 1])
      for (const k of [-0.7, 0.7]) {
        const lx = s * 1.25;
        const lz = 3.4 + k;
        addSeat(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), WATER_Y + deckY + 0.42, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), yaw - s * (Math.PI / 2));
      }
  }
}

function roadsAndBridges(b: Batcher, t: Terrain) {
  for (const r of t.roads) {
    // Ribbon following the smoothed profile.
    const n = r.h.length;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = Math.min(i * 2, r.length);
      const p = polyAt(r.pts, s);
      const nx = -p.tz;
      const nz = p.tx;
      const y = r.h[i] + 0.0;
      pos.push(p.x + (nx * ROAD_WIDTH) / 2, y, p.z + (nz * ROAD_WIDTH) / 2, p.x - (nx * ROAD_WIDTH) / 2, y, p.z - (nz * ROAD_WIDTH) / 2);
      uv.push(0, s / ROAD_WIDTH, 1, s / ROAD_WIDTH);
      if (i < n - 1) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // make sure normals point up
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    if (nrm.getY(0) < 0) {
      for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
      g.setIndex(idx);
      g.computeVertexNormals();
    }
    b.add('road', g);

    // Bridges over the water crossings.
    for (const [s0, s1] of r.bridges) {
      const segLen = 4;
      for (let s = s0; s < s1; s += segLen) {
        const mid = Math.min(s + segLen / 2, s1);
        const p = polyAt(r.pts, mid);
        const yaw = Math.atan2(p.tx, p.tz);
        const f = Math.min(r.h.length - 1, Math.round(mid / 2));
        const top = r.h[f] - 0.02;
        b.box('concrete', p.x, top - 0.35, p.z, ROAD_WIDTH + 1.4, 0.7, segLen + 0.1, { ry: yaw, collide: true });
        for (const side of [-1, 1]) {
          const ox = Math.cos(yaw) * side * (ROAD_WIDTH / 2 + 0.5);
          const oz = -Math.sin(yaw) * side * (ROAD_WIDTH / 2 + 0.5);
          b.box('white', p.x + ox, top + 0.45, p.z + oz, 0.22, 0.9, segLen + 0.05, { ry: yaw, collide: true });
        }
        if (Math.round(s / segLen) % 2 === 0)
          for (const side of [-1, 1]) {
            const ox = Math.cos(yaw) * side * 2.4;
            const oz = -Math.sin(yaw) * side * 2.4;
            b.cyl('concrete', p.x + ox, (top - 0.7 - 3.5) / 2, p.z + oz, 0.45, 0.5, top - 0.7 + 3.5, { seg: 10 });
          }
      }
    }

  }

  // Jetty into the lake.
  const J = JETTY;
  b.box('woodLight', (J.x0 + J.x1) / 2, WATER_Y + 0.85, (J.z0 + J.z1) / 2, J.x1 - J.x0, 0.16, J.z1 - J.z0, { collide: true, uv: 1 });
  for (let zz = J.z0 + 1; zz < J.z1; zz += 2.5)
    for (const xx of [J.x0 + 0.3, J.x1 - 0.3]) b.cyl('wood', xx, WATER_Y - 1, zz, 0.12, 0.14, 3.8, { seg: 6 });
}

function viewpoint(b: Batcher, terrain: Terrain) {
  // Gazebo at the top of the hill road.
  const x = 196;
  const z = -146;
  const g = terrain.heightAt(x, z);
  const f = new Frame(x, g, z, -Math.PI * 0.75);
  f.box(b, 'stone', 0, 0.2, 0, 7, 0.4, 7, { collide: true });
  for (const [ox, oz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) f.cyl(b, 'wood', ox, 0.4 + 1.4, oz, 0.12, 0.14, 2.8, { seg: 10, collide: true });
  f.geo(b, 'roof', hipRoof(7, 7, 2.6, 0.6), 0, 3.2, 0);
  const fl = new Frame(x, g + 0.4, z, -Math.PI * 0.75);
  bench(b, fl, 0, 2.2, 0, 3, 3);
  bench(b, fl, -2.2, 0, -Math.PI / 2, 3, 3);
  for (const [lx, lz, sx, sz] of [[0, -3.4, 7, 0.1], [3.4, 0, 0.1, 7]] as const) f.box(b, 'wood', lx, 1.3, lz, sx, 0.1, sz);
}

function maidanProps(b: Batcher, t: Terrain) {
  const cx = (MAIDAN.x0 + MAIDAN.x1) / 2;
  const cz = (MAIDAN.z0 + MAIDAN.z1) / 2;
  const g = t.heightAt(cx, cz);
  // PA mic on a small dais.
  const mic: [number, number, number] = [cx, g + 0.3, cz];
  b.cyl('laterite', cx, g + 0.15, cz, 2.6, 2.8, 0.3, { seg: 28, collide: true });
  b.cyl('black', cx, g + 0.3 + 0.75, cz, 0.02, 0.02, 1.4, { seg: 6 });
  b.cyl('black', cx, g + 0.3 + 0.04, cz, 0.25, 0.3, 0.08, { seg: 16 });
  b.add('red', new THREE.SphereGeometry(0.09, 12, 10), b.tf(cx, g + 0.3 + 1.5, cz));
  const pa = addPA({ name: 'Maidan PA', mic, micRadius: 2.4, room: null, ref: 8, max: 62 });
  // Benches around the ground's edge.
  const f = new Frame(0, g, 0, 0);
  bench(b, f, cx - 22, MAIDAN.z1 - 2, Math.PI, 2.4, 3);
  bench(b, f, cx + 22, MAIDAN.z1 - 2, Math.PI, 2.4, 3);
  bench(b, f, MAIDAN.x0 + 2, cz, Math.PI / 2, 2.4, 3);
  bench(b, f, MAIDAN.x1 - 2, cz - 8, -Math.PI / 2, 2.4, 3);
  // Flag mast.
  b.cyl('white', cx - 10, g + 4, MAIDAN.z0 + 3, 0.05, 0.08, 8, { seg: 8, collide: true });
  return pa;
}

/** World PA speakers on poles, scattered over dry land (best-candidate sampling). */
function scatterSpeakers(b: Batcher, t: Terrain, pa: number, count: number) {
  const rnd = mulberry32(1337);
  const out: [number, number][] = [];
  const blocked = (x: number, z: number) =>
    t.waterDepth(x, z) > 0 || t.heightAt(x, z) < 0.9 || t.roadDist(x, z) < ROAD_WIDTH / 2 + 1.5 || t.isPaddy(x, z) ||
    BUILDINGS.some((d) => inRect(rect(d.x, d.z, d.w + 4, d.d + 4), x, z)) ||
    inRect(rect(TEMPLE.x, TEMPLE.z, TEMPLE.size + 20, TEMPLE.size + 4), x, z) || inRect(TEMPLE_POND, x, z, 3) ||
    t.normalAt(x, z).y < 0.88;
  while (out.length < count) {
    let best: [number, number] | null = null;
    let bestGap = -1;
    for (let k = 0; k < 40; k++) {
      const x = (rnd() * 2 - 1) * 225;
      const z = (rnd() * 2 - 1) * 225;
      if (blocked(x, z)) continue;
      const gap = Math.min(Infinity, ...out.map(([ox, oz]) => Math.hypot(ox - x, oz - z)));
      if (gap > bestGap) [best, bestGap] = [[x, z], gap];
    }
    if (!best) continue;
    out.push(best);
  }
  for (const [x, z] of out) {
    const g = t.heightAt(x, z);
    const yaw = rnd() * Math.PI * 2;
    b.cyl('metal', x, g + 1.6, z, 0.06, 0.08, 3.2, { seg: 8, collide: true });
    b.box('black', x, g + 3.5, z, 0.9, 1.3, 0.7, { ry: yaw });
    b.cyl('metal', x + Math.sin(yaw) * 0.36, g + 3.5, z + Math.cos(yaw) * 0.36, 0.26, 0.2, 0.06, { seg: 16 });
    registry.speakers.push({ pa, x, y: g + 3.5, z });
  }
}

/** Modern Kerala house: two storeys, flat roof with parapet, sunshades, balcony, black rooftop tank. */
function modernHouse(b: Batcher, t: Terrain, def: BuildingDef) {
  const yaw = sideYaw(def.door);
  const W = def.door === 'e' || def.door === 'w' ? def.d : def.w;
  const D = def.door === 'e' || def.door === 'w' ? def.w : def.d;
  const g = t.heightAt(def.x, def.z);
  const plinth = 0.45;
  const h1 = 3.1;
  const h2 = 3.0;
  const key = `plaster-${def.id}`;
  b.material(key, () => std({ ...pbr().plaster, roughness: 1, color: def.wall }));
  const f = new Frame(def.x, g, def.z, yaw);
  const fl = new Frame(def.x, g + plinth, def.z, yaw);
  const up = new Frame(def.x, g + plinth + h1 + 0.2, def.z, yaw);
  f.box(b, 'concrete', 0, plinth / 2, 0, W, plinth, D, { collide: true, uv: 1.5 });
  f.box(b, 'concrete', 0, 0.12, D / 2 + 0.45, 2.0, 0.24, 0.9, { collide: true });
  fl.box(b, 'stone', 0, 0.01, 0, W - 0.1, 0.02, D - 0.1, { uv: 0.6 }); // vitrified tiles
  walls(b, fl, key, W, D, h1, 0.23, { x: -W / 4, w: 1.1, h: 2.15 });
  fl.box(b, 'wood', -W / 4 + 0.53, 1.07, D / 2 - 0.62, 0.05, 2.1, 1.0); // open door
  // Floor slab with a continuous sunshade (chajja) all round, and the upper storey.
  fl.box(b, 'concrete', 0, h1 + 0.1, 0, W + 0.8, 0.2, D + 0.8, { collide: true, uv: 2 });
  fl.box(b, 'concrete', 0, 2.42, 0, W + 0.5, 0.07, D + 0.5); // window sunshade band
  walls(b, up, key, W, D, h2, 0.23, { x: W / 4, w: 1.0, h: 2.1 });
  up.box(b, 'concrete', 0, 2.36, 0, W + 0.5, 0.07, D + 0.5);
  // Front balcony with a steel railing.
  up.box(b, 'concrete', W / 4, -0.05, D / 2 + 0.7, 3.2, 0.14, 1.4, { collide: true });
  for (let k = 0; k <= 12; k++) up.box(b, 'metal', W / 4 - 1.55 + k * 0.258, 0.5, D / 2 + 1.36, 0.025, 0.9, 0.025);
  up.box(b, 'metal', W / 4, 0.96, D / 2 + 1.36, 3.2, 0.04, 0.05);
  // Flat roof + parapet, staircase room with a little tiled roof, black water tank.
  const ry = h2 + 0.1;
  up.box(b, 'concrete', 0, ry, 0, W + 0.3, 0.2, D + 0.3, { uv: 2 });
  for (const [lx, lz, sx, sz] of [[0, -D / 2 - 0.05, W + 0.3, 0.15], [0, D / 2 + 0.05, W + 0.3, 0.15], [-W / 2 - 0.05, 0, 0.15, D + 0.3], [W / 2 + 0.05, 0, 0.15, D + 0.3]] as const)
    up.box(b, key, lx, ry + 0.55, lz, sx, 0.9, sz);
  up.box(b, key, -W / 2 + 1.8, ry + 1.25, -D / 2 + 1.8, 3, 2.3, 3);
  up.geo(b, 'roof', hipRoof(3, 3, 1.1, 0.35), -W / 2 + 1.8, ry + 2.4, -D / 2 + 1.8);
  up.box(b, 'metal', W / 2 - 1.6, ry + 0.45, -D / 2 + 1.5, 1.3, 0.7, 1.3);
  up.cyl(b, 'black', W / 2 - 1.6, ry + 1.4, -D / 2 + 1.5, 0.58, 0.62, 1.3, { seg: 18 });
  for (const yy of [1.0, 1.4, 1.8]) up.cyl(b, 'black', W / 2 - 1.6, ry + yy, -D / 2 + 1.5, 0.64, 0.64, 0.05, { seg: 18 });
  up.cyl(b, 'black', W / 2 - 1.6, ry + 2.12, -D / 2 + 1.5, 0.2, 0.25, 0.14, { seg: 12 });
  // Car porch on two pillars.
  fl.box(b, 'concrete', W / 4 + 1.0, h1 - 0.2, D / 2 + 2.3, 4.0, 0.18, 3.6, { collide: true });
  for (const ox of [-0.9, 2.9]) fl.cyl(b, key, W / 4 + ox, (h1 - 0.3) / 2, D / 2 + 3.8, 0.16, 0.16, h1 - 0.3, { seg: 12, collide: true });
  // Interior: sofa, TV unit, dining table.
  fl.box(b, 'fabric', -W / 2 + 1.2, 0.4, 0, 0.9, 0.8, 2.2, { collide: true });
  fl.box(b, 'wood', W / 2 - 0.5, 0.45, -0.5, 0.5, 0.9, 1.8, { collide: true });
  fl.box(b, 'black', W / 2 - 0.3, 1.3, -0.5, 0.06, 0.7, 1.2);
  fl.box(b, 'woodLight', 0.5, 0.76, -D / 2 + 1.6, 1.6, 0.05, 0.9, { collide: true });
  const [ix0, iz0] = fl.p(-W / 2 + 0.23, -D / 2 + 0.23);
  const [ix1, iz1] = fl.p(W / 2 - 0.23, D / 2 - 0.23);
  addRoom({ name: def.id, r: { x0: Math.min(ix0, ix1), z0: Math.min(iz0, iz1), x1: Math.max(ix0, ix1), z1: Math.max(iz0, iz1) }, y0: fl.y, y1: fl.y + h1, soundproof: false });
  compoundWall(b, t, def, W, D, yaw, def.kind === 'modern' ? W / 4 + 1.0 : 0);
}

/**
 * Compound wall round a house plot: laterite base with a plaster cap, built in short runs
 * that follow the ground; a gateway with pillars and open iron gates lines up with `gateX`.
 */
function compoundWall(b: Batcher, t: Terrain, def: BuildingDef, W: number, D: number, yaw: number, gateX: number) {
  const front = 5.2;
  const side = 2.6;
  const x0 = -W / 2 - side;
  const x1 = W / 2 + side;
  const z0 = -D / 2 - side;
  const z1 = D / 2 + front;
  const gate = 3.2;
  const H = 1.3;
  const fr = new Frame(def.x, 0, def.z, yaw);
  const run = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 2.5));
    for (let k = 0; k < n; k++) {
      const sx = ax + ((bx - ax) * (k + 0.5)) / n;
      const sz = az + ((bz - az) * (k + 0.5)) / n;
      const [wx, wz] = fr.p(sx, sz);
      const gy = t.heightAt(wx, wz);
      const ry = Math.atan2(bx - ax, bz - az);
      const seg = len / n + 0.02;
      b.box('laterite', wx, gy + H / 2 - 0.1, wz, 0.24, H + 0.2, seg, { ry: yaw + ry, collide: true, uv: 1.5 });
      b.box('white', wx, gy + H + 0.13, wz, 0.32, 0.08, seg + 0.02, { ry: yaw + ry });
    }
  };
  run(x0, z0, x1, z0);
  run(x0, z0, x0, z1);
  run(x1, z0, x1, z1);
  run(x0, z1, gateX - gate / 2, z1);
  run(gateX + gate / 2, z1, x1, z1);
  for (const s of [-1, 1]) {
    const [px, pz] = fr.p(gateX + (s * gate) / 2, z1);
    const gy = t.heightAt(px, pz);
    b.box('plaster', px, gy + 0.85, pz, 0.48, 1.7, 0.48, { ry: yaw, collide: true });
    b.box('roof', px, gy + 1.78, pz, 0.62, 0.14, 0.62, { ry: yaw });
    // open iron gate leaf, swung inwards
    const [lx, lz] = fr.p(gateX + s * (gate / 2 - 0.05), z1 - 0.8);
    b.box('metal', lx, gy + 0.7, lz, 0.04, 1.2, 1.5, { ry: yaw });
  }
}

export function buildArchitecture(scene: THREE.Object3D, b: Batcher, t: Terrain) {
  registerMaterials(b);
  const mainPA = maidanProps(b, t);
  for (const def of BUILDINGS) {
    if (def.kind === 'hall') meetingHall(b, scene, t, def);
    else if (def.kind === 'house') house(b, t, def);
    else if (def.kind === 'modern') modernHouse(b, t, def);
    else teaShop(b, scene, t, def);
  }
  temple(b, t);
  lighthouse(b, scene, t);
  fishingNets(scene, b);
  HOUSEBOATS.forEach((h, i) => houseboat(scene, b, h.x, h.z, h.yaw, i === 0));
  roadsAndBridges(b, t);
  viewpoint(b, t);
  buildProps(scene, b, t);
  scatterSpeakers(b, t, mainPA, 24);

  // Direction signs at the main junction.
  const sg = t.heightAt(-36, 8);
  b.cyl('metal', -36, sg + 1.4, 8, 0.05, 0.05, 2.8, { seg: 6 });
  signBoard(scene, 'KOVALAM  ←', 'Beach · Lighthouse · Fort Kochi', -36, sg + 2.6, 8.05, 0, 2.6, '#174a8b', '#ffffff');
  signBoard(scene, 'MUNNAR  →', 'Tea hills · Viewpoint', -36, sg + 2.0, 8.05, 0, 2.6, '#174a8b', '#ffffff');
  signBoard(scene, 'ALAPPUZHA  ↓', 'Backwaters · Houseboats', -36, sg + 1.4, 8.05, 0, 2.6, '#174a8b', '#ffffff');
}
