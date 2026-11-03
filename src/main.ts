import * as THREE from 'three';
import { Announcer } from './announce';
import { Car, FORTUNER, JIMNY, type CarInput } from './car';
import { AVATAR, CAR_HZ, CAR_PARKED_HEARTBEAT_MS, POS_HZ } from './config';
import { Net } from './net';
import { Pedestrians } from './npc';
import { LOBBY, newRoomCode, roomFromUrl, setUrlRoom, shareInvite } from './rooms';
import { isTouch } from './device';
import { TouchControls } from './touch';
import { Traffic } from './traffic';
import { CAM_LABEL, LocalPlayer, RemotePlayer } from './player';
import { UI, type PlayerRow } from './ui';
import { Voice, gainAt } from './voice';
import { Ambience } from './audio/ambience';
import { audio, surfaceAt } from './audio/index';
import { SoundSystem, type VehicleAudio } from './audio/sound';
import { World } from './world/index';
import { CAR_SPAWNS, WATER_Y, WORLD_HALF } from './world/layout';
import { registry, roomAt } from './world/registry';

// ?solo skips networking (walk and drive alone).
/**
 * Single player: offline, with pedestrians and AI traffic. Multiplayer: a room with other
 * people (public lobby or an invite link) — no NPCs. A room link opens straight into
 * multiplayer; otherwise the last choice is remembered (first run: single player).
 */
type GameMode = 'single' | 'multi';
const params = new URLSearchParams(location.search);
let mode: GameMode = params.has('solo') ? 'single' : params.has('room') ? 'multi' : (() => {
  try {
    return (localStorage.getItem('vw-mode') as GameMode) || 'single';
  } catch {
    return 'single';
  }
})();
let SOLO = mode === 'single';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = new UI();
let room = roomFromUrl();
ui.bindMode({ get: () => mode, set: (m) => (mode = m) });
ui.bindRooms({
  get: () => room,
  create: () => setUrlRoom((room = newRoomCode())),
  lobby: () => setUrlRoom((room = LOBBY)),
  share: () => shareInvite(room),
});
ui.setCredit(AVATAR.credit);
const world = await World.create(canvas);
ui.setMapBackground(world.minimap(180));

const cars = CAR_SPAWNS.map((s, i) => {
  const spec = s.model === 'fortuner' ? FORTUNER : JIMNY;
  const y = world.terrain.heightAt(s.x, s.z) + spec.wheelRadius + 0.03;
  return new Car(i, world.physics, world.scene, s.x, y, s.z, s.yaw, s.color, spec);
});
let traffic: Traffic | null = null;
let pedestrians: Pedestrians | null = null;
ui.ready();

const remotes = new Map<string, RemotePlayer>();
let net: Net | null = null;
let voice: Voice | null = null;
let announcer: Announcer | null = null;
let player: LocalPlayer;
let me = 'me';
const vehAudio = new Map<number, VehicleAudio>();
let ambience: Ambience | null = null;
let touch: TouchControls | null = null;
const TOUCH = isTouch();
if (TOUCH) document.body.classList.add('touch');
audio.terrain = world.terrain;
const hornFor = (c: Car): [number, number] => (c.spec.model === 'fortuner' ? [340, 428] : [415, 520]);

function addRemote(identity: string, name: string) {
  if (remotes.has(identity)) return;
  const r = new RemotePlayer(identity, name, world);
  remotes.set(identity, r);
  world.scene.add(r.avatar.group);
}

function removeRemote(identity: string) {
  remotes.get(identity)?.dispose();
  remotes.delete(identity);
  voice?.detach(identity);
  announcer?.onLeft(identity);
  for (const c of cars) c.seats.forEach((s, i) => s === identity && (c.seats[i] = null));
}

/** Seat claims: whoever has the lower identity wins a simultaneous grab. */
function claimSeat(car: Car, seat: number, who: string) {
  const cur = car.seats[seat];
  if (cur && cur !== who && cur < who) return false;
  if (cur === me && who !== me && player.car?.car === car && player.car.seat === seat) leaveCar(false);
  car.seats[seat] = who;
  if (seat === 0) {
    car.lastDriver = who;
    if (who !== me && car.simulating) {
      car.simulating = false;
      car.resetRemoteSeq();
    }
  }
  return true;
}

function enterCar(car: Car, seat: number) {
  if (!claimSeat(car, seat, me)) return;
  net?.sendCarSeat(car.id, seat, true);
  player.enterCar(car, seat);
  vehAudio.get(car.id)?.door();
  if (seat === 0) car.takeControl();
}

function leaveCar(announce = true) {
  const c = player.car;
  if (!c) return;
  player.exitCar();
  vehAudio.get(c.car.id)?.door();
  if (c.car.seats[c.seat] === me) c.car.seats[c.seat] = null;
  if (c.seat === 0) c.car.release();
  if (announce) net?.sendCarSeat(c.car.id, c.seat, false);
}

ui.onJoin(async (name) => {
  voice = new Voice(); // inside the click: unlocks audio
  audio.sys = new SoundSystem(voice.ctx, voice.master);
  ambience = new Ambience(audio.sys, world.terrain);
  SOLO = mode === 'single';
  try {
    localStorage.setItem('vw-mode', mode);
  } catch {
    /* no storage */
  }
  if (SOLO) {
    // NPCs only in single player.
    traffic = new Traffic(world);
    pedestrians = new Pedestrians(world);
  } else {
    net = new Net({
      onPlayerJoined: addRemote,
      onPlayerLeft: removeRemote,
      onPosition: (id, seq, x, y, z, yaw, st) => {
        remotes.get(id)?.push(seq, x, y, z, yaw, st, performance.now());
        if (st.carSeat >= 0) {
          const c = cars[st.carSeat >> 2];
          if (c && !c.seats[st.carSeat & 3]) claimSeat(c, st.carSeat & 3, id);
        }
      },
      onAudio: (id, track) => (track ? voice!.attach(id, track) : voice!.detach(id)),
      onPA: (id, pa, on) => announcer?.onRemote(id, pa, on, performance.now()),
      onCarPose: (id, ci, seq, p, q, st, parked) => {
        const c = cars[ci];
        if (!c || c.seats[0] === me) return;
        if (c.simulating) {
          c.simulating = false; // someone else has it now
          c.resetRemoteSeq();
        }
        c.lastDriver = id;
        if (!parked && !c.seats[0]) c.seats[0] = id;
        if (parked && c.seats[0] === id) c.seats[0] = null;
        c.pushRemote(seq, p, q, st, performance.now());
      },
      onCarSeat: (id, ci, seat, on) => {
        const c = cars[ci];
        if (!c || seat > 3) return;
        if (on) claimSeat(c, seat, id);
        else if (c.seats[seat] === id) c.seats[seat] = null;
        vehAudio.get(c.id)?.door();
      },
      onDisconnected: () => ui.setStatus('Disconnected — reload to rejoin'),
    });
    try {
      me = (await net.connect(name, room)).identity;
    } catch (e) {
      void voice.ctx.close();
      voice = null;
      net = null;
      throw e;
    }
    announcer = new Announcer(net, voice, world);
  }
  player = new LocalPlayer(world, canvas, name);
  player.onCamMode = (m) => ui.toast(`Camera: ${CAM_LABEL[m]}`);
  if (TOUCH) {
    touch = new TouchControls(player);
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }
  ui.showHud();
  ui.setStatus(SOLO ? `${name} · Single player` : `${name} · ${room === LOBBY ? 'Public lobby' : `Room ${room}`}`);
  ui.setInviteVisible(!SOLO);
  ui.setMic(net?.micAvailable ? 'on' : 'unavailable');
  requestAnimationFrame(frame);
  if (import.meta.env.DEV) Object.assign(window, { __vw: { world, player, remotes, voice, net, cars, registry } });
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
  if (e.repeat || e.target instanceof HTMLInputElement) return;
  if (e.code === 'KeyM') void toggleMic();
  if (e.code === 'KeyG') world.cycleQuality();
});
world.onQuality = (q) => ui.toast(`Graphics: ${q[0].toUpperCase()}${q.slice(1)}`);
addEventListener('pointerdown', () => voice?.resume());
addEventListener('keydown', () => voice?.resume());

// ── interactions (E) ─────────────────────────────────────────────────────────

function occupiedSeats(): Set<number> {
  const s = new Set<number>();
  for (const r of remotes.values()) if (r.state.seat >= 0) s.add(r.state.seat);
  return s;
}

/** Best car seat for where the player stands (driver door → driver seat, etc.). */
function carNearby(): { car: Car; seat: number } | null {
  let best: { car: Car; seat: number; d: number } | null = null;
  for (const c of cars) {
    const d = c.position().distanceTo(player.pos);
    if (d > c.spec.exitX + 2.2 || (best && d > best.d)) continue;
    const local = player.pos.clone().sub(c.position()).applyQuaternion(c.quaternion().invert());
    const front = local.z > -0.5;
    const right = local.x < 0;
    const pref = front ? (right ? [0, 1, 2, 3] : [1, 0, 3, 2]) : right ? [2, 3, 0, 1] : [3, 2, 1, 0];
    const seat = pref.find((s) => !c.seats[s]);
    if (seat !== undefined) best = { car: c, seat, d };
  }
  return best && { car: best.car, seat: best.seat };
}

function chairNearby(): number {
  const taken = occupiedSeats();
  registry.reservedSeats.forEach((id) => taken.add(id));
  let best = -1;
  let bd = 1.1;
  for (const s of registry.seats) {
    const d = Math.hypot(s.x - player.pos.x, s.z - player.pos.z);
    if (d < bd && Math.abs(s.y - 0.45 - player.pos.y) < 0.8 && !taken.has(s.id)) [best, bd] = [s.id, d];
  }
  return best;
}

// ── main loop ────────────────────────────────────────────────────────────────

const STEP = 1 / 60;
const head = new THREE.Vector3();
const fwd = new THREE.Vector3();
let acc = 0;
let last = performance.now();
let lastPos = 0;
let lastCar = 0;
let lastParked = 0;
let lastUi = 0;

function carInput(): CarInput {
  const k = (c: string) => player.isDown(c);
  const a = player.analog;
  if (Math.hypot(a.x, a.y) > 0.1) return { throttle: Math.max(0, a.y), brake: Math.max(0, -a.y), steer: -a.x, handbrake: k('Space') };
  return {
    throttle: k('KeyW') || k('ArrowUp') ? 1 : 0,
    brake: k('KeyS') || k('ArrowDown') ? 1 : 0,
    steer: (k('KeyA') || k('ArrowLeft') ? 1 : 0) - (k('KeyD') || k('ArrowRight') ? 1 : 0),
    handbrake: k('Space'),
  };
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  // ── interactions ──
  let hint = '';
  let live = false;
  const pressE = player.tapped('KeyE');
  let driving = player.car?.seat === 0 ? player.car.car : null;
  if (player.car) {
    hint = driving ? 'E get out · L 4H/4L · R reset if stuck · Space handbrake' : 'E get out';
    if (pressE) leaveCar();
    if (driving && player.tapped('KeyL') && Math.abs(driving.state.speed) < 3) driving.state.low = !driving.state.low;
    if (driving && player.tapped('KeyR')) {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(driving.quaternion());
      if (up.y < 0.6 || Math.abs(driving.state.speed) < 1) driving.resetUpright();
    }
  } else if (player.seat >= 0) {
    hint = 'E stand up';
    if (pressE) player.standUp();
  } else {
    const pa = announcer?.update(player.pos, player.isDown('KeyE'), true, now);
    if (pa?.pa) {
      hint = pa.hint === 'live' ? `🔴 LIVE on the ${pa.pa.name}` : pa.hint === 'busy' ? 'Someone else is on this mic' : pa.hint === 'unmute' ? 'Unmute (M) to use the mic' : `Hold E to talk on the ${pa.pa.name}`;
      live = pa.hint === 'live';
    } else {
      const c = carNearby();
      const chair = c ? -1 : chairNearby();
      if (c) {
        hint = c.seat === 0 ? `E drive the ${c.car.spec.name}` : `E ride in the ${c.car.spec.name}`;
        if (pressE) enterCar(c.car, c.seat);
      } else if (chair >= 0) {
        hint = 'E sit down';
        if (pressE) player.sitOn(chair);
      }
    }
  }
  if (player.car || player.seat >= 0) announcer?.update(player.pos, false, false, now);
  ui.setHint(hint, live);
  touch?.setMode(player.car ? (player.car.seat === 0 ? 'drive' : 'ride') : player.seat >= 0 ? 'seated' : 'foot', hint);
  driving = player.car?.seat === 0 ? player.car.car : null; // (may have changed above)

  // ── fixed-step physics ──
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 5) {
    for (const c of cars) if (c.simulating) c.fixedUpdate(STEP, c === driving ? carInput() : null);
    player.fixedUpdate(STEP);
    world.physics.step();
    acc -= STEP;
    steps++;
  }
  if (steps === 5) acc = 0;

  // ── per-frame updates ──
  player.update(dt);
  const obstacles = [player.avatar.group.position, ...cars.map((c) => c.visual.root.position), ...[...remotes.values()].map((r) => r.avatar.group.position)];
  traffic?.update(dt, obstacles, audio.sys);
  if (driving) driving.state.horn = player.isDown('KeyH');
  pedestrians?.update(dt, world.camera.position);
  for (const c of cars) c.update(now, dt);
  for (const r of remotes.values()) {
    r.update(now, dt, cars);
    r.head(head);
    voice?.setBodyPosition(r.identity, head.x, head.y, head.z, roomAt(head.x, head.y, head.z));
  }
  player.head(head);
  const myRoom = roomAt(head.x, head.y, head.z);
  world.setIndoor(myRoom >= 0);
  if (voice) {
    world.camera.getWorldDirection(fwd);
    voice.setListener(head, fwd, myRoom);
    ambience?.update(dt, head);
    for (const c of cars) {
      const sys = audio.sys;
      if (!sys) break;
      let va = vehAudio.get(c.id);
      if (!va) vehAudio.set(c.id, (va = sys.vehicle(c.spec.diesel, hornFor(c))));
      const running = !!c.seats[0] || (c.simulating && !!driving);
      const p = c.position();
      const wheelBottom = p.y - c.spec.wheelRadius - 0.04;
      const load = c.simulating ? c.state.throttle : running && Math.abs(c.state.speed) > 1 ? 0.35 : 0.05;
      va.update(dt, {
        pos: p,
        running,
        rpm: c.state.rpm,
        load,
        speed: c.state.speed,
        slip: c.slip,
        surface: surfaceAt(p.x, wheelBottom, p.z),
        depth: Math.max(0, WATER_Y - wheelBottom),
        horn: !!c.state.horn && running,
      });
      if (c.bumpHit > 0.45) va.bump(c.bumpHit);
      c.bumpHit = 0;
    }
  }

  // ── network ──
  if (net) {
    if (now - lastPos >= 1000 / POS_HZ) {
      lastPos = now;
      const g = player.avatar.group.position;
      net.sendPosition(g.x, g.y, g.z, player.yaw, player.netState());
    }
    if (driving && now - lastCar >= 1000 / CAR_HZ) {
      lastCar = now;
      net.sendCarPose(driving.id, driving.position(), driving.quaternion(), driving.state, false);
    }
    // Cars I parked: keep telling late joiners where they are.
    if (now - lastParked >= CAR_PARKED_HEARTBEAT_MS) {
      lastParked = now;
      for (const c of cars) if (c.lastDriver === me && !c.seats[0]) net.sendCarPose(c.id, c.position(), c.quaternion(), c.state, true);
    }
  }

  // ── HUD (4 Hz) ──
  if (now - lastUi > 250) {
    lastUi = now;
    const rows: PlayerRow[] = [];
    for (const r of remotes.values()) {
      const d = r.avatar.group.position.distanceTo(player.avatar.group.position);
      r.avatar.setShadow(d < 25);
      const pa = announcer?.liveOn(r.identity);
      rows.push({
        name: r.name,
        distance: d,
        speaking: net?.isSpeaking(r.identity) ?? false,
        audible: gainAt(d) > 0 || pa !== null,
        where: pa !== null && pa !== undefined ? '📣' : r.state.carSeat >= 0 ? '🚙' : r.state.seat >= 0 ? '🪑' : r.state.swim ? '🏊' : '',
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    ui.setPlayers(rows);
    if (net?.micAvailable) ui.setMic(net.micOn ? 'on' : 'muted', net.isSpeaking(net.identity));
    ui.setHelpVisible(!player.isLocked);
    ui.setDash(driving ? { ...driving.hud(), esp: driving.esp } : null);
    const g = player.avatar.group.position;
    ui.drawMap(WORLD_HALF, { x: g.x, z: g.z, yaw: player.car ? Math.atan2(...(() => { const f = new THREE.Vector3(0, 0, 1).applyQuaternion(player.car!.car.quaternion()); return [f.x, f.z] as [number, number]; })()) : player.yaw }, [
      ...[...remotes.values()].map((r) => ({ x: r.avatar.group.position.x, z: r.avatar.group.position.z })),
      ...cars.map((c) => ({ x: c.position().x, z: c.position().z, car: true })),
      ...(traffic?.positions() ?? []).map((p) => ({ x: p.x, z: p.z, car: true })),
    ]);
  }

  world.update(dt, player.avatar.group.position);
  world.render();
}
