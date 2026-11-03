import * as THREE from 'three';

/** Shared clock for all wind-animated materials (advanced by World.update). */
export const windTime = { value: 0 };

export type WindKind = 'frond' | 'leaf' | 'grass' | 'banana';

/**
 * Adds wind sway to an (instanced) vegetation material: a slow gusting envelope times a
 * per-plant phase, scaled by how far each vertex is from where the plant is anchored —
 * palm frond tips flap, grass tips bend, leaf cards flutter.
 */
export function addWind(mat: THREE.Material, kind: WindKind, strength = 1) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.uniforms.uWindTime = windTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          vec4 anchor = vec4(0.0, 0.0, 0.0, 1.0);
          #ifdef USE_INSTANCING
            anchor = instanceMatrix * anchor;
          #endif
          anchor = modelMatrix * anchor;
          float ph = anchor.x * 0.13 + anchor.z * 0.11;
          float t = uWindTime;
          float gust = 0.55 + 0.45 * sin(t * 0.33 + ph * 0.21) * sin(t * 0.21 + ph * 0.07);
          float a;
          ${kind === 'frond' ? 'a = length(transformed.xz) * 0.045; transformed.y += sin(t * 2.3 + ph + length(transformed.xz)) * a * 0.7 * gust;' : ''}
          ${kind === 'grass' ? 'a = max(0.0, transformed.y) * 0.22;' : ''}
          ${kind === 'leaf' ? 'a = 0.05 + max(0.0, transformed.y - 4.0) * 0.006; transformed += normal * sin(t * 4.1 + ph * 3.0 + transformed.y) * 0.03;' : ''}
          ${kind === 'banana' ? 'a = max(0.0, transformed.y - 1.6) * 0.12;' : ''}
          a *= ${strength.toFixed(3)} * gust;
          transformed.x += sin(t * 1.7 + ph) * a;
          transformed.z += cos(t * 1.35 + ph * 1.3) * a * 0.7;
        }`,
      );
  };
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|wind-${kind}`;
}
