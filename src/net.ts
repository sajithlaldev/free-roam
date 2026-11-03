import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
} from 'livekit-client';
import { TOPIC_PA, TOPIC_POS } from './config';

export interface NetHandlers {
  onPlayerJoined(identity: string, name: string): void;
  onPlayerLeft(identity: string): void;
  onPosition(identity: string, seq: number, x: number, y: number, z: number, yaw: number): void;
  onAudio(identity: string, track: MediaStreamTrack | null): void;
  onPA(identity: string, on: boolean): void;
  onDisconnected(): void;
}

export interface JoinInfo {
  identity: string;
}

export class Net {
  readonly room = new Room({
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    dynacast: false,
    adaptiveStream: false,
  });
  micAvailable = false;
  private seq = 0;
  private posBuf = new ArrayBuffer(20);
  private posView = new DataView(this.posBuf);
  private speaking = new Set<string>();

  constructor(private h: NetHandlers) {}

  async connect(name: string): Promise<JoinInfo> {
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Token request failed (${res.status})`);

    const room = this.room;
    const announce = (p: RemoteParticipant) =>
      this.h.onPlayerJoined(p.identity, p.name || p.identity);

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
        if (!p) return; // server-originated
        const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        if (topic === TOPIC_POS && payload.byteLength >= 20) {
          this.h.onPosition(p.identity, v.getUint32(0, true), v.getFloat32(4, true), v.getFloat32(8, true), v.getFloat32(12, true), v.getFloat32(16, true));
        } else if (topic === TOPIC_PA && payload.byteLength >= 1) {
          this.h.onPA(p.identity, v.getUint8(0) === 1);
        }
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        this.speaking = new Set(speakers.map((s) => s.identity));
      })
      .on(RoomEvent.Disconnected, () => this.h.onDisconnected());

    await room.connect(body.url, body.token);
    room.remoteParticipants.forEach(announce); // anyone already here

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      this.micAvailable = true;
    } catch (e) {
      console.warn('Microphone unavailable; joining listen-only', e);
    }
    return { identity: body.identity };
  }

  get connected(): boolean {
    return this.room.state === ConnectionState.Connected;
  }

  isSpeaking(identity: string): boolean {
    return this.speaking.has(identity);
  }

  get micOn(): boolean {
    return this.room.localParticipant.isMicrophoneEnabled;
  }

  async setMic(on: boolean) {
    if (!this.micAvailable) return;
    await this.room.localParticipant.setMicrophoneEnabled(on);
  }

  /** Lossy + unordered: a dropped position packet is simply superseded by the next one. */
  sendPosition(x: number, y: number, z: number, yaw: number) {
    if (!this.connected) return;
    const v = this.posView;
    v.setUint32(0, this.seq++ >>> 0, true);
    v.setFloat32(4, x, true);
    v.setFloat32(8, y, true);
    v.setFloat32(12, z, true);
    v.setFloat32(16, yaw, true);
    void this.room.localParticipant
      .publishData(new Uint8Array(this.posBuf.slice(0)), { reliable: false, topic: TOPIC_POS })
      .catch(() => {});
  }

  sendPA(on: boolean) {
    if (!this.connected) return;
    void this.room.localParticipant
      .publishData(new Uint8Array([on ? 1 : 0]), { reliable: true, topic: TOPIC_PA })
      .catch(() => {});
  }

  disconnect() {
    void this.room.disconnect();
  }
}
