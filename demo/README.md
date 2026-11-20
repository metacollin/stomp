# stomp live

A browser demo of stomp. Write stomp on the left, and the land pattern on the right
redraws as you type: copper, paste, mask, drills, silk, courtyard and fab layers, with
pad numbers. Put the cursor on a placement statement and its dimension is drawn on the
footprint. `pad 3 is 4.56 right of pad 1` shows the 4.56 between the two pad centres.

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
- Drag to pan, scroll or pinch to zoom, double-click to fit. Files with several footprints
  get tabs, and the preview follows whichever footprint the cursor is in.
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
| `js/compile.js` | units and `let`; `template`/`from`/`extends`; `pins`/`balls`/side-block generators with every numbering scheme, `omit`/`only`/`delete`; IPC-style pad synthesis; the §9 constraint solver; mask, paste windowpanes, vias, auto silk/courtyard/assembly, pin-1 and polarity marks; §15 diagnostics |
| `js/geom.js` | exact outlines (lines plus arcs), offsets, hulls, silk clipping |
| `js/view.js` | SVG viewer: true-width layers, pan/zoom, hover inspection, constraint overlays |
| `js/editor.js` | dependency-free code editor: a textarea over lexer-driven highlighting |
| `js/app.js` | wiring, examples, persistence |
| `js/examples.js` | **generated** from `examples/*.stomp` by `tools/build.mjs` |

Not covered: 3D models are parsed and summarized but not rendered, castellated leads draw
a provisional land (SPEC §17.7), and nothing is exported yet.

## Tests

```sh
node --test demo/test/*.test.mjs     # engine tests: geometry, numbering, diagnostics, fuzzing
node demo/tools/build.mjs            # regenerate js/examples.js after editing examples/
```

The suite checks hand-calculated geometry for the relational examples (TO-252, USB
micro-B, the syntax zoo), the generators, the diagnostics and their locations, and that
`js/examples.js` matches `examples/`. It also fuzzes the compiler with half-typed and
mangled versions of every example.

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
