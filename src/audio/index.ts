import * as THREE from 'three';
import { JETTY, ROAD_WIDTH, inRect } from '../world/layout';
import { roomAt } from '../world/registry';
import type { Terrain } from '../world/terrain';
import type { SoundSystem, Surface } from './sound';
import type { Avatar } from '../player';

/** The live sound system (set on join) and the terrain, for surface lookups. */
export const audio = { sys: null as SoundSystem | null, terrain: null as Terrain | null };

/** What's underfoot at a point: structures first, then roads, then the terrain's dominant surface. */
export function surfaceAt(x: number, y: number, z: number): Surface {
  const t = audio.terrain;
  if (!t) return 'grass';
  const g = t.heightAt(x, z);
  const depth = t.waterDepth(x, z);
  if (y > g + 0.12) {
    // Standing on something built.
    if (inRect(JETTY, x, z, 1) || (depth > 0.3 && y < 1.2)) return 'wood'; // jetty, houseboat deck
    if (roomAt(x, y + 0.5, z) >= 0) return 'tile';
    return 'concrete';
  }
  if (depth > 0.03) return 'water';
  if (t.roadDist(x, z) < ROAD_WIDTH / 2) return 'asphalt';
  const V = t.N + 1;
  const half = (t.N * t.cell) / 2;
  const ix = Math.min(V - 1, Math.max(0, Math.round((x + half) / t.cell)));
  const iz = Math.min(V - 1, Math.max(0, Math.round((z + half) / t.cell)));
  const i = iz * V + ix;
  const w = [t.splat[i * 4], t.splat[i * 4 + 1], t.splat[i * 4 + 2], t.splat[i * 4 + 3], t.mud[i]];
  if (w[4] > 0.3) return 'mud'; // squelchy wins wherever it's noticeably wet
  if (w[3] > 0.3) return 'gravel'; // rock / scree
  const k = w.indexOf(Math.max(...w));
  return (['grass', 'soil', 'sand', 'gravel', 'mud'] as Surface[])[k];
}

/** Play a footstep for a body whose feet are at `pos`. */
export function footstepAt(pos: THREE.Vector3, strength: number) {
  const s = audio.sys;
  if (!s) return;
  const surf = surfaceAt(pos.x, pos.y, pos.z);
  s.footstep(surf, pos, strength, roomAt(pos.x, pos.y + 0.5, pos.z) >= 0);
}

/** Footsteps, landings and swim strokes for an avatar. */
export function wireAvatarSounds(av: Avatar) {
  av.onStep = (_side, k) => footstepAt(av.group.position, k);
  av.onLand = (k) => {
    footstepAt(av.group.position, 1.1 + k);
    if (k > 0.5) audio.sys?.play('thud', av.group.position, 0.35 * k, 1.3, 2);
  };
  av.onStroke = () => audio.sys?.play('stroke', av.group.position, 0.45, 0.9 + Math.random() * 0.2, 2);
}
