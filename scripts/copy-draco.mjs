// Copies three's Draco decoder into public/draco so DRACOLoader can load it
// from our own origin (no CDN dependency). Safe to run repeatedly.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
const src = 'node_modules/three/examples/jsm/libs/draco/gltf';
if (existsSync(src)) {
  mkdirSync('public/draco', { recursive: true });
  cpSync(src, 'public/draco', { recursive: true });
}
