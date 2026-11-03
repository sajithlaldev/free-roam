import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Simplex2, clamp, lerp, smoothstep } from './noise';
import { terrainMaterial } from './terrainMaterial';
import {
  BUILDINGS, CANALS, HEADLAND, LAKE, MAIDAN, OFFROAD, OFFROAD_CREEK, OFFROAD_MOUNDS, OFFROAD_PITS, OFFROAD_TRACK, PADDY, PADDY_Y, ROADS, ROAD_WIDTH, SUMMIT, TEMPLE,
  TEMPLE_POND, WATER_Y, WORLD_HALF, coastX, hillMask, inRect, rect, type Rect, type V2,
} from './layout';

const N = 480; // cells per side
const CELL = (WORLD_HALF * 2) / N; // 1 m

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

  // Off-road park: rough ground, steep mounds, mud pits, a rutted twin-track trail.
  h += offroadRelief(x, z);

  // Fine relief on open ground (tussocks, hollows); roads and pads level it out later.
  h += 0.05 * noise.noise(x / 1.3, z / 1.3) + 0.022 * noise.noise(x / 0.55, z / 0.55);
  return h;
}

export function offroadRelief(x: number, z: number): number {
  const od = distToRect(OFFROAD, x, z);
  if (od > 14) return 0;
  const k = 1 - smoothstep(0, 14, od);
  let r = 0.6 * noise.fbm(x / 9 + 11, z / 9 - 4, 3) + 0.22 * noise.noise(x / 2.6, z / 2.6) + 0.09 * noise.noise(x / 1.1, z / 1.1);
  for (const m of OFFROAD_MOUNDS) {
    const dd = Math.hypot(x - m.x, z - m.z) / m.r;
    if (dd < 1.35) r += m.h * smoothstep(1.35, 0.3, dd) + 0.4 * noise.ridged(x / 3, z / 3, 2) * smoothstep(1.35, 0.6, dd);
  }
  for (const p of OFFROAD_PITS) {
    const dd = Math.hypot(x - p.x, z - p.z) / p.r;
    if (dd < 1.1) r -= 1.0 * smoothstep(1.1, 0.35, dd);
  }
  const { d } = polyDist(OFFROAD_TRACK, x, z);
  if (d < 4) {
    const tw = 1 - smoothstep(2, 4, d);
    r *= 1 - 0.55 * tw; // the track is packed smoother…
    r -= 0.14 * Math.exp(-(((d - 0.85) / 0.22) ** 2)) * tw; // …with two wheel ruts
  }
  return r * k;
}

/** 0..1: on the off-road trail (for surfaces / vegetation). */
export function onTrail(x: number, z: number): number {
  return 1 - smoothstep(1.8, 3.2, polyDist(OFFROAD_TRACK, x, z).d);
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
  /** Per-vertex surface weights (grass, soil, sand, rock) + mud, and a colour tint. */
  splat: Float32Array;
  mud: Float32Array;
  tint: Float32Array;
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
  {
    const { d } = polyDist(OFFROAD_CREEK, x, z);
    if (d < 8) h = lerp(-0.45 + 0.1 * noise.noise(x / 2, z / 2), h, smoothstep(2.2, 8, d)); // shallow ford
  }
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
  const { splat, mud, tint } = terrainSplat(heights, roadDistGrid, V);
  cached = {
    splat,
    mud,
    tint,
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

/**
 * Surface weights for the PBR terrain shader, following the same zones as the colours:
 * grass on open land, laterite soil on the maidan / road shoulders / steep banks, sand on
 * the beach and in the temple court, rock on the headland and cliffs, mud at the water.
 * The tint gently shifts each zone (lush lowland, dry patches, darker hills, bright paddy).
 */
function terrainSplat(heights: Float32Array, roadD: Float32Array, V: number) {
  const splat = new Float32Array(V * V * 4);
  const mud = new Float32Array(V * V);
  const tint = new Float32Array(V * V * 3);
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
      const n2 = noise.noise(x / 5, z / 5);
      const n3 = noise.noise(x / 40 + 5, z / 40 - 3);
      const coast = x - coastX(z);
      let so = Math.max(0, n2 - 0.45) * 0.8; // bare earth patches in the grass
      let sa = 0;
      let ro = 0;
      let mu = 0;
      const lush = 0.5 + 0.5 * n1;
      let tr = 0.92 + 0.18 * (1 - lush) + 0.06 * n3;
      let tg = 1.0 + 0.06 * lush;
      let tb = 0.9 + 0.05 * n3;
      if (hillMask(x, z) > 0.3) {
        tr *= 0.86;
        tg *= 0.95;
        tb *= 0.85;
      }
      if (slope > 0.55) so = Math.max(so, smoothstep(0.55, 1.0, slope));
      if (slope > 1.1) ro = smoothstep(1.1, 1.6, slope);
      if (PADDY.some((p) => inRect(p, x, z))) {
        if (h > PADDY_Y + 0.12) so = Math.max(so, 0.5);
        else {
          mu = 0.35;
          tr = 0.85;
          tg = 1.28;
          tb = 0.72;
        }
      }
      if (inRect(MAIDAN, x, z, 1)) so = 1;
      const rd = roadD[i];
      if (rd < ROAD_WIDTH / 2 + 2.2) so = Math.max(so, smoothstep(ROAD_WIDTH / 2 + 2.2, ROAD_WIDTH / 2 + 0.6, rd));
      if (inRect(rect(TEMPLE.x, TEMPLE.z, TEMPLE.size, TEMPLE.size), x, z)) sa = 0.8;
      if (coast < 32 && h < 4.5) sa = Math.max(sa, smoothstep(32, 16, coast));
      const hd = Math.hypot(x - HEADLAND.x, z - HEADLAND.z) / HEADLAND.r;
      if (hd < 1.15 && h > 1.0) ro = Math.max(ro, smoothstep(1.15, 0.7, hd) * (0.6 + 0.4 * Math.max(0, n2 + 0.3)));
      if (distToRect(OFFROAD, x, z) < 6) {
        so = Math.max(so, 0.45 + 0.35 * Math.max(0, n2));
        const tr2 = onTrail(x, z);
        so = Math.max(so, tr2);
        for (const pit of OFFROAD_PITS) if (Math.hypot(x - pit.x, z - pit.z) < pit.r * 1.1) mu = Math.max(mu, 0.9);
        if (slope > 0.45) ro = Math.max(ro, smoothstep(0.45, 0.9, slope) * 0.8);
      }
      if (h < WATER_Y + 0.6 && coast > 10) mu = Math.max(mu, smoothstep(WATER_Y + 0.6, WATER_Y - 0.4, h));
      if (h < WATER_Y - 0.15) {
        if (coast < 0) sa = 1;
        else mu = 1;
      }
      // Grass fills whatever the other surfaces don't take.
      const g = 1 - Math.min(1, so + sa + ro + mu);
      const sum = g + so + sa + ro + mu || 1;
      splat.set([g / sum, so / sum, sa / sum, ro / sum], i * 4);
      mud[i] = mu / sum;
      tint.set([tr, tg, tb], i * 3);
    }
  }
  return { splat, mud, tint };
}

// ── mesh + collider ───────────────────────────────────────────────────────────

/** The terrain as 8×8 chunk meshes (so the GPU can skip chunks that are off screen). */
export function buildTerrainMesh(t: Terrain): THREE.Group {
  const V = t.N + 1;
  const C = 8;
  const cs = t.N / C; // cells per chunk side
  const mat = terrainMaterial();
  const group = new THREE.Group();
  for (let cz = 0; cz < C; cz++)
    for (let cx = 0; cx < C; cx++) {
      const n = cs + 1;
      const pos = new Float32Array(n * n * 3);
      const col = new Float32Array(n * n * 3);
      const spl = new Float32Array(n * n * 4);
      const mud = new Float32Array(n * n);
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const ix = cx * cs + i;
          const iz = cz * cs + j;
          const src = iz * V + ix;
          const k = j * n + i;
          pos.set([-WORLD_HALF + ix * t.cell, t.heights[src], -WORLD_HALF + iz * t.cell], k * 3);
          col.set(t.tint.subarray(src * 3, src * 3 + 3), k * 3);
          spl.set(t.splat.subarray(src * 4, src * 4 + 4), k * 4);
          mud[k] = t.mud[src];
        }
      const idx = new Uint32Array(cs * cs * 6);
      let q = 0;
      for (let j = 0; j < cs; j++)
        for (let i = 0; i < cs; i++) {
          const a0 = j * n + i;
          const b0 = a0 + 1;
          const c0 = a0 + n;
          const d0 = c0 + 1;
          idx.set([a0, c0, b0, b0, c0, d0], q); // diagonal c–b, matching heightAt
          q += 6;
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
      g.setAttribute('mud', new THREE.BufferAttribute(mud, 1));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      // Seam-free lighting: normals from the global height field, not just this chunk.
      const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let k = 0; k < n * n; k++) {
        t.normalAt(pos[k * 3], pos[k * 3 + 2], v);
        nrm.setXYZ(k, v.x, v.y, v.z);
      }
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      group.add(m);
    }
  return group;
}

/**
 * Collision: a Rapier height field (far cheaper than a 460k-triangle mesh). Its row/column
 * convention is checked with raycasts against heightAt; falls back to a triangle mesh.
 */
export function buildTerrainCollider(physics: RAPIER.World, t: Terrain): RAPIER.Collider {
  const V = t.N + 1;
  const size = t.N * t.cell;
  const check = (c: RAPIER.Collider) => {
    physics.step(); // update the query pipeline
    let worst = 0;
    for (let k = 0; k < 24; k++) {
      const x = (((k * 7919) % 997) / 997 - 0.5) * size * 0.9;
      const z = (((k * 104729) % 991) / 991 - 0.5) * size * 0.9;
      const hit = physics.castRay(new RAPIER.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 }), 400, true, undefined, undefined, undefined, undefined, (o) => o === c);
      if (!hit) return Infinity;
      worst = Math.max(worst, Math.abs(200 - hit.timeOfImpact - t.heightAt(x, z)));
    }
    return worst;
  };
  for (const transpose of [true, false]) {
    const h = new Float32Array(V * V);
    for (let iz = 0; iz < V; iz++) for (let ix = 0; ix < V; ix++) h[transpose ? ix * V + iz : iz * V + ix] = t.heights[iz * V + ix];
    const c = physics.createCollider(RAPIER.ColliderDesc.heightfield(t.N, t.N, h, { x: size, y: 1, z: size }).setFriction(0.9));
    const err = check(c);
    if (err < 0.15) return c;
    physics.removeCollider(c, false);
  }
  console.warn('heightfield orientation check failed; using a triangle mesh');
  const pos = new Float32Array(V * V * 3);
  for (let iz = 0; iz < V; iz++) for (let ix = 0; ix < V; ix++) pos.set([-WORLD_HALF + ix * t.cell, t.heights[iz * V + ix], -WORLD_HALF + iz * t.cell], (iz * V + ix) * 3);
  const idx = new Uint32Array(t.N * t.N * 6);
  let q = 0;
  for (let iz = 0; iz < t.N; iz++)
    for (let ix = 0; ix < t.N; ix++) {
      const a0 = iz * V + ix;
      idx.set([a0, a0 + V, a0 + 1, a0 + 1, a0 + V, a0 + V + 1], q);
      q += 6;
    }
  return physics.createCollider(RAPIER.ColliderDesc.trimesh(pos, idx).setFriction(0.9));
}
