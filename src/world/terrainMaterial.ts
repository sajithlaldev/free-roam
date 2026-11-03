import * as THREE from 'three';
import { pbr } from './pbr';

/**
 * PBR terrain: five tileable surfaces (grass, laterite soil, sand, rock, mud) blended per
 * pixel by vertex weights *and* each surface's own height map, so sand settles between grass
 * tufts and rock pushes through soil instead of cross-fading. Each surface is sampled twice
 * (different scale + rotation) and the two are mixed by a large-scale noise to hide tiling.
 * Normal maps are applied in world space; roughness comes from each surface.
 */
export function terrainMaterial(): THREE.MeshStandardMaterial {
  const P = pbr();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const layers = [P.grass, P.soil, P.sand, P.rock, P.mud];
  const scales = [2.4, 3.2, 2.6, 5.5, 3.0]; // metres per repeat
  mat.onBeforeCompile = (sh) => {
    layers.forEach((l, k) => {
      sh.uniforms[`tA${k}`] = { value: l.albedo };
      sh.uniforms[`tN${k}`] = { value: l.normal };
    });
    sh.uniforms.uScale = { value: scales.map((s) => 1 / s) };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 splat; attribute float mud;
        varying vec4 vSplat; varying float vMud; varying vec3 vWPos; varying vec3 vWNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSplat = splat; vMud = mud;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    const samplers = layers.map((_, k) => `uniform sampler2D tA${k}; uniform sampler2D tN${k};`).join('\n');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        ${samplers}
        uniform float uScale[5];
        varying vec4 vSplat; varying float vMud; varying vec3 vWPos; varying vec3 vWNormal;
        float tHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.7); }
        float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y); }
        const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);
        // Two decorrelated samples blended by large-scale noise: no visible repeat.
        #define SAMPLE2(tex, uv, k) mix(texture2D(tex, uv), texture2D(tex, ROT * uv * 0.73 + vec2(0.37, 0.71)), k)`,
      )
      .replace(
        '#include <map_fragment>',
        `
        vec2 wp = vWPos.xz;
        float kTile = smoothstep(0.3, 0.7, tNoise(wp * 0.035));
        vec4 a0 = SAMPLE2(tA0, wp * uScale[0], kTile), a1 = SAMPLE2(tA1, wp * uScale[1], kTile), a2 = SAMPLE2(tA2, wp * uScale[2], kTile);
        vec4 a3 = SAMPLE2(tA3, wp * uScale[3], kTile), a4 = SAMPLE2(tA4, wp * uScale[4], kTile);
        vec4 n0 = SAMPLE2(tN0, wp * uScale[0], kTile), n1 = SAMPLE2(tN1, wp * uScale[1], kTile), n2 = SAMPLE2(tN2, wp * uScale[2], kTile);
        vec4 n3 = SAMPLE2(tN3, wp * uScale[3], kTile), n4 = SAMPLE2(tN4, wp * uScale[4], kTile);
        // Height-based blending.
        float w0 = vSplat.x, w1 = vSplat.y, w2 = vSplat.z, w3 = vSplat.w, w4 = vMud;
        float h0 = a0.a + w0, h1 = a1.a + w1, h2 = a2.a + w2, h3 = a3.a + w3, h4 = a4.a + w4;
        float top = max(max(max(h0, h1), max(h2, h3)), h4) - 0.22;
        float b0 = max(h0 - top, 0.0) * step(0.001, w0), b1 = max(h1 - top, 0.0) * step(0.001, w1);
        float b2 = max(h2 - top, 0.0) * step(0.001, w2), b3 = max(h3 - top, 0.0) * step(0.001, w3);
        float b4 = max(h4 - top, 0.0) * step(0.001, w4);
        float bs = b0 + b1 + b2 + b3 + b4 + 1e-5;
        vec3 tAlb = (a0.rgb * b0 + a1.rgb * b1 + a2.rgb * b2 + a3.rgb * b3 + a4.rgb * b4) / bs;
        vec4 tNrm = (n0 * b0 + n1 * b1 + n2 * b2 + n3 * b3 + n4 * b4) / bs;
        // Large-scale brightness variation so distant fields aren't uniform.
        tAlb *= mix(0.86, 1.1, tNoise(wp * 0.012 + 3.1));
        diffuseColor.rgb *= tAlb;
        float tRough = tNrm.a;`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * tRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec3 tn = tNrm.xyz * 2.0 - 1.0;
          vec3 Nw = normalize(vWNormal);
          vec3 Tw = normalize(vec3(1.0, 0.0, 0.0) - Nw * Nw.x);
          vec3 Bw = normalize(cross(Tw, Nw));
          vec3 nw = normalize(Tw * tn.x + Bw * tn.y + Nw * max(tn.z, 0.2));
          normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'pbr-terrain';
  return mat;
}
