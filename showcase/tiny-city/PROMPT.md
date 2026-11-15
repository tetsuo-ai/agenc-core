# Build "Tiny City"

Build **"Tiny City"**, a single-page three.js diorama of a living miniature city that builds, expands, and runs itself. The city sits on a beautiful floating terrain block, with a clean underground cross-section revealing subway tunnels, stations, pipes, and utility networks.

Above ground, tiny citizens walk the sidewalks, cars navigate intersections, construction cranes assemble buildings floor by floor, trains move underground, and neighborhoods gradually transform into a bustling metropolitan skyline.

Everything must be procedural and built entirely in code: no downloaded models, textures, HDRIs, or external assets. Only three.js and its addons from a CDN.

## DELIVERABLE

- A folder `tiny-city/` with `index.html`, `main.js`, and `style.css`.
- Load `three@0.169.0` and its addons using an import map from jsdelivr.
- No npm, no build step, no frameworks.
- Must run with `python3 -m http.server` in current Chrome, Firefox, and Safari.
- Use a seeded random generator. The same seed must generate the same city layout, building styles, citizen schedules, and growth events.
- Display the seed in the HUD and support `?seed=123`.

## THE DIORAMA (stylized low-poly, realistic proportions)

A detailed 180 × 150 m miniature city district sitting on a floating terrain block, approximately 25 m deep underground.

The city is viewed from a beautiful three-quarter isometric perspective.

**Districts and architecture**

- A historic downtown with colorful townhouses, cafés, shops, and a town square.
- A residential neighborhood with small houses, gardens, trees, and playgrounds.
- A commercial district with offices, apartment towers, and glass skyscrapers.
- An industrial corner with warehouses, delivery trucks, and factories.
- A large central park with winding paths, benches, a fountain, and animated trees.
- A construction district with cranes, scaffolding, and unfinished buildings.
- A river along one side with bridges and a small waterfront promenade.

Buildings must have recognizable architectural details: windows, doors, rooftops, balconies, chimneys, awnings, and signs.

Use a coherent miniature aesthetic with warm pastel colors, rounded trees, charming proportions, and carefully designed architectural silhouettes.

**Underground cutaway**

The front edge of the terrain reveals a clean cross-section showing:

- A working underground metro line with stations and platforms.
- Trains moving through tunnels.
- Sewer pipes with flowing water.
- Electrical and water utility networks.
- Underground parking garages.
- Building foundations and support structures.

The underground area should be clearly readable from the default camera angle.

## THE SIMULATION (the city lives by itself)

One in-game day lasts 60 seconds.

The simulation begins with a small settlement and gradually develops into a thriving miniature metropolis over approximately 10 days.

**Citizens**

- Hundreds of tiny low-poly citizens follow daily routines.
- In the morning, citizens leave their homes and travel to work.
- People walk along sidewalks, wait at crosswalks, enter buildings, and visit parks.
- At lunchtime, cafés and public squares become busy.
- In the evening, residents return home and apartment windows light up.
- Citizens must follow connected paths rather than randomly moving through buildings.

**Traffic and transportation**

- Cars, taxis, buses, delivery trucks, and bicycles navigate a functional road network.
- Traffic lights change at intersections.
- Cars stop at red lights and avoid collisions.
- Buses stop at designated stations.
- Subway trains move between underground stations, stopping to collect passengers.
- Pedestrians wait at crossings when traffic is moving.
- Vehicle movement should be smooth and visually convincing.

**Construction and city growth**

The city must visibly evolve.

- Empty lots become construction sites.
- Cranes rotate and lift construction materials.
- Buildings grow floor by floor, with animated scaffolding.
- Small houses gradually give way to apartment buildings.
- Roads extend into new neighborhoods.
- More citizens, cars, and businesses appear as the city expands.
- Skyscrapers emerge in the commercial district.
- Parks, streetlights, and public infrastructure are added automatically.

Every day should introduce a visible change to the skyline.

Construction must happen through actual geometry changes, not simply swapping an entire city model.

**Economy**

- Citizens generate tax revenue through homes and jobs.
- Businesses produce goods and income.
- Construction costs money.
- The city automatically chooses upgrades based on its budget and population.
- Possible upgrades: new housing, offices, roads, metro stations, parks, hospitals, and skyscrapers.
- The simulation should balance residential, commercial, and industrial development.

**Dynamic events**

Occasionally, events make the city feel alive:

- A fire truck responds to a small building fire.
- An ambulance drives to a hospital.
- A traffic jam forms and eventually clears.
- Rainstorms cause citizens to carry umbrellas.
- A festival fills the town square with colorful lights.
- Construction projects temporarily close a road.
- A subway train arrives as passengers gather on the platform.

Events must be deterministic for a given seed.

## DAY / NIGHT CYCLE

A complete day lasts 60 seconds.

**Morning:** warm sunrise, long shadows, commuters leaving home, shops opening.

**Noon:** bright sunlight, busy streets, active construction sites, bustling parks.

**Evening:** golden-hour lighting, people returning home, streetlights beginning to turn on.

**Night:** deep blue atmosphere, thousands of glowing windows, headlights moving along the streets, neon signs, illuminated metro stations, and stars in the sky.

Buildings should have independently controlled window illumination patterns so the skyline feels organic.

Weather occasionally changes between clear skies, clouds, and rain.

## INTERACTION AND HUD

A small minimalist HUD at the top displays:

- Population
- Money
- Buildings
- Traffic
- Happiness
- Day number
- Current time

Controls:

- Pause / resume
- Speed 1x / 2x / 4x
- New seed
- Toggle underground visibility
- Toggle construction overlay

Hovering over buildings reveals their name, type, residents, and construction status.

Hovering over moving vehicles reveals their role and destination.

Clicking a building smoothly focuses the camera on it.

Use OrbitControls with sensible zoom and rotation limits. The camera gently auto-rotates when idle.

## FILM MODE

With `?film=1`, hide the HUD and play a deterministic 25-second cinematic camera sequence.

The entire film must be reproducible from the seed and frame-clock time.

**Camera timeline**

- **0–4 seconds:** Wide cinematic establishing shot at sunrise. The camera slowly orbits a quiet miniature city while the first citizens leave their houses.
- **4–8 seconds:** Descend toward downtown. Follow a busy street with cars stopping at traffic lights and pedestrians crossing.
- **8–12 seconds:** Glide toward a construction site. A crane lifts materials while a skyscraper visibly grows several floors.
- **12–16 seconds:** Move through the terrain cutaway into the underground metro system. Follow an illuminated train as it enters a station.
- **16–20 seconds:** Rise back above ground at golden hour, passing the central park and waterfront as the city becomes increasingly illuminated.
- **20–25 seconds:** Pull back to a breathtaking wide night view showing the fully developed skyline, illuminated windows, moving headlights, metro tunnels, and glowing streets.

The ending should look like a living miniature metropolis inside a beautifully crafted architectural model.

No random camera jumps.

Camera position, simulation state, lighting, and animation must be deterministic functions of the film clock.

## QUALITY BAR

The experience must look like a polished interactive artwork, not a generic procedural geometry demo.

- Beautiful stylized low-poly / toon-shaded visual design.
- Soft ambient lighting and contact shadows.
- Warm, carefully harmonized colors.
- Smooth animations with natural easing.
- Detailed architecture without unnecessary polygons.
- No pure white or pure black.
- No z-fighting, flickering shadows, or obvious geometry intersections.
- Roads and sidewalks align precisely.
- Vehicles stay on roads.
- Citizens stay on sidewalks and designated public areas.
- No floating objects or disconnected terrain.
- Buildings have proper foundations.
- Underground tunnels and metro stations align with surface infrastructure.
- Smooth antialiased rendering.

**Performance target**

60 fps at 1080p on a 2020 laptop.

- Use InstancedMesh for windows, trees, streetlights, citizens, and repeated architectural elements.
- Reuse shared geometries and materials.
- Cap pixel ratio at 2.
- Reduce particle counts, shadow resolution, and citizen density on mobile.
- Avoid allocating unnecessary objects inside the animation loop.
- Use simplified distant buildings where necessary.

## PROCESS

1. Plan the city layout, road graph, pedestrian paths, metro system, building generator, economy, simulation state machine, and rendering architecture before writing code.

2. Build the environment in small steps. After every major step, serve the folder and take headless Chrome screenshots at sunrise, noon, dusk, and night, plus a close-up of the underground metro and a construction site. Use `--use-angle=swiftshader` if headless WebGL is unavailable. Save screenshots in `tiny-city/shots/`. Inspect them visually and fix issues before continuing.

3. Run the simulation headless at 4x speed for 5 in-game days. Confirm that population increases, buildings are constructed, the economy remains functional, vehicles follow valid routes, metro trains operate, and nothing becomes permanently stuck. Log HUD values and major simulation events.

4. Verify that the same seed produces identical building placement and city growth. Test `?seed=123` and `?film=1`.

5. Finish with a short README explaining how to run the project, the controls, the simulation, film mode, seeded generation, and which elements are procedural.

## FINAL ACCEPTANCE CRITERIA

The result should feel like watching a real city inside a tiny magical world.

The viewer should be able to leave the browser running and watch the city continuously develop, with visible construction, functioning traffic, citizen activity, public transportation, and a beautiful transition from day to night.

The city should feel alive even when the user does nothing.

Prioritize visual polish, believable movement, deterministic behavior, and a cohesive miniature-world aesthetic over unnecessary complexity.

At the end, list all screenshot paths, the results of the 5-day simulation test, and anything that could not be completed correctly.