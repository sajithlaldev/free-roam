import * as THREE from 'three';
import { PA_HEARTBEAT_MS, PA_TIMEOUT_MS } from './config';
import type { Net } from './net';
import type { Voice } from './voice';
import type { PADef } from './world/layout';
import { registry } from './world/registry';
import type { World } from './world/index';

export type PAHint = '' | 'hold' | 'unmute' | 'busy' | 'live';

/**
 * PA mics (the maidan PA, the meeting-hall mic, …). Anyone standing at a mic and
 * holding E goes live on that PA: other clients route their voice through its speakers
 * (and mute their body voice). One person per PA at a time (best-effort, client-side).
 * "On" is re-sent every PA_HEARTBEAT_MS for late joiners; silence for PA_TIMEOUT_MS = off.
 */
export class Announcer {
  private remote = new Map<string, { pa: number; t: number }>();
  private live: number | null = null;
  private lastBeat = 0;

  constructor(
    private net: Net,
    private voice: Voice,
    private world: World,
  ) {}

  onRemote(identity: string, pa: number, on: boolean, now: number) {
    if (!registry.pas[pa]) return;
    if (on) this.remote.set(identity, { pa, t: now });
    else if (this.remote.get(identity)?.pa === pa) this.remote.delete(identity);
    this.voice.setPA(identity, on ? pa : null);
  }

  onLeft(identity: string) {
    if (this.remote.delete(identity)) this.voice.setPA(identity, null);
  }

  /** Which PA a remote player is live on (null if none). */
  liveOn(identity: string): number | null {
    return this.remote.get(identity)?.pa ?? null;
  }

  private nearestMic(p: THREE.Vector3): PADef | null {
    let best: PADef | null = null;
    let bd = Infinity;
    for (const pa of registry.pas) {
      const d = Math.hypot(p.x - pa.mic[0], p.z - pa.mic[2]);
      if (d < pa.micRadius && Math.abs(p.y - pa.mic[1]) < 1.5 && d < bd) [best, bd] = [pa, d];
    }
    return best;
  }

  /** Per frame. `feet` = player's feet; `canUse` = on foot. */
  update(feet: THREE.Vector3, keyHeld: boolean, canUse: boolean, now: number): { hint: PAHint; pa: PADef | null } {
    for (const [id, r] of this.remote) {
      if (now - r.t > PA_TIMEOUT_MS) {
        this.remote.delete(id);
        this.voice.setPA(id, null);
      }
    }
    for (const pa of registry.pas) {
      const remoteLive = [...this.remote.values()].some((r) => r.pa === pa.id);
      this.world.setOnAir(pa.id, remoteLive || this.live === pa.id);
    }

    const pa = canUse ? this.nearestMic(feet) : null;
    let hint: PAHint = pa ? 'hold' : '';
    let want: number | null = null;
    if (pa && keyHeld) {
      const busy = [...this.remote.values()].some((r) => r.pa === pa.id);
      if (!this.net.micOn) hint = 'unmute';
      else if (busy && this.live !== pa.id) hint = 'busy';
      else want = pa.id;
    }
    if (want !== this.live) {
      if (this.live !== null) this.net.sendPA(this.live, false);
      if (want !== null) this.net.sendPA(want, true);
      this.live = want;
      this.lastBeat = now;
    } else if (want !== null && now - this.lastBeat > PA_HEARTBEAT_MS) {
      this.net.sendPA(want, true);
      this.lastBeat = now;
    }
    return { hint: want !== null ? 'live' : hint, pa };
  }

  stop() {
    if (this.live !== null) {
      this.net.sendPA(this.live, false);
      this.live = null;
    }
  }
}
