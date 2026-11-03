import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadOptionalGLB } from './assets';
import { MIC_POS, OBSTACLES, SPEAKERS, WORLD_HALF_SIZE } from './config';

export class World {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 300);
  readonly physics: RAPIER.World;
  readonly micPos = new THREE.Vector3(...MIC_POS);

  private placeholder = new THREE.Group();
  private placeholderColliders: RAPIER.Collider[] = [];
  private onAirLight!: THREE.MeshStandardMaterial;
  private speakerMats: THREE.MeshStandardMaterial[] = [];
  private onAir = false;

  static async create(canvas: HTMLCanvasElement): Promise<World> {
    await RAPIER.init();
    const w = new World(canvas);
    await w.tryLoadWorldModel();
    return w;
  }

  private constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // Gravity is applied manually by the character controller; nothing else is dynamic.
    this.physics = new RAPIER.World({ x: 0, y: 0, z: 0 });

    this.scene.background = new THREE.Color(0x9ec9ea);
    this.scene.fog = new THREE.Fog(0x9ec9ea, 60, 140);
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(35, 60, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = c.bottom = -WORLD_HALF_SIZE - 5;
    c.right = c.top = WORLD_HALF_SIZE + 5;
    c.near = 10;
    c.far = 150;
    this.scene.add(sun);

    this.buildPlaceholder();
    this.buildProps();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private addStaticBox(x: number, y: number, z: number, hx: number, hy: number, hz: number): RAPIER.Collider {
    const col = this.physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z));
    return col;
  }

  private buildPlaceholder() {
    const half = WORLD_HALF_SIZE;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, half * 2),
      new THREE.MeshStandardMaterial({ color: 0x6f8f5a }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    const plaza = new THREE.Mesh(
      new THREE.CircleGeometry(20, 48),
      new THREE.MeshStandardMaterial({ color: 0xbdb7a6 }),
    );
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.01;
    plaza.receiveShadow = true;
    const grid = new THREE.GridHelper(half * 2, half, 0x000000, 0x000000);
    (grid.material as THREE.Material).opacity = 0.08;
    (grid.material as THREE.Material).transparent = true;
    grid.position.y = 0.02;
    this.placeholder.add(ground, plaza, grid);
    this.placeholderColliders.push(this.addStaticBox(0, -0.5, 0, half, 0.5, half));

    // Boundary walls.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x3b4a57 });
    for (const [x, z, w, d] of [
      [0, -half - 0.5, half * 2 + 2, 1],
      [0, half + 0.5, half * 2 + 2, 1],
      [-half - 0.5, 0, 1, half * 2],
      [half + 0.5, 0, 1, half * 2],
    ] as const) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), wallMat);
      m.position.set(x, 1.5, z);
      m.castShadow = m.receiveShadow = true;
      this.placeholder.add(m);
      this.placeholderColliders.push(this.addStaticBox(x, 1.5, z, w / 2, 1.5, d / 2));
    }

    for (const [x, z, w, h, d, color] of OBSTACLES) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
      m.position.set(x, h / 2, z);
      m.castShadow = m.receiveShadow = true;
      this.placeholder.add(m);
      this.placeholderColliders.push(this.addStaticBox(x, h / 2, z, w / 2, h / 2, d / 2));
    }
    this.scene.add(this.placeholder);
  }

  /** PA mic stand + speaker props. These stay even when a custom world.glb replaces the rest. */
  private buildProps() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.6, roughness: 0.4 });

    // Mic stand with a pad on the floor showing the "use" radius.
    const mic = new THREE.Group();
    mic.position.copy(this.micPos);
    const pad = new THREE.Mesh(
      new THREE.RingGeometry(1.9, 2.5, 48),
      new THREE.MeshStandardMaterial({ color: 0xffd34d, emissive: 0x332600 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.03;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.08, 16), metal);
    base.position.y = 0.04;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 8), metal);
    stem.position.y = 0.75;
    this.onAirLight = new THREE.MeshStandardMaterial({ color: 0x552222, emissive: 0xff2222, emissiveIntensity: 0 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), this.onAirLight);
    head.position.y = 1.5;
    stem.castShadow = head.castShadow = true;
    mic.add(pad, base, stem, head);
    this.scene.add(mic);

    // Speakers on poles, scattered around the world (layout from config.ts).
    for (const { x, y, z, yaw } of SPEAKERS) {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, y, 8), metal);
      pole.position.y = y / 2;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.6, 0.8), metal);
      cab.position.y = y + 0.4;
      const coneMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: 0x2255ff, emissiveIntensity: 0 });
      this.speakerMats.push(coneMat);
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.2, 0.15, 20), coneMat);
      cone.rotation.x = Math.PI / 2;
      cone.position.set(0, y + 0.4, 0.45);
      cab.castShadow = pole.castShadow = true;
      g.add(pole, cab, cone);
      g.rotation.y = yaw;
      this.scene.add(g);
      // Solid, so players bump into speakers instead of walking through them.
      const top = y + 1.2;
      this.physics.createCollider(RAPIER.ColliderDesc.cylinder(top / 2, 0.6).setTranslation(x, top / 2, z));
    }
  }

  /** public/models/world.glb replaces the placeholder ground/obstacles (keep it low-poly!). */
  private async tryLoadWorldModel() {
    const gltf = await loadOptionalGLB('/models/world.glb');
    if (!gltf) return;

    this.scene.remove(this.placeholder);
    this.placeholderColliders.forEach((c) => this.physics.removeCollider(c, false));
    this.placeholderColliders = [];

    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = mesh.receiveShadow = true;
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position');
      const verts = new Float32Array(pos.count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        verts.set([v.x, v.y, v.z], i * 3);
      }
      const index = geo.getIndex();
      const idx = index ? Uint32Array.from(index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
      this.physics.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx));
    });
    this.scene.add(gltf.scene);
  }

  /** Lights up the mic and speakers while someone is on the PA. */
  setOnAir(on: boolean) {
    if (on === this.onAir) return;
    this.onAir = on;
    this.onAirLight.emissiveIntensity = on ? 2 : 0;
    this.speakerMats.forEach((m) => (m.emissiveIntensity = on ? 1.5 : 0));
  }

  private resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
