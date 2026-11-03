import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  BUILDINGS, HEADLAND, JETTY, LIGHTHOUSE, MAIDAN, PADDY, ROAD_WIDTH, TEMPLE, TEMPLE_POND, WORLD_HALF, coastX,
  hillMask, inRect, rect,
} from './layout';
import { Simplex2, mulberry32 } from './noise';
import type { Terrain } from './terrain';
import { textures } from './textures';
import { addWind } from './wind';

const rnd = mulberry32(4242);
const noise = new Simplex2(77);

// ── geometry ─────────────────────────────────────────────────────────────────

/** A coconut palm: curved, tapering trunk; ~11 drooping fronds; a coconut cluster. */
function palmGeometry(lean: number, H: number) {
  const trunkPts: THREE.Vector3[] = [];
  const ring = 7;
  const seg = 12;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const P = (t: number) => new THREE.Vector3(lean * t * t * 3, H * t, 0);
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const c = P(t);
    trunkPts.push(c);
    const r = (0.26 - 0.1 * t) * (t < 0.06 ? 1.35 - t * 5.8 : 1);
    for (let j = 0; j <= ring; j++) {
      const a = (j / ring) * Math.PI * 2;
      pos.push(c.x + Math.cos(a) * r, c.y, c.z + Math.sin(a) * r);
      uv.push(j / ring, (t * H) / 2.5);
    }
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < ring; j++) {
      const a = i * (ring + 1) + j;
      const b = a + ring + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const trunk = new THREE.BufferGeometry();
  trunk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  trunk.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  trunk.setIndex(idx);
  trunk.computeVertexNormals();

  const crown = trunkPts[seg];
  const fronds: THREE.BufferGeometry[] = [];
  const n = 11;
  for (let k = 0; k < n; k++) {
    const az = (k / n) * Math.PI * 2 + rnd() * 0.4;
    const elev = 0.75 - (k % 3) * 0.45 - rnd() * 0.2;
    const L = 4.0 + rnd() * 1.0;
    const steps = 7;
    const fp: number[] = [];
    const fu: number[] = [];
    const fi: number[] = [];
    const dirH = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
    let p = crown.clone();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ang = elev - 1.5 * t * t; // droops under its own weight
      const w = 1.5 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05)) + 0.1;
      const fold = 0.25 * w; // V-shaped cross-section
      const down = new THREE.Vector3(0, -fold, 0);
      const l = p.clone().addScaledVector(side, w / 2).add(down);
      const r = p.clone().addScaledVector(side, -w / 2).add(down);
      fp.push(l.x, l.y, l.z, p.x, p.y, p.z, r.x, r.y, r.z);
      fu.push(0, t, 0.5, t, 1, t);
      if (i < steps) {
        const a = i * 3;
        fi.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
      }
      const d = dirH.clone().multiplyScalar(Math.cos(ang)).add(new THREE.Vector3(0, Math.sin(ang), 0));
      p = p.addScaledVector(d, L / steps);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(fu, 2));
    g.setIndex(fi);
    g.computeVertexNormals();
    fronds.push(g);
  }
  const nuts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const a = k * 1.6;
    const s = new THREE.SphereGeometry(0.14, 5, 4);
    s.translate(crown.x + Math.cos(a) * 0.25, crown.y - 0.3 - (k % 2) * 0.12, crown.z + Math.sin(a) * 0.25);
    nuts.push(s);
  }
  return { trunk, fronds: mergeGeometries(fronds)!, nuts: mergeGeometries(nuts)! };
}

/** Canopy: a dark core blob (fills gaps) + many leaf-cluster cards scattered in an ellipsoid. */
function canopyGeometry(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, cards: number, cardSize: number) {
  const core = new THREE.IcosahedronGeometry(1, 1);
  core.scale(rx * 0.78, ry * 0.72, rz * 0.78).translate(cx, cy, cz);
  const quads: THREE.BufferGeometry[] = [];
  for (let k = 0; k < cards; k++) {
    // Points biased towards the surface of the ellipsoid, facing outwards-ish.
    const u = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const r = 0.65 + 0.35 * Math.sqrt(rnd());
    const d = new THREE.Vector3(Math.sqrt(1 - u * u) * Math.cos(a), u * 0.9, Math.sqrt(1 - u * u) * Math.sin(a));
    const q = new THREE.PlaneGeometry(cardSize, cardSize);
    q.lookAt(d.clone().add(new THREE.Vector3((rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8)));
    q.translate(cx + d.x * rx * r, cy + d.y * ry * r, cz + d.z * rz * r);
    quads.push(q);
  }
  const cardGeo = mergeGeometries(quads)!;
  // Bend normals outward from the canopy centre so lighting reads as one volume.
  const p = cardGeo.getAttribute('position') as THREE.BufferAttribute;
  const n = cardGeo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i) - cx, (p.getY(i) - cy) * 1.4, p.getZ(i) - cz).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  return { core, cards: cardGeo };
}

/** Broadleaf tree (mango / jackfruit / rain tree). */
function broadleafGeometry(height: number, spread: number) {
  const trunk = new THREE.CylinderGeometry(0.2, 0.36, height * 0.62, 8);
  trunk.translate(0, height * 0.31, 0);
  const limbs = [0, 1, 2].map((k) => {
    const l = new THREE.CylinderGeometry(0.07, 0.13, spread * 0.9, 5);
    l.translate(0, spread * 0.45, 0).rotateZ(0.7).rotateY((k * Math.PI * 2) / 3).translate(0, height * 0.55, 0);
    return l;
  });
  return { trunk: mergeGeometries([trunk, ...limbs])!, canopy: canopyGeometry(0, height * 0.72, 0, spread, spread * 0.62, spread, 70, 2.2) };
}

/** Banana plant: a pseudostem and big, arching paddle leaves. */
function bananaGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const stem = new THREE.CylinderGeometry(0.1, 0.16, 2.2, 7);
  stem.translate(0, 1.1, 0);
  const leaves: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 7; k++) {
    const az = k * 0.9 + rnd() * 0.3;
    const pts: number[] = [];
    const ix: number[] = [];
    const L = 2.0;
    const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const w = 0.32 * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.03));
      const c = new THREE.Vector3(0, 2.1, 0).addScaledVector(dir, t * L).add(new THREE.Vector3(0, 0.8 * t - 1.5 * t * t, 0));
      const l = c.clone().addScaledVector(side, w);
      const r = c.clone().addScaledVector(side, -w);
      pts.push(l.x, l.y, l.z, r.x, r.y, r.z);
      if (i < 6) ix.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.setIndex(ix);
    g.computeVertexNormals();
    leaves.push(g);
  }
  parts.push(stem);
  return { stem, leaves: mergeGeometries(leaves)! };
}

/** Two crossed quads for grass / rice tufts, origin at the base. */
function tuftGeometry(w: number, h: number) {
  const a = new THREE.PlaneGeometry(w, h);
  a.translate(0, h / 2, 0);
  const b = a.clone().rotateY(Math.PI / 2);
  return mergeGeometries([a, b])!;
}

// ── placement ────────────────────────────────────────────────────────────────

interface Placement {
  x: number;
  y: number;
  z: number;
  s: number;
  ry: number;
}

/** Meshes with a max view distance; World hides them when the camera is further away. */
let teaCount = 0;
const teaVerts = () => teaCount;
export const lodMeshes: { mesh: THREE.Object3D; x: number; z: number; maxDist: number }[] = [];

/**
 * Instanced meshes split into square tiles, so frustum culling (and the player-centred
 * shadow camera) skip whole tiles instead of drawing every instance in the world.
 */
function addInstances(scene: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, list: Placement[], cast: boolean, colors?: THREE.Color[], o: { tile?: number; maxDist?: number } = {}) {
  const T = o.tile ?? 100;
  const tiles = new Map<string, number[]>();
  list.forEach((p, i) => {
    const k = `${Math.floor(p.x / T)},${Math.floor(p.z / T)}`;
    (tiles.get(k) ?? tiles.set(k, []).get(k)!).push(i);
  });
  const obj = new THREE.Object3D();
  for (const [k, ids] of tiles) {
    const m = new THREE.InstancedMesh(geo, mat, ids.length);
    ids.forEach((id, j) => {
      const p = list[id];
      obj.position.set(p.x, p.y, p.z);
      obj.rotation.set(0, p.ry, 0);
      obj.scale.setScalar(p.s);
      obj.updateMatrix();
      m.setMatrixAt(j, obj.matrix);
      if (colors) m.setColorAt(j, colors[id]);
    });
    m.castShadow = cast;
    m.receiveShadow = true;
    m.computeBoundingSphere();
    scene.add(m);
    if (o.maxDist) {
      const [tx, tz] = k.split(',').map(Number);
      lodMeshes.push({ mesh: m, x: (tx + 0.5) * T, z: (tz + 0.5) * T, maxDist: o.maxDist + T * 0.71 });
    }
  }
}

/**
 * Munnar tea: rows of clipped hedges following the slope, as one merged strip mesh
 * (rounded top, vertex-coloured: darker sides, fresh light flush on top).
 */
function teaHedges(t: Terrain, occupied: (x: number, z: number, pad?: number) => boolean, dry: (x: number, z: number) => boolean): THREE.Mesh {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const nrm = new THREE.Vector3();
  const prof = [[-0.62, 0.0, 0.0], [-0.55, 0.55, 0.25], [-0.25, 0.85, 0.7], [0.25, 0.85, 0.7], [0.55, 0.55, 0.25], [0.62, 0.0, 0.0]];
  const dark = new THREE.Color(0x1f3d17);
  const flush = new THREE.Color(0x6f9a35);
  const ok = (x: number, z: number) => {
    if (hillMask(x, z) < 0.42 || !dry(x, z) || occupied(x, z, 1.2)) return false;
    if (Math.hypot(x - 196, z + 146) < 12) return false;
    if (Math.abs(((x * 0.8 + z * 0.35) % 28) - 14) < 0.9) return false; // estate footpaths
    return t.normalAt(x, z, nrm).y > 0.7;
  };
  for (let gz = -WORLD_HALF + 2; gz < 92; gz += 1.75) {
    let run = -1; // index of the first ring in the current strip
    for (let x = 62; x < WORLD_HALF - 2; x += 0.9) {
      const z = gz + 1.1 * Math.sin(x / 13 + gz * 0.05) + 0.6 * noise.noise(x / 25, gz / 25);
      if (!ok(x, z)) {
        run = -1;
        continue;
      }
      const g = t.heightAt(x, z);
      const bump = 0.85 + 0.15 * noise.noise(x * 0.9, z * 0.9);
      const base = pos.length / 3;
      for (const [o, hgt, light] of prof) {
        pos.push(x, g - 0.05 + hgt * bump, z + o);
        const c = dark.clone().lerp(flush, light * (0.7 + 0.3 * noise.noise(x / 3, z / 3)));
        col.push(c.r, c.g, c.b);
      }
      if (run >= 0) {
        const prev = base - prof.length;
        for (let k = 0; k < prof.length - 1; k++) idx.push(prev + k, base + k, prev + k + 1, prev + k + 1, base + k, base + k + 1);
      }
      run = base;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  teaCount = idx.length / 3;
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  m.castShadow = true;
  return m;
}

/** Open grassy ground: dry land that isn't road, building, temple, maidan, paddy, beach or tea. */
export function grassMask(t: Terrain): (x: number, z: number) => boolean {
  const V = t.N + 1;
  const half = (t.N * t.cell) / 2;
  const blocked = BUILDINGS.map((d) => rect(d.x, d.z, d.w + 3, d.d + 3));
  const temple = rect(TEMPLE.x, TEMPLE.z, TEMPLE.size + 2, TEMPLE.size + 2);
  return (x, z) => {
    if (t.waterDepth(x, z) > 0 || t.roadDist(x, z) < ROAD_WIDTH / 2 + 1.2 || t.isPaddy(x, z) || x - coastX(z) < 24) return false;
    if (hillMask(x, z) > 0.42 || inRect(MAIDAN, x, z, 0.5) || inRect(temple, x, z) || inRect(TEMPLE_POND, x, z, 2) || inRect(JETTY, x, z, 1)) return false;
    if (blocked.some((r) => inRect(r, x, z))) return false;
    const ix = Math.round((x + half) / t.cell);
    const iz = Math.round((z + half) / t.cell);
    const i = (Math.min(V - 1, Math.max(0, iz)) * V + Math.min(V - 1, Math.max(0, ix))) * 3;
    return t.colors[i + 1] > t.colors[i] * 1.15; // green-dominant ground colour
  };
}

export function buildVegetation(scene: THREE.Object3D, physics: RAPIER.World, t: Terrain) {
  const tex = textures();
  const buildingRects = BUILDINGS.map((d) => rect(d.x, d.z, d.w + 5, d.d + 5));
  const temple = rect(TEMPLE.x, TEMPLE.z, TEMPLE.size + 4, TEMPLE.size + 4);
  const occupied = (x: number, z: number, pad = 0) =>
    t.roadDist(x, z) < ROAD_WIDTH / 2 + 1.5 + pad ||
    buildingRects.some((r) => inRect(r, x, z, pad)) ||
    inRect(temple, x, z, pad) || inRect(TEMPLE_POND, x, z, 3 + pad) || inRect(MAIDAN, x, z, -2 + pad) ||
    inRect(JETTY, x, z, 2) || Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z) < 16 || Math.abs(x - coastX(z)) < 2 && false;
  const dry = (x: number, z: number) => t.waterDepth(x, z) === 0 && t.heightAt(x, z) > 0.35;
  const nearWater = (x: number, z: number, r: number) =>
    [[r, 0], [-r, 0], [0, r], [0, -r]].some(([dx, dz]) => t.waterDepth(x + dx, z + dz) > 0.3);

  // ── coconut palms ──
  const palms: Placement[][] = [[], [], []];
  for (let gz = -WORLD_HALF + 4; gz < WORLD_HALF - 4; gz += 6.5) {
    for (let gx = -WORLD_HALF + 4; gx < WORLD_HALF - 4; gx += 6.5) {
      const x = gx + (rnd() - 0.5) * 5;
      const z = gz + (rnd() - 0.5) * 5;
      if (!dry(x, z) || occupied(x, z)) continue;
      const coast = x - coastX(z);
      let p = 0.12;
      if (nearWater(x, z, 7)) p = 0.75;
      else if (coast < 36) p = 0.42;
      else if (nearWater(x, z, 18)) p = 0.35;
      if (t.isPaddy(x, z)) p = PADDY.some((r) => !inRect(r, x, z, -3)) ? 0.5 : 0; // only on the field edges
      if (hillMask(x, z) > 0.35) p = 0.015;
      if (BUILDINGS.some((d) => Math.hypot(d.x - x, d.z - z) < 22)) p = Math.max(p, 0.3);
      if (rnd() > p) continue;
      palms[Math.floor(rnd() * 3)].push({ x, y: t.heightAt(x, z) - 0.1, z, s: 0.8 + rnd() * 0.45, ry: rnd() * Math.PI * 2 });
    }
  }
  const barkMat = new THREE.MeshStandardMaterial({ map: tex.bark, roughness: 0.95 });
  const frondMat = new THREE.MeshStandardMaterial({ map: tex.frond, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75, color: 0xd8ecc0 });
  addWind(frondMat, 'frond');
  const nutMat = new THREE.MeshStandardMaterial({ color: 0x6f7a2c, roughness: 0.7 });
  const variants = [palmGeometry(0.6, 11), palmGeometry(1.5, 10.5), palmGeometry(-0.9, 12.5)];
  variants.forEach((v, i) => {
    addInstances(scene, v.trunk, barkMat, palms[i], true);
    addInstances(scene, v.fronds, frondMat, palms[i], true);
    addInstances(scene, v.nuts, nutMat, palms[i], false, undefined, { maxDist: 120 });
    // Trunks are solid.
    for (const p of palms[i]) physics.createCollider(RAPIER.ColliderDesc.cylinder(2, 0.25 * p.s).setTranslation(p.x, p.y + 2, p.z));
  });

  // ── Munnar tea: continuous hedge rows (built below), silver oaks for shade ──
  const oaks: Placement[] = [];
  const tea: unknown[] = [];
  for (let k = 0; k < 4000 && oaks.length < 70; k++) {
    const x = 60 + rnd() * (WORLD_HALF - 60);
    const z = -WORLD_HALF + rnd() * (WORLD_HALF + 90);
    if (hillMask(x, z) < 0.45 || !dry(x, z) || occupied(x, z, 2)) continue;
    oaks.push({ x, y: t.heightAt(x, z) - 0.1, z, s: 0.85 + rnd() * 0.35, ry: rnd() * 6.28 });
  }
  scene.add(teaHedges(t, occupied, dry));

  const oakTrunk = new THREE.CylinderGeometry(0.1, 0.18, 13, 6).translate(0, 6.5, 0);
  const oakCanopy = canopyGeometry(0, 10, 0, 1.8, 3.6, 1.8, 30, 1.6);
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x24401a, roughness: 0.95 });
  const cardMat = new THREE.MeshStandardMaterial({ map: tex.leaves, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8, color: 0xc9dcb0 });
  addWind(cardMat, 'leaf');
  addInstances(scene, oakTrunk, new THREE.MeshStandardMaterial({ color: 0x6b5a48 }), oaks, true);
  addInstances(scene, oakCanopy.core, coreMat, oaks, true);
  addInstances(scene, oakCanopy.cards, cardMat, oaks, true);

  // ── broadleaf trees (mango, jackfruit, rain trees) ──
  const trees: Placement[][] = [[], []];
  for (let k = 0; k < 2600 && trees[0].length + trees[1].length < 170; k++) {
    const x = (rnd() * 2 - 1) * (WORLD_HALF - 6);
    const z = (rnd() * 2 - 1) * (WORLD_HALF - 6);
    if (!dry(x, z) || occupied(x, z, 3) || t.isPaddy(x, z) || hillMask(x, z) > 0.4 || x - coastX(z) < 30) continue;
    if (t.heightAt(x, z) < 0.9) continue;
    trees[k % 2].push({ x, y: t.heightAt(x, z) - 0.1, z, s: 0.8 + rnd() * 0.5, ry: rnd() * 6.28 });
  }
  const treeGeos = [broadleafGeometry(9, 4.2), broadleafGeometry(7, 3.4)];
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95 });
  treeGeos.forEach((g, i) => {
    addInstances(scene, g.trunk, trunkMat, trees[i], true);
    addInstances(scene, g.canopy.core, coreMat, trees[i], true);
    addInstances(scene, g.canopy.cards, cardMat, trees[i], true);
    for (const p of trees[i]) physics.createCollider(RAPIER.ColliderDesc.cylinder(2, 0.35 * p.s).setTranslation(p.x, p.y + 2, p.z));
  });

  // ── banana plants around the houses ──
  const bananas: Placement[] = [];
  for (const d of BUILDINGS) {
    if (d.kind === 'hall') continue;
    for (let k = 0; k < 9; k++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.max(d.w, d.d) / 2 + 4 + rnd() * 6;
      const x = d.x + Math.cos(a) * r;
      const z = d.z + Math.sin(a) * r;
      if (!dry(x, z) || occupied(x, z, -1)) continue;
      bananas.push({ x, y: t.heightAt(x, z), z, s: 0.8 + rnd() * 0.4, ry: rnd() * 6.28 });
    }
  }
  const banana = bananaGeometry();
  addInstances(scene, banana.stem, new THREE.MeshStandardMaterial({ color: 0x7a8a3a }), bananas, true);
  const bananaMat = new THREE.MeshStandardMaterial({ color: 0x5f9a2e, side: THREE.DoubleSide, roughness: 0.6 });
  addWind(bananaMat, 'banana');
  addInstances(scene, banana.leaves, bananaMat, bananas, true);

  // ── rice in the paddy fields ──
  const rice: Placement[] = [];
  for (const p of PADDY) {
    for (let z = p.z0 + 1; z < p.z1 - 1; z += 1.25) {
      for (let x = p.x0 + 1; x < p.x1 - 1; x += 1.25) {
        const xx = x + (rnd() - 0.5) * 0.5;
        const zz = z + (rnd() - 0.5) * 0.5;
        const y = t.heightAt(xx, zz);
        if (y > 0.85 || y < 0.4) continue; // skip bunds and canal edges
        rice.push({ x: xx, y: y - 0.02, z: zz, s: 0.8 + rnd() * 0.4, ry: rnd() * 6.28 });
      }
    }
  }
  const riceMat = new THREE.MeshStandardMaterial({ map: tex.grass, alphaTest: 0.4, side: THREE.DoubleSide, color: 0xc8f07a, roughness: 0.8 });
  addWind(riceMat, 'grass', 0.8);
  addInstances(scene, tuftGeometry(1.1, 0.75), riceMat, rice, false, undefined, { tile: 50, maxDist: 110 });

  // ── grass tufts on open land ──
  const grass: Placement[] = [];
  for (let k = 0; k < 40000 && grass.length < 4500; k++) {
    const x = (rnd() * 2 - 1) * (WORLD_HALF - 3);
    const z = (rnd() * 2 - 1) * (WORLD_HALF - 3);
    if (!dry(x, z) || t.isPaddy(x, z) || x - coastX(z) < 22 || hillMask(x, z) > 0.45) continue;
    const rd = t.roadDist(x, z);
    if (rd < ROAD_WIDTH / 2 + 0.5 || inRect(MAIDAN, x, z, -1) || buildingRects.some((r) => inRect(r, x, z, -1)) || inRect(temple, x, z)) continue;
    if (rnd() > (rd < 12 ? 0.9 : 0.45)) continue;
    grass.push({ x, y: t.heightAt(x, z) - 0.03, z, s: 0.6 + rnd() * 0.6, ry: rnd() * 6.28 });
  }
  const grassMat = new THREE.MeshStandardMaterial({ map: tex.grass, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xd8f0a0, roughness: 0.9 });
  addWind(grassMat, 'grass');
  addInstances(scene, tuftGeometry(0.55, 0.32), grassMat, grass, false, undefined, { tile: 50, maxDist: 90 });

  // ── rocks on the Kovalam headland and along the shore ──
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6d6862, roughness: 0.95, flatShading: true });
  const rockGeo = new THREE.DodecahedronGeometry(1, 1);
  {
    const p = rockGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      v.multiplyScalar(1 + 0.25 * noise.noise(v.x * 2, v.y * 2 + v.z));
      p.setXYZ(i, v.x, v.y * 0.7, v.z);
    }
    rockGeo.computeVertexNormals();
  }
  const rocks: Placement[] = [];
  for (let k = 0; k < 90; k++) {
    const a = rnd() * Math.PI * 2;
    const r = HEADLAND.r * (0.6 + rnd() * 0.75);
    const x = HEADLAND.x + Math.cos(a) * r;
    const z = HEADLAND.z + Math.sin(a) * r;
    if (Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z) < 9) continue;
    const s = 0.6 + rnd() * 2.2;
    rocks.push({ x, y: t.heightAt(x, z) - 0.3 * s, z, s, ry: rnd() * 6.28 });
    if (s > 1.2) physics.createCollider(RAPIER.ColliderDesc.ball(s * 0.75).setTranslation(x, t.heightAt(x, z), z));
  }
  addInstances(scene, rockGeo, rockMat, rocks, true);

  return { palms: palms.reduce((a, l) => a + l.length, 0), tea: tea.length + teaVerts(), trees: trees[0].length + trees[1].length, rice: rice.length, grass: grass.length };
}
