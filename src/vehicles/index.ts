import * as THREE from 'three';
import { meshes, sweep } from './kit';
import { paint, plateMaterial, sharedMaterials, withDirt } from './materials';
import { steeringWheel, wheelGeos, type WheelStyle } from './parts';
import { fortunerModel } from './fortuner';
import { jimnyModel } from './jimny';

/**
 * Vehicle visuals. Each model's body is built once (merged per material) and shared by every
 * car of that model; a car only gets its own paint, plates and lamp materials.
 */

export interface Visual {
  root: THREE.Group;
  wheels: { steer: THREE.Group; spin: THREE.Group; side: number }[];
  steeringWheel: THREE.Object3D;
  brakeMat: THREE.MeshStandardMaterial;
  reverseMat: THREE.MeshStandardMaterial;
  /** Parts that follow the wheels (axles, links, shocks): kept out of the leaning cabin. */
  unsprung: THREE.Object3D[];
  /** Call after the wheels have been placed for the frame. */
  updateRunningGear(): void;
  /** Level of detail from the camera position: interior, tread, brakes, chassis hide when far. */
  lod(camera: THREE.Vector3): void;
  /** 0 = showroom clean … 1 = caked in mud. */
  dirt: { value: number };
}

/** Materials that take the dirt layer (body-side and wheel-side). */
const DIRTY_BODY = ['paint', 'plastic', 'black', 'satin', 'rubber', 'liner', 'powder'];
const DIRTY_WHEEL = ['tyre', 'tread', 'rimBlack', 'rimGun', 'rimLip', 'rimInner'];

/** Keys only worth drawing up close. */
const DETAIL = new Set(['leather', 'fabric', 'dash', 'headliner', 'gauge', 'screen', 'mirror', 'tread', 'under', 'steel', 'disc', 'caliperRed', 'caliperGrey', 'bulb', 'reflector', 'lampHouse', 'gap', 'rimInner']);
const LOD_FAR = 38;

type Anchor = { body: number[] } | { wheel: number; off: number[] };
export interface Link {
  key: string;
  r: number;
  a: Anchor;
  b: Anchor;
  coil?: boolean;
}
export interface ModelDef {
  body: Map<string, THREE.BufferGeometry>;
  wheel: WheelStyle;
  track: number;
  wheelbase: number;
  steering: { pos: THREE.Vector3; tilt: number; R: number };
  gear: {
    axles: { wheels: [number, number]; r: number; diff?: { x: number; r: number } }[];
    links: Link[];
  };
  /** Optional spare wheel (built from the wheel style): position + Euler rotation. */
  spare?: { pos: THREE.Vector3; rot: [number, number, number] };
}

const defs = new Map<string, ModelDef>();
function def(model: 'jimny' | 'fortuner'): ModelDef {
  let d = defs.get(model);
  if (!d) defs.set(model, (d = model === 'fortuner' ? fortunerModel() : jimnyModel()));
  return d;
}

let unitTube: THREE.BufferGeometry | null = null;
let unitCoil: THREE.BufferGeometry | null = null;
let unitDiff: THREE.BufferGeometry | null = null;
function units() {
  unitTube ??= new THREE.CylinderGeometry(1, 1, 1, 10, 1);
  if (!unitCoil) {
    const pts: THREE.Vector3[] = [];
    const turns = 6;
    for (let i = 0; i <= turns * 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), -0.5 + i / (turns * 16), Math.sin(a)));
    }
    unitCoil = sweep(pts, Array.from({ length: 6 }, (_, i) => [Math.cos((i / 6) * Math.PI * 2) * 0.16, Math.sin((i / 6) * Math.PI * 2) * 0.16] as [number, number]), { caps: true });
  }
  unitDiff ??= new THREE.SphereGeometry(1, 16, 12);
  return { tube: unitTube, coil: unitCoil, diff: unitDiff };
}

const Y = new THREE.Vector3(0, 1, 0);

export function buildVisual(model: 'jimny' | 'fortuner', color: number, plate: string): Visual {
  const d = def(model);
  const sm = sharedMaterials();
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x6a0a0c, emissive: 0xff1010, emissiveIntensity: 0.15, roughness: 0.2 });
  const reverseMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 });
  const plateMat = plateMaterial(plate);
  const dirt = { value: 0.1 };
  const own = new Map<string, THREE.Material>();
  own.set('paint', withDirt(paint(color), { uDirt: dirt }));
  own.set('roof', withDirt(paint(0x101113), { uDirt: dirt })); // two-tone black roof (Jimny)
  for (const k of DIRTY_BODY) if (k !== 'paint') own.set(k, withDirt(sm[k] as THREE.MeshStandardMaterial, { uDirt: dirt }));
  for (const k of DIRTY_WHEEL) own.set(k, withDirt(sm[k] as THREE.MeshStandardMaterial, { uDirt: dirt }, true));
  const mat = (k: string): THREE.Material => own.get(k) ?? (k === 'plate' ? plateMat : k === 'brake' ? brakeMat : k === 'reverse' ? reverseMat : (sm[k] ?? sm.black));
  const noShadow = new Set(['glass', 'lens', 'led', 'gap', 'plate', 'gauge', 'screen', 'headliner', 'mirror', 'bulb']);
  const root = new THREE.Group();
  root.add(meshes(d.body, mat, (k) => !noShadow.has(k)));

  // wheels
  const wg = wheelGeos(d.wheel);
  const hz = d.wheelbase / 2;
  const wheels: Visual['wheels'] = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const steer = new THREE.Group();
    steer.position.set((sx * d.track) / 2, 0, sz * hz);
    const side = new THREE.Group();
    side.scale.x = sx; // outer face outwards on both sides
    const spin = meshes(wg.spin, mat);
    side.add(spin, meshes(wg.fixed, mat));
    steer.add(side);
    root.add(steer);
    wheels.push({ steer, spin, side: sx });
  }
  if (d.spare) {
    const sp = meshes(wg.spin, mat);
    sp.position.copy(d.spare.pos);
    sp.rotation.set(...d.spare.rot);
    root.add(sp);
  }

  // steering wheel
  const sw = new THREE.Group();
  sw.position.copy(d.steering.pos);
  sw.rotation.x = d.steering.tilt;
  sw.add(meshes(steeringWheel(d.steering.R).build(), mat, () => false));
  root.add(sw);

  // running gear: axle beams, links/shocks/springs stretched between anchors
  const u = units();
  const unsprung: THREE.Object3D[] = [];
  const axles = d.gear.axles.map((a) => {
    const g = new THREE.Group();
    const tube = new THREE.Mesh(u.tube, mat('steel'));
    tube.rotation.z = Math.PI / 2;
    tube.castShadow = true;
    g.add(tube);
    if (a.diff) {
      const diff = new THREE.Mesh(u.diff, mat('steel'));
      diff.position.x = a.diff.x;
      diff.scale.set(a.diff.r * 0.8, a.diff.r, a.diff.r);
      diff.castShadow = true;
      g.add(diff);
    }
    root.add(g);
    unsprung.push(g);
    return { a, g, tube };
  });
  const links = d.gear.links.map((l) => {
    const m = new THREE.Mesh(l.coil ? u.coil : u.tube, mat(l.key));
    m.castShadow = true;
    root.add(m);
    unsprung.push(m);
    return { l, m };
  });
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const anchor = (a: Anchor, out: THREE.Vector3) => ('body' in a ? out.set(a.body[0], a.body[1], a.body[2]) : out.copy(wheels[a.wheel].steer.position).add(dir.set(a.off[0], a.off[1], a.off[2])));
  const updateRunningGear = () => {
    for (const { a, g, tube } of axles) {
      const w0 = wheels[a.wheels[0]].steer.position;
      const w1 = wheels[a.wheels[1]].steer.position;
      g.position.addVectors(w0, w1).multiplyScalar(0.5);
      g.rotation.z = Math.atan2(w0.y - w1.y, w0.x - w1.x);
      const len = Math.hypot(w0.x - w1.x, w0.y - w1.y) - 0.2;
      tube.scale.set(a.r, len, a.r);
    }
    for (const { l, m } of links) {
      anchor(l.a, pa);
      anchor(l.b, pb);
      dir.subVectors(pb, pa);
      const len = dir.length();
      m.position.addVectors(pa, pb).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(Y, dir.divideScalar(len || 1));
      m.scale.set(l.r, len, l.r);
    }
  };
  updateRunningGear();
  const detail: THREE.Object3D[] = [sw, ...unsprung];
  root.traverse((o) => (o as THREE.Mesh).isMesh && DETAIL.has(o.name) && detail.push(o));
  let near = true;
  const lod = (cam: THREE.Vector3) => {
    const d = cam.distanceTo(root.position);
    const n = near ? d < LOD_FAR + 4 : d < LOD_FAR;
    if (n === near) return;
    near = n;
    for (const o of detail) o.visible = n;
  };
  return { root, wheels, steeringWheel: sw, brakeMat, reverseMat, unsprung, updateRunningGear, lod, dirt };
}
