# Voice World

A free-roam 3D world (three.js + Rapier) where ~20 people walk around and talk. Voices are spatial: they get louder as you approach and come from the speaker's direction. Anyone can step up to the PA mic and be heard from speaker props scattered around the world.

## Run it

You need a LiveKit server (LiveKit Cloud free tier, or self-hosted) for voice.

```bash
cp .env.example .env     # fill in LIVEKIT_URL / API key / secret
npm install
npm run dev              # Vite on :5173 + token server on :3001
```

Open http://localhost:5173 in two browser windows, pick names, allow the mic (use headphones), and walk toward each other.

No LiveKit yet? `http://localhost:5173/?solo` skips networking so you can just walk around.

Production: `npm run build && npm start` — the token server also serves `dist/`.

## Controls

| Key | Action |
| --- | --- |
| Click world | capture mouse (look around), Esc releases |
| W A S D / Shift / Space | move / run / jump |
| M | mute / unmute mic |
| E (hold, at the mic) | announce on the PA — anyone, one person at a time |

## How it works

- **Proximity voice** (`src/voice.ts`): everyone subscribes to everyone's mic. Each remote track goes through a Web Audio `PannerNode` placed at that player's head — `equalpower` panning (HRTF is CPU-heavy at 20 sources), `linear` falloff: full volume within 3 m, silent at 25 m. Tune in `src/config.ts`.
- **Positions** (`src/net.ts`): 20-byte packets (seq, x, y, z, yaw) over LiveKit's lossy data channel at ~15 Hz. Receivers drop out-of-order packets and render ~100 ms in the past, interpolating between snapshots (`RemotePlayer` in `src/player.ts`).
- **PA** (`src/announce.ts`): anyone standing in the yellow ring at the mic and holding **E** goes live. Every client then fans that player's single audio track out to one panner per speaker prop (no extra bandwidth) and fades out their body-position voice so it isn't doubled. "On" is re-sent every 1.5 s so late joiners catch up, and a PA that goes silent for 4.5 s is switched off. One person at a time (best-effort, client-side); whoever is live gets a 📣 in the player list.
- **Speakers** (`src/config.ts`): `SPEAKER_COUNT` (default 8) speakers are scattered around the world from a fixed `SPEAKER_SEED`, so every client computes the same layout. Placement uses best-candidate sampling (random, but no clumps or dead zones) and avoids obstacles, the mic and the spawn point. Each speaker is full volume within 6 m and fades out by 45 m; with the default layout every spot on the map is within range of at least one. Change the seed for a new layout.
- **Token server** (`server/token.ts`): mints a LiveKit token per player; tokens only allow publishing the microphone source.
- **Movement** (`src/player.ts`): Rapier kinematic character controller (capsule, step climbing, slopes), third-person camera that pulls in against walls.

## Character model

`public/models/avatar.glb` is the player character ("Mammotty 3d Model" by Peter Charles, CC BY 4.0 — see `public/models/CREDITS.md`; the credit is also shown on the join screen, as the license requires).

- **Any rigged glTF works.** It's scaled to 1.7 m with its feet on the ground, so the file's units don't matter; humanoid rigs are turned to face forward automatically. Settings live in `AVATAR` in `src/config.ts`.
- **Animation:** if the file has clips whose names match idle / walk / run, those are used. This model has none, so humanoid rigs (standard Mixamo / Ready Player Me bone names like `Hips`, `LeftArm`, `LeftUpLeg`) get **procedural animation** (`src/procedural.ts`): arms come down out of the T-pose, idle breathing, and a walk/run cycle that speeds up with movement. Limbs are aimed at target directions, so it copes with T- or A-pose rigs. For nicer motion, export the character with Mixamo idle/walk/run clips and they take over automatically.
- **Per-player colour:** the `outfit_top` material (`AVATAR.tintMaterial`) is recoloured per player from the texture's brightness, so everyone's shirt is a different colour but keeps its fabric detail.
- **Size budget:** the original was 13.6 MB; it ships as 2.1 MB after `gltf-transform` dedup/prune + WebP textures + meshopt (Draco and meshopt both load). To compress a new model the same way:

  ```bash
  npx @gltf-transform/cli webp in.glb tmp.glb --quality 85
  npx @gltf-transform/cli meshopt tmp.glb public/models/avatar.glb
  ```
- **Cost:** ~57k triangles per character. Only players within 20 m cast shadows, and off-screen characters are culled, but 20 people on screen is still ~1.2M triangles — use a lighter model if low-end laptops matter.

## Your own world

Drop `public/models/world.glb` in to replace the placeholder ground and obstacles. Every mesh becomes a static trimesh collider, so keep it low-poly (use simpler proxy geometry if needed). The PA mic and speakers are code-placed props; the speaker scatter only knows about the placeholder obstacles, so with your own scene check the layout (or tweak `SPEAKER_SEED` / `MIC_POS` in `src/config.ts`).

## Known limits

- **Echo**: browser echo cancellation helps but doesn't fully fix someone playing the world through speakers. Headphones recommended.
- **Mobile Safari** is the weakest target (no pointer lock, no touch controls yet). Desktop browsers only for now.
- The bundle is ~5.5 MB (≈2 MB gzipped), mostly Rapier's inlined WASM and three.js.
- Since anyone can announce, anyone can also hog or spam the PA; the mic is first-come and claims aren't validated server-side.
- The token endpoint has only a small in-memory rate limit; put it behind real auth if the world is public.
