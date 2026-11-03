# Free Roam — Kerala

A free-roam 3D voice world set in a compressed tour of Kerala. Up to ~20 people walk, drive and talk; voices are spatial, walls muffle them, and there's a community hall where you can sit in on a meeting with its own mic and speakers.

Built with three.js, Rapier (physics) and LiveKit (voice + data). Everything in the world — terrain, buildings, trees, textures, the car — is generated procedurally at startup; the only downloaded asset is the character model.

## The world (480 × 480 m)

| Place | What's there |
| --- | --- |
| **Kovalam** (south-west) | Beach on the Arabian Sea, rocky headland with the red-and-white lighthouse (rotating beacon), keeper's cottage |
| **Fort Kochi** (north-west) | Four Chinese fishing nets on wooden platforms, slowly dipping into the sea |
| **Alappuzha backwaters** (south) | Lake and canals, three kettuvallam houseboats (the one at the jetty is walkable), paddy fields with bunds, coconut palms along every bank |
| **Munnar** (north-east) | Rolling hills of contour tea hedges with silver oaks, a winding hill road up to a viewpoint pavilion |
| **Town** (centre) | Padmanabhaswamy-style temple with a seven-tier gopuram, round sreekovil, flag mast, brass lamp tower and stepped temple pond; red-earth maidan with the PA mic; Kerala tiled-roof houses with verandahs; a chaya kada (tea shop); the **community hall** |

Roads connect everything (with bridges over the canals) and street lamps, direction signs and a minimap help you find your way. Water deeper than chest height is swimmable.

## Run it

You need a LiveKit server for voice (LiveKit Cloud free tier, or `livekit-server --dev` locally).

```bash
cp .env.example .env     # LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
npm install
npm run dev              # Vite on :5173 + token server on :3001
```

No LiveKit yet? `http://localhost:5173/?solo` runs everything except voice chat (walk, drive, sit, swim alone).

Production: `npm run build && npm start` (the token server also serves `dist/`).

## Controls

**On foot**

| Key | Action |
| --- | --- |
| Click | capture the mouse (look around); Esc releases · scroll to zoom |
| W A S D | walk · **Shift** sprint |
| Space | jump (stands you up if crouched / lying down) |
| C | crouch / stand |
| Z | lie down (kneel → prone) / get up; moving while prone crawls |
| E | context action: **drive / ride** a Jimny · **sit** on a chair or bench · **hold at a mic** to talk on that PA |
| M | mute / unmute |

**Driving** (E at the driver's door — the right-hand side; other doors make you a passenger)

| Key | Action |
| --- | --- |
| W / S | accelerate / brake; hold S when stopped to reverse |
| A / D | steer |
| Space | handbrake (the tail steps out at speed) |
| L | 4H ↔ 4L transfer case (when slow) — low range for steep climbs |
| R | reset upright if you've rolled it or got stuck |
| E | get out |

## Voice and audio

- **Proximity voice** (`src/voice.ts`): every remote mic plays through a Web Audio `PannerNode` at that person's head — full volume within 3 m, silent at 25 m (`equalpower` panning; HRTF is too heavy for 20 sources).
- **Walls:** if the talker and listener are in different rooms (`registry.rooms`: the houses and the hall), the voice is low-passed and attenuated. The **meeting hall is soundproof**: inside and outside can't hear each other.
- **PA systems** (`src/announce.ts`): stand at a mic and hold **E**.
  - *Maidan PA* — 24 speaker poles scattered across the whole map; heard everywhere.
  - *Hall mic* (on the stage lectern) — four speakers inside the community hall, heard **only by people inside the hall**.

  One person per mic. The talker's single audio track is fanned out client-side to that PA's speakers (no extra bandwidth) and their body voice is muted so it isn't doubled. "On" is re-sent every 1.5 s for late joiners and times out after 4.5 s of silence.
- **Engines:** each running Jimny has a synthesised, spatialised 4-cylinder engine (firing frequency from the live RPM, load-dependent filtering) plus road noise.

## The Jimny (`src/car.ts`)

A Suzuki Jimny–style 4x4 (boxy body, round lamps, five-slot grille, flared arches, tailgate spare, drip rails, KL plates, right-hand drive with a turning steering wheel, working brake and reverse lights) on Rapier's ray-cast vehicle controller:

- 1,090 kg chassis with an explicit inertia tensor and centre of mass; soft long-travel suspension (~1.45 Hz) with separate bump/rebound damping and roll damping.
- K15B-style torque curve → torque converter (slip + multiplication) → automatic 4-speed with kick-down → 4H/4L transfer case → all four wheels.
- Traction control (drive force capped at each tyre's available grip from its live load) and stability control (cuts power when yaw rate or slip angle exceed what the steering asks for). Fronts saturate first, so the limit is safe understeer.
- Speed-sensitive, rate-limited steering; brakes; handbrake (rear grip drops); engine braking; rolling resistance and aerodynamic drag.

Measured with `tools/car-physics.html` (open it while `npm run dev` is running):

| Test | Result |
| --- | --- |
| 0–100 km/h | 11.8 s |
| Top speed | ~125 km/h |
| 100–0 km/h braking | 36.6 m |
| Steady circle, 40 km/h | 0.94 g, no spin |
| 80 km/h lane change | stable |
| 40 % ramp | climbs in 4H and 4L |
| Reverse | limited to 25 km/h |

Only the driver's client simulates a car; everyone else receives its pose at 20 Hz and interpolates it on a kinematic body (so you still collide with it). When the driver gets out, their client lets it settle, then keeps re-broadcasting its parked pose for late joiners. Simultaneous seat grabs are resolved deterministically (lower identity wins).

## Animation (`src/procedural.ts`)

The character model ships without animation clips, so the body is animated procedurally from its humanoid skeleton (works with any Mixamo / Ready Player Me–style rig):

- **Legs:** analytic two-bone IK with planted feet — each foot stays fixed during stance and swings through with lift, heel-off and toe-off; stride, cadence and the stance/swing ratio change continuously from walk to run to sprint; feet follow the ground slope.
- **Body:** pelvis bob (vaulting walk vs compressing run), lateral sway and twist; shoulders counter-rotate; arms swing opposite the legs and bend into a pumping sprint; lean into acceleration; bank into turns; the head stays level and looks into turns; turning on the spot makes the feet step.
- **Jump:** take-off, airborne tuck with arms out, landing absorbed by the knees in proportion to fall speed.
- **Crouch**, **lie down** (kneel first, then onto the forearms; crawling when moving), **swim** (breaststroke when moving, treading water when still), **sit** (chairs and benches; car passenger; driving with hands on the wheel).

If you add real clips to the model (names matching idle / walk / run), they're used instead.

## Character model

`public/models/avatar.glb` — "Mammotty 3d Model" by Peter Charles, CC BY 4.0 (credited on the join screen and in `public/models/CREDITS.md`), compressed 13.6 → 2.1 MB with glTF Transform (WebP + meshopt). Any rigged glTF works: it's scaled to 1.7 m, stood on the ground and turned to face forward automatically (`AVATAR` in `src/config.ts`). Each player's shirt (`outfit_top`) gets its own colour.

## Code map

| Path | What |
| --- | --- |
| `src/world/layout.ts` | The map as data: landmarks, roads, canals, buildings, car spawns |
| `src/world/terrain.ts` | Height field (coast, hills, lowlands, paddy, pads, roads, carved water), colours, collider |
| `src/world/buildings.ts` | Houses, hall interior, temple, lighthouse, fishing nets, houseboats, bridges, lamps, PA speakers |
| `src/world/vegetation.ts` | Palms, tea hedges, trees, bananas, rice, grass, rocks (instanced, tiled for culling) |
| `src/world/textures.ts` | All textures, painted on canvases at startup |
| `src/world/index.ts` | Sky + image-based lighting, water shader, shadows that follow you, distant hills |
| `src/world/registry.ts` | Rooms, PA systems, speakers, seats (built deterministically; ids go over the wire) |
| `src/player.ts` | Local player (movement, stances, swimming, seats, cars, cameras) and remote players |
| `src/procedural.ts` | The animation system |
| `src/car.ts` | Jimny model, drivetrain and physics |
| `src/voice.ts` | Proximity voice, room occlusion, PA routing, engine sound |
| `src/net.ts` | LiveKit room + compact binary data protocol (`tools/net-protocol.html` round-trips it) |
| `server/token.ts` | LiveKit token minting |

## Known limits

- Desktop browsers only (pointer lock, no touch controls). It's a fairly heavy scene: a mid-range GPU is recommended.
- Echo: use headphones; browser echo cancellation doesn't fully fix speakers.
- PA mics and car seats are first-come and not validated server-side.
- The token endpoint only has a small in-memory rate limit; add real auth if the world is public.
