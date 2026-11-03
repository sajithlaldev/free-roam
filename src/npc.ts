import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Avatar } from './player';
import { BUS_STOP, MAIDAN, TEMPLE, coastX, type V2 } from './world/layout';
import { registry } from './world/registry';
import { polyAt } from './world/terrain';
import type { World } from './world/index';

/**
 * Pedestrians: devotees circling the sreekovil clockwise (pradakshinam), people strolling the
 * maidan, the roadside, the jetty and the beach, and others sitting in the meeting hall, at
 * the tea shop and the bus stop. Walkers' positions come from the shared clock, so every
 * player sees the same people in the same places.
 */
interface Walker {
  avatar: Avatar;
  path: V2[];
  closed: boolean;
  length: number;
  speed: number;
  phase: number;
  body: RAPIER.RigidBody;
  prevYaw: number;
}

interface Sitter {
  avatar: Avatar;
}

const NAMES = ['Ammini', 'Kuttan', 'Lakshmi', 'Joseph', 'Fathima', 'Raghavan', 'Mariamma', 'Sreedevi', 'Unni', 'Ayesha', 'Babu', 'Thankamma', 'Vasu', 'Leela'];

function pathLength(p: V2[], closed: boolean) {
  let L = 0;
  const n = closed ? p.length : p.length - 1;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

export class Pedestrians {
  private walkers: Walker[] = [];
  private sitters: Sitter[] = [];

  constructor(private world: World) {
    const T = TEMPLE;
    const sx = T.x - 7;
    const circle = (cx: number, cz: number, r: number, cw: boolean): V2[] =>
      Array.from({ length: 24 }, (_, i) => {
        const a = ((cw ? -1 : 1) * i * Math.PI * 2) / 24;
        return [cx + Math.cos(a) * r, cz + Math.sin(a) * r] as V2;
      });
    const m = MAIDAN;
    const maidanLoop: V2[] = [[m.x0 + 3, m.z0 + 3], [m.x1 - 3, m.z0 + 3], [m.x1 - 3, m.z1 - 3], [m.x0 + 3, m.z1 - 3]];
    const roadside = (ri: number, s0: number, s1: number, off: number): V2[] => {
      const r = world.terrain.roads[ri];
      const pts: V2[] = [];
      for (let s = s0; s <= s1; s += 6) {
        const p = polyAt(r.pts, s);
        pts.push([p.x + p.tz * off, p.z - p.tx * off]);
      }
      return pts;
    };
    const beach: V2[] = Array.from({ length: 12 }, (_, i) => {
      const z = -60 + i * 10;
      return [coastX(z) + 9, z] as V2;
    });
    const routes: [V2[], boolean, number][] = [
      [circle(sx, T.z, 9, true), true, 0.9], // pradakshinam (clockwise)
      [circle(sx, T.z, 9, true), true, 0.85],
      [circle(sx, T.z, 10.2, true), true, 0.95],
      [maidanLoop, true, 1.2],
      [maidanLoop, true, 1.05],
      [roadside(0, 90, 190, 5.3), false, 1.3],
      [roadside(0, 120, 220, -5.3), false, 1.15],
      [roadside(2, 10, 110, 5.2), false, 1.25],
      [[[8, 117], [8, 135]], false, 0.9],
      [beach, false, 1.0],
    ];
    routes.forEach(([path, closed, speed], i) => {
      const avatar = new Avatar(NAMES[i % NAMES.length], `npc-${i}-${NAMES[i]}`);
      avatar.setLabelVisible(false);
      world.scene.add(avatar.group);
      const body = world.physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -60, 0));
      world.physics.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.3), body);
      this.walkers.push({ avatar, path, closed, length: pathLength(path, closed), speed, phase: i * 37.3, body, prevYaw: 0 });
    });

    // Sitters: a few in the meeting hall, at the tea shop benches and the bus stop.
    const pick = (pred: (s: (typeof registry.seats)[number]) => boolean, n: number) =>
      registry.seats.filter((s) => pred(s) && !registry.reservedSeats.has(s.id)).slice(0, n);
    const seats = [
      ...pick((s) => s.x > 50 && s.x < 66 && s.z > -42 && s.z < -28, 3).filter((_, i) => i !== 1),
      ...pick((s) => s.x > 18 && s.x < 32 && s.z > 14 && s.z < 22, 2),
      ...pick((s) => Math.hypot(s.x - BUS_STOP.x, s.z - BUS_STOP.z) < 4, 1),
    ];
    seats.forEach((st, i) => {
      const avatar = new Avatar(NAMES[(i + 7) % NAMES.length], `npc-sit-${i}`);
      avatar.setLabelVisible(false);
      avatar.group.position.set(st.x, st.y, st.z);
      avatar.group.rotation.y = st.yaw;
      world.scene.add(avatar.group);
      registry.reservedSeats.add(st.id);
      this.sitters.push({ avatar });
    });
  }

  private at(w: Walker, d: number) {
    const p = w.path;
    // Closed loops wrap; open paths walk there and back.
    let s = ((d % (w.closed ? w.length : 2 * w.length)) + 2 * w.length) % (w.closed ? w.length : 2 * w.length);
    let back = false;
    if (!w.closed && s > w.length) {
      s = 2 * w.length - s;
      back = true;
    }
    const n = w.closed ? p.length : p.length - 1;
    for (let i = 0; i < n; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (s <= L || i === n - 1) {
        const k = Math.min(1, s / L);
        const dx = (b[0] - a[0]) / L;
        const dz = (b[1] - a[1]) / L;
        return { x: a[0] + (b[0] - a[0]) * k, z: a[1] + (b[1] - a[1]) * k, yaw: Math.atan2(back ? -dx : dx, back ? -dz : dz) };
      }
      s -= L;
    }
    return { x: p[0][0], z: p[0][1], yaw: 0 };
  }

  update(dt: number, camera: THREE.Vector3) {
    const t = Date.now() / 1000;
    for (const w of this.walkers) {
      const p = this.at(w, t * w.speed + w.phase);
      const near = Math.hypot(p.x - camera.x, p.z - camera.z) < 70;
      w.avatar.group.visible = near;
      const y = this.world.terrain.heightAt(p.x, p.z);
      w.body.setNextKinematicTranslation({ x: p.x, y: y + 0.82, z: p.z });
      if (!near) continue;
      // Turn smoothly at corners.
      let dy = p.yaw - w.prevYaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const step = THREE.MathUtils.clamp(dy, -4 * dt, 4 * dt);
      w.prevYaw += step;
      w.avatar.group.position.set(p.x, y, p.z);
      w.avatar.group.rotation.y = w.prevYaw;
      w.avatar.animate(dt, { speed: w.speed, vy: 0, grounded: true, stance: 0, sit: 0, swim: false, sprint: false, yawRate: step / Math.max(dt, 1e-3), ground: this.world.terrain.heightAt });
    }
    for (const s of this.sitters) {
      const near = s.avatar.group.position.distanceTo(camera) < 60;
      s.avatar.group.visible = near;
      if (near) s.avatar.animate(dt, { speed: 0, vy: 0, grounded: true, stance: 0, sit: 1, swim: false, sprint: false, yawRate: 0 });
    }
  }
}
