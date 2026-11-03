import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

let loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (!loader) {
    const draco = new DRACOLoader().setDecoderPath('/draco/');
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
  scene: THREE.Object3D;
  idle?: THREE.AnimationClip;
  walk?: THREE.AnimationClip;
}

let avatarTemplate: Promise<AvatarTemplate | null> | null = null;

/** public/models/avatar.glb — expects clips with "idle" and "walk" in their names. */
export function getAvatarTemplate(): Promise<AvatarTemplate | null> {
  avatarTemplate ??= loadOptionalGLB('/models/avatar.glb').then((gltf) => {
    if (!gltf) return null;
    const find = (re: RegExp) => gltf.animations.find((a) => re.test(a.name));
    return { scene: gltf.scene, idle: find(/idle/i), walk: find(/walk/i) };
  });
  return avatarTemplate;
}

export function cloneAvatar(t: AvatarTemplate): THREE.Object3D {
  return cloneSkinned(t.scene);
}
