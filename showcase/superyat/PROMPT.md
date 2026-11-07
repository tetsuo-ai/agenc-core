# Superyat demo prompt

The prompt given to DeepSeek V4.1 Flash (max effort) in [AgenC Core](https://github.com/tetsuo-ai/agenc-core) to build Superyat, a walkable, drivable 3D yacht at sea in Three.js.

---

Build a hyper-realistic, fully interactive 3D luxury motor yacht at sea, as one runnable browser app using Three.js and WebGL. A person must be able to walk through the whole yacht, outside and below deck, inspect every detail, watch the open ocean around it, and take the helm and drive it. This will be shown publicly as a showcase, so the first impression, the water, the materials and the light matter more than anything else.

Work autonomously from start to finish. Do not ask me questions. Make sensible decisions, keep going, and do not stop until every item in the acceptance checklist at the end works and you have checked it with screenshots.

## 1. THE YACHT (exterior)

A 22 m (72 ft) Italian-style open express motor yacht, sleek, low and sporty.

Main dimensions (use real meters, 1 unit = 1 m):
- Length overall 22.0 m, beam 5.6 m, draft 1.5 m, freeboard about 1.6 m amidships and higher at the bow.
- Interior headroom 2.0 m, step height 0.19 m, door height 1.9 m, rail height 0.7 m.

Hull:
- Deep navy blue gloss paint (clearcoat), a sharp raked bow with fine entry, a long sweeping sheer line, and a deep-V planing hull: about 18 degrees of deadrise at the transom, with strakes and chines.
- A white boot stripe at the waterline, and a dark red antifouling bottom that shows when the yacht rolls.
- A row of round portholes with polished stainless rims along each side.
- Build the hull as a smooth lofted surface from cross-section curves (stations) along its length, not from boxes. The hull must look fluid and real from every angle.

Deck and superstructure:
- White, low and streamlined: a curved tinted wraparound windscreen with polished stainless frames.
- A radar arch over the cockpit carrying a dark navy canvas bimini, a radar dome, antennas, and a small ensign flag at the stern.
- Teak decks with planks and dark caulking lines everywhere outside: foredeck, side decks, cockpit and swim platform.
- Polished stainless bow rails and stanchions all around. Cleats and fairleads, an anchor in a bow roller with a windlass, and navigation lights (red port, green starboard, white stern and masthead).
- A large tan sunpad with cushions on the foredeck. A wide teak swim platform at the stern with a fold-down ladder and a transom shower.

Cockpit:
- An aft U-shaped lounge in cream leather around a teak table, a wet bar with sink and fridge, and a raised helm station under the arch.

## 2. THE HELM

- Two leather helm seats, a leather-wrapped wheel, two chrome throttle levers and a compass.
- Two glass multifunction displays that are alive: speed in knots, engine RPM, a heading compass rose, depth, and a small chart showing the yacht's position and track.
- Switches for the navigation lights and the interior lights.
- Every instrument reflects the boat's real state at all times.

## 3. BELOW DECK (walkable, human scale, eye height 1.65 m)

A companionway with steps leads down from the cockpit. All spaces must fit inside the hull lines and look like a real yacht interior:
- **Saloon:** a curved cream leather sofa, a light oak dining table, walnut wall panels, cushions, a flat TV, warm LED cove lighting in the ceiling, and hull windows and portholes showing the real sea outside.
- **Galley:** stone countertops, a stainless sink and tap, an induction hob, an oven, a fridge, cabinet doors, and glasses in a rack.
- **Master cabin forward:** a double bed with linen and pillows, bedside lights, a wardrobe, and deck hatches overhead with daylight coming in.
- **Guest cabin:** two single berths.
- **Bathroom (head):** a vanity with basin, a mirror, a glass shower and a toilet.
- **Doors:** cabin and bathroom doors open and close, with the E key when facing them.

CRITICAL: the ocean surface must never appear inside the yacht. Exclude the water from the hull interior, for example with a stencil or depth mask shaped like the hull, so that when you stand below deck you only see the sea through windows and portholes.

## 4. THE SEA AND THE SKY

- **Setting:** the yacht floats alone in open ocean, with no land and only horizon in every direction.
- **Ocean:** a large ocean surface with layered Gerstner waves: a long ocean swell plus smaller wind chop, with level of detail toward the horizon. The shading needs:
  - Fresnel reflection of the sky
  - deep blue-green body color with lighter subsurface tint in thin wave crests
  - a bright sun glitter path
  - whitecap foam on steep crests
  - fading into a soft haze at the horizon
- **One wave function:** use exactly the same wave function on the CPU and the GPU, so the physics and the visible water always agree.
- **Water against the hull:**
  - a foam ring where the hull meets the water
  - a white turbulent wake and a V-shaped Kelvin wake trailing behind when moving
  - bow spray and spray particles at speed
  - prop wash
  - the wake fades out slowly behind the yacht
- **Sky:** physically based, with sun and soft clouds.
  - The default is golden hour: a low warm sun across the water.
  - The T key cycles golden hour, midday, sunset and night.
  - At night: moonlight, a starfield, moon glitter on the water, glowing navigation lights, and warm interior light spilling from the windows onto the deck.

## 5. BOAT PHYSICS AND DRIVING

- **Floating:** the yacht is a rigid body.
  - Sample the wave height at about 12 points under the hull and apply buoyancy and damping, so it heaves, pitches and rolls naturally even at rest.
  - The whole interior moves with it.
- **Taking the wheel:** walk to the helm and press E.
  - W and S move the throttle: forward, neutral, reverse. A and D steer.
  - Speed builds with real inertia up to about 35 knots.
  - Planing behavior: the bow rises as the yacht climbs onto the plane, then levels off. The yacht banks into turns and slams slightly on bigger waves.
  - Wake, spray, engine sound and instruments all scale with speed.
- **Sound:** procedural engine sound with the Web Audio API, rising in pitch with RPM, plus water rush and wind that grow with speed. Audio starts on the first user click.
- **Letting go:** E again releases the wheel.
  - Without throttle the yacht coasts to a stop and drifts with the waves.
  - While it moves, you can stand up and walk around. The player moves with the yacht and never slides off or falls through.

## 6. CAMERAS AND CONTROLS

- **Walk mode, the default after the intro:**
  - first person with pointer-lock mouse look, WASD, and Shift to run
  - solid collision with walls, furniture, rails and the hull, and working stairs
  - no falling overboard
  - use a BVH or a simplified collision mesh, so walking is smooth
- **Helm and chase views:** while driving, C toggles between the helm view and a smooth chase camera behind the yacht.
- **Orbit and photo mode (O):** fly freely around the yacht to inspect it from any angle.
  - H hides all UI for clean screenshots.
  - P saves a PNG screenshot.
- **Cinematic intro on load, 15 to 20 seconds:**
  - a smooth drone fly-around of the yacht on the sea at golden hour
  - one low, wide three-quarter shot from the bow with sun glitter behind the hull
  - ending at the swim platform in walk mode
  - any key skips it
- **Help and settings:**
  - F1 toggles an elegant, minimal help panel listing all controls and a quality setting (low, medium, high; high by default).
  - Esc releases the mouse.
  - A clean loading screen with progress.

## 7. REALISM (this is the main goal)

- **Materials:** physically based throughout.
  - MeshPhysicalMaterial with clearcoat for the hull paint
  - real glass with transmission and reflection
  - polished and brushed stainless steel
  - leather with subtle grain and stitching
  - wood with visible grain: teak, oak and walnut
  - linen, stone and canvas
- **Procedural textures:** generate every texture yourself, in canvas or shaders: albedo, normal and roughness maps. Do not download textures, HDRIs or 3D models. The only allowed external code is npm packages, such as three, a post-processing library and a BVH collision library.
- **Lighting:**
  - an environment map built from the sky with PMREM, for real reflections in the paint, chrome and glass
  - soft sun shadows that cover the yacht at high resolution
  - warm practical lights inside, with correct exposure
- **Post-processing, tasteful and photographic, never overdone:**
  - ACES filmic tone mapping
  - subtle bloom on highlights and lights
  - ambient occlusion
  - high-quality anti-aliasing
- **Detail:** enough to hold up close.
  - rounded edges and real thickness everywhere
  - panel lines and seat stitching
  - glass frames, hinges, cleats and switches
  - no floating parts, no gaps, no z-fighting, no stretched textures
- **Performance:** a stable 60 fps at 1080p on a recent laptop GPU.
  - instancing for repeated parts
  - deck planks done in textures, not separate meshes
  - a limited set of shadow casters
  - the pixel ratio capped
  - frustum culling

## 8. ORDER OF WORK (build the showcase shot first)

1. Project setup, then the ocean, sky, sun, tone mapping and post-processing. Get a beautiful golden-hour sea before anything else.
2. The yacht exterior: lofted hull, superstructure, windscreen, arch, rails and teak. Check the hero shot.
3. Floating physics on the shared wave function, then the helm, driving, wake and spray.
4. The interior rooms, the stairs, the doors and the water exclusion inside the hull.
5. Walk mode with collision, the cameras, the intro, the UI and audio.
6. Times of day, night lighting, quality settings and performance.
7. Verification and polish (section 10).

If something has to be simplified, cut in this order: the guest cabin, ocean particles, then night mode. Never cut the realism of the water, the hull or the main rooms.

## 9. TECHNICAL

- **Stack:** Vite plus Three.js, with clear modules:
  - ocean, sky and time of day
  - yacht exterior, interior rooms, and materials with procedural textures
  - player and collision, boat physics, and helm and instruments
  - audio, cameras and UI
- **Code:** clean, with no placeholders, no fake buttons and no pre-rendered video. Every listed control must really work.
- **README:** one-command setup (npm install, then npm run dev), all controls, and the architecture.
- **Screenshot script:** `npm run shots`. It opens the app in Playwright, sets each named camera bookmark, and saves the screenshots listed below. Add the bookmarks as named camera presets in code, so the shots are reproducible.

## 10. VERIFY, LOOK, IMPROVE (do not skip)

Run the app and test it yourself in a headless browser (Playwright, with a WebGL-capable flag):

- **Checks:**
  - There are no console errors or warnings that matter.
  - The intro plays and can be skipped.
  - Walk mode reaches every room, the stairs work, the doors open, and there is no water inside the hull.
  - Driving works: speed, planing, wake, spray, instruments and sound respond.
  - All four times of day work.
  - Frame time is reasonable.
- **Screenshots** in screenshots/:
  1. hero exterior at golden hour: low three-quarter view from the bow, sun glitter on the water
  2. a side profile at speed with the wake, from the chase camera
  3. the bow sunpad and rails
  4. the helm with live instruments
  5. the cockpit lounge
  6. the saloon, with the sea visible through the windows
  7. the galley
  8. the master cabin
  9. the bathroom
  10. a night exterior with lights on

Open each screenshot and judge it honestly, as a demanding art director. Look for anything that looks fake, flat, blocky, too dark, too bright, plastic, mis-scaled or unfinished. Fix those problems, then take the screenshots again. Repeat until the water, the hull reflections and the interior lighting look convincingly real.

## ACCEPTANCE CHECKLIST (all must be true before you finish)

- [ ] Golden-hour ocean with realistic waves, glitter, foam and horizon haze
- [ ] A lofted navy hull with correct proportions and real reflections
- [ ] Superstructure, windscreen, radar arch with bimini, rails and teak decks
- [ ] A helm with live instruments
- [ ] Saloon, galley, master cabin, guest cabin and bathroom, all walkable, with working doors
- [ ] No water visible inside the hull
- [ ] The yacht floats and moves with the waves, using the same wave function as the rendering
- [ ] Driving with throttle, steering, planing, wake, spray and engine sound
- [ ] Walking around while the yacht moves, with solid collision and working stairs
- [ ] Walk, helm, chase and photo camera modes; the intro; the help panel; UI hiding; PNG capture
- [ ] Four times of day, including a beautiful night with lights
- [ ] Smooth performance, with a quality setting
- [ ] No console errors
- [ ] README and the npm run shots script
- [ ] All 10 screenshots saved and reviewed

When you finish, report:
- what you built
- the controls
- the file structure
- the screenshot files
- any limitation that remains
