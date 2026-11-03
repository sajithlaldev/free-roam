import * as THREE from 'three';
import { Simplex2, mulberry32 } from './noise';

// All textures are painted procedurally onto canvases at startup: no image downloads.

const noise = new Simplex2(7);

function canvasTex(
  w: number,
  h: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
  opts: { srgb?: boolean; repeat?: [number, number] } = {},
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) t.repeat.set(...opts.repeat);
  t.anisotropy = 8;
  return t;
}

/** Per-pixel noise fill (value in 0..1 from fbm), tile-able enough at these scales. */
function noiseFill(g: CanvasRenderingContext2D, w: number, h: number, f: (n: number, x: number, y: number) => [number, number, number], scale = 16) {
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Tileable: blend 4 offset samples.
      const u = x / w;
      const v = y / h;
      const s = (a: number, b: number) => noise.fbm(a * scale, b * scale, 3);
      const n =
        s(u, v) * (1 - u) * (1 - v) + s(u - 1, v) * u * (1 - v) + s(u, v - 1) * (1 - u) * v + s(u - 1, v - 1) * u * v;
      const [r, gg, b] = f(0.5 + 0.5 * n, x, y);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

let cache: ReturnType<typeof build> | null = null;
export const textures = () => (cache ??= build());

function build() {
  const rnd = mulberry32(99);

  const detail = canvasTex(256, 256, (g, w, h) => noiseFill(g, w, h, (n) => {
    const v = 190 + n * 65;
    return [v, v, v];
  }, 24), { repeat: [1, 1] });

  // Mangalore-pattern terracotta roof tiles. u across, v down the slope.
  const roofTiles = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#9c3f22';
    g.fillRect(0, 0, w, h);
    const rows = 8;
    const cols = 6;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * (w / cols);
        const y = r * (h / rows);
        const tone = 140 + rnd() * 50;
        const grad = g.createLinearGradient(x, y, x, y + h / rows);
        grad.addColorStop(0, `rgb(${tone + 20},${tone * 0.42},${tone * 0.24})`);
        grad.addColorStop(0.85, `rgb(${tone},${tone * 0.36},${tone * 0.2})`);
        grad.addColorStop(1, 'rgb(60,22,12)');
        g.fillStyle = grad;
        g.fillRect(x + 1, y + 1, w / cols - 2, h / rows - 1);
        // the two ridges of a Mangalore tile
        g.fillStyle = 'rgba(255,200,170,0.12)';
        g.fillRect(x + w / cols * 0.28, y + 2, 3, h / rows - 6);
        g.fillRect(x + w / cols * 0.62, y + 2, 3, h / rows - 6);
        // weathering
        if (rnd() < 0.3) {
          g.fillStyle = `rgba(40,30,20,${0.1 + rnd() * 0.2})`;
          g.fillRect(x, y, w / cols, h / rows);
        }
      }
    }
  });

  const plaster = canvasTex(256, 256, (g, w, h) => noiseFill(g, w, h, (n, _x, y) => {
    const grime = Math.max(0, (y / h - 0.75) * 3) * 40; // dirtier near the ground
    const v = 228 + n * 22 - grime;
    return [v, v - 4, v - 12];
  }, 10));

  const laterite = canvasTex(256, 256, (g, w, h) => {
    noiseFill(g, w, h, (n) => [150 + n * 50, 70 + n * 25, 40 + n * 15], 30);
    g.strokeStyle = 'rgba(70,35,20,0.55)';
    g.lineWidth = 3;
    const bh = h / 6;
    for (let r = 0; r < 6; r++) {
      g.beginPath();
      g.moveTo(0, r * bh);
      g.lineTo(w, r * bh);
      g.stroke();
      for (let c = 0; c < 4; c++) {
        const x = (c + (r % 2) * 0.5) * (w / 4);
        g.beginPath();
        g.moveTo(x, r * bh);
        g.lineTo(x, (r + 1) * bh);
        g.stroke();
      }
    }
    // laterite pores
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(60,25,10,${0.2 + rnd() * 0.4})`;
      g.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
  });

  const wood = canvasTex(128, 512, (g, w, h) => {
    g.fillStyle = '#5a3418';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w;
      g.strokeStyle = `rgba(${30 + rnd() * 40},${15 + rnd() * 20},5,${0.25 + rnd() * 0.3})`;
      g.lineWidth = 1 + rnd() * 2;
      g.beginPath();
      g.moveTo(x, 0);
      for (let y = 0; y <= h; y += 16) g.lineTo(x + Math.sin(y / 40 + i) * 3, y);
      g.stroke();
    }
  });

  const redFloor = canvasTex(256, 256, (g, w, h) => {
    noiseFill(g, w, h, (n) => [125 + n * 30, 28 + n * 10, 22 + n * 8], 6);
    g.strokeStyle = 'rgba(30,5,5,0.35)';
    g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo((i * w) / 4, 0);
      g.lineTo((i * w) / 4, h);
      g.moveTo(0, (i * h) / 4);
      g.lineTo(w, (i * h) / 4);
      g.stroke();
    }
  });

  // Road: u across the width (0..1), v along (repeats every 12 m).
  const road = canvasTex(256, 512, (g, w, h) => {
    noiseFill(g, w, h, (n) => {
      const v = 58 + n * 30;
      return [v, v, v + 3];
    }, 20);
    g.fillStyle = 'rgba(235,235,225,0.85)';
    g.fillRect(w * 0.045, 0, w * 0.025, h); // edge lines
    g.fillRect(w * 0.93, 0, w * 0.025, h);
    g.fillRect(w * 0.49, 0, w * 0.02, h * 0.45); // centre dashes
    g.fillStyle = 'rgba(120,70,40,0.5)'; // dusty laterite shoulders
    g.fillRect(0, 0, w * 0.04, h);
    g.fillRect(w * 0.96, 0, w * 0.04, h);
  });

  // Coconut frond with leaflets (alpha). u across (0..1, rachis in the middle), v along.
  const frond = canvasTex(128, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let y = 8; y < h - 4; y += 5) {
      const t = y / h;
      const len = (w / 2) * Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.95;
      const shade = 70 + rnd() * 40;
      g.strokeStyle = `rgb(${shade * 0.55},${shade + 40},${shade * 0.35})`;
      g.lineWidth = 3.2;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(w / 2, y);
        g.quadraticCurveTo(w / 2 + s * len * 0.5, y + 10, w / 2 + s * len, y + 26 + rnd() * 6);
        g.stroke();
      }
    }
    g.strokeStyle = '#8a8a3a';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(w / 2, 0);
    g.lineTo(w / 2, h);
    g.stroke();
  });

  const bark = canvasTex(64, 256, (g, w, h) => {
    noiseFill(g, w, h, (n) => [110 + n * 40, 95 + n * 30, 75 + n * 20], 8);
    for (let y = 0; y < h; y += 7 + rnd() * 5) {
      g.fillStyle = `rgba(50,40,30,${0.35 + rnd() * 0.3})`;
      g.fillRect(0, y, w, 2);
    }
  });

  // Woven bamboo / coir thatch for the houseboat roof.
  const thatch = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#a6814b';
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 8) {
      for (let x = 0; x < w; x += 8) {
        const over = ((x + y) / 8) % 2 === 0;
        g.fillStyle = over ? `rgba(220,180,110,${0.5 + rnd() * 0.3})` : `rgba(90,60,25,${0.4 + rnd() * 0.3})`;
        g.fillRect(x, y, over ? 8 : 7, over ? 7 : 8);
      }
    }
  });

  const net = canvasTex(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(40,40,35,0.9)';
    g.lineWidth = 1.5;
    for (let i = 0; i <= 16; i++) {
      g.beginPath();
      g.moveTo((i * w) / 16, 0);
      g.lineTo((i * w) / 16, h);
      g.moveTo(0, (i * h) / 16);
      g.lineTo(w, (i * h) / 16);
      g.stroke();
    }
  });

  // Tileable normal map for water ripples, from a height field.
  const waterNormal = canvasTex(256, 256, (g, w, h) => {
    const H = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const v = y / h;
        const s = (a: number, b: number) => noise.fbm(a * 6, b * 6, 4);
        H[y * w + x] = s(u, v) * (1 - u) * (1 - v) + s(u - 1, v) * u * (1 - v) + s(u, v - 1) * (1 - u) * v + s(u - 1, v - 1) * u * v;
      }
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = H[y * w + ((x + 1) % w)] - H[y * w + ((x - 1 + w) % w)];
        const dy = H[((y + 1) % h) * w + x] - H[((y - 1 + h) % h) * w + x];
        const n = new THREE.Vector3(-dx * 6, -dy * 6, 1).normalize();
        const i = (y * w + x) * 4;
        img.data[i] = (n.x * 0.5 + 0.5) * 255;
        img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
        img.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    g.putImageData(img, 0, 0);
  }, { srgb: false });

  // Grass tuft (alpha blades).
  const grass = canvasTex(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 46; i++) {
      const x = 10 + rnd() * (w - 20);
      const lean = (rnd() - 0.5) * 30;
      const tall = h * (0.45 + rnd() * 0.5);
      const c = 60 + rnd() * 60;
      g.strokeStyle = `rgb(${c * 0.6},${c + 50},${c * 0.3})`;
      g.lineWidth = 2 + rnd() * 2;
      g.beginPath();
      g.moveTo(x, h);
      g.quadraticCurveTo(x + lean * 0.3, h - tall * 0.6, x + lean, h - tall);
      g.stroke();
    }
  });

  const tyre = canvasTex(256, 64, (g, w, h) => {
    g.fillStyle = '#1b1b1b';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#0c0c0c';
    for (let x = 0; x < w; x += 16) {
      g.fillRect(x, 4, 7, h * 0.4);
      g.fillRect(x + 8, h * 0.55, 7, h * 0.4);
    }
  });

  // Leaf cluster card for broadleaf trees (alpha).
  const leaves = canvasTex(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * w * 0.44;
      const x = w / 2 + Math.cos(a) * r;
      const y = h / 2 + Math.sin(a) * r;
      const l = 40 + rnd() * 50;
      g.fillStyle = `rgb(${l * 0.55},${l + 35},${l * 0.3})`;
      g.save();
      g.translate(x, y);
      g.rotate(rnd() * Math.PI);
      g.beginPath();
      g.ellipse(0, 0, 9 + rnd() * 5, 4 + rnd() * 2, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  });

  return { leaves, detail, roofTiles, plaster, laterite, wood, redFloor, road, frond, bark, thatch, net, waterNormal, grass, tyre };
}

/** A sign board with text. */
export function signTexture(text: string, bg = '#1f4d2b', fg = '#f5e9c8', sub?: string): THREE.CanvasTexture {
  return canvasTex(512, 128, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = fg;
    g.lineWidth = 6;
    g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${sub ? 46 : 56}px system-ui, sans-serif`;
    g.fillText(text, w / 2, sub ? h * 0.4 : h / 2);
    if (sub) {
      g.font = '500 26px system-ui, sans-serif';
      g.fillText(sub, w / 2, h * 0.75);
    }
  });
}
