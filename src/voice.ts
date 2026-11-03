import * as THREE from 'three';
import { SPEAKERS, SPEAKER_VOICE, VOICE } from './config';

interface Peer {
  el: HTMLAudioElement; // muted element: required for Chrome to start flowing remote WebRTC audio
  src: MediaStreamAudioSourceNode;
  body: GainNode;
  bodyPan: PannerNode;
  speakers?: { gain: GainNode; pans: PannerNode[] };
  pa: boolean;
}

/** Linear distance model, identical to PannerNode 'linear' — used for UI audibility. */
export function gainAt(distance: number, ref = VOICE.refDistance, max = VOICE.maxDistance): number {
  const d = Math.min(Math.max(distance, ref), max);
  return 1 - (d - ref) / (max - ref);
}

/**
 * Proximity voice. Every remote mic track is routed through a PannerNode placed at
 * that player's avatar. When a player is on the PA, the same source is also fanned
 * out to one panner per speaker prop and their body-position voice is faded out.
 */
export class Voice {
  readonly ctx: AudioContext;
  private master: DynamicsCompressorNode;
  private peers = new Map<string, Peer>();
  private paWanted = new Set<string>(); // PA state that arrived before the track did

  /** Must be constructed inside a user gesture (the Join click). */
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createDynamicsCompressor(); // keeps a crowd from clipping
    this.master.connect(this.ctx.destination);
    void this.ctx.resume();
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  private makePanner(ref: number, max: number): PannerNode {
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
    const bodyPan = this.makePanner(VOICE.refDistance, VOICE.maxDistance);
    src.connect(body).connect(bodyPan).connect(this.master);

    const peer: Peer = { el, src, body, bodyPan, pa: false };
    this.peers.set(identity, peer);
    if (this.paWanted.has(identity)) this.setPA(identity, true);
  }

  detach(identity: string) {
    const p = this.peers.get(identity);
    if (!p) return;
    p.src.disconnect();
    p.body.disconnect();
    p.bodyPan.disconnect();
    p.speakers?.gain.disconnect();
    p.speakers?.pans.forEach((n) => n.disconnect());
    p.el.srcObject = null;
    this.peers.delete(identity);
  }

  setBodyPosition(identity: string, x: number, y: number, z: number) {
    const p = this.peers.get(identity)?.bodyPan;
    if (!p) return;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  }

  /** Route a player's voice through the PA speakers (and silence their body voice). */
  setPA(identity: string, on: boolean) {
    if (on) this.paWanted.add(identity);
    else this.paWanted.delete(identity);

    const p = this.peers.get(identity);
    if (!p) return;
    if (on && !p.speakers) {
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      p.src.connect(gain); // one source -> one gain -> N panners (no extra bandwidth)
      const pans = SPEAKERS.map(({ x, y, z }) => {
        const pan = this.makePanner(SPEAKER_VOICE.refDistance, SPEAKER_VOICE.maxDistance);
        pan.positionX.value = x;
        pan.positionY.value = y;
        pan.positionZ.value = z;
        gain.connect(pan).connect(this.master);
        return pan;
      });
      p.speakers = { gain, pans };
    }
    p.pa = on;
    const t = this.ctx.currentTime;
    p.body.gain.setTargetAtTime(on ? 0 : 1, t, 0.04);
    p.speakers?.gain.gain.setTargetAtTime(on ? 1 : 0, t, 0.04);
  }

  updateListener(pos: THREE.Vector3, forward: THREE.Vector3) {
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
  }
}
