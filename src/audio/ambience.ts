import * as THREE from 'three';
import { TEMPLE, WORLD_HALF, coastX, hillMask } from '../world/layout';
import { roomAt, registry } from '../world/registry';
import type { Terrain } from '../world/terrain';
import { windTime } from '../world/wind';
import type { SoundSystem } from './sound';

/**
 * The world's soundscape, mixed by where you are: sea waves from the nearest coastline,
 * lapping water along the backwaters, gusting wind (stronger on the hills), cicadas near
 * vegetation, Kerala birds (koel, myna, crow) in the trees, temple bells near the temple,
 * distant auto horns in town, and the hall's ceiling fans.
 */
export class Ambience {
  private ctx: AudioContext;
  private wind: GainNode;
  private windF: BiquadFilterNode;
  private waves: GainNode;
  private wavePan: PannerNode;
  private waveHiss: GainNode;
  private cicada: GainNode;
  private fans: GainNode;
  private nextBird = 2;
  private nextBell = 8;
  private nextHorn = 6;
  private nextLap = 1;
  private wavePhase = 0;

  constructor(
    private S: SoundSystem,
    private terrain: Terrain,
  ) {
    const ctx = (this.ctx = S.ctx);
    const loop = (rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = S.noise;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start();
      return s;
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    // Wind
    this.windF = filt('lowpass', 500, 0.5);
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    loop(0.5).connect(this.windF).connect(filt('highpass', 60)).connect(this.wind).connect(S.sfx);
    // Sea: a low roar from the coast plus the hiss of breaking surf
    this.wavePan = ctx.createPanner();
    this.wavePan.panningModel = 'equalpower';
    this.wavePan.distanceModel = 'inverse';
    this.wavePan.refDistance = 25;
    this.wavePan.rolloffFactor = 1;
    this.wavePan.connect(S.sfx);
    this.waves = ctx.createGain();
    this.waves.gain.value = 0;
    loop(0.6).connect(filt('lowpass', 420, 0.6)).connect(this.waves).connect(this.wavePan);
    this.waveHiss = ctx.createGain();
    this.waveHiss.gain.value = 0;
    loop(1).connect(filt('bandpass', 2600, 0.5)).connect(this.waveHiss).connect(this.wavePan);
    // Cicadas: narrow-band noise chopped at ~30 Hz
    this.cicada = ctx.createGain();
    this.cicada.gain.value = 0;
    const chop = ctx.createGain();
    chop.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 31;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    lfo.connect(lfoGain).connect(chop.gain);
    lfo.start();
    loop(1).connect(filt('bandpass', 4700, 7)).connect(chop).connect(this.cicada).connect(S.sfx);
    // Hall fans: a soft hum + whoosh, only inside the meeting hall
    this.fans = ctx.createGain();
    this.fans.gain.value = 0;
    const hum = ctx.createOscillator();
    hum.frequency.value = 100;
    hum.connect(this.fans);
    hum.start();
    loop(0.8).connect(filt('lowpass', 700)).connect(this.fans);
    this.fans.connect(S.sfx);
  }

  private nearWater(p: THREE.Vector3, r: number) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      if (x - coastX(z) > 10 && this.terrain.waterDepth(x, z) > 0.3) return { x, z };
    }
    return null;
  }

  update(dt: number, ear: THREE.Vector3) {
    const t = this.ctx.currentTime;
    const room = roomAt(ear.x, ear.y, ear.z);
    const indoors = room >= 0;
    const muffle = indoors ? 0.25 : 1;
    // Wind follows the same gusts as the swaying trees.
    const wt = windTime.value;
    const gust = 0.55 + 0.45 * Math.sin(wt * 0.33) * Math.sin(wt * 0.21);
    const height = Math.max(0, ear.y - 5) / 40;
    this.wind.gain.setTargetAtTime((0.025 + 0.05 * gust + 0.08 * height) * muffle, t, 0.4);
    this.windF.frequency.setTargetAtTime(300 + 500 * gust + 600 * height, t, 0.4);
    // Sea, from the nearest point of the coast.
    const coastDist = Math.max(0, ear.x - coastX(ear.z));
    this.wavePan.positionX.value = coastX(ear.z) - 12;
    this.wavePan.positionY.value = 0;
    this.wavePan.positionZ.value = ear.z;
    this.wavePhase += dt / 7.5;
    const ph = this.wavePhase % 1;
    const swell = ph < 0.18 ? ph / 0.18 : Math.exp(-(ph - 0.18) * 5); // rise, break, recede
    const sea = Math.exp(-coastDist / 70) * muffle;
    this.waves.gain.setTargetAtTime(sea * (0.12 + 0.18 * swell), t, 0.2);
    this.waveHiss.gain.setTargetAtTime(sea * 0.1 * Math.max(0, swell - 0.3), t, 0.15);
    // Cicadas: louder in green, tree-heavy country; quiet by the sea and indoors.
    const green = Math.min(1, 0.4 + hillMask(ear.x, ear.z) * 0.6 + Math.min(1, coastDist / 60) * 0.3);
    const pulse = 0.6 + 0.4 * Math.sin(t * 0.21) * Math.sin(t * 0.13);
    this.cicada.gain.setTargetAtTime(0.012 * green * pulse * muffle, t, 1.0);
    // Fans in the meeting hall.
    const inHall = indoors && registry.rooms[room]?.soundproof;
    this.fans.gain.setTargetAtTime(inHall ? 0.012 : 0, t, 0.5);

    // Events.
    if ((this.nextBird -= dt) <= 0) {
      this.nextBird = 2 + Math.random() * 6;
      if (!indoors && coastDist > 15) this.bird(ear);
    }
    const toTemple = Math.hypot(ear.x - TEMPLE.x, ear.z - TEMPLE.z);
    if ((this.nextBell -= dt) <= 0) {
      this.nextBell = 18 + Math.random() * 25;
      if (toTemple < 140) this.bell(new THREE.Vector3(TEMPLE.x - 7, 3, TEMPLE.z));
    }
    if ((this.nextHorn -= dt) <= 0) {
      this.nextHorn = 8 + Math.random() * 18;
      const roads = this.terrain.roads;
      const r = roads[(Math.random() * roads.length) | 0];
      const pts = r.pts[(Math.random() * r.pts.length) | 0];
      const p = new THREE.Vector3(pts[0], 2, pts[1]);
      const d = p.distanceTo(ear);
      if (d > 40 && d < 180) this.autoHorn(p);
    }
    if ((this.nextLap -= dt) <= 0) {
      this.nextLap = 0.6 + Math.random() * 1.4;
      const w = this.nearWater(ear, 6 + Math.random() * 14);
      if (w && !indoors) this.S.play('splash', new THREE.Vector3(w.x, 0, w.z), 0.12 + Math.random() * 0.1, 1.6 + Math.random() * 0.6, 2);
    }
  }

  private panner(p: THREE.Vector3, ref = 6): PannerNode {
    const pan = this.ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = ref;
    pan.rolloffFactor = 1;
    pan.positionX.value = p.x;
    pan.positionY.value = p.y;
    pan.positionZ.value = p.z;
    pan.connect(this.S.sfx);
    return pan;
  }

  /** A note: oscillator with an envelope and optional pitch glide. */
  private note(out: AudioNode, t0: number, dur: number, f0: number, f1: number, type: OscillatorType, peak: number) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.03, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private bird(ear: THREE.Vector3) {
    const a = Math.random() * Math.PI * 2;
    const r = 14 + Math.random() * 30;
    const p = new THREE.Vector3(ear.x + Math.cos(a) * r, ear.y + 6 + Math.random() * 6, ear.z + Math.sin(a) * r);
    if (Math.abs(p.x) > WORLD_HALF || Math.abs(p.z) > WORLD_HALF) return;
    const out = this.panner(p, 8);
    const t = this.ctx.currentTime + 0.05;
    const kind = Math.random();
    if (kind < 0.35) {
      // Asian koel: "ku-OO", repeated, each call a little higher and more urgent.
      const n = 3 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const base = 620 + i * 45;
        this.note(out, t + i * 0.7, 0.16, base, base * 1.05, 'sine', 0.05);
        this.note(out, t + i * 0.7 + 0.2, 0.32, base * 1.25, base * 1.55, 'sine', 0.07);
      }
    } else if (kind < 0.7) {
      // Myna: a rapid, varied chatter.
      let tt = t;
      for (let i = 0; i < 7 + Math.random() * 6; i++) {
        const f = 1500 + Math.random() * 2400;
        const d = 0.04 + Math.random() * 0.08;
        this.note(out, tt, d, f, f * (0.7 + Math.random() * 0.8), Math.random() < 0.5 ? 'sine' : 'triangle', 0.035);
        tt += d + 0.02 + Math.random() * 0.06;
      }
    } else {
      // House crow: a few harsh "kaa"s (buzzy, with a falling formant).
      for (let i = 0; i < 2 + ((Math.random() * 3) | 0); i++) {
        const t0 = t + i * 0.45;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 3;
        bp.frequency.setValueAtTime(1500, t0);
        bp.frequency.exponentialRampToValueAtTime(900, t0 + 0.3);
        bp.connect(out);
        this.note(bp, t0, 0.32, 560, 470, 'sawtooth', 0.08);
      }
    }
  }

  /** Temple bell: inharmonic partials with a long decay. */
  private bell(p: THREE.Vector3) {
    const out = this.panner(p, 15);
    const t = this.ctx.currentTime + 0.05;
    const f = 520;
    const parts: [number, number, number][] = [[1, 0.1, 3.5], [2.0, 0.06, 2.6], [2.76, 0.05, 2.2], [5.4, 0.03, 1.4], [8.93, 0.015, 0.9]];
    for (let k = 0; k < 3; k++) for (const [m, a, d] of parts) this.note(out, t + k * 1.6, d, f * m, f * m * 0.998, 'sine', a);
  }

  /** A distant autorickshaw horn: a nasal double beep. */
  private autoHorn(p: THREE.Vector3) {
    const out = this.panner(p, 12);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1300;
    bp.Q.value = 1.2;
    bp.connect(out);
    const t = this.ctx.currentTime + 0.05;
    for (let i = 0; i < 2; i++) {
      this.note(bp, t + i * 0.28, 0.2, 470, 470, 'square', 0.05);
      this.note(bp, t + i * 0.28, 0.2, 590, 590, 'square', 0.04);
    }
  }
}
