import * as THREE from 'three';
import { MIC_USE_RADIUS, PA_HEARTBEAT_MS, PA_TIMEOUT_MS } from './config';
import type { Net } from './net';
import type { Voice } from './voice';
import type { World } from './world';

export type PAHint = '' | 'approach' | 'hold' | 'unmute' | 'busy' | 'live';

/**
 * PA mic. Only players whose server-signed token says role=announcer are honoured.
 * An announcer standing at the mic and holding the key is "live": every other client
 * routes their voice through the speaker props and mutes their body voice.
 *
 * "On" is re-sent every PA_HEARTBEAT_MS so late joiners catch up, and a PA that goes
 * quiet for PA_TIMEOUT_MS (crash, tab closed) is switched off automatically.
 */
export class Announcer {
  private remote = new Map<string, number>(); // identity -> last heartbeat time
  private liveLocal = false;
  private lastBeat = 0;

  constructor(
    private net: Net,
    private voice: Voice,
    private world: World,
    private isAnnouncer: boolean,
  ) {}

  /** Handles a PA message from `identity`. Non-announcers are ignored. */
  onRemote(identity: string, role: string, on: boolean, now: number) {
    if (role !== 'announcer') return;
    if (on) this.remote.set(identity, now);
    else this.remote.delete(identity);
    this.voice.setPA(identity, on);
  }

  onLeft(identity: string) {
    if (this.remote.delete(identity)) this.voice.setPA(identity, false);
  }

  /** Called every frame. Returns what to tell the player about the mic. */
  update(playerPos: THREE.Vector3, keyHeld: boolean, now: number): PAHint {
    for (const [id, t] of this.remote) {
      if (now - t > PA_TIMEOUT_MS) {
        this.remote.delete(id);
        this.voice.setPA(id, false);
      }
    }
    this.world.setOnAir(this.liveLocal || this.remote.size > 0);

    if (!this.isAnnouncer) return '';

    const near = Math.hypot(playerPos.x - this.world.micPos.x, playerPos.z - this.world.micPos.z) < MIC_USE_RADIUS;
    let hint: PAHint = near ? 'hold' : '';
    let want = false;
    if (near && keyHeld) {
      if (!this.net.micOn) hint = 'unmute';
      else if (this.remote.size > 0) hint = 'busy'; // someone else has the mic
      else want = true;
    }

    if (want !== this.liveLocal) {
      this.liveLocal = want;
      this.net.sendPA(want);
      this.lastBeat = now;
    } else if (want && now - this.lastBeat > PA_HEARTBEAT_MS) {
      this.net.sendPA(true);
      this.lastBeat = now;
    }
    return want ? 'live' : hint;
  }

  /** Release the mic on mute / disconnect. */
  stop() {
    if (this.liveLocal) {
      this.liveLocal = false;
      this.net.sendPA(false);
    }
  }
}
