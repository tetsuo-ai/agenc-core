I played the new build by hand and watched the demo at full quality. The controls work now, and the skyline, the wet floor and the rust are much better. Four things still look fake or spoil the video. Fix only these and keep everything else as it is.

1. The aiming view. When I hold aim, the whole screen turns black and the world is only visible through a small round window in the middle, about one sixth of the screen. The demo spends almost half of its time like that, so the video is mostly a black frame. Make aiming look like looking through a real optic on a rifle:
- The magnified picture fills most of the screen: the lens circle is at least 85% of the screen height.
- Around the lens there is a thin scope housing ring with a soft dark eye-relief shadow just inside its edge, and outside the ring the world stays visible, darker and out of focus, never plain black.
- Keep the reticle you have, a little finer. Keep the HUD readable.
- Add a slight breathing sway, a recoil kick of the picture on each shot, and a transition of about 0.2 s. During the transition the rifle model must not show up inside the lens (it does now for a moment).
- Muzzle smoke seen through the optic is drawn as big flat white disks. Make it thin, gray and translucent so it never hides the target.

2. The rifle in the hip view. It is far too big and sits in the middle of the screen: the handguard and the left hand reach the crosshair, and a soldier standing 3 m in front of me is hidden behind the rifle and its optic. It is also built from flat boxes, the left hand is a faceted lump, and the optic is a hollow tube on a thin post.
- Hold it low and to the right like a first-person view from a shouldered carbine: it takes at most the lower right third of the screen, the muzzle points toward the crosshair but stays below it, and nothing of it covers the center of the screen.
- Give it rounded, beveled real shapes: receiver, handguard with rails, stock, grip, magazine, an optic with a body, glass lenses and a solid mount, and a worn finish with edge wear.
- Two gloved hands with separate fingers that grip the handguard and the pistol grip, and sleeves with fabric folds.

3. The enemy soldiers must look like real people. From 3 m they still read as robots: stacked blocks for the torso, thin stick legs made of segments, a box for the head and a helmet shaped like a wide mushroom cap. They are also so dark that they are hard to tell from the background. Aim for the realism of a modern military shooter, with your own original designs:
- Real adult proportions: a head about one seventh of the height, a neck, shoulders wider than the hips, thighs and calves with real volume, natural limb lengths and joints, and hands with fingers wrapped around the weapon.
- One smooth skinned mesh per soldier on a skeleton, with no visible boxes or primitives, deforming cleanly at shoulders, elbows, hips and knees.
- Clothing with folds and seams in muted olive, tan, gray and black, and layered gear: a close-fitting helmet with a cover or a soft cap, balaclava or face mask with goggles or a scarf (no bare plastic faces), plate carrier with magazine pouches, belt, knee pads, gloves and boots. Several variants so they are not clones.
- Physically based materials with normal and roughness detail on fabric, webbing, metal and rubber, and enough light on them that the shape reads clearly against the factory.
- Motion that looks captured from real people: breathing and weight shifts at idle, walk and run cycles with planted feet, crouching, moving into cover, leaning out to fire with both hands on the weapon, recoil on their own shots, reloading, flinching where they are hit, and deaths that fall with weight.
- When a soldier is hit, the whole body flashes bright orange. Remove that flash. Show the hit with a flinch at the place that was hit, a small dark puff and the hit marker.
- Downloaded characters or animations must be CC0 and listed in ASSETS.md; otherwise generate them in code.

4. The demo run. After the second fight the player walks for about ten seconds through a dark side passage with the camera pointed at blank walls, and long stretches show nothing but the rifle. Keep the route and the fights, but make the camera look where a careful player looks: down the path, at doors and corners, across the hall and the yard. Use the hip view between fights and aim only for the shots. The player's health never drops in the whole run; let the enemies land one or two hits so the damage feedback shows. Keep it around a minute, keep the misses, the reload under fire and the cover stops, and keep `?seed=N` repeatable.

Add verify screenshots, all at full quality, and look at each one yourself before you finish: one soldier at about 3 m in good light, two soldiers firing from cover, the hip view and the aiming view at the same spot, and the aiming view while firing at a soldier. If a screenshot still shows a blocky soldier, a rifle that covers the center, or a mostly black aiming view, keep working.

Rebuild, rerun verify.mjs, and update DESIGN.md and VERIFY.md. Do not ask me questions.
