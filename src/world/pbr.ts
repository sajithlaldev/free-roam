import * as THREE from 'three';
import { mulberry32 } from './noise';

/**
 * Procedural PBR material library: every surface gets an albedo, a normal map derived from
 * a real height field, and roughness — all tileable, built at startup into DataTextures.
 *
 * Terrain layers pack albedo.rgb + height.a and normal.rgb + roughness.a so the terrain
 * shader can height-blend them.
 */

// ── tileable fields ─────────────────────────────────────────────────────────

type Field = Float32Array;

/** Tileable value noise with `period` lattice cells across the texture. */
function valueNoise(N: number, period: number, seed: number): Field {
  const rnd = mulberry32(seed);
  const lat = new Float32Array(period * period).map(() => rnd());
  const out = new Float32Array(N * N);
  const s = period / N;
  for (let y = 0; y < N; y++) {
    const fy = y * s;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % period) * period;
    const r1 = ((y0 + 1) % period) * period;
    for (let x = 0; x < N; x++) {
      const fx = x * s;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % period;
      const c1 = (x0 + 1) % period;
      const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
      const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
      out[y * N + x] = a + (b - a) * sy;
    }
  }
  return out;
}

function fbm(N: number, period: number, octaves: number, seed: number, gain = 0.5): Field {
  const out = new Float32Array(N * N);
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const p = period << o;
    if (p > N) break;
    const n = valueNoise(N, p, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Tileable Worley noise: distance to nearest (f1) and second-nearest (f2) feature point. */
function worley(N: number, cells: number, seed: number): { f1: Field; f2: Field; id: Field } {
  const rnd = mulberry32(seed);
  const pts = new Float32Array(cells * cells * 2).map(() => rnd());
  const ids = new Float32Array(cells * cells).map(() => rnd());
  const f1 = new Float32Array(N * N);
  const f2 = new Float32Array(N * N);
  const id = new Float32Array(N * N);
  const cs = N / cells;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const cx = Math.floor(x / cs);
      const cy = Math.floor(y / cs);
      let d1 = 9;
      let d2 = 9;
      let best = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const gx = (cx + ox + cells) % cells;
          const gy = (cy + oy + cells) % cells;
          const k = gy * cells + gx;
          const px = (cx + ox + pts[k * 2]) * cs;
          const py = (cy + oy + pts[k * 2 + 1]) * cs;
          const d = Math.hypot(px - x, py - y) / cs;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = ids[k];
          } else if (d < d2) d2 = d;
        }
      const i = y * N + x;
      f1[i] = d1;
      f2[i] = d2;
      id[i] = best;
    }
  return { f1, f2, id };
}

/** Bilinear, wrapping sample of a field at fractional pixel coords. */
function sample(f: Field, N: number, x: number, y: number) {
  x = ((x % N) + N) % N;
  y = ((y % N) + N) % N;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const x1 = (x0 + 1) % N;
  const y1 = (y0 + 1) % N;
  const a = f[y0 * N + x0] + (f[y0 * N + x1] - f[y0 * N + x0]) * tx;
  const b = f[y1 * N + x0] + (f[y1 * N + x1] - f[y1 * N + x0]) * tx;
  return a + (b - a) * ty;
}

/** Domain warp: resample `f` with offsets from two noise fields (organic, non-repeating shapes). */
function warp(f: Field, N: number, amount: number, seed: number): Field {
  const wx = fbm(N, 4, 4, seed);
  const wy = fbm(N, 4, 4, seed + 7);
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      out[i] = sample(f, N, x + (wx[i] - 0.5) * amount, y + (wy[i] - 0.5) * amount);
    }
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// ── texture builders ────────────────────────────────────────────────────────

function toTexture(N: number, rgba: Uint8Array, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(rgba, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Normal map (tangent space, +Y up in the texture) from a height field; `a` channel = extra. */
function normalFrom(N: number, h: Field, strength: number, extra?: Field): Uint8Array {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const l = h[y * N + ((x - 1 + N) % N)];
      const r = h[y * N + ((x + 1) % N)];
      const u = h[((y - 1 + N) % N) * N + x];
      const d = h[((y + 1) % N) * N + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * N + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = extra ? clamp01(extra[y * N + x]) * 255 : 255;
    }
  return out;
}

interface Layer {
  /** albedo.rgb (sRGB) + height in alpha */
  albedo: THREE.DataTexture;
  /** normal.rgb + roughness in alpha */
  normal: THREE.DataTexture;
}

type Px = (i: number, x: number, y: number) => [number, number, number, number, number]; // r g b height rough

function layer(N: number, heightStrength: number, h: Field, px: Px): Layer {
  const alb = new Uint8Array(N * N * 4);
  const rough = new Float32Array(N * N);
  const hh = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const [r, g, b, height, ro] = px(i, x, y);
      alb[i * 4] = clamp01(r) * 255;
      alb[i * 4 + 1] = clamp01(g) * 255;
      alb[i * 4 + 2] = clamp01(b) * 255;
      alb[i * 4 + 3] = clamp01(height) * 255;
      hh[i] = height;
      rough[i] = ro;
    }
  void h;
  return { albedo: toTexture(N, alb, true), normal: toTexture(N, normalFrom(N, hh, heightStrength, rough), false) };
}

// ── terrain layers ──────────────────────────────────────────────────────────

function grassLayer(N: number): Layer {
  // Dense turf seen from above: thousands of short blade strokes over darker thatch & soil.
  const rnd = mulberry32(11);
  const h = new Float32Array(N * N);
  const col = new Float32Array(N * N * 3);
  const base = fbm(N, 8, 5, 3);
  const patch = fbm(N, 4, 3, 9);
  for (let i = 0; i < N * N; i++) {
    const d = patch[i];
    col[i * 3] = mix(0.16, 0.24, d) * 0.9;
    col[i * 3 + 1] = mix(0.24, 0.3, base[i]);
    col[i * 3 + 2] = 0.07;
    h[i] = base[i] * 0.25;
  }
  const blades = N * N * 0.09;
  for (let k = 0; k < blades; k++) {
    const x0 = rnd() * N;
    const y0 = rnd() * N;
    const ang = rnd() * Math.PI * 2;
    const len = 3 + rnd() * 9;
    const lum = 0.75 + rnd() * 0.6;
    const dry = rnd() < 0.12 ? 1 : 0;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    for (let s = 0; s < len; s++) {
      const t = s / len;
      const x = (Math.floor(x0 + dx * s) + N) % N;
      const y = (Math.floor(y0 + dy * s) + N) % N;
      const i = y * N + x;
      const hv = 0.35 + 0.65 * t;
      if (hv < h[i]) continue;
      h[i] = hv;
      const g = (0.32 + 0.22 * t) * lum;
      col[i * 3] = dry ? g * 1.05 : g * 0.52;
      col[i * 3 + 1] = dry ? g * 0.95 : g;
      col[i * 3 + 2] = dry ? g * 0.45 : g * 0.22;
    }
  }
  return layer(N, 2.2, h, (i) => [col[i * 3], col[i * 3 + 1], col[i * 3 + 2], h[i], 0.92]);
}

function soilLayer(N: number): Layer {
  // Kerala laterite earth: red-brown and packed, fine grit, sparse small stones of varied
  // size, damp darker patches, and hairline drying cracks only in places (domain-warped).
  const base = fbm(N, 6, 6, 21);
  const grit = fbm(N, 128, 2, 22);
  const damp = fbm(N, 3, 3, 25);
  const st = worley(N, 56, 23);
  const crackW = fbm(N, 4, 3, 26);
  const crackF = worley(N, 7, 24);
  const crackMask = fbm(N, 3, 2, 27);
  return layer(N, 2.6, base, (i, x, y) => {
    const size = 0.06 + 0.16 * st.id[i];
    const stone = smooth(size, size * 0.4, st.f1[i]) * (st.id[i] > 0.83 ? 1 : 0);
    const edge = sample(crackF.f2, N, x + (crackW[i] - 0.5) * 40, y) - sample(crackF.f1, N, x + (crackW[i] - 0.5) * 40, y);
    const crack = smooth(0.035, 0.0, edge) * smooth(0.62, 0.75, crackMask[i]);
    const wet = smooth(0.5, 0.75, damp[i]);
    const v = (0.78 + 0.3 * base[i] + 0.12 * grit[i]) * (1 - 0.28 * wet) - 0.25 * crack;
    const sc = 0.22 + 0.2 * st.id[i];
    const h = 0.4 + 0.25 * base[i] + 0.15 * grit[i] + 0.45 * stone - 0.35 * crack;
    return [mix(0.5 * v, sc, stone), mix(0.25 * v, sc * 0.9, stone), mix(0.14 * v, sc * 0.75, stone), h, mix(0.9, 0.55, wet) - 0.1 * stone];
  });
}

function sandLayer(N: number): Layer {
  // Beach sand: fine grain, wind ripples, the odd shell fragment.
  const grain = fbm(N, 128, 2, 31);
  const low = fbm(N, 4, 3, 32);
  const shells = worley(N, 24, 33);
  return layer(N, 1.6, grain, (i, x, y) => {
    const ripple = Math.sin((y / N) * Math.PI * 2 * 18 + low[i] * 9 + Math.sin((x / N) * Math.PI * 2 * 2) * 1.5) * 0.5 + 0.5;
    const shell = smooth(0.12, 0.05, shells.f1[i]) * (shells.id[i] > 0.8 ? 1 : 0);
    const h = 0.3 + 0.35 * ripple * (0.5 + low[i]) + 0.2 * grain[i] + 0.3 * shell;
    const v = 0.9 + 0.15 * grain[i] + 0.05 * ripple;
    return [mix(0.76 * v, 0.92, shell), mix(0.66 * v, 0.88, shell), mix(0.48 * v, 0.82, shell), h, 0.9];
  });
}

function rockLayer(N: number): Layer {
  // Weathered granite / laterite outcrop: ridged, domain-warped strata, faint fractures,
  // pale weathering on the raised parts and grey-green lichen in the hollows.
  const ridged = fbm(N, 4, 6, 41, 0.55).map((v) => 1 - Math.abs(2 * v - 1));
  const strata = warp(ridged, N, 90, 44);
  const fine = fbm(N, 64, 3, 43);
  const cells = worley(N, 5, 42);
  const lichenF = fbm(N, 8, 4, 45);
  return layer(N, 4.0, strata, (i, x, y) => {
    void cells;
    const crack = smooth(0.08, 0.02, Math.abs(sample(strata, N, x * 1.7, y * 0.6) - 0.5)) * 0.25;
    const h = 0.2 + 0.6 * strata[i] + 0.15 * fine[i] - 0.35 * crack;
    const v = 0.62 + 0.4 * strata[i] + 0.12 * fine[i] - 0.3 * crack;
    const lichen = smooth(0.55, 0.7, lichenF[i] * 0.7 + (1 - strata[i]) * 0.4) * 0.5;
    return [mix(0.46 * v, 0.42, lichen), mix(0.44 * v, 0.46, lichen), mix(0.41 * v, 0.33, lichen), h, 0.8 - 0.1 * lichen];
  });
}

function mudLayer(N: number): Layer {
  const base = fbm(N, 8, 5, 51);
  const wet = fbm(N, 3, 3, 52);
  return layer(N, 1.2, base, (i) => {
    const puddle = smooth(0.55, 0.7, wet[i]);
    const v = 0.7 + 0.3 * base[i];
    return [0.24 * v * (1 - puddle * 0.3), 0.2 * v * (1 - puddle * 0.3), 0.13 * v, 0.4 + 0.3 * base[i] - 0.3 * puddle, mix(0.6, 0.12, puddle)];
  });
}

// ── building / road surfaces ────────────────────────────────────────────────

/** A terrain layer as an ordinary map + normalMap pair (rough in normal.a is ignored). */
export const layerSurface = (l: Layer) => ({ map: l.albedo, normalMap: l.normal });

export interface Surface {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap?: THREE.DataTexture;
}

/** Albedo + normal + roughness (G channel, as three.js expects). */
function surface(N: number, strength: number, px: Px, srgb = true): Surface {
  const alb = new Uint8Array(N * N * 4);
  const rgh = new Uint8Array(N * N * 4);
  const hh = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const [r, g, b, height, ro] = px(i, x, y);
      alb.set([clamp01(r) * 255, clamp01(g) * 255, clamp01(b) * 255, 255], i * 4);
      const rv = clamp01(ro) * 255;
      rgh.set([rv, rv, rv, 255], i * 4);
      hh[i] = height;
    }
  return { map: toTexture(N, alb, srgb), normalMap: toTexture(N, normalFrom(N, hh, strength), false), roughnessMap: toTexture(N, rgh, false) };
}

function asphalt(N: number): Surface {
  // Aggregate, binder, hairline cracks, patched repairs and darker tyre tracks.
  const agg = fbm(N, 256, 1, 61);
  const stones = worley(N, 260, 62);
  const big = fbm(N, 4, 4, 63);
  const cracks = worley(N, 5, 64);
  const patch = worley(N, 3, 65);
  return surface(N, 2.6, (i, x) => {
    const stone = smooth(0.38, 0.2, stones.f1[i]);
    const crack = smooth(0.025, 0.0, cracks.f2[i] - cracks.f1[i]) * smooth(0.45, 0.6, big[i]);
    const repaired = patch.id[i] > 0.82 && patch.f1[i] < 0.5 ? 1 : 0;
    const lane = (x / N) % 0.5;
    const track = Math.exp(-(((lane - 0.12) / 0.05) ** 2)) + Math.exp(-(((lane - 0.38) / 0.05) ** 2));
    let v = 0.2 + 0.08 * agg[i] + 0.12 * stone * stones.id[i] + 0.05 * big[i] - 0.05 * track;
    if (repaired) v *= 0.7;
    v -= crack * 0.12;
    const h = 0.4 + 0.3 * stone + 0.1 * agg[i] - 0.5 * crack;
    return [v, v, v * 1.03, h, 0.92 - 0.25 * track - 0.05 * repaired];
  });
}

function plaster(N: number): Surface {
  // Lime wash on rendered brick: soft undulation, rain streaks from the top, grime at the base.
  const und = fbm(N, 4, 5, 71);
  const fine = fbm(N, 96, 2, 72);
  const streakX = warp(fbm(N, 6, 3, 73), N, 40, 74);
  const blot = fbm(N, 3, 3, 75);
  return surface(N, 1.6, (i, x, y) => {
    const v = y / N; // 0 top → 1 bottom of the tile (UVs are metres; it repeats every 2 m)
    // Monsoon staining: soft, irregular runs, strongest in some places, fading downwards.
    const col = sample(streakX, N, x, y * 0.08);
    const streak = smooth(0.58, 0.85, col) * (0.25 + 0.5 * (1 - v)) * smooth(0.45, 0.7, blot[i]) * 0.7;
    const grime = smooth(0.6, 1.0, v) * 0.35;
    const base = 0.86 + 0.06 * und[i] + 0.03 * fine[i] - 0.22 * streak - grime * (0.5 + 0.5 * fine[i]);
    const h = 0.5 + 0.25 * und[i] + 0.1 * fine[i];
    return [base, base * 0.985, base * 0.95, h, 0.9];
  });
}

function roofTiles(N: number): Surface {
  // Mangalore pattern tiles: rows of interlocking tiles, each with two raised ribs, a lip at
  // the bottom edge and shadowed overlaps; lichen and soot in places.
  const rnd = mulberry32(81);
  const rows = 6;
  const cols = 4;
  const tone = new Float32Array(rows * cols).map(() => 0.85 + rnd() * 0.3);
  const moss = fbm(N, 6, 4, 82);
  const fine = fbm(N, 64, 2, 83);
  return surface(N, 5.5, (i, x, y) => {
    const ry = Math.floor((y / N) * rows);
    const ty = ((y / N) * rows) % 1; // 0 = top of tile (under the row above), 1 = bottom lip
    const off = ry % 2 ? 0.5 : 0;
    const tx = ((x / N) * cols + off) % 1;
    const cx = Math.floor((x / N) * cols + off) % cols;
    const t = tone[ry * cols + cx];
    const rib = Math.max(Math.exp(-(((tx - 0.3) / 0.05) ** 2)), Math.exp(-(((tx - 0.7) / 0.05) ** 2)));
    const lip = smooth(0.82, 0.96, ty);
    const overlap = smooth(0.12, 0.0, ty); // shadow under the next row
    const edge = smooth(0.03, 0.0, Math.min(tx, 1 - tx));
    const h = 0.35 + 0.35 * ty + 0.25 * rib + 0.15 * lip - 0.5 * edge - 0.3 * overlap + 0.04 * fine[i];
    const lichen = smooth(0.58, 0.72, moss[i]) * 0.6;
    const ao = 1 - 0.55 * overlap - 0.3 * edge;
    const r = (0.6 * t + 0.05 * rib) * ao;
    const g = (0.23 * t + 0.02 * rib) * ao;
    const b = (0.13 * t) * ao;
    return [mix(r, 0.22, lichen), mix(g, 0.24, lichen), mix(b, 0.14, lichen), h, 0.72 + 0.15 * lichen];
  });
}

function lateriteBlocks(N: number): Surface {
  // Cut laterite blocks: porous, rusty red, mortar joints.
  const pores = worley(N, 70, 91);
  const base = fbm(N, 8, 5, 92);
  return surface(N, 3.2, (i, x, y) => {
    const rowsN = 7;
    const ry = Math.floor((y / N) * rowsN);
    const bx = ((x / N) * 4 + (ry % 2) * 0.5) % 1;
    const by = ((y / N) * rowsN) % 1;
    const joint = Math.max(smooth(0.035, 0.0, Math.min(bx, 1 - bx)), smooth(0.05, 0.0, Math.min(by, 1 - by)));
    const pore = smooth(0.3, 0.12, pores.f1[i]) * (pores.id[i] > 0.4 ? 1 : 0);
    const v = 0.85 + 0.3 * base[i];
    const h = 0.6 + 0.2 * base[i] - 0.45 * pore - 0.6 * joint;
    const tone = 0.8 + 0.4 * sample(base, N, Math.floor((x / N) * 4) * 37 + ry * 91, ry * 53); // per-block variation
    return [mix(0.46 * v * tone * (1 - 0.45 * pore), 0.5, joint), mix(0.27 * v * tone * (1 - 0.45 * pore), 0.46, joint), mix(0.18 * v * tone, 0.4, joint), h, 0.92];
  });
}

function wood(N: number): Surface {
  const grainSeed = fbm(N, 4, 3, 101);
  const fine = fbm(N, 64, 2, 102);
  return surface(N, 1.4, (i, x) => {
    const g = Math.sin((x / N) * Math.PI * 2 * 24 + grainSeed[i] * 14) * 0.5 + 0.5;
    const v = 0.65 + 0.25 * g + 0.1 * fine[i];
    return [0.36 * v, 0.21 * v, 0.11 * v, 0.5 + 0.2 * g, 0.62];
  });
}

function bark(N: number): Surface {
  // Coconut palm trunk: horizontal leaf-scar rings, fibrous vertical texture.
  const fib = fbm(N, 64, 2, 111);
  const ring = fbm(N, 4, 3, 112);
  return surface(N, 3.4, (i, _x, y) => {
    const r = Math.sin((y / N) * Math.PI * 2 * 14 + ring[i] * 3);
    const scar = smooth(0.7, 1.0, r);
    const v = 0.55 + 0.25 * fib[i] - 0.25 * scar;
    return [0.52 * v, 0.46 * v, 0.38 * v, 0.6 - 0.4 * scar + 0.15 * fib[i], 0.95];
  });
}

function concrete(N: number): Surface {
  const base = fbm(N, 6, 5, 121);
  const pits = worley(N, 60, 122);
  return surface(N, 1.8, (i) => {
    const pit = smooth(0.2, 0.08, pits.f1[i]) * (pits.id[i] > 0.6 ? 1 : 0);
    const v = 0.62 + 0.18 * base[i] - 0.2 * pit;
    return [v, v * 0.98, v * 0.94, 0.5 + 0.2 * base[i] - 0.3 * pit, 0.92];
  });
}

/** Road: asphalt with painted edge lines, centre dashes and dusty laterite shoulders.
 * u runs across the 7 m carriageway, v along it (one repeat = 7 m). */
function roadSurface(N: number, base: Surface): Surface {
  const src = base.map.image.data as Uint8Array;
  const rgh = base.roughnessMap!.image.data as Uint8Array;
  const alb = new Uint8Array(src);
  const rough = new Uint8Array(rgh);
  const h = new Float32Array(N * N);
  const dust = fbm(N, 8, 3, 131);
  const wear = fbm(N, 32, 3, 132);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const i = y * N + x;
      const edge = (u > 0.045 && u < 0.07) || (u > 0.93 && u < 0.955);
      const centre = u > 0.492 && u < 0.508 && v % 0.5 < 0.26;
      let paint = edge || centre ? 1 : 0;
      paint *= smooth(0.25, 0.5, wear[i]); // worn paint
      const shoulder = Math.max(smooth(0.05, 0.0, u), smooth(0.95, 1.0, u)) + smooth(0.08, 0.0, u) * dust[i] * 0.6 + smooth(0.92, 1.0, u) * dust[i] * 0.6;
      const k = i * 4;
      for (let c = 0; c < 3; c++) {
        let val = src[k + c];
        val = val * (1 - paint) + 225 * paint;
        const soil = [150, 90, 60][c];
        val = val * (1 - Math.min(1, shoulder)) + soil * Math.min(1, shoulder);
        alb[k + c] = val;
      }
      rough[k] = rough[k + 1] = rough[k + 2] = paint ? 150 : rgh[k + 1];
      h[i] = 0.5 + 0.25 * paint;
    }
  // combine the paint relief with the asphalt normals
  const nrm = new Uint8Array(base.normalMap.image.data as Uint8Array);
  const pn = normalFrom(N, h, 3);
  for (let i = 0; i < N * N; i++)
    if (h[i] > 0.5) for (let c = 0; c < 3; c++) nrm[i * 4 + c] = (nrm[i * 4 + c] + pn[i * 4 + c]) / 2;
  return { map: toTexture(N, alb, true), normalMap: toTexture(N, nrm, false), roughnessMap: toTexture(N, rough, false) };
}

function carvedStone(N: number): Surface {
  const fig = warp(fbm(N, 16, 4, 141), N, 18, 142);
  const weather = fbm(N, 4, 4, 143);
  const fine = fbm(N, 96, 2, 144);
  return surface(N, 4.5, (i, x, y) => {
    const u = x / N;
    const v = y / N;
    // Horizontal friezes (mouldings) and vertical pilasters framing figure niches.
    const band = Math.abs(((v * 4) % 1) - 0.5);
    const moulding = smooth(0.43, 0.48, band);
    const pil = Math.abs(((u * 6) % 1) - 0.5);
    const pilaster = smooth(0.4, 0.46, pil);
    const inNiche = (1 - moulding) * (1 - pilaster);
    const figure = smooth(0.52, 0.6, fig[i]) * inNiche * 0.8;
    const h = 0.4 + 0.35 * moulding + 0.3 * pilaster - 0.25 * inNiche + 0.45 * figure + 0.06 * fine[i];
    const ao = 1 - 0.2 * inNiche * (1 - figure);
    const dark = smooth(0.55, 0.85, weather[i] + (1 - v) * 0.1) * 0.28; // monsoon weathering
    const c = (0.78 + 0.1 * fine[i]) * ao * (1 - dark);
    return [c, c * 0.94, c * 0.82, h, 0.88];
  });
}

let cache: ReturnType<typeof build> | null = null;
/** Builds everything once (≈1 s); call early. */
export const pbr = () => (cache ??= build());

function build() {
  const t0 = performance.now();
  const T = 512;
  const out = {
    grass: grassLayer(T),
    soil: soilLayer(T),
    sand: sandLayer(T),
    rock: rockLayer(T),
    mud: mudLayer(T),
    asphalt: asphalt(T),
    road: null as unknown as Surface,
    plaster: plaster(T),
    roof: roofTiles(T),
    laterite: lateriteBlocks(T),
    wood: wood(256),
    bark: bark(256),
    concrete: concrete(256),
    carved: carvedStone(T),
    ms: 0,
  };
  out.road = roadSurface(T, out.asphalt);
  out.ms = Math.round(performance.now() - t0);
  return out;
}
