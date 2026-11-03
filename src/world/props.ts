import * as THREE from 'three';
import { Batcher } from './batch';
import { BUILDINGS, BUS_STOP, OFFROAD, OFFROAD_MOUNDS, OFFROAD_TRACK, ROAD_WIDTH, WORLD_HALF, inRect, rect } from './layout';
import RAPIER from '@dimforge/rapier3d-compat';
import { pbr, layerSurface } from './pbr';
import { mulberry32 } from './noise';
import { addSeat } from './registry';
import { polyAt, polyDist, type Terrain } from './terrain';
import { textures } from './textures';
import { addWind } from './wind';

/**
 * Roadside life: KSEB poles with sagging power lines and street lamps, parked autos and
 * scooters, a KSRTC bus at its shelter, flex boards, milestones, flowering shrubs.
 */

const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.6, ...o });
const UP = new THREE.Vector3(0, 1, 0);

function registerPropMaterials(b: Batcher) {
  b.material('cable', () => std({ color: 0x111111, roughness: 0.5 }), false)
    .material('insulator', () => std({ color: 0xe8e4d8, roughness: 0.3 }))
    .material('autoBlack', () => std({ color: 0x151515, roughness: 0.35, metalness: 0.3 }))
    .material('autoYellow', () => std({ color: 0xf2c21b, roughness: 0.35, metalness: 0.2 }))
    .material('tyre', () => std({ color: 0x151515, roughness: 0.9 }))
    .material('chrome', () => std({ color: 0xdddddd, metalness: 1, roughness: 0.15 }))
    .material('ksrtcRed', () => std({ color: 0xa3161a, roughness: 0.4, metalness: 0.2 }))
    .material('ksrtcCream', () => std({ color: 0xefe3c2, roughness: 0.45 }))
    .material('busGlass', () => std({ color: 0x24343c, metalness: 0.8, roughness: 0.08 }))
    .material('scooterRed', () => std({ color: 0xb0181b, roughness: 0.3, metalness: 0.3 }))
    .material('scooterBlue', () => std({ color: 0x1c3d8c, roughness: 0.3, metalness: 0.3 }))
    .material('scooterWhite', () => std({ color: 0xe8e8e6, roughness: 0.3, metalness: 0.2 }))
    .material('mileWhite', () => std({ color: 0xf2f0ea, roughness: 0.8 }))
    .material('mileYellow', () => std({ color: 0xf2c400, roughness: 0.7 }));
}

/** A thin cylinder from a to b (for wires and rods). */
function rod(b: Batcher, key: string, a: THREE.Vector3, c: THREE.Vector3, r: number, seg = 4) {
  const len = a.distanceTo(c);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, c.clone().sub(a).normalize());
  const m = new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  b.add(key, g, m);
}

/** Poles every ~34 m along one side of each road, three conductors strung between them. */
function powerLines(b: Batcher, t: Terrain) {
  for (const r of t.roads) {
    let prev: THREE.Vector3[] | null = null;
    for (let s = 6, k = 0; s < r.length - 3; s += 34, k++) {
      if (r.bridges.some(([a, c]) => s > a - 6 && s < c + 6)) {
        prev = null;
        continue;
      }
      const p = polyAt(r.pts, s);
      const nx = -p.tz;
      const nz = p.tx;
      const off = ROAD_WIDTH / 2 + 1.6;
      const x = p.x + nx * off;
      const z = p.z + nz * off;
      const g = t.heightAt(x, z);
      const along = Math.atan2(p.tx, p.tz);
      // Tapered prestressed-concrete pole.
      const pole = new THREE.CylinderGeometry(0.1, 0.16, 9, 4, 1);
      b.add('concrete', pole, b.tf(x, g + 4.5, z, along + Math.PI / 4));
      b.cuboid(x, g + 4.5, z, 0.14, 4.5, 0.14);
      // Crossarm across the road direction, three insulators.
      b.box('metal', x, g + 8.6, z, 1.7, 0.08, 0.08, { ry: along + Math.PI / 2 });
      const tops: THREE.Vector3[] = [];
      for (const o of [-0.75, 0, 0.75]) {
        const ix = x + nx * o;
        const iz = z + nz * o;
        b.cyl('insulator', ix, g + 8.75, iz, 0.04, 0.06, 0.18, { seg: 8 });
        tops.push(new THREE.Vector3(ix, g + 8.86, iz));
      }
      if (k % 6 === 3) b.box('metal', x - nx * 0.3, g + 7.2, z - nz * 0.3, 0.6, 0.9, 0.45, { ry: along }); // transformer
      if (k % 2 === 0) {
        // Street lamp on an arm over the road.
        const ax = x - nx * 1.4;
        const az = z - nz * 1.4;
        rod(b, 'metal', new THREE.Vector3(x, g + 7.3, z), new THREE.Vector3(ax, g + 7.6, az), 0.035, 6);
        b.box('lamp', ax, g + 7.52, az, 0.4, 0.08, 0.2, { ry: along });
      }
      if (prev) {
        for (let w = 0; w < 3; w++) {
          const A = prev[w];
          const B = tops[w];
          const span = A.distanceTo(B);
          const sag = 0.35 + span * 0.012;
          let last = A;
          for (let i = 1; i <= 8; i++) {
            const u = i / 8;
            const pt = A.clone().lerp(B, u);
            pt.y -= sag * 4 * u * (1 - u);
            rod(b, 'cable', last, pt, 0.012);
            last = pt;
          }
        }
      }
      prev = tops;
    }
  }
}

function autorickshaw(b: Batcher, t: Terrain, x: number, z: number, yaw: number) {
  const g = t.heightAt(x, z);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const P = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * c + lz * s, g + ly, z - lx * s + lz * c];
  const box = (key: string, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, rx = 0) => b.box(key, ...P(lx, ly, lz), sx, sy, sz, { ry: yaw, rx });
  box('autoBlack', 0, 0.55, -0.25, 1.25, 0.55, 1.6); // passenger tub
  box('autoBlack', 0, 0.5, 0.85, 0.7, 0.45, 0.8); // nose
  box('autoYellow', 0, 1.72, -0.15, 1.32, 0.08, 2.2); // canopy
  box('autoYellow', 0, 1.2, -1.02, 1.3, 1.0, 0.06); // back panel
  for (const sx of [-0.64, 0.64]) box('autoYellow', sx, 1.25, -0.6, 0.04, 0.9, 0.8);
  box('busGlass', 0, 1.35, 0.72, 1.0, 0.62, 0.04, -0.3); // windscreen
  box('chrome', 0, 1.0, 1.15, 0.5, 0.04, 0.04); // handlebar
  box('ksrtcCream', 0, 0.85, 1.26, 0.16, 0.16, 0.06); // headlamp
  for (const [lx, lz] of [[0, 1.05], [-0.55, -0.7], [0.55, -0.7]]) {
    const [wx, wy, wz] = P(lx, 0.22, lz);
    b.add('tyre', new THREE.CylinderGeometry(0.22, 0.22, 0.14, 14).rotateZ(Math.PI / 2), b.tf(wx, wy, wz, yaw));
  }
  const [cx, , cz] = P(0, 0, 0);
  b.cuboid(cx, g + 0.9, cz, 0.66, 0.9, 1.3, yaw);
}

function scooter(b: Batcher, t: Terrain, x: number, z: number, yaw: number, color: string) {
  const g = t.heightAt(x, z);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const P = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * c + lz * s, g + ly, z - lx * s + lz * c];
  b.box(color, ...P(0, 0.5, -0.2), 0.42, 0.45, 0.9, { ry: yaw });
  b.box('autoBlack', ...P(0, 0.8, -0.25), 0.34, 0.1, 0.7, { ry: yaw });
  b.box(color, ...P(0, 0.75, 0.55), 0.38, 0.75, 0.12, { ry: yaw, rx: -0.25 });
  b.box('autoBlack', ...P(0, 0.32, 0.25), 0.3, 0.08, 0.55, { ry: yaw });
  b.box('chrome', ...P(0, 1.15, 0.6), 0.7, 0.04, 0.04, { ry: yaw });
  for (const lz of [0.7, -0.6]) b.add('tyre', new THREE.CylinderGeometry(0.2, 0.2, 0.1, 14).rotateZ(Math.PI / 2), b.tf(...P(0, 0.2, lz), yaw));
  const [cx, , cz] = P(0, 0, 0);
  b.cuboid(cx, g + 0.6, cz, 0.3, 0.6, 0.9, yaw);
}

function busAndShelter(b: Batcher, scene: THREE.Object3D, t: Terrain) {
  // Shelter: concrete roof slab on four posts, a bench (sittable), facing the road (-Z).
  const { x, z } = BUS_STOP;
  const g = t.heightAt(x, z);
  b.box('concrete', x, g + 0.1, z, 6, 0.2, 2.6, { collide: true });
  b.box('concrete', x, g + 2.7, z, 6.4, 0.15, 3.0);
  for (const [ox, oz] of [[-2.8, -1.1], [2.8, -1.1], [-2.8, 1.1], [2.8, 1.1]]) b.cyl('metal', x + ox, g + 1.4, z + oz, 0.05, 0.05, 2.6, { seg: 8, collide: true });
  b.box('plaster', x, g + 1.3, z + 1.2, 5.8, 2.2, 0.1, { collide: true });
  b.box('woodLight', x, g + 0.62, z + 0.75, 4.5, 0.06, 0.45, { collide: true });
  for (let i = 0; i < 4; i++) addSeat(x - 1.7 + i * 1.13, g + 0.65, z + 0.75, Math.PI);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshStandardMaterial({ map: kTex('KSRTC  BUS STOP', '#a3161a', '#ffffff') }));
  sign.position.set(x, g + 2.38, z - 1.52);
  sign.rotation.y = Math.PI;
  scene.add(sign);

  // KSRTC bus waiting in the lane (11 m, red and cream).
  const bx = x + 9;
  const bz = z - 5.6;
  const by = t.heightAt(bx, bz);
  const yaw = Math.PI / 2 + 0.05;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const P = (lx: number, ly: number, lz: number): [number, number, number] => [bx + lx * c + lz * s, by + ly, bz - lx * s + lz * c];
  b.box('ksrtcRed', ...P(0, 0.95, 0), 2.5, 1.3, 11, { ry: yaw });
  b.box('ksrtcCream', ...P(0, 2.1, 0), 2.5, 1.0, 11, { ry: yaw });
  b.box('ksrtcRed', ...P(0, 2.75, 0), 2.48, 0.3, 11, { ry: yaw });
  b.box('ksrtcCream', ...P(0, 2.95, 0), 2.3, 0.12, 10.6, { ry: yaw });
  for (const sx of [-1.26, 1.26]) b.box('busGlass', ...P(sx, 2.15, -0.3), 0.02, 0.8, 9.6, { ry: yaw });
  b.box('busGlass', ...P(0, 2.0, 5.51), 2.3, 1.3, 0.02, { ry: yaw });
  b.box('ksrtcCream', ...P(0, 0.6, 5.52), 2.0, 0.25, 0.04, { ry: yaw });
  for (const [lx, lz] of [[-1.05, 3.6], [1.05, 3.6], [-1.05, -2.8], [1.05, -2.8], [-1.05, -4.0], [1.05, -4.0]])
    b.add('tyre', new THREE.CylinderGeometry(0.5, 0.5, 0.32, 18).rotateZ(Math.PI / 2), b.tf(...P(lx, 0.5, lz), yaw));
  b.cuboid(bx, by + 1.6, bz, 1.25, 1.5, 5.5, yaw);
  const front = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.32), new THREE.MeshStandardMaterial({ map: kTex('ERNAKULAM', '#111111', '#ffcf3a') }));
  const fp = P(0, 2.92, 5.53);
  front.position.set(...fp);
  front.rotation.y = yaw;
  scene.add(front);
}

const texCache = new Map<string, THREE.Texture>();
function kTex(text: string, bg: string, fg: string, sub?: string, w = 512, h = 128) {
  const key = text + bg + fg + sub;
  if (texCache.has(key)) return texCache.get(key)!;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, shade(bg, -30));
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 ${Math.round(h * (sub ? 0.36 : 0.5))}px system-ui, sans-serif`;
  g.fillText(text, w / 2, sub ? h * 0.36 : h / 2);
  if (sub) {
    g.font = `600 ${Math.round(h * 0.17)}px system-ui, sans-serif`;
    g.fillText(sub, w / 2, h * 0.75);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}
function shade(hex: string, d: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, v + d));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Big flex boards on frames — a fixture of every Kerala roadside. */
function flexBoards(b: Batcher, scene: THREE.Object3D, t: Terrain) {
  const boards: [number, number, string, string, string, string][] = [
    [-38, -7, 'ONAM MEGA SALE', 'Up to 50% off · Textiles & Jewellery', '#c2185b', '#fff6d5'],
    [32, -6, 'KERALA LOTTERY', 'Win ₹80 Lakh · Every Week', '#1b5e20', '#ffe082'],
    [14, 52, 'PURE COCONUT OIL', 'Since 1952 · Kozhikode', '#0d47a1', '#ffffff'],
    [-139, -12, 'WELCOME TO KOVALAM', 'Lighthouse Beach 2 km', '#e65100', '#ffffff'],
    [128, -40, 'MUNNAR TEA ESTATES', 'Factory · Museum · 6 km', '#33691e', '#f1f8e9'],
    [-6, 108, 'HOUSEBOAT CRUISE', 'Day / Overnight · AC', '#006064', '#e0f7fa'],
  ];
  for (const [x, z, title, sub, bg, fg] of boards) {
    const g = t.heightAt(x, z);
    // face the nearest road
    let best = { d: Infinity, x: 0, z: 0 };
    for (const r of t.roads)
      for (let s = 0; s < r.length; s += 4) {
        const p = polyAt(r.pts, s);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < best.d) best = { d, x: p.x, z: p.z };
      }
    const yaw = Math.atan2(best.x - x, best.z - z);
    for (const o of [-1.9, 1.9]) b.cyl('metal', x + Math.cos(yaw) * o, g + 2.0, z - Math.sin(yaw) * o, 0.05, 0.05, 4, { seg: 6, collide: true });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.2), new THREE.MeshStandardMaterial({ map: kTex(title, bg, fg, sub, 640, 320), roughness: 0.7 }));
    m.position.set(x, g + 3.0, z);
    m.rotation.y = yaw;
    m.castShadow = true;
    scene.add(m);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.2), new THREE.MeshStandardMaterial({ color: 0x777777 }));
    back.position.copy(m.position);
    back.rotation.y = yaw + Math.PI;
    scene.add(back);
  }
}

function milestones(b: Batcher, t: Terrain) {
  for (const r of t.roads.slice(0, 2)) {
    for (let s = 40; s < r.length; s += 120) {
      if (r.bridges.some(([a, c]) => s > a - 4 && s < c + 4)) continue;
      const p = polyAt(r.pts, s);
      const x = p.x + p.tz * (ROAD_WIDTH / 2 + 0.9);
      const z = p.z - p.tx * (ROAD_WIDTH / 2 + 0.9);
      const g = t.heightAt(x, z);
      const yaw = Math.atan2(p.tx, p.tz) + Math.PI / 2;
      b.box('mileWhite', x, g + 0.3, z, 0.4, 0.6, 0.18, { ry: yaw, collide: true });
      b.cyl('mileYellow', x, g + 0.64, z, 0.2, 0.2, 0.18, { seg: 12, ry: yaw });
    }
  }
}

/** Hibiscus, croton and bougainvillea round the houses and along compound walls. */
function shrubs(scene: THREE.Object3D, t: Terrain) {
  const rnd = mulberry32(777);
  const leafTex = textures().leaves;
  const kinds = [
    { leaf: 0x2f5a20, flower: 0xd21f2b, flowers: 22, size: 1.0 }, // hibiscus
    { leaf: 0xffffff, flower: 0, flowers: 0, size: 0.75 }, // croton (multicolour leaves via instance colour)
    { leaf: 0x3a6a26, flower: 0xc2187a, flowers: 40, size: 1.3 }, // bougainvillea
  ];
  const place: { x: number; y: number; z: number; s: number; k: number; c: THREE.Color }[] = [];
  for (const d of BUILDINGS) {
    if (d.kind === 'hall' || d.kind === 'teashop') continue;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.3;
      const rad = Math.max(d.w, d.d) / 2 + 2.0 + rnd() * 1.4;
      const x = d.x + Math.cos(a) * rad;
      const z = d.z + Math.sin(a) * rad;
      if (t.roadDist(x, z) < ROAD_WIDTH / 2 + 1 || inRect(rect(d.x, d.z, d.w + 0.6, d.d + 0.6), x, z)) continue;
      const k = Math.floor(rnd() * 3);
      const c = k === 1 ? new THREE.Color().setHSL(0.02 + rnd() * 0.12, 0.85, 0.35 + rnd() * 0.15) : new THREE.Color(kinds[k].leaf);
      place.push({ x, y: t.heightAt(x, z), z, s: kinds[k].size * (0.75 + rnd() * 0.5), k, c });
    }
  }
  // roadside wild shrubs
  for (let i = 0; i < 260; i++) {
    const r = t.roads[Math.floor(rnd() * t.roads.length)];
    const p = polyAt(r.pts, rnd() * r.length);
    const side = rnd() < 0.5 ? -1 : 1;
    const off = ROAD_WIDTH / 2 + 2.5 + rnd() * 3;
    const x = p.x - p.tz * side * off;
    const z = p.z + p.tx * side * off;
    if (Math.abs(x) > WORLD_HALF - 4 || Math.abs(z) > WORLD_HALF - 4 || t.waterDepth(x, z) > 0) continue;
    if (BUILDINGS.some((d) => inRect(rect(d.x, d.z, d.w + 12, d.d + 12), x, z))) continue;
    place.push({ x, y: t.heightAt(x, z), z, s: 0.7 + rnd() * 0.8, k: 0, c: new THREE.Color().setHSL(0.26 + rnd() * 0.05, 0.45, 0.42 + rnd() * 0.12) });
  }

  // geometry: a rounded clump of leaf cards + tiny flower quads
  const cards: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 26; k++) {
    const q = new THREE.PlaneGeometry(0.55, 0.55);
    const dir = new THREE.Vector3(rnd() - 0.5, rnd() * 0.8, rnd() - 0.5).normalize();
    q.lookAt(dir);
    q.translate(dir.x * 0.45, 0.45 + dir.y * 0.35, dir.z * 0.45);
    cards.push(q);
  }
  const leafGeo = mergeAll(cards);
  const flowers: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 40; k++) {
    const q = new THREE.PlaneGeometry(0.09, 0.09);
    const dir = new THREE.Vector3(rnd() - 0.5, rnd() * 0.9, rnd() - 0.5).normalize();
    q.lookAt(dir);
    q.translate(dir.x * 0.62, 0.5 + dir.y * 0.42, dir.z * 0.62);
    flowers.push(q);
  }
  const flowerGeo = mergeAll(flowers);
  const leafMat = new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75 });
  addWind(leafMat, 'leaf', 0.6);
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, place.length);
  const o = new THREE.Object3D();
  place.forEach((p, i) => {
    o.position.set(p.x, p.y - 0.05, p.z);
    o.rotation.set(0, rnd() * 6.28, 0);
    o.scale.setScalar(p.s);
    o.updateMatrix();
    leaves.setMatrixAt(i, o.matrix);
    leaves.setColorAt(i, p.c);
  });
  leaves.castShadow = true;
  leaves.receiveShadow = true;
  scene.add(leaves);
  for (const k of [0, 2]) {
    const ps = place.filter((p) => p.k === k && p.c.getHex() === kinds[k].leaf);
    if (!ps.length) continue;
    const fm = new THREE.InstancedMesh(flowerGeo, std({ color: kinds[k].flower, side: THREE.DoubleSide, roughness: 0.5, emissive: kinds[k].flower, emissiveIntensity: 0.08 }), ps.length);
    ps.forEach((p, i) => {
      o.position.set(p.x, p.y - 0.05, p.z);
      o.rotation.set(0, i * 2.4, 0);
      o.scale.setScalar(p.s);
      o.updateMatrix();
      fm.setMatrixAt(i, o.matrix);
    });
    scene.add(fm);
  }
}

function mergeAll(gs: THREE.BufferGeometry[]) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const g of gs) {
    const base = pos.length / 3;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nrm.push(...(g.getAttribute('normal').array as Float32Array));
    uv.push(...(g.getAttribute('uv').array as Float32Array));
    idx.push(...Array.from(g.getIndex()!.array, (v) => v + base));
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  m.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  m.setIndex(idx);
  return m;
}

/** Off-road park furniture: logs to crawl over, boulders, white tyre course markers, a sign. */
function offroadPark(b: Batcher, scene: THREE.Object3D, t: Terrain) {
  const rnd = mulberry32(31337);
  b.material('bark', () => std({ ...pbr().bark, roughness: 1, color: 0x9a8a78 }))
    .material('tyreWhite', () => std({ color: 0xe8e8e0, roughness: 0.85 }));
  // Logs across parts of the course (low enough to drive over, solid).
  const logs: [number, number, number, number][] = [[-70, -170, 0.4, 0.3], [-104, -206, 1.2, 0.35], [-56, -205, 2.2, 0.28], [-90, -224, -0.3, 0.32], [-80, -186, 2.8, 0.25]];
  for (const [x, z, yaw, r] of logs) {
    const g = t.heightAt(x, z);
    const len = 5 + rnd() * 2;
    b.add('bark', new THREE.CylinderGeometry(r, r * 1.1, len, 12).rotateZ(Math.PI / 2), b.tf(x, g + r * 0.8, z, yaw));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, Math.PI / 2, 'YXZ'));
    b.physics.createCollider(RAPIER.ColliderDesc.capsule(len / 2 - r, r).setTranslation(x, g + r * 0.8, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
  }
  // Boulders scattered round the mounds.
  let rock: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 2);
  const pos = rock.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    const n = Math.sin(v.x * 3.1 + v.z * 1.7) * 0.12 + Math.sin(v.y * 4.3 - v.x * 2.2) * 0.08;
    v.multiplyScalar(1 + n);
    pos.setXYZ(i, v.x, v.y * 0.7, v.z);
  }
  rock.computeVertexNormals();
  const rockMat = std({ ...layerSurface(pbr().rock), roughness: 0.85, color: 0xb0a898 });
  const stones: THREE.Matrix4[] = [];
  for (const m of OFFROAD_MOUNDS)
    for (let k = 0; k < 6; k++) {
      const a = rnd() * Math.PI * 2;
      const rr = m.r * (0.8 + rnd() * 0.6);
      const x = m.x + Math.cos(a) * rr;
      const z = m.z + Math.sin(a) * rr;
      const s = 0.5 + rnd() * 1.1;
      if (polyDist(OFFROAD_TRACK, x, z).d < 4.6 + s) continue; // keep the race trail clear
      stones.push(new THREE.Matrix4().compose(new THREE.Vector3(x, t.heightAt(x, z) - 0.2 * s, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd(), rnd() * 6, rnd())), new THREE.Vector3(s, s, s)));
      b.physics.createCollider(RAPIER.ColliderDesc.ball(s * 0.72).setTranslation(x, t.heightAt(x, z), z));
    }
  const rocks = new THREE.InstancedMesh(rock, rockMat, stones.length);
  stones.forEach((m, i) => rocks.setMatrixAt(i, m));
  rocks.castShadow = rocks.receiveShadow = true;
  scene.add(rocks);
  // Half-buried white tyres marking the course.
  for (let i = 0; i < OFFROAD_TRACK.length - 1; i++) {
    const [ax, az] = OFFROAD_TRACK[i];
    const [bx, bz] = OFFROAD_TRACK[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const nx = -(bz - az) / len;
    const nz = (bx - ax) / len;
    for (let s = 4; s < len; s += 9) {
      for (const side of [-1, 1]) {
        const x = ax + ((bx - ax) * s) / len + nx * side * 3.4;
        const z = az + ((bz - az) * s) / len + nz * side * 3.4;
        if (!inRect(OFFROAD, x, z, 6)) continue;
        b.add('tyreWhite', new THREE.TorusGeometry(0.33, 0.12, 8, 16), b.tf(x, t.heightAt(x, z) + 0.12, z, rnd() * 3, Math.PI / 2 - 0.3));
      }
    }
  }
  // Entrance sign.
  const [sx, sz] = [-118, -180];
  const g = t.heightAt(sx, sz);
  for (const o of [-1.6, 1.6]) b.cyl('wood', sx + o, g + 1.5, sz, 0.08, 0.1, 3, { seg: 8, collide: true });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.2), new THREE.MeshStandardMaterial({ map: kTex('OFF-ROAD PARK', '#3e2723', '#ffcc80', '4x4 only · Engage 4L on the climbs', 640, 213) }));
  m.position.set(sx, g + 2.6, sz - 0.05);
  m.rotation.y = Math.PI;
  scene.add(m);
}

export function buildProps(scene: THREE.Object3D, b: Batcher, t: Terrain) {
  offroadPark(b, scene, t);
  registerPropMaterials(b);
  powerLines(b, t);
  busAndShelter(b, scene, t);
  flexBoards(b, scene, t);
  milestones(b, t);
  // Parked autos & scooters around town.
  autorickshaw(b, t, 27, -14, Math.PI / 2 + 0.2);
  autorickshaw(b, t, 31, -16, Math.PI / 2 - 0.1);
  autorickshaw(b, t, 18, 18, 0.3);
  autorickshaw(b, t, -40, -14, -0.4);
  scooter(b, t, 21, 19, 1.2, 'scooterRed');
  scooter(b, t, 22.2, 19.4, 1.25, 'scooterBlue');
  scooter(b, t, -58, 12, 0.2, 'scooterWhite');
  scooter(b, t, 74, 15, -0.3, 'scooterRed');
  shrubs(scene, t);
}
