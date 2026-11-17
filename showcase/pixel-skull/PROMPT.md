Build “PIXEL SKULL”: a finished, original pixel-art illustration of a human skull, drawn entirely through code.

Act as both a pixel artist and a frontend engineer. Your main deliverable is the artwork. Spend most of your effort on its silhouette, anatomy, lighting, color clusters, and visual polish.

Make reasonable artistic decisions and complete the implementation without asking follow-up questions.

DELIVERABLE

Create one self-contained index.html containing all HTML, CSS, and JavaScript.

It must work when opened directly in a modern browser, without installation, a package manager, a build step, or a local server. Do not use external libraries, frameworks, fonts, assets, or network requests.

Display the finished illustration immediately and include a working “Download PNG” button. All artwork must be created by your own pixel-drawing code.

Write the actual working file. Do not stop at a plan, pseudocode, or an unfinished scaffold.

ART DIRECTION

Draw a striking human skull facing the viewer.

The visual character should resemble a carefully crafted sprite from a dark fantasy adventure game: weathered ivory bone, rich violet shadows, restrained turquoise reflections, small coral accents, and deep, empty eye sockets.

Use crisp, deliberate pixel edges and a dramatic but controlled lighting scheme. The skull should feel solid, dimensional, and slightly ominous.

Use recognizable human skull anatomy. Give it personality through subtle asymmetry, worn edges, and one small crack. Keep the surrounding composition simple so the skull receives all the attention.

CANVAS AND COMPOSITION

The logical artwork resolution must be exactly 128 × 128 pixels.

Center the skull horizontally and let it occupy approximately 80–85% of the image height. Leave a clear margin around the silhouette. Include the complete cranium, cheekbones, upper teeth, and lower jaw. Keep the artwork clear of the canvas edges.

Use these approximate landmarks as a starting point: the top of the cranium around y = 12, the bottom of the jaw around y = 116, and the horizontal center at x = 64. Place the eye socket centers near (43, 59) and (85, 59), the nasal opening around (64, 78), and the main tooth row around y = 91–101.

These landmarks are compositional guides, not a rigid geometric template. Adjust them when necessary to improve the drawing.

The skull must remain immediately recognizable when viewed at its native 128 × 128 size.

ANATOMY AND SHAPE

Build a broad, rounded cranial dome. Use a deliberate sequence of pixel steps around its contour. Narrow the silhouette around the temples and shape the forehead with several connected planes of light and shadow. Avoid making the head look like a perfect circle or a rounded rectangle.

Create two large, recessed eye sockets beneath a visible brow ridge. Their shapes should be irregular and anatomical, roughly angular ovals. Use dark interior colors, with subtle differences between the upper recesses and lower rims. Suggest the thickness of the bone around each socket. Keep the sockets distinct from the surrounding background and leave both sockets empty.

Draw a clearly visible nasal opening beneath and between the eyes. Use a tapered, roughly inverted triangular shape. A small central division may help suggest the nasal structure. Keep enough bone between the nose and eye sockets for the face to read clearly.

Give both cheekbones a projecting outer edge. Add a small highlight on their upper-facing surfaces and place darker recessed areas beneath them. Use these changes in value to separate the face from the sides of the skull.

Show approximately eight clearly readable upper front teeth, with smaller suggestions toward the sides. Include a subtler lower row. Use individual tooth shapes and narrow dark separations. Vary the widths slightly, making the central incisors broader and the side teeth narrower. Arrange the teeth along a shallow curve. Keep the jaw nearly closed, with a thin dark separation between the rows.

Draw a substantial, connected lower jaw. Show the side angles and a clear chin. Give the underside a darker plane. Ensure the jaw belongs structurally to the skull rather than appearing to float beneath it.

Add one small branching crack on one side of the forehead and a few controlled chips or worn areas. Keep these details sparse and preserve the larger anatomical forms.

EXACT COLOR PALETTE

Use only the following 16 colors in the artwork, including its background. You may leave some colors unused.

Index 0: #090D19, near-black navy for the background and selected deepest darks.

Index 1: #142039, dark blue for subtle background separation and dark edges.

Index 2: #211D35, deep socket shadow.

Index 3: #382848, dark violet.

Index 4: #553657, violet.

Index 5: #76506C, muted purple.

Index 6: #91717E, soft mauve transition.

Index 7: #A88D82, shadowed bone.

Index 8: #BCAA8B, muted ochre.

Index 9: #D4C39C, base ivory.

Index 10: #E9D8AD, illuminated bone.

Index 11: #FFF0C7, brightest highlight.

Index 12: #244D60, deep teal.

Index 13: #377B87, medium teal.

Index 14: #78D6CF, bright turquoise.

Index 15: #C5768D, muted coral.

Most visible bone surfaces should use the ivory and ochre colors. Use violet to describe recessed and shadowed planes. Reserve turquoise for a few reflected edges. Use coral sparingly as a secondary reflected color. Keep the brightest highlights limited to selected surfaces.

Every color change should help describe shape, depth, material, or lighting.

LIGHTING

Place the primary light above and to the left of the skull.

Illuminate the upper-left forehead, upper edges of the brow, left cheekbone, selected tooth surfaces, and small portions of the jaw.

Place deeper shadows on the right temple, inside the eye sockets, beneath the cheekbones, inside the nasal cavity, and along the underside of the jaw.

Add a restrained cool reflection along parts of the right edge.

Build the lighting from solid, connected color clusters. Transitions may use several palette steps, but every logical pixel must have one solid color.

Preserve enough contrast for the main forms to remain readable at native size. The darkest cavities should establish depth, while the brightest highlights should remain small and intentional.

PIXEL CONSTRUCTION

Create the artwork directly on a 128 × 128 integer grid.

Store the image in an indexed pixel buffer. Each cell should contain an integer from 0 to 15 referencing the palette.

Initialize the entire buffer with the background color. Draw the skull silhouette, then add internal anatomical regions, shadow planes, illuminated planes, selective outlines, and final details.

You may use hand-authored pixel coordinates, explicit row data, horizontal scanline fills, integer polygon rasterization, masks, integer line algorithms, small reusable drawing helpers, and mathematical shape tests evaluated at individual grid cells.

Useful helpers might include setPixel(x, y, colorIndex), fillSpan(y, xStart, xEnd, colorIndex), fillPixelPolygon(points, colorIndex), and drawSteppedLine(points, colorIndex).

Choose the implementation structure that gives you the most artistic control. Hand-authored pixel arrays and scanline data are encouraged.

Render the final buffer with ImageData or integer-aligned fillRect calls.

Every final source pixel must be fully opaque and must belong to the provided palette. All artwork coordinates must resolve to the logical pixel grid.

Construct the image at 128 × 128 from the beginning. Do not render a smooth high-resolution illustration and then shrink it to imitate pixel art.

PIXEL-ART CRAFT

Pay close attention to how neighboring pixels form readable shapes.

Use connected clusters of color, deliberate stair-step contours, consistent curves, selective dark outlines, and small highlights placed where the light catches bone. Maintain clear separation between major planes.

Avoid random speckles, large amounts of isolated single-pixel noise, uniformly thick black outlines around every feature, checkerboard texture covering the entire skull, flat rectangular teeth, perfectly circular eye sockets, arbitrary colored patches, and excessive cracks that obscure the anatomy.

Single-pixel details are appropriate for a crack, a tooth separation, or a carefully placed highlight.

Dithering is optional. If used, keep it sparse and localized to a few transitions.

Refine the outer silhouette carefully. Remove accidental bumps, awkward stair-step patterns, and unnecessary protrusions. Let the silhouette carry the basic anatomy before relying on interior details.

BACKGROUND AND PAGE

Use the near-black navy background.

You may add a subtle, hard-edged background shape behind the skull using one additional dark palette color, provided it improves silhouette separation. Keep this element restrained.

Keep the page minimal, with centered artwork, a small “PIXEL SKULL” title outside the canvas, one “Download PNG” button, comfortable spacing, and a dark page background.

Keep interface text outside the artwork. The illustration should dominate the screen.

CRISP DISPLAY

The canvas backing resolution must remain exactly 128 × 128.

On a sufficiently large screen, display it at 768 × 768 CSS pixels, which is a 6× enlargement.

On smaller screens, choose the largest integer scale from 1× to 6× that fits. Preserve the square aspect ratio and avoid fractional CSS scaling.

Use image-rendering: pixelated for display. Set imageSmoothingEnabled to false wherever canvas scaling is performed.

Do not use blur, shadowBlur, smooth gradients, or antialiased vector paths to create the artwork.

Disabling imageSmoothingEnabled does not turn ordinary Canvas curves into integer pixel art. The source drawing itself must respect the pixel grid.

PNG EXPORT

Make the “Download PNG” button export the complete illustration as pixel-skull.png.

The exported image must be exactly 1024 × 1024 pixels.

Create a separate export canvas and enlarge the 128 × 128 artwork by exactly 8×. Disable image smoothing before copying. Preserve the opaque background.

Export only the artwork, without the page title or button.

The exported image must have perfectly crisp pixel boundaries and the same colors as the source.

RESTRICTIONS

All illustrated content must originate from your own code.

Do not use downloaded or embedded reference images, base64-encoded source artwork, SVG artwork, emoji, font glyphs as the skull, icon libraries, stock sprites, image-generation services, external drawing packages, or CSS illustrations used as a substitute for the pixel buffer.

Do not substitute a generic skull symbol for the requested illustration.

VISUAL REVIEW

If browser or screenshot tools are available, open the actual page and inspect the rendered artwork at both its native 128 × 128 size and its enlarged 6× display.

Check that the silhouette immediately reads as a human skull. Confirm that the cranium, cheekbones, teeth, and lower jaw are distinct. Make sure the eye sockets feel recessed and the nasal cavity is clear.

Inspect the teeth individually. Confirm that the lower jaw is connected and substantial. Check that the lighting consistently comes from the upper left and that the turquoise and coral accents remain restrained.

Look for accidental holes, stray pixels, broken contours, awkward anatomical connections, and details that become confusing at native size.

Confirm that the enlarged image retains clean square pixels and that the PNG button downloads the correct 1024 × 1024 image.

Revise the illustration when inspection reveals a problem.

Also verify that the final source buffer uses only the provided palette and contains no partially transparent pixels.

If visual inspection tools are unavailable, still complete the file and clearly state which checks you could not perform.

PRIORITIES AND COMPLETION

First establish a recognizable silhouette and convincing anatomy. Then develop strong lighting and readable color groups. Add carefully placed pixel details after the major forms work. Complete the crisp display and PNG export, then finish the minimal page styling.

Spend the largest share of the effort on the drawing.

Finish with the working index.html and a concise completion message stating what you created and what you actually verified.