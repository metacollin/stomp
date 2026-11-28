# The stomp editor

stomp runs in the browser. Write stomp on the left, and the land pattern on the right
redraws as you type: copper, paste, mask, drills, silk, courtyard and fab layers, with
pad numbers. Put the cursor on a placement and its dimension is drawn on the footprint:
`pad 3 is 4.56 right of pad 1` shows the 4.56 between the two pad centers. Switch to
**3D** and the same source shows the part's model, sitting on a board with its copper,
silk and courtyard.

Everything runs in the browser, with no dependencies. The engine is C++ (`../src`),
compiled to WebAssembly and committed as `js/stomp-core.js`, and the editor around it is
plain JavaScript, so the page needs no build step and works straight from disk.

## Running it

- **From disk:** open `demo/index.html` in a browser.
- **Served:** `python3 -m http.server -d demo 8000`, then visit <http://localhost:8000>.
  You can also publish the `demo/` folder as it is, for example on GitHub Pages.
- **Single file:** `node demo/tools/build.mjs --bundle stomp.html` puts every
  script, style and docs page into one HTML file you can send around.

The file picker has your own files first, saved in the browser, then the files in
[`examples/`](../examples/), with the libraries (`*_library.stomp`) in a group of their
own that opens on the Library view, and the standard library's files in
[`stdlib/`](../stdlib/). Your edits to an example are kept in the browser too, and
**Reset** restores the original. The **File** menu saves files in the browser, saves
them to disk and opens them from disk.

**Tutorial** and **Docs** open the documentation in place of the editor: the
[tutorial](../docs/tutorial.md), the [language reference](../docs/reference.md),
[Using stomp](../docs/using.md), the [standard library](../stdlib/README.md) and the
[specification](../SPEC.md), rendered from those Markdown files when the editor is built.

## Using it

[Using stomp](../docs/using.md) covers the editor: writing, the drawing and its layers,
3D, your files and how long the browser keeps them, the standard library, KiCad export,
the keys, and the choices this version makes where the specification leaves a meaning
open. It's also the editor's **Docs** page.

## What's implemented

The engine implements the whole draft, from `grammar.peg` to finished layers. It is a
C++20 library in [`../src`](../src):

| file | what it does |
|---|---|
| `../src/lexer.cpp` | tokens, as the grammar defines them: attached unit suffixes and side marks, `1..4` ranges, hyphenated keywords and the newline rules (SPEC §4); a brace is reported, and a `}` still closes its block |
| `../src/parser/` | recursive descent in `grammar.peg`'s choice order, on [PEGTL](https://github.com/taocpp/PEGTL), with keywords that count only where expected; recovers from errors one statement at a time, and reports a missing `end` at the block that lacks it |
| `../src/compile/` | units (per file, footprint or template), names (`NAME = value`) and `{...}` interpolation; functions and colors; custom features with sections and flags, and the standard library they're looked up in; templates, `from` calls, `footprints from` tables and `extends`; the `pins`, `balls` and side-list generators with every numbering scheme, plus `omit`, `only` and `delete`; IPC-style pad sizing and per-pin leads; the placement solver (§9); mask, paste windows, vias, automatic silk, courtyard and assembly, pin-1 and polarity marks (from library features); `model` blocks merged down `extends`, and their solids as descriptors for the 3D model; diagnostics (§15); a build cache |
| `../src/model3d.cpp` | the 3D model (SPEC §13): measures the part, calls the library's body, lead, exposed-pad and polarity features (SPEC §13.5), works out the flags they ask for, and turns the solids they draw into meshes; the board under it; VRML and STL export |
| `../src/kicad.cpp` | KiCad 9 export: footprints (`.kicad_mod`) with the 3D model embedded |
| `../src/geom.cpp` | exact outlines (lines and arcs), offsets, hulls, silk clipping, triangulation |
| `../src/jsrt.cpp` | JavaScript's number formatting and rounding, and V8's own trigonometry (`../third_party/v8-ieee754`), so every platform gives the same numbers as the JavaScript engine this was ported from |

The C++ was ported from a JavaScript engine, function by function, and its comments cite
the functions and lines it follows (`compile.js 686-930`). That engine is in the history:
`demo/js` as of commit 597ad62. The editor's files:

| file | what it does |
|---|---|
| `js/stomp-core.js` | **generated**: the engine as WebAssembly, by `emcmake cmake --preset wasm-release` (`../wasm`) |
| `js/engine.js` | the engine as the editor sees it: `Stomp.ready` resolves once the module has loaded, and then `Stomp.compile`, `Stomp.model3d` and `Stomp.kicad` are ordinary calls. Results stay in the engine; their outlines and automatic layers come when first used, and a footprint the build cache keeps is the same object as before |
| `js/view.js` | SVG viewer: layers at true width, pan and zoom, hover details, dimension overlays |
| `js/view3d.js` | WebGL viewer: one merged buffer, lights that follow the camera, shiny metals, orbit, pan and zoom, preset views, highlights from the cursor |
| `js/editor.js` | a code editor with no dependencies: a textarea over highlighting from the lexer, which also highlights the code in the docs |
| `js/store.js` | your files: kept in IndexedDB with a copy in localStorage, merged on load, persistent storage asked for, other tabs told of changes; reading and writing `.zip` files |
| `js/docsview.js` | the docs view: pages, contents, `#links`, highlighted code with Try it and Copy |
| `js/playground.js` | Try it: an example edited in place, its footprint drawn beside it in 2D or 3D |
| `js/app.js` | ties it all together: the file picker and File menu, saving and opening files, KiCad libraries, the docs, saved settings |
| `js/examples.js` | **generated** from `examples/*.stomp` by `tools/build.mjs` |
| `js/stdlib.js` | **generated** from `../stdlib/*.stomp`, the standard library, by `tools/build.mjs`; the page hands it to the engine when it starts |
| `js/docs.js` | **generated** from the docs' Markdown by `tools/build.mjs`, with `tools/md.mjs` |
| `../docs/img/*.svg` | **generated** by `tools/figures.mjs`: footprints the engine builds, with the dimensions their numbers stand for |

Not covered: `step` files aren't loaded. A footprint that names one shows the generated
model instead, and its KiCad export points to the file rather than embedding a model.
Castellated leads get a temporary land (SPEC §17.7), though the model draws their
plating. Export is for KiCad 9 and later only.

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
node --test demo/test/*.test.mjs     # syntax, engine, library, 3D and KiCad tests
node demo/tools/build.mjs            # rebuild js/examples.js, js/stdlib.js and js/docs.js
                                     # after editing examples/, stdlib/ or the docs
node demo/tools/snapshot.mjs         # compare every model with the recorded snapshot
node demo/tools/snapshot.mjs --write # record it again, after a change you meant
ctest --preset native-release        # the C++ library's own tests and the stomp tool's
node tests/compare/compare.mjs       # the native engine against the WebAssembly one
```

The tests run on the engine the editor uses, the WebAssembly build in `js/stomp-core.js`.
They check:

- hand-calculated geometry for the relational examples (TO-252, USB micro-B, the syntax
  zoo), the generators, interpolation and tables, side marks and units in footprints;
- rectangular courtyards, custom features, the L-bend, straight and column lead forms,
  and which end the polarity marks go on;
- that every library builds with no warnings and unique names;
- the syntax: blocks and their `end`, a missing `end` and where it's reported, braces,
  names given values with `=`, named values with a colon (and without), named
  arguments, keywords used as names, flat features, footprint graphics and their layers;
- the diagnostics and where they point;
- that `js/examples.js`, `js/stdlib.js` and `js/docs.js` match their sources;
- the docs: every example in the tutorial and the reference compiles (or, for a
  fragment, parses), every link and `#anchor` leads somewhere, the Markdown
  converter's output for lists, tables, code, images and inline markup, that each
  figure's labels are the dimensions its footprint really has, and that the header
  mark and the favicon are the files in `docs/logo`;
- your files: names, merging the two copies (newest wins, deletions stick), saving,
  renaming and deleting with either copy failing, other tabs' changes, and reading
  stored and deflated `.zip` files;
- that half-typed and mangled versions of every example don't break the compiler, and
  that random edits never make the build cache change a result;
- the engine as the editor sees it: tokens as the JavaScript lexer gave them, a
  footprint the build cache keeps coming back as the same object, results and models
  the engine let go made again with the same values, and the engine's memory staying
  within its budget;
- for 3D: each example's model is finite and wound consistently; measured parts
  (gull-wing toes at the span, terminals flush with the body, balls collapsed to the
  standoff, leads 3 mm below the board); per-pin leads and their lands; the `model`
  block and its diagnostics; both export formats; and fuzzing of the model builder;
- a snapshot of every example's model and automatic marks, and of a corpus of
  footprints for cases the examples miss (`test/fixtures/corpus.stomp`): each mesh's
  name, color, counts, extent, centroid and moments, and how the VRML export reuses
  shapes. The library was written to match the JavaScript that drew the models before
  it, and this is how that was checked;
- for the standard library: that it parses cleanly; that every feature the model calls
  exists and needs only what the model passes; sections, flags, functions and colors;
  every solid; replacing library features and the warnings for ones it can't call;
  `body shape` and `leads shape`; problems in library code reported where it was used;
  and fuzzing of the library's own sources;
- for KiCad: the checksum against MurmurHash3's published test value and fixed vectors;
  zstd frames that round-trip; every example's export parsed as KiCad would (keywords,
  unique UUIDs, pads and their properties, margins, paste windows, via pads); and each
  embedded model decoded back to VRML with a matching checksum.

## Performance

The file recompiles every time you pause typing, so big libraries need two things:

- **A build cache.** Each footprint's result is cached under the text it is built from:
  its template, its arguments and the file's names. Editing or adding one row of a
  table rebuilds only that row. A row's position isn't part of its key, so the rows below
  an edit stay cached and their diagnostics move with them.
- **Lazy layers.** Automatic silk, assembly and courtyard geometry, the slow part, is
  computed when a footprint is first drawn. Anything that can report a problem still
  runs on every compile.

For a 150-row QFN table in Chromium, a cold compile takes about 165 ms, and typing in
one row recompiles in about 6 ms. Editing the template rebuilds every row.

The standard library is parsed once. A model is built when it's first shown, in about a
millisecond for most parts. A lead's feature runs once for each different lead, and the
result is copied for the others, so a 484-ball BGA's model takes about 16 ms in Node
and its VRML still writes the ball once.

## Semantic decisions

The draft leaves some meanings open. The editor picks these, and
[Using stomp](../docs/using.md#choices-this-version-makes) lists the main ones too.

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
   smallest rectangle around the lands and body, plus the clearance. Graphics in a
   footprint add to the automatic silk and assembly layers, as §12 describes.
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
    `lead gullwing 0.41 x 1.04 span: 6.0`, and 1.04 is the whole lead beyond the 3.9 mm
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
    band marks pin 1, the way tantalums are marked. The library's `polarity` feature
    says which, and the silk bar and the 3D stripe both ask it, so an axial or MELF
    capacitor's bar is at pin 2 like its band.
16. **Model blocks merge down `extends`.** A child's model block with `standoff: 0.2`
    changes one setting and keeps the parent's solids. `no model` ends the model at that level.
17. **Sections, not `if`.** A feature chooses with sections turned on by flags (SPEC
    §12.1), and the engine turns flags on from measurements by asking the library: a
    feature's `bent_if = …` above zero means `bent`. So the thresholds and formulas
    (when a gull-wing has room to bend, when a can gets a vent) are library code, and
    only the comparison with zero is the engine's.
18. **Two ways to place a solid.** In a feature, `at` puts the solid's own origin (a
    box's bottom center) at a point of the feature, which composes cleanly. In a
    footprint's model block it keeps the earlier meaning: the solid's center over the
    point and its bottom at z, on the board or on the body.
19. **Leads on the left and top are mirror images.** A lead is drawn once in its side's
    frame and copied to every lead like it, through a frame that mirrors x for the left
    side and y for the top, as the JavaScript drew the leads that bend outward. A lead
    drawn asymmetric across its width would show the mirroring.
20. **Castellations are drawn per lead.** Each castellated lead draws its half-hole's
    plating, so the model's lead count includes them and the export reuses one shape for
    all of them. The board cuts its notches with `slab … castellated`.
21. **Library errors point at your file.** The library's code isn't in the editor, so a
    problem inside it is reported at the statement that used it, with the chain of
    library features it went through.
22. **A missing `end` is found by what comes next.** A `footprint`, `template` or
    `footprints` line, or a feature declaration at the left margin, can't be inside a
    block, so an open block stops there and is reported at its header. When an inner
    block was closed by an `end` that lines up with an outer header, the inner block is
    the one reported, since that `end` was most likely meant for the outer one.
23. **Keywords count only where they're expected.** So the library's parameters have
    natural names (`draft`, `below`, `d`, `top`), and a template's can be `pitch`.
    Object names keep the old rule: `pad at` would read as part of the statement, so a
    pad named after a keyword is quoted.

## Notes on the spec from implementing it

- **TO-252 needed one more line.** Under §9.2, `body bottom is 1.1 above pad 1` also
  weakly lines up the body's center with pad 1. Nothing else placed the body
  horizontally, so it sat over pin 1 instead of the tab. The example now says
  `body is centered on pad 2 horizontally`. This is a real case for open question 2.
- `only 1..5` in the syntax zoo isn't allowed by `region_or_name` in `grammar.peg`,
  which takes only names, `rows ...` and `cols ...`.
- §6 says all coordinates are relative to the final origin, but `origin at (x, y)` can't
  be relative to itself. ZOO-GRID's courtyard implies the reading in decision 3.
- `dshape` needs a default flat side (the editor uses `left`). It also needs a rule for
  when the round end doesn't fit: `dshape 0.6 x 1.5 flat: left` asks for a 0.75 mm radius
  in a 0.6 mm width. The editor caps the radius.
- In ZOO-DUAL, `pad "TP1" is 60 left of side left outer` uses the left row's edge facing
  away from TP1, which is its right edge, by §8.2. TP1 then just touches pin 9. If the
  intent was "60 left of the row's outer edge", the anchor would be `inner`.
- ZOO-SHAPES has overlapping pads (5 and 7, 4 and 9). The editor reports them as §15
  suspicious-geometry warnings.
- §11.3's `lead tab ... (becomes highest-numbered pin unless named)` reads as an extra
  pin, but `lead` describes the pins a generator already made. The editor treats a general
  `lead tab` like a flat terminal, and a per-pin `lead 2 tab` as a slab under pad 2,
  which is how the DPAK example models its drain tab.
- The old `model` block had only the `dimple` and `stripe` marks. A DIP's notch and a QFN's laser
  dot need their own names, so the block now takes `dimple`, `dot`, `notch`, `stripe`
  and `none`, and defaults from the footprint's `pin1` where it can.
