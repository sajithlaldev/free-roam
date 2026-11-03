# Voice World

A free-roam 3D world (three.js + Rapier) where ~20 people walk around and talk. Voices are spatial: they get louder as you approach and come from the speaker's direction. A PA mic lets an announcer be heard from speaker props across the plaza.

## Run it

You need a LiveKit server (LiveKit Cloud free tier, or self-hosted) for voice.

```bash
cp .env.example .env     # fill in LIVEKIT_URL / API key / secret, set ANNOUNCER_CODE
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
| E (hold, at the mic) | announce on the PA — announcers only |

## How it works

- **Proximity voice** (`src/voice.ts`): everyone subscribes to everyone's mic. Each remote track goes through a Web Audio `PannerNode` placed at that player's head — `equalpower` panning (HRTF is CPU-heavy at 20 sources), `linear` falloff: full volume within 3 m, silent at 25 m. Tune in `src/config.ts`.
- **Positions** (`src/net.ts`): 20-byte packets (seq, x, y, z, yaw) over LiveKit's lossy data channel at ~15 Hz. Receivers drop out-of-order packets and render ~100 ms in the past, interpolating between snapshots (`RemotePlayer` in `src/player.ts`).
- **PA** (`src/announce.ts`): an announcer standing in the yellow ring at the mic and holding **E** goes live. Every client then fans that player's single audio track out to one panner per speaker prop (no extra bandwidth) and fades out their body-position voice so it isn't doubled. "On" is re-sent every 1.5 s so late joiners catch up, and a PA that goes silent for 4.5 s is switched off. One announcer at a time (best-effort, client-side).
- **Roles** (`server/token.ts`): the token server sets `role=announcer` in the signed token attributes when the join code matches `ANNOUNCER_CODE`; with no code configured nobody can announce. Clients read the sender's role from LiveKit's server-signed participant attributes and ignore PA messages from anyone else. Tokens only allow publishing the microphone source, and never grant `canUpdateOwnMetadata`, so a client can't promote itself.
- **Movement** (`src/player.ts`): Rapier kinematic character controller (capsule, step climbing, slopes), third-person camera that pulls in against walls.

## Your own models (milestone 4)

Drop files in `public/models/`; they're picked up automatically, with placeholders used when absent:

- `avatar.glb` — a character with animation clips whose names contain `idle` and `walk`. Faces +Z, feet at the origin, ~1.7 m tall.
- `world.glb` — the scene. Every mesh becomes a static trimesh collider, so keep it low-poly (use simpler proxy geometry if needed). The PA mic and speakers are code-placed props; move them in `src/config.ts` to match your scene.

Draco and meshopt compression are both supported (the Draco decoder is copied to `public/draco` on `npm run dev`/`build`). Compress with e.g. `npx gltf-transform optimize in.glb out.glb --compress draco` (or `meshopt`).

## Known limits

- **Echo**: browser echo cancellation helps but doesn't fully fix someone playing the world through speakers. Headphones recommended.
- **Mobile Safari** is the weakest target (no pointer lock, no touch controls yet). Desktop browsers only for now.
- The bundle is ~5.5 MB (≈2 MB gzipped), mostly Rapier's inlined WASM and three.js.
- The token endpoint has only a small in-memory rate limit; put it behind real auth if the world is public.
