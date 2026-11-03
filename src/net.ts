import * as THREE from 'three';
import { ConnectionState, Room, RoomEvent, Track, type RemoteParticipant } from 'livekit-client';
import type { CarState } from './car';
import { TOPIC_CAR, TOPIC_CAR_SEAT, TOPIC_PA, TOPIC_POS } from './config';
import { packFlags, unpackFlags, type NetState } from './player';

export interface NetHandlers {
  onPlayerJoined(identity: string, name: string): void;
  onPlayerLeft(identity: string): void;
  onPosition(identity: string, seq: number, x: number, y: number, z: number, yaw: number, state: NetState): void;
  onAudio(identity: string, track: MediaStreamTrack | null): void;
  onPA(identity: string, pa: number, on: boolean): void;
  onCarPose(identity: string, car: number, seq: number, p: THREE.Vector3, q: THREE.Quaternion, st: CarState, parked: boolean): void;
  onCarSeat(identity: string, car: number, seat: number, on: boolean): void;
  onDisconnected(): void;
}

/**
 * LiveKit room + data protocol (all little-endian):
 *  pos  (lossy, 15 Hz)  seq u32 · x y z yaw f32 · flags u8 · seat i16 · carSeat i16   = 25 B
 *  car  (lossy, 20 Hz)  car u8 · seq u32 · pos 3×f32 · quat 4×f32 · steer speed rpm f32 ·
 *                       gear i8 · flags u8 (braking | low | parked)                     = 47 B
 *  pa   (reliable)      pa u8 · on u8
 *  carseat (reliable)   car u8 · seat u8 · on u8
 */
export class Net {
  readonly room = new Room({
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    dynacast: false,
    adaptiveStream: false,
  });
  micAvailable = false;
  private seq = 0;
  private carSeq = 0;
  private speaking = new Set<string>();

  constructor(private h: NetHandlers) {
    this.wire();
  }

  private wire() {
    const room = this.room;
    const announce = (p: RemoteParticipant) => this.h.onPlayerJoined(p.identity, p.name || p.identity);
    room
      .on(RoomEvent.ParticipantConnected, announce)
      .on(RoomEvent.ParticipantDisconnected, (p) => this.h.onPlayerLeft(p.identity))
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
        if (track.kind === Track.Kind.Audio) this.h.onAudio(p.identity, track.mediaStreamTrack);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => {
        if (track.kind === Track.Kind.Audio) this.h.onAudio(p.identity, null);
      })
      .on(RoomEvent.DataReceived, (payload, p, _kind, topic) => {
        if (!p) return;
        const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        try {
          if (topic === TOPIC_POS && payload.byteLength >= 25) {
            const f = unpackFlags(v.getUint8(20));
            this.h.onPosition(p.identity, v.getUint32(0, true), v.getFloat32(4, true), v.getFloat32(8, true), v.getFloat32(12, true), v.getFloat32(16, true), {
              ...f,
              seat: v.getInt16(21, true),
              carSeat: v.getInt16(23, true),
            });
          } else if (topic === TOPIC_CAR && payload.byteLength >= 47) {
            const pos = new THREE.Vector3(v.getFloat32(5, true), v.getFloat32(9, true), v.getFloat32(13, true));
            const q = new THREE.Quaternion(v.getFloat32(17, true), v.getFloat32(21, true), v.getFloat32(25, true), v.getFloat32(29, true));
            const flags = v.getUint8(46);
            this.h.onCarPose(p.identity, v.getUint8(0), v.getUint32(1, true), pos, q.normalize(), {
              steer: v.getFloat32(33, true),
              speed: v.getFloat32(37, true),
              rpm: v.getFloat32(41, true),
              gear: v.getInt8(45),
              throttle: 0,
              braking: !!(flags & 1),
              low: !!(flags & 2),
              horn: !!(flags & 8),
            }, !!(flags & 4));
          } else if (topic === TOPIC_PA && payload.byteLength >= 2) {
            this.h.onPA(p.identity, v.getUint8(0), v.getUint8(1) === 1);
          } else if (topic === TOPIC_CAR_SEAT && payload.byteLength >= 3) {
            this.h.onCarSeat(p.identity, v.getUint8(0), v.getUint8(1), v.getUint8(2) === 1);
          }
        } catch (e) {
          console.warn('bad packet', topic, e);
        }
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        this.speaking = new Set(speakers.map((s) => s.identity));
      })
      .on(RoomEvent.Disconnected, () => this.h.onDisconnected());

  }

  async connect(name: string, roomCode: string): Promise<{ identity: string }> {
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, room: roomCode }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Token request failed (${res.status})`);

    const room = this.room;
    await room.connect(body.url, body.token);
    room.remoteParticipants.forEach((p) => this.h.onPlayerJoined(p.identity, p.name || p.identity));
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      this.micAvailable = true;
    } catch (e) {
      console.warn('Microphone unavailable; joining listen-only', e);
    }
    return { identity: body.identity };
  }

  get connected() {
    return this.room.state === ConnectionState.Connected;
  }
  get identity() {
    return this.room.localParticipant.identity;
  }
  isSpeaking(identity: string) {
    return this.speaking.has(identity);
  }
  get micOn() {
    return this.room.localParticipant.isMicrophoneEnabled;
  }
  async setMic(on: boolean) {
    if (this.micAvailable) await this.room.localParticipant.setMicrophoneEnabled(on);
  }

  private send(data: Uint8Array<ArrayBuffer>, topic: string, reliable: boolean) {
    if (!this.connected) return;
    void this.room.localParticipant.publishData(data, { reliable, topic }).catch(() => {});
  }

  sendPosition(x: number, y: number, z: number, yaw: number, s: NetState) {
    const b = new ArrayBuffer(25);
    const v = new DataView(b);
    v.setUint32(0, this.seq++ >>> 0, true);
    v.setFloat32(4, x, true);
    v.setFloat32(8, y, true);
    v.setFloat32(12, z, true);
    v.setFloat32(16, yaw, true);
    v.setUint8(20, packFlags(s));
    v.setInt16(21, s.seat, true);
    v.setInt16(23, s.carSeat, true);
    this.send(new Uint8Array(b), TOPIC_POS, false);
  }

  sendCarPose(car: number, p: THREE.Vector3, q: THREE.Quaternion, st: CarState, parked: boolean) {
    const b = new ArrayBuffer(47);
    const v = new DataView(b);
    v.setUint8(0, car);
    v.setUint32(1, this.carSeq++ >>> 0, true);
    [p.x, p.y, p.z, q.x, q.y, q.z, q.w, st.steer, st.speed, st.rpm].forEach((n, i) => v.setFloat32(5 + i * 4, n, true));
    v.setInt8(45, st.gear);
    v.setUint8(46, (st.braking ? 1 : 0) | (st.low ? 2 : 0) | (parked ? 4 : 0) | (st.horn ? 8 : 0));
    // Parked heartbeats go reliable so late joiners surely get them; live driving is lossy.
    this.send(new Uint8Array(b), TOPIC_CAR, parked);
  }

  sendPA(pa: number, on: boolean) {
    this.send(new Uint8Array([pa, on ? 1 : 0]), TOPIC_PA, true);
  }

  sendCarSeat(car: number, seat: number, on: boolean) {
    this.send(new Uint8Array([car, seat, on ? 1 : 0]), TOPIC_CAR_SEAT, true);
  }

  disconnect() {
    void this.room.disconnect();
  }
}
