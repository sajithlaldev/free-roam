import * as THREE from 'three';

/**
 * Vehicle materials. Shared ones are created once; paint is cached per colour; plates and
 * the lamps that light up (brake, reverse) are per vehicle.
 */

let shared: Record<string, THREE.Material> | null = null;

function noiseTex(size: number, fn: (x: number, y: number) => number, repeat = 1): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y) * 255)));
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  const t = new THREE.DataTexture(d, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Hexagon-mesh grille insert (alpha-free: dark holes on a black lattice). */
function hexTex(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1c1d1f';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#030303';
  const R = 9;
  for (let row = -1; row < 10; row++)
    for (let col = -1; col < 10; col++) {
      const cx = col * R * 1.75 + (row % 2 ? R * 0.875 : 0);
      const cy = row * R * 1.5;
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        g.lineTo(cx + Math.cos(a) * (R - 2), cy + Math.sin(a) * (R - 2));
      }
      g.fill();
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(9, 9);
  return t;
}

function tyreSidewall(): THREE.CanvasTexture {
  // u: around the tyre, v: across the profile. Fine radial ribs + a lettering band.
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1e1e1e';
  g.fillRect(0, 0, 1024, 64);
  g.fillStyle = '#262626';
  for (let x = 0; x < 1024; x += 6) g.fillRect(x, 0, 2, 64);
  g.fillStyle = '#323232';
  g.font = '700 13px system-ui, sans-serif';
  g.textBaseline = 'middle';
  for (const x of [40, 552]) g.fillText('ALL-TERRAIN  A/T    M+S    RADIAL TUBELESS', x, 20);
  for (const x of [300, 812]) g.fillText('MAX LOAD 1450 KG', x, 44);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export function sharedMaterials(): Record<string, THREE.Material> {
  if (shared) return shared;
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.5, ...o });
  const grain = noiseTex(64, () => 0.75 + Math.random() * 0.25, 6);
  shared = {
    // plastics
    black: std({ color: 0x141516, roughness: 0.55, side: THREE.DoubleSide }),
    plastic: std({ color: 0x1c1d1f, roughness: 0.88, roughnessMap: grain, side: THREE.DoubleSide }),
    trim: std({ color: 0x060607, roughness: 0.18, metalness: 0.2, side: THREE.DoubleSide }), // piano black
    gap: std({ color: 0x020202, roughness: 0.9 }),
    rubber: std({ color: 0x111111, roughness: 0.75 }),
    // metals
    chrome: std({ color: 0xf2f3f5, metalness: 1, roughness: 0.07 }),
    satin: std({ color: 0xb8bcc2, metalness: 0.9, roughness: 0.32 }),
    steel: std({ color: 0x3b3d40, metalness: 0.75, roughness: 0.5 }),
    under: std({ color: 0x171717, roughness: 0.9, metalness: 0.2 }),
    disc: std({ color: 0x6d6e70, metalness: 0.85, roughness: 0.38 }),
    caliperRed: std({ color: 0xa3141a, roughness: 0.35, metalness: 0.2 }),
    caliperGrey: std({ color: 0x55585c, roughness: 0.4, metalness: 0.6 }),
    hook: std({ color: 0xc8161c, roughness: 0.35, metalness: 0.2 }),
    liner: std({ color: 0x0e0e0e, roughness: 0.95, side: THREE.DoubleSide }),
    shockGold: std({ color: 0xd9a51a, roughness: 0.35, metalness: 0.4 }),
    shockBlack: std({ color: 0x1a1a1a, roughness: 0.45, metalness: 0.3 }),
    springRed: std({ color: 0xa8161a, roughness: 0.4, metalness: 0.3 }),
    springBlack: std({ color: 0x222222, roughness: 0.5, metalness: 0.3 }),
    // glass & lamps
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0b1217, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.62, envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.18, envMapIntensity: 2, depthWrite: false }),
    reflector: std({ color: 0xe8e8e8, metalness: 1, roughness: 0.12 }),
    lampHouse: std({ color: 0x0d0e10, metalness: 0.5, roughness: 0.25 }),
    led: std({ color: 0xffffff, emissive: 0xf2f6ff, emissiveIntensity: 2.2, roughness: 0.2 }),
    bulb: std({ color: 0xffffff, emissive: 0xfff3dc, emissiveIntensity: 0.9, roughness: 0.2 }),
    amber: std({ color: 0xff8a1a, emissive: 0x7a3300, emissiveIntensity: 0.5, roughness: 0.15 }),
    redLens: std({ color: 0x8c0d10, emissive: 0x3a0002, emissiveIntensity: 0.6, roughness: 0.12, metalness: 0.1 }),
    reflectorRed: std({ color: 0x9e1016, roughness: 0.25 }),
    mirror: std({ color: 0xd9dde2, metalness: 1, roughness: 0.03 }),
    grille: std({ color: 0xffffff, map: hexTex(), roughness: 0.5, metalness: 0.3 }),
    // interior
    fabric: std({ color: 0x2b2a29, roughness: 0.95 }),
    leather: std({ color: 0x3a2c22, roughness: 0.62 }),
    dash: std({ color: 0x1b1c1e, roughness: 0.7, side: THREE.DoubleSide }),
    headliner: std({ color: 0x7d786f, roughness: 0.95, side: THREE.DoubleSide }),
    screen: std({ color: 0x050a10, emissive: 0x1d3a5a, emissiveIntensity: 0.55, roughness: 0.1 }),
    gauge: std({ color: 0x0a0a0c, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.3 }),
    // tyres & wheels
    tyre: std({ color: 0xffffff, map: tyreSidewall(), roughness: 0.88 }),
    tread: std({ color: 0x161616, roughness: 0.95 }),
    rimGun: std({ color: 0x4a4e54, metalness: 0.85, roughness: 0.28 }),
    rimBlack: std({ color: 0x18191b, metalness: 0.6, roughness: 0.42 }),
    rimLip: std({ color: 0xc9ccd0, metalness: 1, roughness: 0.18 }),
    rimInner: std({ color: 0x2a2c2f, metalness: 0.6, roughness: 0.6, side: THREE.DoubleSide }),
  };
  return shared;
}

/** Car paint: metallic base under a glossy clear coat (darker colours less metallic). */
export function paint(color: number): THREE.MeshPhysicalMaterial {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const white = hsl.l > 0.8 && hsl.s < 0.2;
  const dark = hsl.l < 0.2;
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: white ? 0.3 : dark ? 0.26 : 0.34,
    metalness: white ? 0.1 : dark ? 0.2 : 0.45,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: dark ? 1.1 : 0.9,
    side: THREE.DoubleSide,
    ...(white ? { sheen: 0.4, sheenColor: new THREE.Color(0xfff3e8), sheenRoughness: 0.4 } : {}),
  });
}

/**
 * Dirt layer: red laterite dust and mud, thickest low down and on the wheels, broken up by
 * noise. `amount` (0..1) is a shared uniform per vehicle so mud can build up and wash off.
 * Works in model space (the vehicle's own frame), so it sticks to the body as it moves.
 */
export function withDirt<T extends THREE.MeshStandardMaterial>(m: T, uniforms: { uDirt: { value: number } }, wheel = false): T {
  const c = m.clone() as T;
  c.onBeforeCompile = (sh) => {
    sh.uniforms.uDirt = uniforms.uDirt;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMp = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vMp;
        uniform float uDirt;
        float dh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        float dn(vec3 p) {
          vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(dh(i), dh(i + vec3(1,0,0)), f.x), mix(dh(i + vec3(0,1,0)), dh(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(dh(i + vec3(0,0,1)), dh(i + vec3(1,0,1)), f.x), mix(dh(i + vec3(0,1,1)), dh(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float dirtMask() {
          float n = dn(vMp * 9.0) * 0.55 + dn(vMp * 27.0) * 0.3 + dn(vMp * 2.5) * 0.4;
          ${wheel ? 'float h = 0.85;' : 'float h = smoothstep(0.55, -0.15, vMp.y) + 0.25 * smoothstep(0.9, 0.0, vMp.y);'}
          float raw = (h * 1.3 * uDirt + uDirt * 0.2) * (0.3 + n);
          return smoothstep(0.32, 0.55, raw) * (0.75 + 0.25 * dn(vMp * 60.0));
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float dm = dirtMask();
        vec3 mud = mix(vec3(0.075, 0.032, 0.016), vec3(0.2, 0.095, 0.05), smoothstep(0.3, 0.8, dn(vMp * 14.0 + 3.0)));
        diffuseColor.rgb = mix(diffuseColor.rgb, mud, dm);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.95, dm);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, dm);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= 1.0 - dm;\n#endif');
  };
  c.customProgramCacheKey = () => `dirt${wheel ? 'w' : 'b'}`;
  return c;
}

export function plateMaterial(text: string): THREE.MeshStandardMaterial {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 112;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f8f8f3';
  g.fillRect(0, 0, 512, 112);
  g.strokeStyle = '#151515';
  g.lineWidth = 6;
  g.strokeRect(5, 5, 502, 102);
  // IND strip
  g.fillStyle = '#1d3f9a';
  g.fillRect(12, 12, 46, 88);
  g.fillStyle = '#fff';
  g.font = '700 20px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('IND', 35, 82);
  g.beginPath();
  g.arc(35, 38, 12, 0, Math.PI * 2);
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#111';
  g.font = '700 64px "Arial Narrow", system-ui, sans-serif';
  g.fillText(text, 284, 60);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.45, metalness: 0.1 });
}
