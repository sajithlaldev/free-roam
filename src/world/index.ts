import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Batcher } from './batch';
import { buildArchitecture } from './buildings';
import { WATER_Y, WORLD_HALF, coastX } from './layout';
import { registry } from './registry';
import { buildTerrainCollider, buildTerrainMesh, getTerrain, type Terrain } from './terrain';
import { textures } from './textures';
import { GrassField } from './grass';
import { Post, type Quality } from './post';
import { buildVegetation, grassMask, lodMeshes } from './vegetation';
import { windTime } from './wind';

export const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 31), THREE.MathUtils.degToRad(222));

export class World {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1800);
  readonly physics: RAPIER.World;
  readonly terrain: Terrain;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private waterTime = { value: 0 };
  private leds!: THREE.InstancedMesh;
  private micLights = new Map<number, THREE.Mesh>();
  private onAir = new Set<number>();
  private t = 0;
  private indoor = false;
  private lodTimer = 0;
  stats: Record<string, number> = {};
  private post!: Post;
  private grass!: GrassField;
  private clouds!: THREE.Mesh;
  /** Called when G changes the graphics quality. */
  onQuality?: (q: Quality) => void;

  static async create(canvas: HTMLCanvasElement): Promise<World> {
    await RAPIER.init();
    return new World(canvas);
  }

  private constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.5;

    // Gravity is applied by the character controller; cars use their own (see car.ts).
    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = 1 / 60;

    const t0 = performance.now();
    this.terrain = getTerrain();
    this.stats.terrainMs = Math.round(performance.now() - t0);

    this.buildSkyAndLight();
    const tex = textures();
    tex.detail.repeat.set(1, 1);
    const ground = buildTerrainMesh(this.terrain, tex.detail);
    const gm = ground.material as THREE.MeshStandardMaterial;
    gm.bumpMap = tex.detail;
    gm.bumpScale = 1.6;
    gm.onBeforeCompile = (sh) => {
      // Macro variation (a second, much larger sample) breaks up visible tiling.
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <map_fragment>',
        '#include <map_fragment>\n\tdiffuseColor.rgb *= mix(0.8, 1.14, texture2D(map, vMapUv * 0.071 + vec2(0.37, 0.11)).r);',
      );
    };
    this.scene.add(ground);
    buildTerrainCollider(this.physics, ground);
    this.buildDistantLand();
    this.buildWater();
    this.buildBounds();

    const b = new Batcher(this.scene, this.physics);
    buildArchitecture(this.scene, b, this.terrain);
    b.finish();
    Object.assign(this.stats, buildVegetation(this.scene, this.physics, this.terrain));
    this.buildOnAirIndicators();
    this.buildClouds();
    this.grass = new GrassField(this.terrain, grassMask(this.terrain));
    this.scene.add(this.grass.mesh);
    this.stats.buildMs = Math.round(performance.now() - t0);

    this.post = new Post(this.renderer, this.scene, this.camera, (q) => this.applyQuality(q));
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private buildSkyAndLight() {
    const sky = new Sky();
    sky.scale.setScalar(1500);
    const u = sky.material.uniforms;
    u.turbidity.value = 2.2;
    u.rayleigh.value = 2.4;
    u.mieCoefficient.value = 0.0011;
    u.mieDirectionalG.value = 0.72;
    u.sunPosition.value.copy(SUN_DIR);
    this.scene.add(sky);

    // Image-based lighting from the sky: realistic ambient + reflections everywhere.
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky2 = new Sky();
    sky2.scale.setScalar(1000);
    Object.assign(sky2.material.uniforms.sunPosition.value, SUN_DIR);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG'] as const) sky2.material.uniforms[k].value = u[k].value;
    envScene.add(sky2);
    this.scene.environment = pm.fromScene(envScene, 0, 0.1, 2000).texture;
    this.scene.environmentIntensity = 0.55;

    this.scene.fog = new THREE.Fog(0xa9c7de, 160, 700);

    this.hemi = new THREE.HemisphereLight(0xdcefff, 0x5a6a3a, 0.55);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffe6c4, 3.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = c.bottom = -60;
    c.right = c.top = 60;
    c.near = 1;
    c.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
  }

  /** Low-res land/sea beyond the playable square so the horizon isn't a cliff edge. */
  private buildDistantLand() {
    const S = 1500;
    const n = 60;
    const g = new THREE.PlaneGeometry(S, S, n, n).rotateX(-Math.PI / 2);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(p.count * 3);
    const land = new THREE.Color(0x4f7d33);
    const hills = new THREE.Color(0x3f6a2c);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const inside = Math.abs(x) < WORLD_HALF - 6 && Math.abs(z) < WORLD_HALF - 6;
      const coast = x - coastX(z);
      let h = coast < 0 ? -12 : 1.5 + Math.min(1, coast / 40) * 2;
      // Western Ghats rising in the east, smoothly.
      const ghats = THREE.MathUtils.smoothstep(x, 120, 420) * THREE.MathUtils.smoothstep(-z, -260, 40);
      h += ghats * (45 + 40 * Math.max(0, Math.sin(x / 70) * Math.cos(z / 90)));
      if (!inside && Math.abs(x) < WORLD_HALF + 10 && Math.abs(z) < WORLD_HALF + 10) h = Math.min(h, this.terrain.heightAt(THREE.MathUtils.clamp(x, -WORLD_HALF, WORLD_HALF), THREE.MathUtils.clamp(z, -WORLD_HALF, WORLD_HALF)) - 0.4);
      if (inside) h = -20;
      p.setY(i, h);
      const c = land.clone().lerp(hills, THREE.MathUtils.smoothstep(x, 120, 300));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    m.receiveShadow = true;
    this.scene.add(m);
  }

  private buildWater() {
    const tex = textures();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2a6a6a,
      roughness: 0.06,
      metalness: 0.0,
      transparent: true,
      opacity: 0.9,
      normalMap: tex.waterNormal,
      envMapIntensity: 1.2,
    });
    const time = this.waterTime;
    // Terrain height as a texture, so the water knows its own depth (colour, clarity, foam).
    const V = this.terrain.N + 1;
    const hdata = new Uint16Array(V * V);
    for (let i = 0; i < V * V; i++) hdata[i] = THREE.DataUtils.toHalfFloat(this.terrain.heights[i]);
    const htex = new THREE.DataTexture(hdata, V, V, THREE.RedFormat, THREE.HalfFloatType);
    htex.magFilter = htex.minFilter = THREE.LinearFilter;
    htex.needsUpdate = true;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = time;
      sh.uniforms.uHeight = { value: htex };
      sh.uniforms.uHalf = { value: WORLD_HALF };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\nuniform sampler2D uHeight;\nuniform float uHalf;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float sea = smoothstep(-135.0, -175.0, vWPos.x);
          vec2 huv = (vWPos.xz + uHalf) / (2.0 * uHalf);
          float inside = step(0.0, huv.x) * step(huv.x, 1.0) * step(0.0, huv.y) * step(huv.y, 1.0);
          float ground = mix(-30.0, texture2D(uHeight, huv).r, inside);
          float depth = max(0.0, ${WATER_Y.toFixed(2)} - ground);
          vec3 deep = mix(vec3(0.05, 0.16, 0.10), vec3(0.015, 0.11, 0.24), sea);
          vec3 shallow = mix(vec3(0.16, 0.36, 0.26), vec3(0.10, 0.48, 0.50), sea);
          diffuseColor.rgb = mix(shallow, deep, smoothstep(0.0, 2.5, depth));
          // Foam where it laps the shore (and around the edges of anything standing in it).
          float n1 = texture2D(normalMap, vWPos.xz * 0.21 + vec2(uTime * 0.03, -uTime * 0.02)).r;
          float lap = 0.18 + 0.12 * sin(uTime * (0.9 + sea * 0.6) + vWPos.x * 0.05 + vWPos.z * 0.03);
          float foam = (1.0 - smoothstep(0.0, lap + 0.25 * sea, depth)) * smoothstep(0.42, 0.62, n1 + 0.25 * (1.0 - depth));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.9, 0.9), clamp(foam, 0.0, 1.0) * 0.85);
          diffuseColor.a = mix(0.55, 0.94, smoothstep(0.0, 1.6, depth)) + foam * 0.4;`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `{
            float sea = smoothstep(-135.0, -175.0, vWPos.x);
            vec2 uvA = vWPos.xz * 0.05 + vec2(uTime * 0.011, uTime * 0.007);
            vec2 uvB = vWPos.xz * 0.13 + vec2(-uTime * 0.017, uTime * 0.013);
            vec3 nA = texture2D(normalMap, uvA).xyz * 2.0 - 1.0;
            vec3 nB = texture2D(normalMap, uvB).xyz * 2.0 - 1.0;
            float k = mix(0.28, 0.6, sea); // the sea is choppier than the backwaters
            vec3 wn = normalize(vec3(-(nA.x + nB.x) * k, 1.0, -(nA.y + nB.y) * k));
            normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          }`,
        );
    };
    const water = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), mat);
    water.position.y = WATER_Y;
    water.receiveShadow = true;
    water.renderOrder = 1;
    this.scene.add(water);
  }

  private buildBounds() {
    const h = WORLD_HALF - 1;
    for (const [x, z, hx, hz] of [[0, -h, h, 0.5], [0, h, h, 0.5], [-h, 0, 0.5, h], [h, 0, 0.5, h]]) {
      this.physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, 60, hz).setTranslation(x, 20, z));
    }
  }

  /** Small LEDs on every speaker and a lamp at each mic that light up while that PA is live. */
  private buildOnAirIndicators() {
    const sp = registry.speakers;
    this.leds = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, sp.length));
    const o = new THREE.Object3D();
    sp.forEach((s, i) => {
      o.position.set(s.x, s.y + 0.5, s.z);
      o.updateMatrix();
      this.leds.setMatrixAt(i, o.matrix);
      this.leds.setColorAt(i, new THREE.Color(0x333333));
    });
    this.scene.add(this.leds);
    for (const pa of registry.pas) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshBasicMaterial({ color: 0x550000 }));
      m.position.set(pa.mic[0], pa.mic[1] + 1.55, pa.mic[2]);
      this.scene.add(m);
      this.micLights.set(pa.id, m);
    }
  }

  setOnAir(pa: number, on: boolean) {
    if (on === this.onAir.has(pa)) return;
    if (on) this.onAir.add(pa);
    else this.onAir.delete(pa);
    const live = new THREE.Color(0xff2a2a);
    const off = new THREE.Color(0x333333);
    registry.speakers.forEach((s, i) => s.pa === pa && this.leds.setColorAt(i, on ? live : off));
    this.leds.instanceColor!.needsUpdate = true;
    (this.micLights.get(pa)?.material as THREE.MeshBasicMaterial | undefined)?.color.set(on ? 0xff2020 : 0x550000);
  }

  /** A drifting procedural cloud layer under the sky dome. */
  private buildClouds() {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
      uniforms: { uTime: this.waterTime, uSun: { value: SUN_DIR } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uSun; varying vec3 vDir;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * n(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
        void main() {
          if (vDir.y < 0.0) discard;
          vec2 p = vDir.xz / (vDir.y + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
          float d = fbm(p);
          float cover = smoothstep(0.48, 0.78, d);
          float shade = fbm(p * 1.7 + 4.0);
          float sun = pow(max(0.0, dot(normalize(vDir), uSun)), 6.0);
          vec3 col = mix(vec3(0.72, 0.76, 0.82), vec3(1.0, 0.97, 0.93), smoothstep(0.35, 0.75, shade)) + sun * vec3(0.4, 0.3, 0.15);
          float a = cover * smoothstep(0.0, 0.18, vDir.y) * 0.9;
          gl_FragColor = vec4(col * 1.6, a);
        }`,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    this.clouds.renderOrder = -1;
    this.scene.add(this.clouds);
  }

  get quality(): Quality {
    return this.post.quality;
  }

  /** G: High → Medium → Low. */
  cycleQuality() {
    this.post.cycle();
  }

  private applyQuality(q: Quality) {
    const size = q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024;
    const span = q === 'high' ? 75 : q === 'medium' ? 60 : 45;
    const sh = this.sun.shadow;
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      sh.map = null as unknown as THREE.WebGLRenderTarget;
    }
    const c = sh.camera;
    c.left = c.bottom = -span;
    c.right = c.top = span;
    c.updateProjectionMatrix();
    this.shadowSpan = span;
    this.grass?.setDensity(q === 'high' ? 14000 : q === 'medium' ? 7000 : 0, q === 'high' ? 30 : 22);
    this.onQuality?.(q);
  }
  private shadowSpan = 75;

  /** Dimmer, warmer light indoors (the sun can't reach in). */
  setIndoor(indoor: boolean) {
    if (indoor === this.indoor) return;
    this.indoor = indoor;
    this.hemi.intensity = indoor ? 0.85 : 0.55;
    this.scene.environmentIntensity = indoor ? 0.62 : 0.55;
  }

  update(dt: number, focus: THREE.Vector3) {
    this.t += dt;
    this.waterTime.value = this.t;
    windTime.value = this.t;
    this.grass.update(focus);
    this.clouds.position.copy(this.camera.position);
    for (const a of registry.animators) a(this.t, dt);
    if ((this.lodTimer -= dt) <= 0) {
      this.lodTimer = 0.25;
      const c = this.camera.position;
      for (const l of lodMeshes) l.mesh.visible = Math.hypot(l.x - c.x, l.z - c.z) < l.maxDist;
    }
    // Keep the shadow map centred on the player, snapped to texels to avoid shimmer.
    const texel = (this.shadowSpan * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx, focus.y, fz).addScaledVector(SUN_DIR, 200);
  }

  private resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    if (this.post) this.post.resize();
    else this.renderer.setSize(innerWidth, innerHeight, false);
  }

  render() {
    this.post.render();
  }

  /** A top-down map image for the HUD minimap. */
  minimap(size = 256): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const img = g.createImageData(size, size);
    const t = this.terrain;
    const V = t.N + 1;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const ix = Math.floor((x / size) * V);
        const iz = Math.floor((y / size) * V);
        const i = iz * V + ix;
        const wx = -WORLD_HALF + (x / size) * WORLD_HALF * 2;
        const wz = -WORLD_HALF + (y / size) * WORLD_HALF * 2;
        const water = t.heights[i] < WATER_Y - 0.1;
        const road = t.roadDist(wx, wz) < 4;
        const k = (y * size + x) * 4;
        const col = road ? [70, 70, 70] : water ? (wx < -140 ? [40, 90, 150] : [50, 110, 100]) : [t.colors[i * 3] * 255, t.colors[i * 3 + 1] * 255, t.colors[i * 3 + 2] * 255];
        img.data.set([col[0], col[1], col[2], 255], k);
      }
    g.putImageData(img, 0, 0);
    return c;
  }
}
