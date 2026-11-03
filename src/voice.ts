import * as THREE from 'three';
import { OCCLUSION, VOICE } from './config';
import { registry } from './world/registry';

interface PAChain {
  gain: GainNode;
  pans: PannerNode[];
}

interface Peer {
  el: HTMLAudioElement; // muted element: needed for Chrome to start flowing remote WebRTC audio
  src: MediaStreamAudioSourceNode;
  body: GainNode; // body voice on/off (off while on a PA)
  occl: BiquadFilterNode; // wall occlusion: low-pass…
  occlGain: GainNode; // …and attenuation
  bodyPan: PannerNode;
  room: number;
  pa: number | null;
  chains: Map<number, PAChain>;
}

/** Linear distance model, identical to PannerNode 'linear' — used for UI audibility. */
export function gainAt(distance: number, ref = VOICE.refDistance, max = VOICE.maxDistance): number {
  const d = Math.min(Math.max(distance, ref), max);
  return 1 - (d - ref) / (max - ref);
}

/**
 * Proximity voice + PA systems + room acoustics.
 * - Every remote mic goes through a PannerNode at that player's head.
 * - Voices crossing a room boundary are muffled; across a soundproof room they're cut.
 * - A player on a PA mic is fanned out (one source, no extra bandwidth) to that PA's
 *   speakers, and their body voice fades out so it isn't doubled. A PA that belongs to
 *   a room (the meeting hall) is only heard by listeners inside that room.
 */
export class Voice {
  readonly ctx: AudioContext;
  readonly master: DynamicsCompressorNode;
  private peers = new Map<string, Peer>();
  private paWanted = new Map<string, number>();
  private listenerRoom = -1;

  /** Must be constructed inside a user gesture (the Join click). */
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createDynamicsCompressor();
    this.master.connect(this.ctx.destination);
    void this.ctx.resume();
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  makePanner(ref: number, max: number): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower'; // HRTF is CPU-heavy at ~20 sources
    p.distanceModel = 'linear';
    p.refDistance = ref;
    p.maxDistance = max;
    p.rolloffFactor = 1;
    return p;
  }

  attach(identity: string, track: MediaStreamTrack) {
    this.detach(identity);
    const stream = new MediaStream([track]);
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => {});
    const src = this.ctx.createMediaStreamSource(stream);
    const body = this.ctx.createGain();
    const occl = this.ctx.createBiquadFilter();
    occl.type = 'lowpass';
    occl.frequency.value = 20000;
    const occlGain = this.ctx.createGain();
    const bodyPan = this.makePanner(VOICE.refDistance, VOICE.maxDistance);
    src.connect(body).connect(occl).connect(occlGain).connect(bodyPan).connect(this.master);
    this.peers.set(identity, { el, src, body, occl, occlGain, bodyPan, room: -1, pa: null, chains: new Map() });
    const pa = this.paWanted.get(identity);
    if (pa !== undefined) this.setPA(identity, pa);
  }

  detach(identity: string) {
    const p = this.peers.get(identity);
    if (!p) return;
    for (const n of [p.src, p.body, p.occl, p.occlGain, p.bodyPan]) n.disconnect();
    p.chains.forEach((c) => {
      c.gain.disconnect();
      c.pans.forEach((n) => n.disconnect());
    });
    p.el.srcObject = null;
    this.peers.delete(identity);
  }

  setBodyPosition(identity: string, x: number, y: number, z: number, room: number) {
    const p = this.peers.get(identity);
    if (!p) return;
    p.bodyPan.positionX.value = x;
    p.bodyPan.positionY.value = y;
    p.bodyPan.positionZ.value = z;
    p.room = room;
  }

  /** Route a player's voice through PA `pa` (or back to their body with null). */
  setPA(identity: string, pa: number | null) {
    if (pa === null) this.paWanted.delete(identity);
    else this.paWanted.set(identity, pa);
    const p = this.peers.get(identity);
    if (!p) return;
    if (pa !== null && !p.chains.has(pa)) {
      const def = registry.pas[pa];
      if (!def) return;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      p.src.connect(gain);
      const pans = registry.speakers
        .filter((s) => s.pa === pa)
        .map((s) => {
          const pan = this.makePanner(def.ref, def.max);
          pan.positionX.value = s.x;
          pan.positionY.value = s.y;
          pan.positionZ.value = s.z;
          gain.connect(pan).connect(this.master);
          return pan;
        });
      p.chains.set(pa, { gain, pans });
    }
    p.pa = pa;
    this.applyGains(p);
  }

  setListener(pos: THREE.Vector3, forward: THREE.Vector3, room: number) {
    const l = this.ctx.listener;
    l.positionX.value = pos.x;
    l.positionY.value = pos.y;
    l.positionZ.value = pos.z;
    l.forwardX.value = forward.x;
    l.forwardY.value = forward.y;
    l.forwardZ.value = forward.z;
    l.upX.value = 0;
    l.upY.value = 1;
    l.upZ.value = 0;
    this.listenerRoom = room;
    this.peers.forEach((p) => this.applyGains(p));
  }

  private applyGains(p: Peer) {
    const t = this.ctx.currentTime;
    // Walls between talker and listener.
    let g = 1;
    let f = 20000;
    if (p.room !== this.listenerRoom) {
      const proof = (r: number) => r >= 0 && registry.rooms[r]?.soundproof;
      if (proof(p.room) || proof(this.listenerRoom)) g = 0;
      else {
        g = OCCLUSION.gain;
        f = OCCLUSION.lowpassHz;
      }
    }
    p.occlGain.gain.setTargetAtTime(g, t, 0.08);
    p.occl.frequency.setTargetAtTime(f, t, 0.08);
    p.body.gain.setTargetAtTime(p.pa === null ? 1 : 0, t, 0.04);
    p.chains.forEach((c, id) => {
      const room = registry.pas[id]?.room ?? null;
      const audible = room === null || room === this.listenerRoom;
      c.gain.gain.setTargetAtTime(p.pa === id && audible ? 1 : 0, t, 0.05);
    });
  }
}

/**
 * Synthesised 4-cylinder engine + road noise, spatialised at the car.
 * Firing frequency = rpm/60 × 2 (four-stroke, four cylinders), with harmonics and a
 * load-dependent low-pass so it growls on throttle and burbles when coasting.
 */
export class EngineSound {
  private oscA: OscillatorNode;
  private oscB: OscillatorNode;
  private noise: AudioBufferSourceNode;
  private filter: BiquadFilterNode;
  private gain: GainNode;
  private roadGain: GainNode;
  private pan: PannerNode;
  private on = false;

  constructor(private v: Voice, private diesel = false) {
    const ctx = v.ctx;
    this.pan = v.makePanner(4, 80);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 3;
    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscB = ctx.createOscillator();
    this.oscB.type = 'square';
    const bGain = ctx.createGain();
    bGain.gain.value = 0.35;
    this.oscA.connect(this.filter);
    this.oscB.connect(bGain).connect(this.filter);
    this.filter.connect(this.gain).connect(this.pan).connect(v.master);
    // Road / tyre noise: filtered white noise scaled by speed.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 500;
    nf.Q.value = 0.6;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    this.noise.connect(nf).connect(this.roadGain).connect(this.pan);
    this.oscA.start();
    this.oscB.start();
    this.noise.start();
  }

  update(pos: THREE.Vector3, running: boolean, rpm: number, throttle: number, speed: number) {
    const t = this.v.ctx.currentTime;
    this.pan.positionX.value = pos.x;
    this.pan.positionY.value = pos.y + 0.5;
    this.pan.positionZ.value = pos.z;
    this.on = running;
    const fire = (rpm / 60) * 2;
    this.oscA.frequency.setTargetAtTime(fire, t, 0.03);
    this.oscB.frequency.setTargetAtTime(fire * 0.5, t, 0.03);
    // Diesel: lower, grittier clatter; petrol: smoother and revvier.
    this.filter.frequency.setTargetAtTime((this.diesel ? 150 : 220) + rpm * (this.diesel ? 0.32 : 0.22) + throttle * (this.diesel ? 600 : 900), t, 0.05);
    this.gain.gain.setTargetAtTime(running ? (this.diesel ? 0.07 : 0.05) + throttle * 0.09 + rpm / 90000 : 0, t, 0.08);
    this.roadGain.gain.setTargetAtTime(running || speed > 0.5 ? Math.min(0.12, Math.abs(speed) * 0.006) : 0, t, 0.1);
  }

  get running() {
    return this.on;
  }
}
