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
