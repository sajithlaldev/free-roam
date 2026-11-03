import * as THREE from 'three';
import { Announcer } from './announce';
import { POS_HZ } from './config';
import { Net } from './net';
import { LocalPlayer, RemotePlayer } from './player';
import { UI, type PlayerRow } from './ui';
import { Voice, gainAt } from './voice';
import { World } from './world';

// ?solo skips networking entirely (walk around alone, milestone 1).
const SOLO = new URLSearchParams(location.search).has('solo');

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = new UI();
const world = await World.create(canvas);
ui.ready();

const remotes = new Map<string, RemotePlayer>();
let net: Net | null = null;
let voice: Voice | null = null;
let announcer: Announcer | null = null;
let player: LocalPlayer;
let myRole = 'player';

function addRemote(identity: string, name: string, role: string) {
  if (remotes.has(identity)) return;
  const r = new RemotePlayer(identity, name, role);
  remotes.set(identity, r);
  world.scene.add(r.avatar.group);
}

function removeRemote(identity: string) {
  remotes.get(identity)?.dispose();
  remotes.delete(identity);
  voice?.detach(identity);
  announcer?.onLeft(identity);
}

ui.onJoin(async (name, code) => {
  // Audio + mic need a user gesture; this submit handler is it.
  voice = new Voice();

  if (!SOLO) {
    net = new Net({
      onPlayerJoined: addRemote,
      onPlayerLeft: removeRemote,
      onPosition: (id, seq, x, y, z, yaw) => remotes.get(id)?.push(seq, x, y, z, yaw, performance.now()),
      onAudio: (id, track) => (track ? voice!.attach(id, track) : voice!.detach(id)),
      onPA: (id, role, on) => announcer?.onRemote(id, role, on, performance.now()),
      onDisconnected: () => ui.setStatus('Disconnected — reload to rejoin'),
    });
    try {
      const info = await net.connect(name, code);
      myRole = info.role;
    } catch (e) {
      voice.ctx.close();
      voice = null;
      net = null;
      throw e;
    }
    announcer = new Announcer(net, voice, world, myRole === 'announcer');
  }

  player = new LocalPlayer(world, canvas, name);
  ui.showHud();
  ui.setStatus(SOLO ? 'Solo mode (no voice)' : `Connected as ${name}${myRole === 'announcer' ? ' · announcer' : ''}`);
  ui.setMic(net?.micAvailable ? 'on' : 'unavailable');
  requestAnimationFrame(frame);
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__vw = { world, player, remotes, voice, net };
});

async function toggleMic() {
  if (!net?.micAvailable) return;
  const next = !net.micOn;
  if (!next) announcer?.stop();
  await net.setMic(next);
  ui.setMic(next ? 'on' : 'muted');
}
ui.onMicToggle(() => void toggleMic());
addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat && !(e.target instanceof HTMLInputElement)) void toggleMic();
});
// Browsers can suspend audio contexts (tab switches); wake on any interaction.
addEventListener('pointerdown', () => voice?.resume());
addEventListener('keydown', () => voice?.resume());

const head = new THREE.Vector3();
const fwd = new THREE.Vector3();
let last = performance.now();
let lastSend = 0;
let lastUi = 0;
let sentX = NaN;
let sentZ = NaN;
let sentYaw = NaN;

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  player.update(dt);

  for (const r of remotes.values()) {
    r.update(now, dt);
    r.head(head);
    voice?.setBodyPosition(r.identity, head.x, head.y, head.z);
  }

  if (voice) {
    player.head(head);
    world.camera.getWorldDirection(fwd);
    voice.updateListener(head, fwd);
  }

  const hint = announcer?.update(player.pos, player.isDown('KeyE'), now) ?? '';
  ui.setHint(hint);

  // Position sync: ~15 Hz when moving, 2 Hz keep-alive when still.
  if (net && now - lastSend >= 1000 / POS_HZ) {
    const p = player.pos;
    const moved = Math.abs(p.x - sentX) > 0.01 || Math.abs(p.z - sentZ) > 0.01 || Math.abs(player.yaw - sentYaw) > 0.01;
    if (moved || now - lastSend > 500) {
      net.sendPosition(p.x, p.y, p.z, player.yaw);
      sentX = p.x;
      sentZ = p.z;
      sentYaw = player.yaw;
      lastSend = now;
    }
  }

  if (now - lastUi > 250) {
    lastUi = now;
    const rows: PlayerRow[] = [];
    for (const r of remotes.values()) {
      const d = Math.hypot(r.pos.x - player.pos.x, r.pos.z - player.pos.z);
      rows.push({
        name: r.name,
        distance: d,
        speaking: net?.isSpeaking(r.identity) ?? false,
        audible: gainAt(d) > 0,
        announcer: r.role === 'announcer',
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    ui.setPlayers(rows);
    if (net?.micAvailable) ui.setMic(net.micOn ? 'on' : 'muted', net.isSpeaking(net.room.localParticipant.identity));
    ui.setLockHintVisible(!player.isLocked);
  }

  world.render();
}
