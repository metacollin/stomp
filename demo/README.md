# stomp live

A browser demo of stomp. Write stomp on the left, and the land pattern on the right
redraws as you type: copper, paste, mask, drills, silk, courtyard and fab layers, with
pad numbers. Put the cursor on a placement statement and its dimension is drawn on the
footprint. `pad 3 is 4.56 right of pad 1` shows the 4.56 between the two pad centres.
Switch to **3D** and the same source shows the part's generated model, sitting on a
board with its copper, silk and courtyard.

Everything runs client-side in plain JavaScript with no dependencies and no build step.
The page works opened straight from disk.

## Running it

- **From disk:** open `demo/index.html` in a browser.
- **Served:** `python3 -m http.server -d demo 8000`, then visit <http://localhost:8000>.
  The `demo/` folder can also be published as-is, for example on GitHub Pages.
- **Single file:** `node demo/tools/build.mjs --bundle stomp-live.html` inlines every
  script and style into one HTML page you can send around.

The example picker loads the files in [`examples/`](../examples/). Your edits are kept per
example in the browser's local storage, and **Reset** restores the original.

## Using it

- Type on the left. The preview recompiles about 120 ms after you pause. Errors are
  underlined, marked in the gutter and listed under **Problems**. Click one to jump to it.
- The cursor's statement highlights the objects it creates or moves, and placements draw
  their dimension. **Constraints** in the layer bar draws every placement at once.
- Hover a pad for its size, position, mask and paste; the statements behind it light up
  in the editor. Click a pad, or a row of the pad table, to jump to its definition.
- Drag to pan, scroll or pinch to zoom, double-click to fit. The preview follows whichever
  footprint the cursor is in. With more than five footprints the tabs become a dropdown
  grouped by table.
- **Library** shows every footprint in the file as a thumbnail gallery, grouped by the
  table that made it. Click one to open it, or move the cursor through a table's rows to
  step through the footprints they make.
- **3D** shows the model the body, pins and lead form describe (SPEC §13). Drag to orbit,
  shift-drag or right-drag to pan, scroll or pinch to zoom, double-click to reset; the bar
  under it has preset views, and from below the board turns see-through so you can check
  balls and terminals. The statement under the cursor tints the parts it makes, so the
  cursor on `lead 1, 3 gullwing …` lights up those two leads. **VRML** downloads a `.wrl`
  for KiCad (0.1-inch units) and **STL** a binary STL in millimetres. Embedded in a host
  that saves files for the page (the bundle built with `--fragment`), **Save .zip** saves
  both in one archive; with no such host, **Copy VRML** copies the text instead.
- **Export to KiCad** saves every footprint in the file as a KiCad library: a zipped
  `.pretty` folder with one `.kicad_mod` per footprint and a README. Each footprint carries
  its generated 3D model inside it, so the library needs no 3D model folder; footprints
  with errors are left out and listed. Embedded, the page saves the zip through its host;
  where nothing can be saved, the button copies the shown footprint's `.kicad_mod`.
- A syntax error inside the footprint you're editing usually means a half-typed line. The
  preview then keeps the last version that parsed, dimmed, until the line is complete.
  Semantic errors, such as an over-constrained pad, still draw live.
- Editor keys: <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> indent,
  <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>/</kbd> toggles comments, and <kbd>Esc</kbd> then
  <kbd>Tab</kbd> moves focus out of the editor.

## What's implemented

The engine is a complete prototype of the draft, from `grammar.peg` to finished layers:

| file | role |
|---|---|
| `js/lexer.js` | tokens per the grammar's lexical layer: attached unit suffixes, `1..4` ranges, hyphenated keywords, newline rules from SPEC §4 |
| `js/parser.js` | recursive descent following `grammar.peg`'s ordered choices, with per-statement error recovery |
| `js/compile.js` | units and `let`; text values and `{…}` interpolation; templates as functions (`name`), `from` calls, `footprints from` tables, `extends`; `pins`/`balls`/side-block generators with every numbering scheme, `omit`/`only`/`delete`; IPC-style pad synthesis, per-pin leads; the §9 constraint solver; mask, paste windowpanes, vias, auto silk/courtyard/assembly, pin-1 and polarity marks; `model` blocks merged down `extends`; §15 diagnostics; an incremental build cache |
| `js/model3d.js` | the 3D model (SPEC §13): a body per lead form (molded with draft, sawn, chip, MELF, BGA, DIP, header, can, axial, module), swept gull-wing and J leads, terminals, balls, pins and wires, pin-1 and polarity marks, extra solids; the board under it; VRML and STL export |
| `js/kicad.js` | KiCad 9 export: footprints (`.kicad_mod`) with the 3D model embedded, and whole `.pretty` libraries |
| `js/geom.js` | exact outlines (lines plus arcs), offsets, hulls, silk clipping, triangulation |
| `js/view.js` | SVG viewer: true-width layers, pan/zoom, hover inspection, constraint overlays |
| `js/view3d.js` | WebGL viewer: one merged buffer, camera-fixed lighting with shiny metals, orbit/pan/zoom, preset views, highlight by source range |
| `js/editor.js` | dependency-free code editor: a textarea over lexer-driven highlighting |
| `js/app.js` | wiring, examples, persistence |
| `js/examples.js` | **generated** from `examples/*.stomp` by `tools/build.mjs` |

Not covered: `step` files aren't loaded (a footprint that names one shows its generated
stand-in, and its KiCad export refers to the file instead of embedding a model),
castellated leads draw a provisional land (SPEC §17.7), and export is to KiCad 9 and
later only.

## KiCad export

A footprint becomes a KiCad 9 `.kicad_mod` (pcbnew file version 20241229):

- **Coordinates.** KiCad's y axis points down, so y is negated; angles keep their sense
  on screen. A rectangular, rounded or oval pad turned a quarter is written unturned with
  its sides swapped, as KiCad's own libraries do.
- **Pads.** `rect`, `roundrect` (radius as `roundrect_rratio`), `circle` and `oval` map
  directly; D-shapes and polygons become custom pads with one polygon primitive. Drills
  and slots, NPTH holes, castellated (`pad_prop_castellated`), BGA (`pad_prop_bga`) and
  heatsink (`pad_prop_heatsink`) pads carry over. A `mask` or `paste` override becomes the
  pad's `solder_mask_margin` / `solder_paste_margin`; stomp's default 0.05 mm mask
  expansion is left to the board's setting, as KiCad's library conventions ask. Divided
  paste becomes paste-only pads, one per window, and thermal vias become tented plated
  holes with the pad's number.
- **Graphics.** Silk, fab and courtyard outlines, marks and texts go to `F.SilkS`,
  `F.Fab` and `F.CrtYd`. The fab label is KiCad's `${REFERENCE}`; Reference sits above
  the courtyard and Value below it unless the source placed them with `text ref` /
  `text value`. Item UUIDs are derived from the footprint's name, so exporting twice
  gives identical files.
- **The 3D model** is embedded the way KiCad 9 embeds files: VRML in KiCad's 0.1-inch
  units, wrapped in a zstd frame of stored blocks, base64-encoded between `|` marks, with
  KiCad's checksum (its MurmurHash3 variant, seed `0xABBA2345`), and referenced as
  `kicad-embed://NAME.wrl`. Repeated parts (balls, terminals, identical leads) are written
  once and reused with VRML's `USE`, so even a BGA's model is about 14 kB.

How this was checked, without a KiCad install to load the files: the format, the
checksum and the VRML reader's support for `DEF`/`USE` were read from KiCad 9's source;
the checksum code reproduces all 45 checksums in the embedded files of KiCad's own
*vme-wren* demo library; the frames decode with libzstd and declare their size, as
KiCad's loader requires; and every word the exporter writes is in KiCad 9's keyword
list. The tests repeat the decode-and-checksum step on every example. One quirk carries
over on purpose: KiCad's checksum ignores a final 12-15 bytes it can't fill out to 16, so
"Hello, World!" checksums like any other 13-byte input.

## Tests

```sh
node --test demo/test/*.test.mjs     # engine and 3D tests: geometry, numbering, diagnostics, fuzzing
node demo/tools/build.mjs            # regenerate js/examples.js after editing examples/
```

The suite checks hand-calculated geometry for the relational examples (TO-252, USB
micro-B, the syntax zoo), the generators, interpolation and tables, the diagnostics and
their locations, and that `js/examples.js` matches `examples/`. It also fuzzes the
compiler with half-typed and mangled versions of every example, and checks over
sequences of random edits that the build cache never changes a result. The 3D tests
check each example's model is finite and consistently wound, measure the generated parts
(gull-wing toes at the span, terminals flush with the body, balls collapsed to the
standoff, leads 3 mm below the board), per-pin leads and their lands, the `model` block
and its diagnostics, and both export formats, and fuzz the model builder too. The KiCad
tests check the checksum against MurmurHash3's published test value and fixed vectors,
round-trip the zstd frames, parse every example's export as KiCad would (keywords,
unique UUIDs, pads and their properties, margins, paste windows, via pads) and decode
each embedded model back to VRML with a matching checksum.

## Performance

Footprint files are recompiled on every pause in typing, so big libraries need two
things:

- **A build cache.** Each footprint's result is cached under the text it is built from:
  its template, its arguments and the file's `let`s. Editing one row of a table, or
  adding one, rebuilds only that row. A table row's own position isn't part of its key,
  so rows below an edit stay cached, and their row-local diagnostics move with them.
- **Lazy layers.** Automatic silk, assembly and courtyard geometry, the costly part, is
  computed when a footprint is first drawn. Anything that can report a problem still
  runs on every compile.

For a 150-row QFN table in Chromium, a cold compile takes about 165 ms, and typing in
one row recompiles in about 6 ms. Editing the template rebuilds every row.

## Semantic decisions

The draft leaves some meanings open. The demo picks the following, and the page's
**How it works** dialog lists them too.

1. **Generated pads are sized across × along.** For `pins …` generators, `W x L` means
   width across the row by length along the lead. Each side's pads are rotated to face
   outward. Without this, `default pad rect 0.6 x 2.2` (SOIC-8-HS) would overlap its
   neighbours, and the DIP's oval pads would run along the row. Explicitly placed pads
   keep the literal reading (`W` = x extent).
2. **Floating layouts are anchored by the origin rule.** A purely relational footprint
   like TO-252 has no absolute anchor, so a literal reading of §9.7 would report its
   first pad as under-constrained. The solver places each connected group relative to
   one free object, and §6's origin rule (body centroid, else land-pattern centre) fixes
   the translation. Only a group that floats free of an anchored layout is an error.
3. **One coordinate frame.** `at (x, y)`, mirror axes, generator defaults and graphic
   coordinates all share one frame, and `origin` re-bases the finished footprint. This is
   what ZOO-GRID's courtyard polygon needs: it only encloses its pads when read in the
   frame before `origin at (0, -25)`.
4. **Single assignment per axis, implemented literally.** Each object axis takes exactly
   one strong placement. Weak sources fill the rest, in this order: §9.2 cross-axis
   alignment, then generator defaults, then the body centred on the land pattern. A
   later inheritance level replaces an inherited placement instead of over-constraining
   it (§14).
5. **`span`/`gap`/`pitch` pairs.** For a mirrored pair the measurement places the
   prototype (§9.4). Otherwise it places whichever object is still free, with B on the
   positive side of A, along the axis given by the mirror, an `align`, or an explicit
   `horizontally`/`vertically`.
6. **IPC-style lands** use IPC-7351B fillet goals per lead form and density, with nominal
   part dimensions only (no part tolerances), F = 0.05 mm and P = 0.025 mm. Corners are
   rounded at 25% (capped at 0.25 mm). Ball lands are 80% of the ball. Through-hole drills
   are the lead plus 0.15–0.25 mm. Mask expansion defaults to 0.05 mm per side.
7. **Courtyards.** A `courtyard { … }` block replaces the automatic courtyard. Silk and
   assembly blocks add to theirs, as §12 describes.
8. **Two grammar extensions.** `omit`/`only` accept name ranges (`only 1..5`, as the
   syntax zoo uses), and sizes may be written without spaces (`0.6x1.5`).
9. **Interpolation output.** Numbers print in their shortest form, up to 6 decimals, so
   `0.5`, `3.45` and `32` print as written. Lengths print in the file's `units`, and
   `{x:.N}` fixes the decimals.
10. **Where template errors go.** A problem inside a template body that only some calls
    trigger (say a pin count that isn't a multiple of 4) is reported on those table rows
    or calls, pointing back at the template line. A problem every call shares is
    reported once, at the template.

11. **The body's height is the seated height** (JEDEC *A*), from the board to the top
    of the part, and the body sits on its standoff (*A1*). Each lead form picks a
    standoff and a body: 0.1 mm under a molded gull-wing body, 0.02 under a sawn
    leadless block, three quarters of the ball under a BGA (SPEC §13.1 has the table).
    Lead thickness follows the pitch: 0.15 mm below 1 mm, 0.2 up to 2 mm, 0.3 above.
12. **A gull-wing's foot is shortened if the bend needs the room.** SOIC-8 gives
    `lead gullwing 0.41 x 1.04 span 6.0`, and 1.04 is the whole lead beyond the 3.9 mm
    body. Taken as the foot alone, it would leave no room to bend down, so the model's
    foot is 0.79 mm and the rest is the bend. The lands still use the full 1.04.
13. **Per-pin leads.** `lead 4 gullwing 3.0 x 0.9` re-derives pin 4's land from its own
    lead, on the same span, wherever that pin's land was derived at all. In land mode,
    where explicit pads keep their sizes, per-pin leads only add leads to the model.
14. **A cylinder body lies down when its pins can't leave its bottom:** always for
    endcaps (a MELF), and for wire leads that sit outside the circle (an axial part).
    It is then a rectangle in 2D, its length along the pins and its diameter across.
15. **The polarity stripe follows the part family:** the cathode of a diode or LED and
    the negative lead of a can are pin 2, but a chip capacitor's band marks pin 1, as
    tantalums are marked (SPEC §17.12).
16. **Model blocks merge down `extends`.** A child's `model { standoff 0.2 }` changes
    one setting and keeps the parent's solids; `no model` ends the model at that level.

## Notes on the spec from implementing it

- **TO-252 needed one more line.** Under §9.2, `body bottom is 1.1 above pad 1` also
  weakly aligns the body's centre with pad 1. Nothing else placed the body horizontally,
  so it sat over pin 1 instead of the tab. The example now says
  `body is centered on pad 2 horizontally`. This is a concrete case for open question 2.
- `only 1..5` in the syntax zoo isn't derivable from `region_or_name` in `grammar.peg`,
  which allows only names, `rows …` and `cols …`.
- §6 says all coordinates are relative to the final origin, but `origin at (x, y)` can't
  be relative to itself. ZOO-GRID's courtyard implies the reading in decision 3.
- `dshape` needs a default flat side (the demo uses `left`). It also needs a rule for when
  the round end doesn't fit: `dshape 0.6 x 1.5 flat left` asks for a 0.75 mm radius in a
  0.6 mm width. The demo caps the radius.
- In ZOO-DUAL, `pad "TP1" is 60 left of side left outer` uses the left row's
  edge facing away from TP1, which is its right edge, by §8.2. TP1 then just touches
  pin 9. If the intent was "60 left of the row's outer edge", the anchor would be `inner`.
- ZOO-SHAPES has overlapping pads (5/7 and 4/9). The demo reports them as §15
  suspicious-geometry warnings.
- §11.3's `lead tab … (becomes highest-numbered pin unless named)` reads as an extra
  pin, but `lead` describes the pins a generator already made. The demo treats a general
  `lead tab` like a flat terminal, and a per-pin `lead 2 tab` as a slab under pad 2,
  which is how the DPAK example models its drain tab.
- The old `model` block had only `pin1 dimple|stripe`. A DIP's notch and a QFN's laser
  dot need their own names, so the block now takes `dimple`, `dot`, `notch`, `stripe`
  and `none`, and defaults from the footprint's `pin1` where it can.
