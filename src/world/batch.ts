import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Collects static geometry per material and merges it into one mesh per material at the
 * end (hundreds of buildings/props → a handful of draw calls). Also creates colliders.
 */
export class Batcher {
  private parts = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean }>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  constructor(
    readonly scene: THREE.Object3D,
    readonly physics: RAPIER.World,
  ) {}

  material(key: string, make: () => THREE.Material, castShadow = true) {
    if (!this.parts.has(key)) this.parts.set(key, { mat: make(), geos: [], cast: castShadow });
    return this;
  }

  /** Adds a geometry (consumed) transformed by `m`. */
  add(key: string, geo: THREE.BufferGeometry, m?: THREE.Matrix4) {
    const p = this.parts.get(key);
    if (!p) throw new Error(`unknown material ${key}`);
    if (m) geo.applyMatrix4(m);
    // Normalise attributes so everything merges.
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
    if (!geo.index) geo.setIndex(Array.from({ length: geo.getAttribute('position').count }, (_, i) => i));
    p.geos.push(geo);
  }

  /** Transform helper: position + yaw (+ optional pitch/roll). */
  tf(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, s = 1): THREE.Matrix4 {
    this.q.setFromEuler(this.e.set(rx, ry, rz, 'YXZ'));
    return this.m4.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(s, s, s)).clone();
  }

  /**
   * Box centred at (x,y,z), size (sx,sy,sz), rotated by ry about Y. UVs are in metres / uvScale
   * so textures keep a consistent size. `collide` adds a matching static cuboid collider.
   */
  box(key: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, o: { ry?: number; rx?: number; rz?: number; collide?: boolean; uv?: number } = {}) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    const s = o.uv ?? 1;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const dims: [number, number][] = [
      [sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy],
    ];
    for (let f = 0; f < 6; f++)
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        uv.setXY(i, (uv.getX(i) * dims[f][0]) / s, (uv.getY(i) * dims[f][1]) / s);
      }
    this.add(key, g, this.tf(x, y, z, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0));
    if (o.collide) this.cuboid(x, y, z, sx / 2, sy / 2, sz / 2, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0);
  }

  cyl(key: string, x: number, y: number, z: number, rTop: number, rBot: number, h: number, o: { seg?: number; collide?: boolean; open?: boolean; uv?: number; ry?: number } = {}) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, o.seg ?? 12, 1, o.open ?? false);
    if (o.uv) {
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * 2 * Math.PI * Math.max(rTop, rBot)) / o.uv, (uv.getY(i) * h) / o.uv);
    }
    this.add(key, g, this.tf(x, y, z, o.ry ?? 0));
    if (o.collide) this.physics.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, Math.max(rTop, rBot)).setTranslation(x, y, z));
  }

  cuboid(x: number, y: number, z: number, hx: number, hy: number, hz: number, ry = 0, rx = 0, rz = 0) {
    this.q.setFromEuler(this.e.set(rx, ry, rz, 'YXZ'));
    return this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRotation({ x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w }),
    );
  }

  finish(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, p] of this.parts) {
      if (!p.geos.length) continue;
      const merged = mergeGeometries(p.geos, false);
      if (!merged) {
        console.warn('merge failed for', key);
        continue;
      }
      p.geos.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, p.mat);
      mesh.name = `batch:${key}`;
      mesh.castShadow = p.cast;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      out.push(mesh);
    }
    this.parts.clear();
    return out;
  }
}
