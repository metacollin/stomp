# stomp live

A browser demo of stomp. Write stomp on the left, and the land pattern on the right
redraws as you type: copper, paste, mask, drills, silk, courtyard and fab layers, with
pad numbers. Put the cursor on a placement and its dimension is drawn on the footprint:
`pad 3 is 4.56 right of pad 1` shows the 4.56 between the two pad centers. Switch to
**3D** and the same source shows the part's model, sitting on a board with its copper,
silk and courtyard.

Everything runs in the browser, in plain JavaScript with no dependencies and no build
step. The page works straight from disk.

## Running it

- **From disk:** open `demo/index.html` in a browser.
- **Served:** `python3 -m http.server -d demo 8000`, then visit <http://localhost:8000>.
  You can also publish the `demo/` folder as it is, for example on GitHub Pages.
- **Single file:** `node demo/tools/build.mjs --bundle stomp-live.html` puts every
  script and style into one HTML page you can send around.

The example picker loads the files in [`examples/`](../examples/), with the libraries
(`*_library.stomp`) in a group of their own that opens on the Library view. Your edits
to each example are kept in the browser's local storage, and **Reset** restores the
original.

## Using it

- Type on the left. The preview recompiles about 120 ms after you pause. Errors are
  underlined, marked in the gutter and listed under **Problems**. Click one to jump to it.
- The statement under the cursor highlights the objects it creates or moves, and a
  placement draws its dimension. **Constraints** in the layer bar draws every placement
  at once.
- Hover over a pad to see its size, position, mask and paste. The statements behind it
  light up in the editor. Click a pad, or a row of the pad table, to jump to its
  definition.
- Drag to pan, scroll or pinch to zoom, and double-click to fit. The preview follows the
  footprint the cursor is in. With more than five footprints, the tabs become a dropdown
  grouped by table.
- **Library** shows every footprint in the file as thumbnails, grouped by the table that
  made them. Click one to open it, or move the cursor through a table's rows to step
  through their footprints.
- **3D** shows the model that the body, pins and lead form describe (SPEC §13). Drag to
  orbit, shift-drag or right-drag to pan, scroll or pinch to zoom, and double-click to
  reset. The bar below it has preset views. Seen from below, the board turns see-through
  so you can check balls and terminals. The statement under the cursor tints the parts
  it makes: with the cursor on `lead 1, 3 gullwing ...`, those two leads light up.
  **VRML** downloads a `.wrl` for KiCad (0.1-inch units) and **STL** a binary STL in
  millimeters. When the page is embedded in a host that saves files for it (the bundle
  built with `--fragment`), **Save .zip** saves both in one archive. With no such host,
  **Copy VRML** copies the text instead.
- **Export to KiCad** saves every footprint in the file as a KiCad library: a zipped
  `.pretty` folder with one `.kicad_mod` per footprint and a README. Each footprint
  carries its own 3D model, so there's no model folder. Footprints with errors are left
  out and listed. When embedded, the page saves the zip through its host. Where nothing
  can be saved, the button copies the current footprint's `.kicad_mod` instead.
- A syntax error in the footprint you're editing usually means a half-typed line, so the
  preview keeps the last version that parsed, dimmed, until the line is complete. Other
  errors, such as an over-constrained pad, still draw live.
- Editor keys: <kbd>Tab</kbd> and <kbd>Shift</kbd>+<kbd>Tab</kbd> indent,
  <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>/</kbd> toggles comments, and <kbd>Esc</kbd> then
  <kbd>Tab</kbd> moves focus out of the editor.

## What's implemented

The engine prototypes the whole draft, from `grammar.peg` to finished layers:

| file | what it does |
|---|---|
| `js/lexer.js` | tokens, as the grammar defines them: attached unit suffixes and side marks, `1..4` ranges, hyphenated keywords and the newline rules (SPEC §4) |
| `js/parser.js` | recursive descent in `grammar.peg`'s choice order; recovers from errors one statement at a time |
| `js/compile.js` | units (per file, footprint or template), `let` and `{...}` interpolation; custom features; templates, `from` calls, `footprints from` tables and `extends`; the `pins`, `balls` and side-block generators with every numbering scheme, plus `omit`, `only` and `delete`; IPC-style pad sizing and per-pin leads; the placement solver (§9); mask, paste windows, vias, automatic silk, courtyard and assembly, pin-1 and polarity marks; `model` blocks merged down `extends`; diagnostics (§15); a build cache |
| `js/model3d.js` | the 3D model (SPEC §13): a body for each lead form (molded with draft, sawn, chip, MELF, BGA, DIP, header, can, axial, module), swept gull-wing, J and L-bend leads, straight leads, terminals, balls, solder columns, pins and wires, bare polymer cans, pin-1 and polarity marks, extra solids; the board under it; VRML and STL export |
| `js/kicad.js` | KiCad 9 export: footprints (`.kicad_mod`) with the 3D model embedded, and whole `.pretty` libraries |
| `js/geom.js` | exact outlines (lines and arcs), offsets, hulls, silk clipping, triangulation |
| `js/view.js` | SVG viewer: layers at true width, pan and zoom, hover details, dimension overlays |
| `js/view3d.js` | WebGL viewer: one merged buffer, lights that follow the camera, shiny metals, orbit, pan and zoom, preset views, highlights from the cursor |
| `js/editor.js` | a code editor with no dependencies: a textarea over highlighting from the lexer |
| `js/app.js` | ties it all together; examples and saved edits |
| `js/examples.js` | **generated** from `examples/*.stomp` by `tools/build.mjs` |

Not covered: `step` files aren't loaded. A footprint that names one shows the generated
model instead, and its KiCad export points to the file rather than embedding a model.
Castellated leads get a temporary land (SPEC §17.7). Export is for KiCad 9 and later only.

## KiCad export

A footprint becomes a KiCad 9 `.kicad_mod` (pcbnew file version 20241229):

- **Coordinates.** KiCad's y axis points down, so y is flipped. Angles still turn the
  same way on screen. A rectangular, rounded or oval pad turned 90° is written unturned
  with its sides swapped, as KiCad's own libraries do.
- **Pads.** `rect`, `roundrect` (radius as `roundrect_rratio`), `circle` and `oval` map
  directly. D-shapes and polygons become custom pads with one polygon. Drills and slots,
  NPTH holes, and castellated (`pad_prop_castellated`), BGA (`pad_prop_bga`) and
  heatsink (`pad_prop_heatsink`) pads carry over. A `mask` or `paste` override becomes
  the pad's `solder_mask_margin` or `solder_paste_margin`. stomp's default 0.05 mm mask
  expansion is left to the board setting, as KiCad's library conventions ask. Divided
  paste becomes paste-only pads, one per window, and thermal vias become tented plated
  holes with the pad's number.
- **Graphics.** Silk, fab and courtyard outlines, marks and texts go to `F.SilkS`,
  `F.Fab` and `F.CrtYd`. The fab label is KiCad's `${REFERENCE}`. Reference sits above
  the courtyard and Value below it, unless the source placed them with `text ref` or
  `text value`. Item UUIDs come from the footprint's name, so exporting twice gives
  identical files.
- **The 3D model** is embedded the way KiCad 9 embeds files: VRML in KiCad's 0.1-inch
  units, in a zstd frame of stored blocks, base64-encoded between `|` marks, with
  KiCad's checksum (its MurmurHash3 variant, seed `0xABBA2345`), and referenced as
  `kicad-embed://NAME.wrl`. Repeated parts (balls, terminals, identical leads) are
  written once and reused with VRML's `USE`, so even a BGA's model is about 14 kB.

There was no KiCad install to load the files, so this is how the export was checked:

- The format, the checksum and the VRML reader's `DEF`/`USE` support come from KiCad 9's
  source.
- The checksum code reproduces all 45 checksums of the embedded files in KiCad's own
  *vme-wren* demo library.
- The zstd frames decode with libzstd and declare their size, as KiCad's loader requires.
- Every word the exporter writes is in KiCad 9's keyword list.

The tests repeat the decode-and-checksum step on every example. One KiCad quirk is kept
on purpose: its checksum ignores a final 12-15 bytes it can't fill out to 16, so
"Hello, World!" checksums like any other 13-byte input.

## Tests

```sh
node --test demo/test/*.test.mjs     # engine, 3D and KiCad tests
node demo/tools/build.mjs            # rebuild js/examples.js after editing examples/
```

The tests check:

- hand-calculated geometry for the relational examples (TO-252, USB micro-B, the syntax
  zoo), the generators, interpolation and tables, side marks and units in footprints;
- rectangular courtyards, custom features, the L-bend, straight and column lead forms,
  and which end the polarity marks go on;
- that every library builds with no warnings and unique names;
- the diagnostics and where they point;
- that `js/examples.js` matches `examples/`;
- that half-typed and mangled versions of every example don't break the compiler, and
  that random edits never make the build cache change a result;
- for 3D: each example's model is finite and wound consistently; measured parts
  (gull-wing toes at the span, terminals flush with the body, balls collapsed to the
  standoff, leads 3 mm below the board); per-pin leads and their lands; the `model`
  block and its diagnostics; both export formats; and fuzzing of the model builder;
- for KiCad: the checksum against MurmurHash3's published test value and fixed vectors;
  zstd frames that round-trip; every example's export parsed as KiCad would (keywords,
  unique UUIDs, pads and their properties, margins, paste windows, via pads); and each
  embedded model decoded back to VRML with a matching checksum.

## Performance

The file recompiles every time you pause typing, so big libraries need two things:

- **A build cache.** Each footprint's result is cached under the text it is built from:
  its template, its arguments and the file's `let`s. Editing or adding one row of a
  table rebuilds only that row. A row's position isn't part of its key, so the rows below
  an edit stay cached and their diagnostics move with them.
- **Lazy layers.** Automatic silk, assembly and courtyard geometry, the slow part, is
  computed when a footprint is first drawn. Anything that can report a problem still
  runs on every compile.

For a 150-row QFN table in Chromium, a cold compile takes about 165 ms, and typing in
one row recompiles in about 6 ms. Editing the template rebuilds every row.

## Semantic decisions

The draft leaves some meanings open. The demo picks these, and the page's
**How it works** dialog lists them too.

1. **Generated pads are sized across × along.** For `pins ...` generators, `W x L` means
   the width across the row by the length along the lead. Each side's pads turn to face
   outward. Without this, `default pad rect 0.6 x 2.2` (SOIC-8-HS) would overlap its
   neighbors, and the DIP's oval pads would run along the row. Pads placed by hand keep
   the literal reading (`W` is the x size).
2. **The origin rule places floating layouts.** A footprint placed only by relations,
   like TO-252, has nothing fixed to start from, so a literal reading of §9.7 would call
   its first pad under-constrained. The solver places each connected group from one free
   object, then §6's origin rule (the body center, else the land-pattern center) fixes
   where it all sits. Only a group that floats free of an anchored layout is an error.
3. **One coordinate frame.** `at (x, y)`, mirror axes, generator defaults and graphics
   all use one frame, and `origin` then moves the finished footprint. ZOO-GRID's
   courtyard polygon needs this: it only encloses its pads in the frame before
   `origin at (0, -25)`.
4. **One placement per axis, taken literally.** Each axis of each object takes exactly
   one strong placement. Weak sources fill in the rest, in this order: §9.2's cross-axis
   alignment, then generator defaults, then centering the body on the land pattern. A
   child footprint's placement replaces an inherited one instead of over-constraining it
   (§14).
5. **`span`, `gap` and `pitch` pairs.** For a mirrored pair, the measurement places the
   prototype (§9.4). Otherwise it places whichever object is still free, with B on the
   positive side of A, along the axis given by the mirror, an `align`, or an explicit
   `horizontally` or `vertically`.
6. **IPC-style lands** use the IPC-7351B fillet goals for each lead form and density,
   with nominal part dimensions only (no part tolerances), F = 0.05 mm and
   P = 0.025 mm. Corners are rounded at 25% (at most 0.25 mm). Ball lands are 80% of
   the ball. Through-hole drills are the lead plus 0.15 to 0.25 mm. Mask expansion
   defaults to 0.05 mm per side.
7. **Courtyards are always one rectangle** (SPEC §12): the automatic one is the
   smallest rectangle around the lands and body, plus the clearance. Silk and assembly
   blocks add to their automatic layers, as §12 describes.
8. **Two grammar extensions.** `omit` and `only` take name ranges (`only 1..5`, used in
   the syntax zoo), and sizes can be written without spaces (`0.6x1.5`).
9. **Interpolation output.** Numbers print in their shortest form, up to 6 decimals, so
   `0.5`, `3.45` and `32` print as written. Lengths print in the file's `units`, and
   `{x:.N}` sets N decimals.
10. **Where template errors go.** A problem in a template body that only some calls hit
    (say, a pin count that isn't a multiple of 4) is reported on those table rows or
    calls, pointing back at the template line. A problem every call shares is reported
    once, at the template.
11. **The body's height is the seated height** (JEDEC *A*), from the board to the top
    of the part, and the body sits on its standoff (*A1*). Each lead form picks a
    standoff and a body: 0.1 mm under a molded gull-wing body, 0.02 mm under a sawn
    leadless block, three quarters of the ball under a BGA (SPEC §13.1 has the table).
    Lead thickness follows the pitch: 0.15 mm below 1 mm, 0.2 mm up to 2 mm, 0.3 mm
    above.
12. **A gull-wing's foot is shortened if the bend needs the room.** SOIC-8 gives
    `lead gullwing 0.41 x 1.04 span 6.0`, and 1.04 is the whole lead beyond the 3.9 mm
    body. Taken as the foot alone, it would leave no room to bend down, so the model's
    foot is 0.79 mm and the rest is the bend. The lands still use the full 1.04.
13. **Per-pin leads.** `lead 4 gullwing 3.0 x 0.9` sizes pin 4's land from its own
    lead, on the same span, wherever that pin's land came from the lead in the first
    place. In land mode, where explicit pads keep their sizes, per-pin leads only add
    leads to the model.
14. **A cylinder body lies down when its pins can't leave its bottom:** always for
    endcaps (a MELF), and for wire leads outside the circle (an axial part). In 2D it
    is then a rectangle, with its length along the pins and its diameter across.
15. **The polarity marks follow the part family** (SPEC §13.1). The cathode of a diode
    or LED and the negative lead of a can are pin 2, but a chip or molded capacitor's
    band marks pin 1, the way tantalums are marked. The silk bar and the 3D stripe go on
    the same end.
16. **Model blocks merge down `extends`.** A child's `model { standoff 0.2 }` changes
    one setting and keeps the parent's solids. `no model` ends the model at that level.

## Notes on the spec from implementing it

- **TO-252 needed one more line.** Under §9.2, `body bottom is 1.1 above pad 1` also
  weakly lines up the body's center with pad 1. Nothing else placed the body
  horizontally, so it sat over pin 1 instead of the tab. The example now says
  `body is centered on pad 2 horizontally`. This is a real case for open question 2.
- `only 1..5` in the syntax zoo isn't allowed by `region_or_name` in `grammar.peg`,
  which takes only names, `rows ...` and `cols ...`.
- §6 says all coordinates are relative to the final origin, but `origin at (x, y)` can't
  be relative to itself. ZOO-GRID's courtyard implies the reading in decision 3.
- `dshape` needs a default flat side (the demo uses `left`). It also needs a rule for
  when the round end doesn't fit: `dshape 0.6 x 1.5 flat left` asks for a 0.75 mm radius
  in a 0.6 mm width. The demo caps the radius.
- In ZOO-DUAL, `pad "TP1" is 60 left of side left outer` uses the left row's edge facing
  away from TP1, which is its right edge, by §8.2. TP1 then just touches pin 9. If the
  intent was "60 left of the row's outer edge", the anchor would be `inner`.
- ZOO-SHAPES has overlapping pads (5 and 7, 4 and 9). The demo reports them as §15
  suspicious-geometry warnings.
- §11.3's `lead tab ... (becomes highest-numbered pin unless named)` reads as an extra
  pin, but `lead` describes the pins a generator already made. The demo treats a general
  `lead tab` like a flat terminal, and a per-pin `lead 2 tab` as a slab under pad 2,
  which is how the DPAK example models its drain tab.
- The old `model` block had only `pin1 dimple|stripe`. A DIP's notch and a QFN's laser
  dot need their own names, so the block now takes `dimple`, `dot`, `notch`, `stripe`
  and `none`, and defaults from the footprint's `pin1` where it can.
