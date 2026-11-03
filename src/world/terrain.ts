import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Simplex2, clamp, lerp, smoothstep } from './noise';
import {
  BUILDINGS, CANALS, HEADLAND, LAKE, MAIDAN, PADDY, PADDY_Y, ROADS, ROAD_WIDTH, SUMMIT, TEMPLE,
  TEMPLE_POND, WATER_Y, WORLD_HALF, coastX, hillMask, inRect, rect, type Rect, type V2,
} from './layout';

const N = 240; // cells per side
const CELL = (WORLD_HALF * 2) / N; // 2 m

const noise = new Simplex2(20251103);

// ── geometry helpers ─────────────────────────────────────────────────────────

/** Distance from p to polyline, plus which segment / how far along the line (metres). */
function polyDist(pts: V2[], x: number, z: number): { d: number; s: number } {
  let best = Infinity;
  let bestS = 0;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const len = Math.sqrt(len2);
    const t = clamp(((x - ax) * dx + (z - az) * dz) / len2, 0, 1);
    const px = ax + dx * t - x;
    const pz = az + dz * t - z;
    const d = px * px + pz * pz;
    if (d < best) {
      best = d;
      bestS = acc + t * len;
    }
    acc += len;
  }
  return { d: Math.sqrt(best), s: bestS };
}

function polyLength(pts: V2[]): number {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return L;
}

/** Point at arc length s along the polyline, plus the unit tangent. */
export function polyAt(pts: V2[], s: number): { x: number; z: number; tx: number; tz: number } {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (s <= acc + len || i === pts.length - 2) {
      const t = clamp((s - acc) / len, 0, 1);
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / len, tz: (bz - az) / len };
    }
    acc += len;
  }
  return { x: pts[0][0], z: pts[0][1], tx: 1, tz: 0 };
}

const distToRect = (r: Rect, x: number, z: number) => {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dz = Math.max(r.z0 - z, 0, z - r.z1);
  return Math.hypot(dx, dz);
};

// ── height layers ─────────────────────────────────────────────────────────────

function lakeE(x: number, z: number) {
  const e = ((x - LAKE.x) / LAKE.rx) ** 2 + ((z - LAKE.z) / LAKE.rz) ** 2;
  return e + 0.12 * noise.noise(x / 25, z / 25);
}

/** Distance to the nearest open water edge (lake or canal), for lowland blending. */
function waterDist(x: number, z: number) {
  let d = Math.max(0, (Math.sqrt(Math.max(0, lakeE(x, z))) - 1) * Math.min(LAKE.rx, LAKE.rz));
  for (const c of CANALS) d = Math.min(d, Math.max(0, polyDist(c.pts, x, z).d - c.width / 2));
  return d;
}

/** Natural ground before anything man-made is levelled. */
function natural(x: number, z: number): number {
  let h = 1.9 + 0.9 * noise.fbm(x / 70, z / 70, 4) + 0.35 * noise.fbm(x / 14, z / 14, 2);

  // Lowlands (Kuttanad): flat, barely above the water near the backwaters.
  const low = 1 - smoothstep(25, 80, waterDist(x, z));
  h = lerp(h, 1.0 + 0.15 * noise.noise(x / 9, z / 9), low * 0.9);

  // Munnar hills.
  const m = hillMask(x, z);
  if (m > 0) {
    const sd = Math.hypot(x - SUMMIT.x, z - SUMMIT.z);
    // Rolling, rounded hills (Munnar), not jagged peaks.
    h += m * (24 * (0.5 + 0.5 * noise.fbm(x / 130 + 3, z / 130 - 7, 3)) + 3.5 * noise.fbm(x / 32, z / 32, 2));
    h += m * 28 * Math.exp(-((sd / 62) ** 2));
  }

  // Coast: beach, then the seabed.
  const d = x - coastX(z);
  if (d < 34) {
    const shore = d < 0 ? Math.max(-8, d * 0.22) : 0.25 + d * 0.07;
    h = lerp(shore, h, smoothstep(14, 34, d));
  }

  // Kovalam headland: a rocky hump rising out of the sea.
  const hd = Math.hypot(x - HEADLAND.x, z - HEADLAND.z) / HEADLAND.r;
  if (hd < 1.4) {
    const k = smoothstep(1.4, 0.2, hd);
    h = Math.max(h, k * HEADLAND.h + k * 1.6 * noise.ridged(x / 7, z / 7, 3) - 2.5 * (1 - k));
  }
  return h;
}

/** Natural + paddy fields + flat town pads (no roads, no water yet). */
function levelled(x: number, z: number): number {
  let h = natural(x, z);

  for (const p of PADDY) {
    const dd = distToRect(p, x, z);
    if (dd < 4) {
      const w = 1 - smoothstep(0, 4, dd);
      // Bunds (raised earth walls) every 18 m.
      const bx = Math.abs(((x - p.x0) % 18) - 9);
      const bz = Math.abs(((z - p.z0) % 18) - 9);
      const bund = Math.max(smoothstep(8.2, 9, bx), smoothstep(8.2, 9, bz)) * 0.3;
      h = lerp(h, PADDY_Y + bund, w);
    }
  }

  for (const pad of PADS) {
    const dd = distToRect(pad.r, x, z);
    if (dd < pad.blend) h = lerp(h, pad.h, 1 - smoothstep(0, pad.blend, dd));
  }
  return h;
}

interface Pad {
  r: Rect;
  h: number;
  blend: number;
}
const PADS: Pad[] = [];
function addPad(r: Rect, blend: number) {
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  PADS.push({ r, h: Math.max(1.6, natural(cx, cz)), blend });
}
addPad(MAIDAN, 6);
addPad(rect(TEMPLE.x, TEMPLE.z, TEMPLE.size + 6, TEMPLE.size + 6), 8);
addPad(rect(TEMPLE_POND.x0 + 12, TEMPLE_POND.z0 + 10, 34, 30), 6);
for (const b of BUILDINGS) addPad(rect(b.x, b.z, b.w + 5, b.d + 5), 5);
addPad(rect(196, -146, 12, 12), 9); // hill-top viewpoint

// ── roads ─────────────────────────────────────────────────────────────────────

export interface RoadProfile {
  pts: V2[];
  length: number;
  /** Centre-line height every 2 m. */
  h: Float32Array;
  /** [s0, s1] spans (metres along the road) that cross water and need a bridge. */
  bridges: [number, number][];
}
const STEP = 2;

function buildRoadProfiles(): RoadProfile[] {
  return ROADS.map((pts) => {
    const length = polyLength(pts);
    const n = Math.ceil(length / STEP) + 1;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = polyAt(pts, i * STEP);
      raw[i] = levelled(p.x, p.z);
    }
    // Smooth the profile so the road doesn't follow every bump.
    const h = new Float32Array(n);
    const W = 6;
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let k = -W; k <= W; k++) {
        const j = clamp(i + k, 0, n - 1);
        s += raw[j];
        c++;
      }
      h[i] = Math.max(1.0, s / c);
    }
    return { pts, length, h, bridges: [] };
  });
}

function profileAt(r: RoadProfile, s: number) {
  const f = clamp(s / STEP, 0, r.h.length - 1);
  const i = Math.floor(f);
  const j = Math.min(i + 1, r.h.length - 1);
  return lerp(r.h[i], r.h[j], f - i);
}

// ── the terrain ───────────────────────────────────────────────────────────────

export interface Terrain {
  N: number;
  cell: number;
  heights: Float32Array; // (N+1)² row-major: [iz * (N+1) + ix]
  colors: Float32Array;
  roads: RoadProfile[];
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  /** Metres of water above the ground here (0 on dry land). */
  waterDepth(x: number, z: number): number;
  /** Distance to the nearest road centre line. */
  roadDist(x: number, z: number): number;
  isPaddy(x: number, z: number): boolean;
}

function finalHeight(x: number, z: number, roads: RoadProfile[]): { h: number; road: number } {
  let h = levelled(x, z);

  // Roads: level the cross-section to the smoothed centre-line height.
  let roadD = Infinity;
  for (const r of roads) {
    const { d, s } = polyDist(r.pts, x, z);
    if (d < ROAD_WIDTH / 2 + 7) {
      const w = 1 - smoothstep(ROAD_WIDTH / 2 + 0.5, ROAD_WIDTH / 2 + 7, d);
      h = lerp(h, profileAt(r, s) - 0.05, w);
    }
    roadD = Math.min(roadD, d);
  }

  // Water: lake, canals, temple pond (carved last so roads cross them on bridges).
  const e = lakeE(x, z);
  if (e < 1.5) h = lerp(-2.6, h, smoothstep(0.8, 1.25, e));
  for (const c of CANALS) {
    const { d } = polyDist(c.pts, x, z);
    if (d < c.width / 2 + 4) h = lerp(-2.3, h, smoothstep(c.width / 2 - 2.5, c.width / 2 + 3, d));
  }
  if (inRect(TEMPLE_POND, x, z)) h = -1.8;
  return { h, road: roadD };
}

let cached: Terrain | null = null;

export function getTerrain(): Terrain {
  if (cached) return cached;
  const roads = buildRoadProfiles();
  const V = N + 1;
  const heights = new Float32Array(V * V);
  const roadDistGrid = new Float32Array(V * V);
  for (let iz = 0; iz < V; iz++) {
    for (let ix = 0; ix < V; ix++) {
      const x = -WORLD_HALF + ix * CELL;
      const z = -WORLD_HALF + iz * CELL;
      const { h, road } = finalHeight(x, z, roads);
      heights[iz * V + ix] = h;
      roadDistGrid[iz * V + ix] = road;
    }
  }

  const heightAt = (x: number, z: number): number => {
    const fx = clamp((x + WORLD_HALF) / CELL, 0, N - 1e-4);
    const fz = clamp((z + WORLD_HALF) / CELL, 0, N - 1e-4);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const u = fx - ix;
    const v = fz - iz;
    const h00 = heights[iz * V + ix];
    const h10 = heights[iz * V + ix + 1];
    const h01 = heights[(iz + 1) * V + ix];
    const h11 = heights[(iz + 1) * V + ix + 1];
    // Same triangulation as the mesh: diagonal from (0,1) to (1,0).
    return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  };
  const sampleGrid = (g: Float32Array, x: number, z: number) => {
    const ix = clamp(Math.round((x + WORLD_HALF) / CELL), 0, N);
    const iz = clamp(Math.round((z + WORLD_HALF) / CELL), 0, N);
    return g[iz * V + ix];
  };

  // Mark the bridge spans: road samples whose ground ended up under water.
  for (const r of roads) {
    let start = -1;
    const n = r.h.length;
    for (let i = 0; i <= n; i++) {
      const p = i < n ? polyAt(r.pts, i * STEP) : null;
      const wet = p ? heightAt(p.x, p.z) < r.h[i] - 1.2 && heightAt(p.x, p.z) < WATER_Y + 0.4 : false;
      if (wet && start < 0) start = i;
      if (!wet && start >= 0) {
        r.bridges.push([Math.max(0, (start - 3) * STEP), Math.min(r.length, (i + 2) * STEP)]);
        start = -1;
      }
    }
  }

  const colors = terrainColors(heights, roadDistGrid, V);
  cached = {
    N,
    cell: CELL,
    heights,
    colors,
    roads,
    heightAt,
    normalAt(x, z, out = new THREE.Vector3()) {
      const e = 0.75;
      return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
    },
    waterDepth: (x, z) => Math.max(0, WATER_Y - heightAt(x, z)),
    roadDist: (x, z) => sampleGrid(roadDistGrid, x, z),
    isPaddy: (x, z) => PADDY.some((p) => inRect(p, x, z, -1)),
  };
  return cached;
}

// ── colours ───────────────────────────────────────────────────────────────────

function terrainColors(heights: Float32Array, roadD: Float32Array, V: number): Float32Array {
  const out = new Float32Array(V * V * 3);
  const c = new THREE.Color();
  const tmp = new THREE.Color();
  const pal = {
    sand: new THREE.Color(0xd8c594),
    wetSand: new THREE.Color(0xa89366),
    seabed: new THREE.Color(0x6f6848),
    mud: new THREE.Color(0x5b5236),
    grass: new THREE.Color(0x5c8a33),
    lush: new THREE.Color(0x3f7a26),
    dry: new THREE.Color(0x8a8a45),
    hill: new THREE.Color(0x4e7f2e),
    laterite: new THREE.Color(0xa0522d),
    rock: new THREE.Color(0x77706a),
    paddy: new THREE.Color(0x8cbf3a),
    bund: new THREE.Color(0x6b7a35),
  };
  for (let iz = 0; iz < V; iz++) {
    for (let ix = 0; ix < V; ix++) {
      const x = -WORLD_HALF + ix * CELL;
      const z = -WORLD_HALF + iz * CELL;
      const i = iz * V + ix;
      const h = heights[i];
      const hx = heights[iz * V + Math.min(ix + 1, V - 1)] - heights[iz * V + Math.max(ix - 1, 0)];
      const hz = heights[Math.min(iz + 1, V - 1) * V + ix] - heights[Math.max(iz - 1, 0) * V + ix];
      const slope = Math.hypot(hx, hz) / (2 * CELL);
      const n1 = noise.noise(x / 18, z / 18);
      const n2 = noise.noise(x / 4.5, z / 4.5);
      const coast = x - coastX(z);

      c.copy(pal.grass).lerp(pal.lush, 0.5 + 0.5 * n1).lerp(pal.dry, Math.max(0, n2) * 0.25);
      if (hillMask(x, z) > 0.3) c.lerp(pal.hill, 0.6);
      if (slope > 0.6) c.lerp(pal.laterite, smoothstep(0.6, 1.1, slope) * 0.7);

      if (PADDY.some((p) => inRect(p, x, z))) {
        c.copy(h > PADDY_Y + 0.12 ? pal.bund : pal.paddy).lerp(tmp.set(0xa6cc4a), 0.25 + 0.25 * n2);
      }
      if (inRect(MAIDAN, x, z, 1) || roadD[i] < ROAD_WIDTH / 2 + 2.2) c.copy(pal.laterite).lerp(tmp.set(0x7d4a2e), 0.3 + 0.3 * n2);
      if (inRect(rect(TEMPLE.x, TEMPLE.z, TEMPLE.size, TEMPLE.size), x, z)) c.copy(pal.sand).lerp(pal.laterite, 0.25 + 0.15 * n2);

      if (coast < 30 && h < 4.5) c.lerp(h < 0.6 ? pal.wetSand : pal.sand, smoothstep(30, 18, coast));
      const hd = Math.hypot(x - HEADLAND.x, z - HEADLAND.z) / HEADLAND.r;
      if (hd < 1.1 && h > 1.2) c.copy(pal.rock).lerp(pal.grass, Math.max(0, n2) * 0.5 * (1 - slope));
      if (h < WATER_Y - 0.15) c.copy(coast < 0 ? pal.seabed : pal.mud).lerp(pal.wetSand, smoothstep(-2.5, 0, h) * 0.4);
      else if (h < WATER_Y + 0.5 && coast > 10) c.lerp(pal.mud, 0.5);

      const k = 0.93 + 0.07 * n2;
      out[i * 3] = c.r * k;
      out[i * 3 + 1] = c.g * k;
      out[i * 3 + 2] = c.b * k;
    }
  }
  return out;
}

// ── mesh + collider ───────────────────────────────────────────────────────────

export function buildTerrainMesh(t: Terrain, detail: THREE.Texture): THREE.Mesh {
  const V = t.N + 1;
  const pos = new Float32Array(V * V * 3);
  const uv = new Float32Array(V * V * 2);
  for (let iz = 0; iz < V; iz++) {
    for (let ix = 0; ix < V; ix++) {
      const i = iz * V + ix;
      pos[i * 3] = -WORLD_HALF + ix * t.cell;
      pos[i * 3 + 1] = t.heights[i];
      pos[i * 3 + 2] = -WORLD_HALF + iz * t.cell;
      uv[i * 2] = ix / 4;
      uv[i * 2 + 1] = iz / 4;
    }
  }
  const idx = new Uint32Array(t.N * t.N * 6);
  let k = 0;
  for (let iz = 0; iz < t.N; iz++) {
    for (let ix = 0; ix < t.N; ix++) {
      const a = iz * V + ix;
      const b = a + 1;
      const c = a + V;
      const d = c + 1;
      idx.set([a, c, b, b, c, d], k); // diagonal c–b, matching heightAt
      k += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(t.colors, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(
    g,
    new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.96, metalness: 0 }),
  );
  mesh.receiveShadow = true;
  return mesh;
}

export function buildTerrainCollider(physics: RAPIER.World, mesh: THREE.Mesh): RAPIER.Collider {
  const g = mesh.geometry;
  return physics.createCollider(
    RAPIER.ColliderDesc.trimesh(
      (g.getAttribute('position').array as Float32Array).slice(),
      (g.getIndex()!.array as Uint32Array).slice(),
    ).setFriction(0.9),
  );
}
