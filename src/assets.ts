import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AVATAR } from './config';
import { findHumanoidBone } from './procedural';

let loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (!loader) {
    const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

// The Vite dev server answers unknown paths with index.html (200), so a plain
// "ok" check isn't enough to know a model file really exists.
async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

/** Loads a .glb (Draco / meshopt supported) or resolves null if it isn't there. */
export async function loadOptionalGLB(url: string): Promise<GLTF | null> {
  if (!(await exists(url))) return null;
  try {
    return await getLoader().loadAsync(url);
  } catch (e) {
    console.warn(`Failed to load ${url}; using placeholder`, e);
    return null;
  }
}

export interface AvatarTemplate {
  /** Normalised: AVATAR.height tall, feet at the origin, facing +Z. */
  root: THREE.Object3D;
  idle?: THREE.AnimationClip;
  walk?: THREE.AnimationClip;
  run?: THREE.AnimationClip;
}

/** Scale to the configured height, stand it on y=0, centre it, and apply the facing fix. */
function normalise(scene: THREE.Object3D): THREE.Object3D {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene, true);
  const size = box.getSize(new THREE.Vector3());
  if (size.y > 0) scene.scale.multiplyScalar(AVATAR.height / size.y);
  scene.updateMatrixWorld(true);
  box.setFromObject(scene, true);
  const c = box.getCenter(new THREE.Vector3());
  scene.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));

  // A humanoid facing +Z has its left side at +X; if it's the other way round, turn it.
  const left = findHumanoidBone(scene, 'LeftUpLeg') ?? findHumanoidBone(scene, 'LeftArm');
  const right = findHumanoidBone(scene, 'RightUpLeg') ?? findHumanoidBone(scene, 'RightArm');
  const x = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).x;
  const flip = left && right && x(left) < x(right) ? Math.PI : 0;

  const root = new THREE.Group();
  root.rotation.y = flip + AVATAR.yawOffset;
  root.add(scene);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
  });
  return root;
}

let avatarTemplate: Promise<AvatarTemplate | null> | null = null;

export function getAvatarTemplate(): Promise<AvatarTemplate | null> {
  avatarTemplate ??= loadOptionalGLB(AVATAR.url).then((gltf) => {
    if (!gltf) return null;
    const find = (re: RegExp) => gltf.animations.find((a) => re.test(a.name));
    return {
      root: normalise(gltf.scene),
      idle: find(AVATAR.clips.idle),
      walk: find(AVATAR.clips.walk),
      run: find(AVATAR.clips.run),
    };
  });
  return avatarTemplate;
}

const lumCache = new WeakMap<THREE.Texture, number>();

/** Mean linear luminance of a texture (sampled small), so recolouring keeps its brightness. */
function meanLuminance(tex: THREE.Texture): number {
  let v = lumCache.get(tex);
  if (v !== undefined) return v;
  v = 0.25;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(tex.image as CanvasImageSource, 0, 0, 16, 16);
    const px = g.getImageData(0, 0, 16, 16).data;
    const lin = (x: number) => Math.pow(x / 255, 2.2);
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
    v = sum / (px.length / 4);
  } catch {
    /* keep default */
  }
  lumCache.set(tex, v);
  return v;
}

/**
 * Multiplying a colour over a dark/saturated texture barely changes it (a blue shirt
 * stays blue). Instead keep the texture's shading (its luminance) and apply the tint as
 * the colour, normalised so the average brightness lands in a pleasant mid-tone.
 */
function recolourTextured(mat: THREE.MeshStandardMaterial, tint: THREE.Color) {
  const gain = 0.45 / Math.max(0.02, meanLuminance(mat.map!));
  mat.color.set(0xffffff);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTint = { value: tint.clone() };
    shader.uniforms.uGain = { value: gain };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uTint;\nuniform float uGain;\nvoid main() {')
      .replace(
        '#include <map_fragment>',
        '#include <map_fragment>\n\t{ float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)); diffuseColor.rgb = uTint * clamp(l * uGain, 0.0, 1.5); }',
      );
  };
  mat.customProgramCacheKey = () => 'luminance-tint';
}

/** A per-player copy (own skeleton); the tint material is cloned and recoloured. */
export function cloneAvatar(t: AvatarTemplate, tint: THREE.Color): THREE.Object3D {
  const obj = cloneSkinned(t.root);
  if (AVATAR.tintMaterial) {
    const tinted = new Map<THREE.Material, THREE.Material>();
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const swap = (mat: THREE.Material) => {
        if (mat.name !== AVATAR.tintMaterial || !('color' in mat)) return mat;
        let c = tinted.get(mat);
        if (!c) {
          c = mat.clone();
          const std = c as THREE.MeshStandardMaterial;
          if (std.map) recolourTextured(std, tint);
          else std.color.copy(tint);
          tinted.set(mat, c);
        }
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
    });
  }
  return obj;
}
