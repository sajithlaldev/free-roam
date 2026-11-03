import * as THREE from 'three';
import { mulberry32 } from './noise';
import type { Terrain } from './terrain';
import { addWind } from './wind';

/**
 * Dense grass carpet around the camera: thousands of instanced, wind-swept blade clumps on a
 * world-aligned grid (hashed jitter, so blades stay put as the field re-centres), shrinking
 * smoothly to nothing at the edge so there's no popping.
 */
export class GrassField {
  readonly mesh: THREE.InstancedMesh;
  private center = new THREE.Vector2(1e9, 1e9);
  private uCenter = { value: new THREE.Vector2() };
  private uRadius = { value: 30 };
  private max: number;
  private spacing = 0.5;

  constructor(
    private terrain: Terrain,
    private isGrass: (x: number, z: number) => boolean,
    max = 14000,
  ) {
    this.max = max;
    const geo = clumpGeometry();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.92 });
    addWind(mat, 'grass', 1.2);
    const uC = this.uCenter;
    const uR = this.uRadius;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev.call(mat, sh, r);
      sh.uniforms.uGrassCenter = uC;
      sh.uniforms.uGrassRadius = uR;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec2 uGrassCenter;\nuniform float uGrassRadius;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            vec4 o = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float fade = 1.0 - smoothstep(uGrassRadius * 0.62, uGrassRadius, distance(o.xz, uGrassCenter));
            transformed *= fade;
          }`,
        );
    };
    mat.customProgramCacheKey = () => 'grass-field';
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  setDensity(max: number, radius: number) {
    this.max = Math.min(max, this.mesh.instanceMatrix.count);
    this.uRadius.value = radius;
    this.center.set(1e9, 1e9); // force a rebuild
  }

  update(focus: THREE.Vector3) {
    this.uCenter.value.set(focus.x, focus.z);
    if (this.center.distanceTo(new THREE.Vector2(focus.x, focus.z)) < 3) return;
    this.center.set(focus.x, focus.z);
    const R = this.uRadius.value;
    const s = this.spacing;
    const o = new THREE.Object3D();
    let n = 0;
    const i0 = Math.floor((focus.x - R) / s);
    const i1 = Math.ceil((focus.x + R) / s);
    const j0 = Math.floor((focus.z - R) / s);
    const j1 = Math.ceil((focus.z + R) / s);
    for (let j = j0; j <= j1 && n < this.max; j++) {
      for (let i = i0; i <= i1 && n < this.max; i++) {
        const rnd = mulberry32((i * 73856093) ^ (j * 19349663));
        const x = (i + rnd()) * s;
        const z = (j + rnd()) * s;
        if ((x - focus.x) ** 2 + (z - focus.z) ** 2 > R * R) continue;
        if (!this.isGrass(x, z)) continue;
        o.position.set(x, this.terrain.heightAt(x, z) - 0.02, z);
        o.rotation.set(0, rnd() * Math.PI * 2, 0);
        const sc = 0.75 + rnd() * 0.5;
        o.scale.set(sc, sc * (0.75 + rnd() * 0.6), sc);
        o.updateMatrix();
        this.mesh.setMatrixAt(n++, o.matrix);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Seven curved blades in a ~0.4 m clump; vertex colours dark at the root, sunlit at the tip. */
function clumpGeometry(): THREE.BufferGeometry {
  const rnd = mulberry32(5);
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const base = new THREE.Color(0x2b4f18);
  const tip = new THREE.Color(0x7fae3e);
  const tip2 = new THREE.Color(0xa3b555);
  for (let b = 0; b < 11; b++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * 0.18;
    const bx = Math.cos(a) * r;
    const bz = Math.sin(a) * r;
    const h = 0.16 + rnd() * 0.2;
    const w = 0.012 + rnd() * 0.009;
    const lean = new THREE.Vector2(Math.cos(a + 1), Math.sin(a + 1)).multiplyScalar(0.05 + rnd() * 0.07);
    const face = rnd() * Math.PI;
    const fx = Math.cos(face) * w;
    const fz = Math.sin(face) * w;
    const t = tip.clone().lerp(tip2, rnd() * 0.6);
    const start = pos.length / 3;
    const segs = 3;
    for (let k = 0; k <= segs; k++) {
      const v = k / segs;
      const width = 1 - v * 0.9;
      const x = bx + lean.x * v * v;
      const z = bz + lean.y * v * v;
      const y = h * v;
      pos.push(x - fx * width, y, z - fz * width, x + fx * width, y, z + fz * width);
      const c = base.clone().lerp(t, Math.pow(v, 0.8));
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (k < segs) {
        const q = start + k * 2;
        idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Grass lit from above reads better than true blade normals.
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}
