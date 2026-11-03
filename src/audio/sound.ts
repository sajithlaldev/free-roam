import * as THREE from 'three';
import { ENGINE_WORKLET } from './engineWorklet';

/**
 * All the non-voice audio: vehicles (engine simulation, tyres, skids, horn, doors, bumps,
 * crashes, splashes), footsteps per surface, and a reverb for indoor spaces. Every sound is
 * synthesised — nothing is downloaded.
 */

export type Surface = 'grass' | 'soil' | 'sand' | 'gravel' | 'asphalt' | 'concrete' | 'wood' | 'tile' | 'mud' | 'water';

// ── tiny offline DSP helpers (for building one-shot buffers) ─────────────────

class Rng {
  constructor(private s: number) {}
  next() {
    this.s = (this.s * 1664525 + 1013904223) | 0;
    return (this.s >>> 0) / 4294967296;
  }
  n() {
    return this.next() * 2 - 1;
  }
}

class Bq {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  constructor(type: 'lp' | 'hp' | 'bp', f: number, q: number, sr: number) {
    const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const a = s / (2 * q);
    let b0: number;
    let b1: number;
    let b2: number;
    if (type === 'lp') [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
    else if (type === 'hp') [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    else [b0, b1, b2] = [a, 0, -a];
    const a0 = 1 + a;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - a) / a0;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function buffer(ctx: BaseAudioContext, seconds: number, fill: (d: Float32Array, sr: number) => void): AudioBuffer {
  const b = ctx.createBuffer(1, Math.max(1, Math.floor(seconds * ctx.sampleRate)), ctx.sampleRate);
  const d = b.getChannelData(0);
  fill(d, ctx.sampleRate);
  // normalise to a sensible peak
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (let i = 0; i < d.length; i++) d[i] *= 0.9 / peak;
  return b;
}

/** Footstep for one surface: the heel/sole impact plus the material's own texture. */
function footstep(ctx: BaseAudioContext, s: Surface, seed: number): AudioBuffer {
  const r = new Rng(seed * 7919 + s.length * 131);
  const dur = { grass: 0.26, soil: 0.2, sand: 0.3, gravel: 0.28, asphalt: 0.16, concrete: 0.18, wood: 0.3, tile: 0.22, mud: 0.36, water: 0.45 }[s];
  return buffer(ctx, dur, (d, sr) => {
    const thump = new Bq('lp', { wood: 260, tile: 900, concrete: 700, asphalt: 600, soil: 300, gravel: 500, sand: 220, grass: 300, mud: 200, water: 400 }[s], 0.8, sr);
    const tex = new Bq(s === 'sand' || s === 'mud' ? 'lp' : 'bp', { grass: 3800, soil: 1500, sand: 1100, gravel: 3000, asphalt: 2800, concrete: 3200, wood: 1600, tile: 4200, mud: 700, water: 1600 }[s], s === 'gravel' ? 0.9 : 0.6, sr);
    const ring = new Bq('bp', s === 'wood' ? 190 + r.next() * 30 : 420 + r.next() * 80, s === 'wood' ? 8 : 12, sr);
    const ring2 = new Bq('bp', 470 + r.next() * 60, 10, sr);
    let crackle = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const n = r.n();
      // impact transient
      const hit = Math.exp(-t / (s === 'sand' || s === 'mud' ? 0.02 : 0.006)) * n;
      let y = thump.run(hit) * (s === 'tile' || s === 'concrete' || s === 'asphalt' ? 1.2 : 2.0);
      const env = t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) / (dur * 0.28));
      switch (s) {
        case 'grass': // rustling blades: sparse crackles in high-passed noise
          if (r.next() < 0.03) crackle = 1;
          crackle *= 0.9;
          y += tex.run(n * (0.4 + crackle)) * env * 1.2;
          break;
        case 'gravel': // stones grinding: dense granular clicks
          if (r.next() < 0.08) crackle = r.next();
          crackle *= 0.7;
          y += tex.run(n * crackle * 2) * env * 1.6;
          break;
        case 'soil':
          y += tex.run(n) * env * 0.5;
          break;
        case 'sand': // soft compressing shhh
          y += tex.run(n) * (t < 0.05 ? t / 0.05 : Math.exp(-(t - 0.05) / 0.09)) * 0.9;
          break;
        case 'asphalt':
        case 'concrete': // hard tap + shoe scuff
          y += tex.run(n) * Math.exp(-t / 0.012) * 1.1 + tex.run(n) * (t > 0.04 && t < 0.11 ? 0.15 : 0);
          break;
        case 'tile':
          y += tex.run(n) * Math.exp(-t / 0.01) * 1.3 + ring.run(hit) * 0.6;
          break;
        case 'wood': // hollow boards
          y += ring.run(hit * 3) * 2.2 + ring2.run(hit * 2) * 0.8 + tex.run(n) * Math.exp(-t / 0.02) * 0.4;
          break;
        case 'mud': // squelch: gloopy, pulsing low-passed suction
          y += tex.run(n) * env * 1.4 * (0.5 + 0.5 * Math.sin(t * 90 - t * t * 300));
          break;
        case 'water': // splash + bubbles
          y = tex.run(n) * (t < 0.02 ? t / 0.02 : Math.exp(-(t - 0.02) / 0.12)) * 1.5;
          if (r.next() < 0.004) crackle = 1;
          crackle *= 0.995;
          y += Math.sin(t * (2400 + 4000 * r.next())) * crackle * 0.3 * env;
          break;
      }
      d[i] = y;
    }
  });
}

/** Indoor impulse response: early reflections + a ~1.2 s exponentially decaying tail. */
function roomIR(ctx: BaseAudioContext): AudioBuffer {
  const r = new Rng(99);
  const b = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 1.3), ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    const lp = new Bq('lp', 5200, 0.7, ctx.sampleRate);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      d[i] = lp.run(r.n()) * Math.exp(-t / 0.28) * (t < 0.004 ? 0 : 1);
    }
    for (const t of [0.011, 0.017, 0.023, 0.031]) d[Math.floor(t * ctx.sampleRate) + ch * 7] += 0.5;
  }
  return b;
}

function noiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  const r = new Rng(12345);
  for (let i = 0; i < d.length; i++) d[i] = r.n();
  return b;
}

// ── the sound system ─────────────────────────────────────────────────────────

export class SoundSystem {
  readonly ctx: AudioContext;
  readonly sfx: GainNode; // all effects (separate from voice so it can be balanced)
  readonly reverb: ConvolverNode;
  readonly noise: AudioBuffer;
  /** Vehicles have their own (quieter) bus so they sit under voices and footsteps. */
  readonly vehicles: GainNode;
  private steps = new Map<Surface, AudioBuffer[]>();
  private oneShots = new Map<string, AudioBuffer>();
  workletReady = false;

  constructor(ctx: AudioContext, master: AudioNode) {
    this.ctx = ctx;
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(master);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = roomIR(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.reverb.connect(wet).connect(this.sfx);
    this.noise = noiseBuffer(ctx);
    this.vehicles = ctx.createGain();
    this.vehicles.gain.value = 0.55;
    this.vehicles.connect(this.sfx);
    const surfaces: Surface[] = ['grass', 'soil', 'sand', 'gravel', 'asphalt', 'concrete', 'wood', 'tile', 'mud', 'water'];
    for (const s of surfaces) this.steps.set(s, [0, 1, 2, 3, 4].map((k) => footstep(ctx, s, k + 1)));
    this.buildOneShots();
    const url = URL.createObjectURL(new Blob([ENGINE_WORKLET], { type: 'application/javascript' }));
    ctx.audioWorklet
      ?.addModule(url)
      .then(() => (this.workletReady = true))
      .catch((e) => console.warn('engine worklet unavailable', e));
  }

  private buildOneShots() {
    const ctx = this.ctx;
    const r = new Rng(4);
    // car door: latch click + panel thunk
    this.oneShots.set('door', buffer(ctx, 0.35, (d, sr) => {
      const lp = new Bq('lp', 220, 1.2, sr);
      const click = new Bq('bp', 3200, 2, sr);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = lp.run(r.n() * Math.exp(-t / 0.03)) * 3 + click.run(r.n() * Math.exp(-Math.max(0, t - 0.008) / 0.004) * (t > 0.008 ? 1 : 0)) * 0.6;
      }
    }));
    // suspension bump / thud
    this.oneShots.set('thud', buffer(ctx, 0.25, (d, sr) => {
      const lp = new Bq('lp', 140, 1.4, sr);
      for (let i = 0; i < d.length; i++) d[i] = lp.run(r.n() * Math.exp(-(i / sr) / 0.04)) * 4;
    }));
    // crash: crunch of metal + glass tinkle
    this.oneShots.set('crash', buffer(ctx, 1.1, (d, sr) => {
      const lp = new Bq('lp', 900, 0.8, sr);
      const metal = [new Bq('bp', 610, 25, sr), new Bq('bp', 1330, 30, sr), new Bq('bp', 2270, 30, sr)];
      const hp = new Bq('hp', 5000, 0.7, sr);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const n = r.n();
        const impact = Math.exp(-t / 0.08);
        let y = lp.run(n * impact) * 2.5;
        for (const m of metal) y += m.run(n * impact) * 3;
        y += hp.run(n) * (r.next() < 0.002 + 0.01 * Math.exp(-t / 0.3) ? 1 : 0) * 0.6;
        d[i] = y;
      }
    }));
    // splash (wheels or body into water)
    this.oneShots.set('splash', buffer(ctx, 0.9, (d, sr) => {
      const bp = new Bq('bp', 1300, 0.5, sr);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = bp.run(r.n()) * (t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) / 0.22));
      }
    }));
    // landing (jump) on soft ground and swim stroke
    this.oneShots.set('stroke', buffer(ctx, 0.6, (d, sr) => {
      const bp = new Bq('bp', 900, 0.6, sr);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = bp.run(r.n()) * Math.sin(Math.PI * Math.min(1, t / 0.5)) * 0.8;
      }
    }));
  }

  /** Positional source routed into the effects bus (optionally also into the room reverb). */
  private spatial(pos: THREE.Vector3, ref = 2, max = 40, indoor = false): AudioNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.maxDistance = max;
    p.rolloffFactor = 1.2;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    p.connect(this.sfx);
    if (indoor) p.connect(this.reverb);
    return p;
  }

  play(name: string, pos: THREE.Vector3, gain = 1, rate = 1, ref = 3) {
    const b = this.oneShots.get(name);
    if (!b) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.spatial(pos, ref, 80));
    src.start();
  }

  /** A footstep on `surface` at `pos`; `intensity` ~0.3 (creeping) … 1.5 (sprint/landing). */
  footstep(surface: Surface, pos: THREE.Vector3, intensity: number, indoor = false) {
    const list = this.steps.get(surface);
    if (!list) return;
    const src = this.ctx.createBufferSource();
    src.buffer = list[(Math.random() * list.length) | 0];
    src.playbackRate.value = 0.92 + Math.random() * 0.16 - (intensity > 1 ? 0.05 : 0);
    const g = this.ctx.createGain();
    g.gain.value = 0.18 * Math.min(2, intensity) * (0.85 + Math.random() * 0.3);
    src.connect(g).connect(this.spatial(pos, 1.5, 30, indoor));
    src.start();
  }

  /** Non-spatial UI tone (race beeps, chimes): `when` is seconds from now. */
  tone(freq: number, dur: number, gain = 0.25, when = 0, type: OscillatorType = 'triangle') {
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.setTargetAtTime(0, t + dur * 0.6, dur * 0.25);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur * 2 + 0.1);
  }

  vehicle(diesel: boolean, horn: [number, number]): VehicleAudio {
    return new VehicleAudio(this, diesel, horn);
  }
}

/** Everything one vehicle sounds like. */
export class VehicleAudio {
  private pan: PannerNode;
  private engine: AudioWorkletNode | null = null;
  private rollSrc: AudioBufferSourceNode;
  private rollFilter: BiquadFilterNode;
  private rollGain: GainNode;
  private grit: GainNode;
  private skidGain: GainNode;
  private skidOsc: OscillatorNode;
  private hornGain: GainNode;
  private lastSpeed = 0;
  private lastDepth = 0;
  private bumpCool = 0;
  private pos = new THREE.Vector3();
  private surface: Surface = 'asphalt';

  constructor(
    private S: SoundSystem,
    private diesel: boolean,
    horn: [number, number],
  ) {
    const ctx = S.ctx;
    this.pan = ctx.createPanner();
    this.pan.panningModel = 'equalpower';
    this.pan.distanceModel = 'inverse';
    this.pan.refDistance = 4;
    this.pan.maxDistance = 140;
    this.pan.rolloffFactor = 1.1;
    this.pan.connect(S.vehicles);
    // tyre roll: filtered noise, tone set by the surface; gravel adds granular grit
    this.rollSrc = ctx.createBufferSource();
    this.rollSrc.buffer = S.noise;
    this.rollSrc.loop = true;
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'bandpass';
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    this.grit = ctx.createGain();
    this.grit.gain.value = 0;
    const gritSrc = ctx.createBufferSource();
    gritSrc.buffer = S.noise;
    gritSrc.loop = true;
    gritSrc.playbackRate.value = 0.37;
    const gritBp = ctx.createBiquadFilter();
    gritBp.type = 'bandpass';
    gritBp.frequency.value = 3200;
    gritBp.Q.value = 0.8;
    this.rollSrc.connect(this.rollFilter).connect(this.rollGain).connect(this.pan);
    gritSrc.connect(gritBp).connect(this.grit).connect(this.pan);
    // skid: narrow-band noise + a wavering squeal tone
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = S.noise;
    skidSrc.loop = true;
    const skidBp = ctx.createBiquadFilter();
    skidBp.type = 'bandpass';
    skidBp.frequency.value = 1700;
    skidBp.Q.value = 6;
    this.skidOsc = ctx.createOscillator();
    this.skidOsc.type = 'triangle';
    this.skidOsc.frequency.value = 980;
    const skidTone = ctx.createGain();
    skidTone.gain.value = 0.25;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skidSrc.connect(skidBp).connect(this.skidGain);
    this.skidOsc.connect(skidTone).connect(this.skidGain);
    this.skidGain.connect(this.pan);
    // horn: two detuned square tones through a horn-ish band-pass
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    const hornBp = ctx.createBiquadFilter();
    hornBp.type = 'bandpass';
    hornBp.frequency.value = 1100;
    hornBp.Q.value = 0.7;
    for (const f of horn) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(hornBp);
      o.start();
    }
    hornBp.connect(this.hornGain).connect(this.pan);
    this.rollSrc.start();
    gritSrc.start();
    skidSrc.start();
    this.skidOsc.start();
  }

  private ensureEngine() {
    if (this.engine || !this.S.workletReady) return;
    this.engine = new AudioWorkletNode(this.S.ctx, 'engine-sim', { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { cylinders: 4, diesel: this.diesel } });
    this.engine.connect(this.pan);
  }

  door() {
    this.S.play('door', this.pos, 0.9, 0.95 + Math.random() * 0.1);
  }

  update(dt: number, s: { pos: THREE.Vector3; running: boolean; rpm: number; load: number; speed: number; slip: number; surface: Surface; depth: number; horn: boolean }) {
    const ctx = this.S.ctx;
    const t = ctx.currentTime;
    this.pos.copy(s.pos);
    this.pan.positionX.value = s.pos.x;
    this.pan.positionY.value = s.pos.y + 0.4;
    this.pan.positionZ.value = s.pos.z;
    this.ensureEngine();
    if (this.engine) {
      this.engine.parameters.get('rpm')!.setTargetAtTime(s.rpm, t, 0.03);
      this.engine.parameters.get('load')!.setTargetAtTime(s.running ? s.load : 0, t, 0.05);
      this.engine.parameters.get('gain')!.setTargetAtTime(s.running ? (this.diesel ? 0.16 : 0.13) : 0, t, 0.15);
    }
    const v = Math.abs(s.speed);
    this.surface = s.surface;
    const surf = {
      asphalt: [700, 0.6, 0.0], concrete: [900, 0.6, 0.0], gravel: [2200, 0.5, 1.0], soil: [500, 0.6, 0.45], sand: [380, 0.5, 0.25],
      grass: [1400, 0.4, 0.3], mud: [300, 0.7, 0.2], wood: [450, 1.2, 0.2], tile: [900, 0.6, 0.0], water: [1300, 0.4, 0.0],
    }[this.surface];
    this.rollFilter.frequency.setTargetAtTime(surf[0] + v * 18, t, 0.1);
    this.rollFilter.Q.value = surf[1];
    const roll = Math.min(0.1, v * 0.004) * (this.surface === 'asphalt' ? 0.8 : 1.1);
    this.rollGain.gain.setTargetAtTime(roll, t, 0.08);
    this.grit.gain.setTargetAtTime(Math.min(0.15, v * 0.01) * surf[2], t, 0.08);
    // Squeal only on hard surfaces; on dirt a slide is a scrabble (handled by the grit).
    const hard = this.surface === 'asphalt' || this.surface === 'concrete' || this.surface === 'tile';
    const squeal = hard ? THREE.MathUtils.clamp((s.slip - 0.25) * 1.4, 0, 1) * Math.min(1, v / 4) : 0;
    this.skidGain.gain.setTargetAtTime(squeal * 0.16, t, 0.05);
    this.skidOsc.frequency.setTargetAtTime(900 + 140 * Math.sin(t * 13) + v * 6, t, 0.02);
    if (!hard && s.slip > 0.4) this.grit.gain.setTargetAtTime(Math.min(0.25, v * 0.02), t, 0.05);
    this.hornGain.gain.setTargetAtTime(s.horn ? 0.07 : 0, t, 0.015);
    // Events: crash (sudden loss of speed), splash (into water), bumps.
    this.bumpCool -= dt;
    const decel = (this.lastSpeed - v) / Math.max(dt, 1e-3);
    if (decel > 16 && this.lastSpeed > 4 && this.bumpCool <= 0) {
      this.S.play('crash', this.pos, Math.min(1.4, this.lastSpeed / 10), 0.9 + Math.random() * 0.2, 5);
      this.bumpCool = 0.6;
    }
    if (s.depth > 0.15 && this.lastDepth <= 0.15 && v > 2) this.S.play('splash', this.pos, Math.min(1.5, v / 6), 0.9, 4);
    this.lastSpeed = v;
    this.lastDepth = s.depth;
  }

  /** Suspension hit (big compression change). */
  bump(strength: number) {
    if (this.bumpCool > 0) return;
    this.bumpCool = 0.15;
    this.S.play('thud', this.pos, Math.min(1.2, strength), 0.85 + Math.random() * 0.3, 3);
  }
}
