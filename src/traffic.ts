import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FORTUNER, JIMNY, buildFortuner, buildJimny, restWheelY, type VehicleSpec, type Visual } from './car';
import type { SoundSystem, VehicleAudio } from './audio/sound';
import { ROAD_WIDTH } from './world/layout';
import { polyAt, type RoadProfile } from './world/terrain';
import type { World } from './world/index';

/**
 * Ambient traffic. Each vehicle loops along a road: up the left lane (India drives on the
 * left), a U-turn at the end, back down the other side. Where a car is comes from the shared
 * wall clock, so every player sees the same traffic; locally, a car brakes and waits if you
 * (or the car you're driving) are in its way, so it never drives through you.
 */
interface Vehicle {
  spec: VehicleSpec;
  visual: Visual;
  body: RAPIER.RigidBody;
  road: RoadProfile;
  speed: number;
  phase: number; // seconds of offset
  delay: number; // locally accumulated waiting time
  cur: number; // current speed (m/s) after braking
  spin: number;
  yaw: number;
  sound?: VehicleAudio;
  blockedFor: number;
}

const LANE = ROAD_WIDTH / 4; // centre of a lane
const END = 7; // metres from each road end where the U-turn happens

export class Traffic {
  private vehicles: Vehicle[] = [];
  private tmpQ = new THREE.Quaternion();

  constructor(world: World) {
    const roads = world.terrain.roads;
    const plan: [number, VehicleSpec, number, number, number][] = [
      // road, model, colour, speed m/s, phase s
      [0, JIMNY, 0xb3121a, 11, 0],
      [0, FORTUNER, 0x9fa3a8, 12.5, 41],
      [0, JIMNY, 0x1f3a64, 10, 83],
      [1, FORTUNER, 0x2a2b2e, 13, 10],
      [1, JIMNY, 0xe8c21b, 11, 64],
      [2, JIMNY, 0xf2f2ee, 8.5, 5],
      [3, FORTUNER, 0x6d4c2e, 8, 20],
    ];
    plan.forEach(([ri, spec, color, speed, phase], i) => {
      const visual = spec.model === 'fortuner' ? buildFortuner(color, `KL-${10 + i} T ${4321 + i * 777}`) : buildJimny(color, `KL-${10 + i} T ${4321 + i * 777}`);
      world.scene.add(visual.root);
      const body = world.physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0));
      for (const [hx, hy, hz, cx, cy, cz] of spec.colliders) world.physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz), body);
      this.vehicles.push({ spec, visual, body, road: roads[ri], speed, phase, delay: 0, cur: speed, spin: 0, yaw: 0, blockedFor: 0 });
    });
  }

  lod(camera: THREE.Vector3) {
    for (const v of this.vehicles) v.visual.lod(camera);
  }

  /** Pose along the loop at distance d: lane position, heading, height. */
  private poseAt(r: RoadProfile, d: number) {
    const L = Math.max(20, r.length - 2 * END);
    const arc = Math.PI * LANE;
    const loop = 2 * L + 2 * arc;
    d = ((d % loop) + loop) % loop;
    let s: number;
    let dir: number; // +1 = along the polyline, −1 = back
    let turn = -1; // 0..1 during a U-turn
    if (d < L) {
      s = END + d;
      dir = 1;
    } else if (d < L + arc) {
      s = END + L;
      dir = 1;
      turn = (d - L) / arc;
    } else if (d < 2 * L + arc) {
      s = END + L - (d - L - arc);
      dir = -1;
    } else {
      s = END;
      dir = -1;
      turn = (d - 2 * L - arc) / arc;
    }
    const p = polyAt(r.pts, s);
    const y = r.h[Math.min(r.h.length - 1, Math.max(0, Math.round(s / 2)))];
    const ex = p.tx * dir; // heading
    const ez = p.tz * dir;
    const lx = ez; // left of the heading (India drives on the left)
    const lz = -ex;
    if (turn >= 0) {
      // U-turn to the right, across the road, from the left lane to the opposite one.
      const a = turn * Math.PI;
      const x = p.x + lx * LANE * Math.cos(a) + ex * LANE * Math.sin(a);
      const z = p.z + lz * LANE * Math.cos(a) + ez * LANE * Math.sin(a);
      const hx = -lx * Math.sin(a) + ex * Math.cos(a);
      const hz = -lz * Math.sin(a) + ez * Math.cos(a);
      return { x, y, z, yaw: Math.atan2(hx, hz) };
    }
    return { x: p.x + lx * LANE, y, z: p.z + lz * LANE, yaw: Math.atan2(ex, ez) };
  }

  update(dt: number, obstacles: THREE.Vector3[], sys: SoundSystem | null) {
    const t = Date.now() / 1000;
    for (const v of this.vehicles) {
      // Look ahead for something in the lane.
      const here = this.poseAt(v.road, (t - v.delay) * v.speed + v.phase * v.speed);
      const hx = Math.sin(here.yaw);
      const hz = Math.cos(here.yaw);
      let blocked = false;
      for (const o of obstacles) {
        const dx = o.x - here.x;
        const dz = o.z - here.z;
        const ahead = dx * hx + dz * hz;
        const lateral = Math.abs(-dx * hz + dz * hx);
        if (ahead > 0 && ahead < 10 + v.cur * 0.8 && lateral < 2.2) blocked = true;
      }
      const target = blocked ? 0 : v.speed;
      v.cur += THREE.MathUtils.clamp(target - v.cur, -7 * dt, 2.5 * dt);
      v.delay += dt * (1 - v.cur / v.speed); // waiting falls behind the shared schedule
      const p = this.poseAt(v.road, (t - v.delay) * v.speed + v.phase * v.speed);
      const yawRate = Math.atan2(Math.sin(p.yaw - v.yaw), Math.cos(p.yaw - v.yaw)) / Math.max(dt, 1e-3);
      v.yaw = p.yaw;
      const y = p.y + v.spec.wheelRadius - restWheelY(v.spec) - 0.01;
      this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
      v.body.setNextKinematicTranslation({ x: p.x, y, z: p.z });
      v.body.setNextKinematicRotation(this.tmpQ);
      const root = v.visual.root;
      root.position.set(p.x, y, p.z);
      root.quaternion.copy(this.tmpQ);
      v.spin += (v.cur / v.spec.wheelRadius) * dt;
      const steer = THREE.MathUtils.clamp((yawRate * v.spec.wheelbase) / Math.max(1, v.cur), -0.5, 0.5);
      v.visual.wheels.forEach((w, i) => {
        w.steer.position.y = restWheelY(v.spec);
        w.steer.rotation.y = i < 2 ? steer : 0;
        w.spin.rotation.x = v.spin;
      });
      v.visual.updateRunningGear();
      v.visual.steeringWheel.rotation.z = -steer * 9;
      v.visual.brakeMat.emissiveIntensity = blocked ? 2.2 : 0.15;
      v.blockedFor = blocked ? v.blockedFor + dt : 0;
      if (sys) {
        v.sound ??= sys.vehicle(v.spec.diesel, v.spec.model === 'fortuner' ? [340, 428] : [415, 520]);
        // Rough gear model: rpm climbs with speed, drops at each "shift".
        const kmh = v.cur * 3.6;
        const gearBand = v.spec.diesel ? 22 : 18;
        const rpm = v.spec.idleRpm + ((kmh % gearBand) / gearBand) * (v.spec.diesel ? 1300 : 2200) + Math.min(1, kmh / 10) * 600;
        const accel = Math.abs(target - v.cur) > 0.5 && target > v.cur;
        const honk = v.blockedFor > 1.2 && v.blockedFor % 3 < 0.45; // Kerala etiquette
        v.sound.update(dt, { pos: root.position, running: true, rpm, load: accel ? 0.7 : blocked ? 0.05 : 0.3, speed: v.cur, slip: 0, surface: 'asphalt', depth: 0, horn: honk });
      }
    }
  }

  positions(): THREE.Vector3[] {
    return this.vehicles.map((v) => v.visual.root.position);
  }
}

