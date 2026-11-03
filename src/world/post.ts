import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { isTouch } from '../device';

export type Quality = 'high' | 'medium' | 'low';
export const QUALITIES: Quality[] = ['high', 'medium', 'low'];

/**
 * Cinematic grade, applied in linear HDR before tone mapping: a touch of warmth, vibrance
 * (saturates muted colours more than already-vivid ones), contrast around mid-grey, and a
 * soft vignette.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vibrance: { value: 0.28 },
    contrast: { value: 1.08 },
    warmth: { value: 0.05 },
    vignette: { value: 0.28 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vibrance, contrast, warmth, vignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      col *= vec3(1.0 + warmth, 1.0 + warmth * 0.35, 1.0 - warmth * 0.6);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float mx = max(col.r, max(col.g, col.b));
      float mn = min(col.r, min(col.g, col.b));
      float sat = (mx - mn) / max(mx, 1e-4);
      col = mix(vec3(l), col, 1.0 + vibrance * (1.0 - sat));
      // contrast in log-ish space around 0.18 (mid grey), so highlights stay HDR
      col = max(vec3(0.0), 0.18 * pow(max(col, vec3(1e-5)) / 0.18, vec3(contrast)));
      vec2 d = vUv - 0.5;
      col *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      gl_FragColor = vec4(col, c.a);
    }`,
};

/**
 * Renders the scene into its own target (colour + a real depth texture, so alpha-tested
 * leaves are correct), then hands the colour on to the rest of the chain. GTAO reads that
 * depth directly instead of re-rendering the scene with an override material.
 */
class ScenePass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  private quad: FullScreenQuad;
  private copy: THREE.ShaderMaterial;
  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    super();
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.target.depthTexture = new THREE.DepthTexture(1, 1);
    this.target.depthTexture.type = THREE.UnsignedIntType;
    this.copy = new THREE.ShaderMaterial({ ...CopyShader, uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms) });
    this.copy.uniforms.tDiffuse.value = this.target.texture;
    this.quad = new FullScreenQuad(this.copy);
  }
  setSize(w: number, h: number) {
    this.target.setSize(w, h);
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

/** Rendering pipeline with three quality presets (G cycles them). */
export class Post {
  private composer: EffectComposer;
  private gtao: GTAOPass;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private smaa: SMAAPass;
  quality: Quality = 'high';

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private onQuality: (q: Quality) => void,
  ) {
    const size = renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0 });
    this.composer = new EffectComposer(renderer, target);
    const scenePass = new ScenePass(scene, camera);
    this.composer.addPass(scenePass);
    this.gtao = new GTAOPass(scene, camera, size.x, size.y, { depthTexture: scenePass.target.depthTexture! });
    this.gtao.blendIntensity = 0.85;
    this.gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    this.composer.addPass(this.gtao);
    // Threshold is in linear HDR (before tone mapping): only the sun, sky glare and lamps glow.
    this.bloom = new UnrealBloomPass(size, 0.12, 0.3, 9.0);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
    let saved: Quality | null = null;
    try {
      saved = localStorage.getItem('vw-quality') as Quality | null;
    } catch {
      /* no storage */
    }
    // Phones start on Low (they can step up with the graphics setting).
    this.setQuality(saved && QUALITIES.includes(saved) ? saved : isTouch() ? 'low' : 'high');
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.gtao.enabled = q === 'high';
    this.bloom.enabled = q !== 'low';
    this.smaa.enabled = q !== 'low';
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'high' ? 1.5 : q === 'medium' ? 1.25 : 1));
    this.resize();
    try {
      localStorage.setItem('vw-quality', q);
    } catch {
      /* no storage */
    }
    this.onQuality(q);
  }

  cycle() {
    this.setQuality(QUALITIES[(QUALITIES.indexOf(this.quality) + 1) % QUALITIES.length]);
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // AO at half resolution: most of the look for a fraction of the cost.
    this.gtao.setSize(Math.floor((w * pr) / 2), Math.floor((h * pr) / 2));
  }

  render() {
    if (this.quality === 'low') this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }
}
