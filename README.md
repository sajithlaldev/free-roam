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
| **Off-road park** (north) | Rough 4×4 course: steep mounds with boulders, mud pits, a creek to ford, logs to crawl over, a rutted twin-track trail marked with white tyres |
| **Town** (centre) | Padmanabhaswamy-style temple with a seven-tier gopuram, round sreekovil, flag mast, brass lamp tower and stepped temple pond; red-earth maidan with the PA mic; Kerala tiled-roof houses with verandahs; a chaya kada (tea shop); the **community hall** |

Life: Jimnys and Fortuners drive the roads (left-hand traffic, U-turns at dead ends, braking for you), devotees circle the sreekovil, people stroll the maidan, roadside, jetty and beach, and others sit in the hall, at the tea shop and the bus stop. Traffic and pedestrians follow the shared clock, so everyone sees the same world.

KSEB poles carry sagging power lines along every road; houses have laterite compound walls and gates; there are modern two-storey houses with black rooftop water tanks, parked autorickshaws and scooters, a KSRTC bus at its shelter, flex boards, milestones and flowering hibiscus, croton and bougainvillea.

Roads connect everything (with bridges over the canals) and street lamps, direction signs and a minimap help you find your way. Water deeper than chest height is swimmable.

## Off-road Challenge

A two-lap time trial round the off-road park's trail, through both mud pits, across the creek and along the flanks of the mounds. Drive any 4×4 (there's a Fortuner parked at the park gate) onto the chequered start line, stop, and press **T** (touch: **Race**). After a 3-2-1 countdown, take the nine orange gates in order; the one you're heading for glows, and the HUD shows your time, lap, gate, an arrow and the distance to the next gate (it's also circled on the minimap).

- **R** puts you back on the last gate you cleared, with a 2 s penalty. **T** quits. Leaving the car or driving far off course ends the run.
- Medals: 🥇 under 0:58 · 🥈 under 1:10 · 🥉 under 1:30. Your best time is kept per vehicle (Jimny and Fortuner separately).
- In multiplayer, every finish is announced to the room and the HUD shows the room's best.
- The clock follows the physics simulation, so a slow frame rate doesn't cost you time.

## Modes, rooms and invites

The join screen offers **Single player** (offline: you, the town's pedestrians and AI traffic) or **Multiplayer** (voice chat with other people; no NPCs). In multiplayer you join the **public lobby**, or press **Create private room** to get an unguessable room code and an invite link (`…/?room=k7mq-x2pd`) to copy or share; anyone opening the link lands in the same room. Each room is its own LiveKit room on the server. The in-game **Invite** button shares the link again.

## Phones and tablets

On touch devices a controls overlay appears: a floating analog stick on the left (push gently to walk, all the way to sprint; when driving it's throttle / brake / steering), drag anywhere on the right to look, and context buttons — Jump, Crouch, Lie, Interact (E: enter / sit / exit, hold at a mic to talk), camera and mic; in a car Brake (handbrake), Horn, 4L, Reset, Race, Exit. Graphics start on Low on phones; landscape is recommended.

## Run it

You need a LiveKit server for voice (LiveKit Cloud free tier, or `livekit-server --dev` locally).

```bash
cp .env.example .env     # LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
npm install
npm run dev              # Vite on :5173 + token server on :3001
```

No LiveKit yet? Choose **Single player** on the join screen (or open `http://localhost:5173/?solo`).

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
| V | camera: normal → zoomed out → over the shoulder → first person |
| G | graphics quality: High → Medium → Low |
| M | mute / unmute |

**Driving** (E at the driver's door — the right-hand side; other doors make you a passenger)

| Key | Action |
| --- | --- |
| W / S | accelerate / brake; hold S when stopped to reverse |
| A / D | steer |
| Space | handbrake (the tail steps out at speed) |
| H | horn (other players hear it) |
| L | 4H ↔ 4L transfer case (when slow) — low range for steep climbs |
| R | reset upright if you've rolled it or got stuck (in a race: back to the last gate) |
| T | start the Off-road Challenge (on its start line) / quit the race |
| V | camera: chase → far chase → close chase → driver's-eye cockpit |
| E | get out |

## Materials and ground

Every surface uses procedural PBR materials (albedo + normal map from a real height field + roughness), built at startup (`src/world/pbr.ts`): grass turf, laterite soil with stones and drying cracks, wind-rippled sand, weathered rock, wet mud, asphalt (aggregate, cracks, patches, worn paint, dusty shoulders), monsoon-stained plaster, Mangalore roof tiles with lichen, porous laterite blocks, carved temple stone, teak, palm bark, concrete.

The terrain is a 1 m grid (480 × 480 cells, drawn as 64 culled chunks, collided as a Rapier height field) with fine relief on open ground. Its shader blends five surfaces per pixel by vertex weights *and* each surface's height map (sand settles between grass, rock pushes through soil), samples each twice at different scales/rotations to hide tiling, and applies the normal maps in world space.

## Graphics

Three presets (G; remembered per browser):

| | High | Medium | Low |
| --- | --- | --- | --- |
| Ambient occlusion (GTAO, half-res, from the real scene depth so leaves are correct) | ✓ | | |
| Bloom (HDR threshold: only the sun, sky glare and lamps), colour grade, SMAA | ✓ | ✓ | |
| Sun shadow map / area around you | 4096 / ±75 m | 2048 / ±60 m | 1024 / ±45 m |
| Dense grass carpet around the camera | 14k clumps, 30 m | 7k, 22 m | off |

Always on: sky with image-based lighting, a drifting procedural cloud layer, wind sway on palms, trees, bananas, rice and grass, depth-aware water (turquoise shallows, dark deeps, transparent at the edge) with lapping shoreline foam, bump-mapped ground with anti-tiling variation, distance-culled vegetation tiles.

## Voice and audio

- **Proximity voice** (`src/voice.ts`): every remote mic plays through a Web Audio `PannerNode` at that person's head — full volume within 3 m, silent at 25 m (`equalpower` panning; HRTF is too heavy for 20 sources).
- **Walls:** if the talker and listener are in different rooms (`registry.rooms`: the houses and the hall), the voice is low-passed and attenuated. The **meeting hall is soundproof**: inside and outside can't hear each other.
- **PA systems** (`src/announce.ts`): stand at a mic and hold **E**.
  - *Maidan PA* — 24 speaker poles scattered across the whole map; heard everywhere.
  - *Hall mic* (on the stage lectern) — four speakers inside the community hall, heard **only by people inside the hall**.

  One person per mic. The talker's single audio track is fanned out client-side to that PA's speakers (no extra bandwidth) and their body voice is muted so it isn't doubled. "On" is re-sent every 1.5 s for late joiners and times out after 4.5 s of silence.
- **Engines:** each running Jimny has a synthesised, spatialised 4-cylinder engine (firing frequency from the live RPM, load-dependent filtering) plus road noise.

## Vehicles (`src/car.ts`)

Two models, both data-driven (`VehicleSpec`) on Rapier's ray-cast vehicle controller:

| | Jimny 5-door (lifted, 29-inch A/T) | Fortuner (4-inch lift, 33-inch A/T) |
| --- | --- | --- |
| Mass | 1,250 kg | 2,200 kg |
| Engine | 1.5 petrol, 130 Nm | 2.8 diesel, 500 Nm @ 1,600–2,800 |
| Gearbox | 4-speed auto + 4H/4L | 6-speed auto + 4H/4L |
| 0–100 km/h (measured) | 14.0 s | 11.5 s |
| 100–0 km/h | 41.4 m | 42.2 m |

**Handling is tuned to feel like GTA IV**: heavy and momentum-driven; soft, under-damped springs; a sprung-body model so the body visibly leans out of corners, dives under braking, squats under power and wobbles after quick direction changes; no stability control, lighter traction control and a slightly loose rear so slides are easy to start and catch, with progressive understeer at the limit.

### Models (`src/vehicles/`)

Both vehicles are modelled in code with a small toolkit (`kit.ts`):
- **Body shells:** lofted from cross-sections along the car (sill, side wall with a slight bow, shoulder radius, cambered bonnet and roof). The wheel arches are cut out of the side walls, and the ends close with filleted faces. Every grid cell is given a material by a classifier, so windscreen, side glass, pillars, the roof, cladding and door shut lines all come out of one surface and line up exactly.
- **Swept parts:** a 2D profile run along a path, used for bumpers, arch flares and cladding, lamps that wrap round the corners, chrome belt lines, roof rails, the snorkel and trim.

Details on both:
- **Wheels:** the tyre carcass has bulging sidewalls and a lettered sidewall texture, with separate tread blocks (all-terrain on both). Rims are spoked alloys with lips and lug nuts, with brake discs and calipers behind them (calipers stay put while the wheel turns).
- **Lamps and glass:** lamps have reflectors, bulbs or projectors, clear lenses and LED strips. Glass is tinted and reflective, set slightly into the frame.
- **Underneath:** wheel-well liners, a ladder frame and underbody, and running gear that follows the wheels: axle beams with diffs, wishbones and links, and shocks with coil springs.
- **Cabin:** seats, dash, gauges, screen, console, door cards and headliner, so the first-person view works.

Model-specific:
- **Jimny (5-door):**
  - **Body:** long-wheelbase body (2.59 m) with rear doors and a small quarter window, two-tone black roof and A-pillars, drip rails and a roof antenna.
  - **Front and sides:** chrome-ringed round lamps either side of a piano-black five-slot grille, flat square-cut black over-fenders and a black sill strip.
  - **Bumpers and tailgate:** black bumpers with round fog lamps and corner tail lamps, and a side-hinged tailgate carrying the spare.
  - **Running gear:** a mild long-travel lift (about 8 cm) with all-terrains on gunmetal alloys.
- **Fortuner (1st-generation facelift look):**
  - **Front:** tall upright nose with a bonnet scoop, black three-bar grille, large clear headlamps with projectors swept back into the wings, and a body-colour bumper with round fog lamps and a wide lower intake.
  - **Sides and roof:** straight beltline, blacked-out B and C pillars, wind deflectors, black roof rails, tall tail lamps up the D-pillars, wide bolt-on arch flares and a snorkel.
  - **Running gear:** a 4-inch long-travel lift (about 11 cm more ground clearance) on 33-inch all-terrains and black 10-spoke rims.
- **Underneath (both):** nothing hangs below the body.

Each model's geometry is merged per material and shared by every car of that model. A car adds only its own paint, plates and lamp materials. Beyond about 38 m the interior, tread, brakes, chassis and running gear switch off.

**Mud:** a dirt layer builds up on the lower body and wheels as you drive through mud (and slowly on dirt tracks), and washes off when you ford water.

`tools/car-studio.html?model=fortuner|jimny&color=17181a&dirt=0.6` is a turntable for looking at the models.

### The Jimny

A 5-door Jimny-style 4x4 (see Models above; right-hand drive with a turning steering wheel, working brake and reverse lights) on Rapier's ray-cast vehicle controller:

- 1,250 kg chassis with an explicit inertia tensor and centre of mass; soft long-travel suspension (~1.45 Hz) with separate bump/rebound damping and roll damping.
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

## Sound (`src/audio/`)

Everything is synthesised in the browser — no audio files.

- **Engines** run as an AudioWorklet combustion simulation: the crank turns at the live rpm, each of the four cylinders fires once per two revolutions with a pressure pulse sized by engine load (and a little cycle-to-cycle variation), through exhaust resonances and a load-dependent low-pass, plus intake roar. The diesel adds injector clatter on every firing and a turbo whistle that rises with boost. Pitch tracks rpm exactly (checked by FFT in `tools/audio-lab.html`, which also renders WAVs to listen to).
- **Tyres**: rolling noise tuned per surface (asphalt hiss, gravel crunch, grass swish, mud), squeal from real tyre slip on hard surfaces, scrabble on dirt; suspension thumps, crash crunches, splashes into water, door thunks, two-tone horns. Vehicles have their own, quieter bus.
- **Footsteps** are triggered by the animation at the moment each foot plants, with a sound for each surface underfoot — grass, laterite soil, sand, gravel/rock, asphalt, concrete, wooden decks, indoor tiles (with room reverb), mud and shallow water — heavier when running, a thud on landing, strokes when swimming.
- **Ambience** follows where you are: waves from the nearest stretch of coast with breaking surf, water lapping along the backwaters, wind that gusts with the swaying trees and blows harder up the hills, cicadas, Kerala birds in the trees (koel, mynas, crows), temple bells near the temple, distant auto horns in town, ceiling fans in the hall. Traffic honks if you block it.

## Animation (`src/procedural.ts`)

The character model ships without animation clips, so the body is animated procedurally from its humanoid skeleton (works with any Mixamo / Ready Player Me–style rig):

- **Legs:** analytic two-bone IK with planted feet. The stance foot's toe joint stays fixed on the ground while the heel strikes, rolls flat and lifts (the foot pivots about the toe, raising the ankle) before toe-off; cadence, stride and the stance/swing ratio follow speed and are scaled to the rig's leg length; hip height is solved each frame from what the stance leg can reach (the natural walking bob, ~7 cm), so the body never sinks into a crouch. Feet follow the ground slope. `tools/anim-lab.html` measures foot slip and hip/head height at each speed.
- **Body:** pelvis bob (vaulting walk vs compressing run), lateral sway and twist; shoulders counter-rotate; arms swing opposite the legs and bend into a pumping sprint; lean into acceleration; bank into turns; the head stays level and looks into turns; turning on the spot makes the feet step.
- **Walk:** follows measured human gait. It's a relaxed 1.3 m/s at about 1.8 steps a second, with pelvic list (the swing-side hip drops), sway over the stance foot and a modest arm swing that grows with speed, the elbow bending as each arm comes forward. Sprint is unchanged.
- **Idle:**
  - **Always, when standing still:** breathing (chest and shoulders) and a slow balance sway.
  - **Weight:** it rests on one leg (that hip rides up, the other knee relaxes and its foot sits a little forward), and every so often shifts across to the other leg.
  - **Actions:** random ones blend in and out every few seconds: looking around, checking a watch, scratching the head, a stretch, hands on hips, arms crossed, a yawn and a neck roll. The same action never plays twice in a row.
  - **Who gets it:** you, other players and pedestrians who stop.
  - **Testing:** `tools/anim-lab.html` can trigger each one (`lab.av.rig.forceIdle('cross')`, `lab.camFront()`).
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
| `src/car.ts` | Vehicle specs, drivetrain and physics |
| `src/vehicles/` | Vehicle models: modelling toolkit, materials (paint, glass, mud), wheels and parts, Jimny, Fortuner |
| `src/race.ts` | Off-road Challenge: gates, timing, medals, HUD |
| `src/voice.ts` | Proximity voice, room occlusion, PA routing, engine sound |
| `src/net.ts` | LiveKit room + compact binary data protocol (`tools/net-protocol.html` round-trips it) |
| `server/token.ts` | LiveKit token minting |

## Known limits

- Desktop browsers only (pointer lock, no touch controls). It's a fairly heavy scene: a mid-range GPU is recommended.
- Echo: use headphones; browser echo cancellation doesn't fully fix speakers.
- PA mics and car seats are first-come and not validated server-side.
- The token endpoint only has a small in-memory rate limit; add real auth if the world is public.
