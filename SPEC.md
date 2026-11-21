# stomp — a footprint description language

*stomp: because a stomp leaves a footprint. File extension: `.stomp`.*

**Status: draft 1 — syntax and grammar only.** This document nails down the surface
language. Parsing (PEGTL is the intended parser toolkit), constraint solving, IPC
pad synthesis, and 2D/3D generation are deliberately out of scope for this revision;
where the syntax forces a semantic decision, the chosen default is stated and marked
as a decision, and genuinely open items are collected in [§17 Open
questions](#17-open-questions).

The formal grammar lives in [`grammar.peg`](grammar.peg). Worked examples live in
[`examples/`](examples/) — every construct in this spec appears in at least one
example file: most in realistic context, with the naturally rare ones swept by the
deliberately synthetic [`examples/syntax_zoo.stomp`](examples/syntax_zoo.stomp) (which
doubles as a future parser test fixture). Not every keyword *variant* is exercised;
the grammar file is the authority on those.

---

## Table of contents

1.  [Goals](#1-goals)
2.  [Design principles](#2-design-principles)
3.  [Quick tour](#3-quick-tour)
4.  [Lexical structure](#4-lexical-structure)
5.  [Files, footprints, metadata](#5-files-footprints-metadata)
6.  [Coordinate system and units](#6-coordinate-system-and-units)
7.  [Values, expressions, `let`](#7-values-expressions-let)
8.  [Objects and anchors](#8-objects-and-anchors)
9.  [Placement and dimensioning](#9-placement-and-dimensioning)
10. [Pads and holes](#10-pads-and-holes)
11. [Parametric part description](#11-parametric-part-description)
12. [Graphic layers](#12-graphic-layers)
13. [3D model](#13-3d-model)
14. [Templates, tables and inheritance](#14-templates-tables-and-inheritance)
15. [Diagnostics](#15-diagnostics)
16. [Formal grammar](#16-formal-grammar)
17. [Open questions](#17-open-questions)
18. [Example index](#18-example-index)

---

## 1. Goals

stomp is an **external DSL** for describing electronic component footprints. From one
source file it must be possible to generate:

- a **2D land pattern** — copper pads, drills, mask/paste, silkscreen, courtyard,
  assembly outline;
- optionally, a **3D model** of the physical part — body plus leads — suitable for
  MCAD export and board rendering.

Two authoring modes, freely mixable in one footprint:

- **Land mode** — describe the pads directly (sizes and positions), when the
  datasheet gives you a recommended land pattern or you are reverse-engineering one.
- **Part mode** — describe the *component* (body size, pins per side, pitch, lead
  form, lead span, thermal pad…) and let the tool derive the land pattern
  (IPC-7351-style) and the 3D model. Explicit pads always override derived ones.

The headline feature is **relational dimensioning**: any object can be positioned by
stating that it is a given distance, in a given direction, from another object — and
that distance can be measured **center-to-center, edge-to-edge, or mixed
(center-to-edge)**. Datasheets dimension drawings as an arbitrary web of offsets
between whichever features the draftsman fancied; stomp lets you transcribe those
dimensions *verbatim*, without ever converting them to a common origin by hand.

## 2. Design principles

1. **Datasheet-direct entry.** Every number in a mechanical drawing should be
   enterable as-written: pitches (center-to-center), spans (outer-to-outer), gaps
   (inner-to-inner), edge offsets, letter dimensions (`let e = 0.65`). Variation
   tables transcribe the same way, one row per variant ([§14.3](#143-tables-footprints-from)).
   If you find yourself doing arithmetic while transcribing, the language has failed.
2. **Terse for the common case, explicit for the weird case.** A JEDEC-standard
   package is 4–6 lines. An awful connector is longer but never impossible; you drop
   from generators to primitives and relations without changing files or dialects.
3. **Declarative, order-mostly-irrelevant.** Statements are facts, not commands. The
   solver orders them; contradictions and gaps are hard errors with both offending
   statements cited ([§9.7](#97-constraint-semantics)).
4. **One namespace, real names.** Pads, holes, rows, groups, the body, and the origin
   are all nameable objects, all usable as dimension references.
5. **Generated defaults are weak.** A generator (`pins 8 dual pitch 1.27 …`) produces
   ordinary objects with *default* placements and geometry. Any explicit statement
   about a generated object overrides the default — so "standard package except pad 5
   is wider and there's a mounting hole" is a generator plus two lines, not a manual
   re-description.
6. **English-shaped, but small.** Statements read aloud (`pad 3 is 4.56 right of
   pad 1`) yet the keyword set is closed and the grammar is a deterministic PEG. There
   are no optional noise words; there is one way to write each construct.

## 3. Quick tour

A passive, land mode — pad sizes plus one inner-edge gap, exactly as land-pattern
drawings give them:

```stomp
footprint "R0402" {
  pins 2 horizontal
  default pad rect 0.5 x 0.6
  gap 0.5                      # inner edge to inner edge between the two pads
  body 1.0 x 0.5 x 0.35        # optional: enables silk/courtyard/3D
}
```

An IC, part mode — the component is described; pads are derived (IPC density
`nominal` unless overridden):

```stomp
footprint "SOIC-8" {
  body 3.9 x 4.9 x 1.5
  pins 8 dual pitch 1.27
  lead gullwing 0.41 x 1.04 span 6.0   # lead width x foot length, span outer-to-outer
  pin1 dot
}
```

A DPAK, relational mode — dimensions transcribed straight off the drawing, each
measured however the drawing measured it:

```stomp
footprint "TO-252" {
  pad 1 rect 1.1 x 1.6
  pad 3 rect 1.1 x 1.6
  pad 2 rect 5.5 x 6.2                              # the tab

  pad 3 is 4.56 right of pad 1                      # center-to-center
  pad 2 is centered between pad 1 and pad 3 horizontally
  pad 2 inner is 1.9 above pad 1                    # tab's near edge to pin-row centers
}
```

`pad 2 inner` is the tab edge *facing* pad 1 — `inner`/`outer` resolve automatically
from the direction of the relation, so you never work out which absolute edge a
drawing meant.

A library, one footprint per row — the template names what it makes by interpolating
its parameters, and a table calls it once per row:

```stomp
template qfn(n, D, D2, e = 0.5) {
  name "QFN-{n}-1EP_{D}x{D}mm_P{e}mm_EP{D2}x{D2}mm"
  body D x D x 0.9
  pins n quad pitch e
  lead flat e / 2 x 0.4
  thermal pad "{n + 1}" D2 x D2
}

footprints from qfn {
  n    D    D2
  16   3    1.7
  32   5    3.45
  48   7    5.6
}
```

## 4. Lexical structure

- **Encoding** — UTF-8. Non-ASCII is permitted only inside quoted strings and
  comments.
- **Comments** — `#` to end of line. No block comments.
- **Statements** — one per line, terminated by the newline. Multiple statements may
  share a line separated by `;`. Newlines are insignificant inside parentheses
  `( … )` and immediately after `{`, `,`, or an infix operator, which is enough for
  natural wrapping of long statements; there is no continuation character.
- **Blocks** — `{ … }` groups statements (footprint bodies, side lists, graphic
  layers, model overrides). Blocks nest.
- **Identifiers** — `[A-Za-z_][A-Za-z0-9_]*`. Case-sensitive. Keywords are reserved
  (list in [`grammar.peg`](grammar.peg)); a pad may not be *barely* named `span`, but
  `pad "span"` is legal via quoting.
- **Names** (of pads, holes, rows, groups, footprints, templates) — an identifier, an
  unsigned integer (`1`, `14` — the overwhelmingly common pad name), or a quoted
  string for anything else: `pad "D+"`, `footprint "SOIC-8_3.9x4.9mm_P1.27mm"`.
- **Strings** — `"…"` with `\"`, `\\`, `\{` and `\}` escapes. A `{…}` inside any
  string interpolates an expression ([§7](#7-values-expressions-let)), so a literal
  brace is written `\{`. Strings end at the end of the line.
- **Numbers** — decimal only: `1`, `0.65`, `.5`. No exponents (footprints don't need
  them). A number may carry an immediately attached suffix:
  - length units `mm` `um` `nm` `mil` `in` (e.g. `50mil`, `0.65mm`);
  - `%` for ratios (`25%`);
  - `deg` (default) or `rad` for angles.
- **Reserved single letters** — `x` (the size separator, §7) and `d`/`h` (diameter /
  height markers) cannot be `let` names.

## 5. Files, footprints, metadata

A file contains any number of `units`/`let` file-level statements, `template`
declarations ([§14](#14-templates-tables-and-inheritance)), `footprint` declarations,
and `footprints` tables ([§14.3](#143-tables-footprints-from)). Several related
footprints (variants, a family, a whole library) naturally share one file.

```stomp
units mm                          # file default; mm is the default default

footprint "QFN-32" { … }

footprint "QFN-32-HS" extends "QFN-32" {   # inherit + override (§14)
  …
}

footprint "SOIC-16" from soic(16)          # template instantiation (§14)

footprints from qfn { … }                  # one footprint per table row (§14.3)
```

Metadata statements, all optional, all string-valued except `tags`:

```stomp
description "32-lead 5x5 mm QFN, 0.5 mm pitch, exposed pad"
datasheet   "https://example.com/qfn32.pdf"
manufacturer "Acme"
mpn          "ACME-32Q"
refdes       "U"                  # reference designator prefix
tags qfn, leadless, ipc
```

## 6. Coordinate system and units

- **+x is right, +y is up.** Angles are in degrees, counter-clockwise, `0°` along +x.
  (Matches Gerber; the y-down convention of certain EDA tools is
  explicitly rejected.)
- The footprint is described **top side, as viewed from above**. Bottom-side
  placement/mirroring is the layout tool's job, not the footprint's.
- **Default length unit is mm**, changeable per file (`units mil`) and overridable
  per literal (`0.3mm`, `12mil` mid-expression, freely mixed). Internally everything
  becomes int64 nanometers.
- **Origin** defaults to the centroid of the body if a body is declared, else of the
  land pattern bounding box. It can be re-based:

  ```stomp
  origin at pad 1                        # e.g. connectors dimensioned from pin 1
  origin at (0, -1.25)
  origin centered between pad 1 and pad 2
  ```

  All `(x, y)` coordinates in the footprint are relative to the (final) origin;
  `origin` is also a referencable zero-size object ([§8](#8-objects-and-anchors)).

## 7. Values, expressions, `let`

- **Length expressions** — `+ - * /`, parentheses, numeric literals with optional
  unit suffixes, and `let` names. `(6.4 - 4.4) / 2`, `e * 3`, `span/2 - foot`.
  Multiplying two lengths is a semantic (unit) error; dividing two lengths yields a
  plain ratio.
- **Sizes** — `WIDTH x LENGTH`, two length expressions joined by the keyword `x`:
  `0.6 x 1.5`, `(a+b) x 1.5`. Width is the x extent and length the y extent *before*
  any `rotate`.
- **Points** — `(x, y)`; 3D points `(x, y, z)` appear only in `model` blocks.
- **Percentages** — `25%`; used for round-rect corner ratio and paste coverage.
- **Angles** — `45`, `45deg`, `0.7854rad`; only ever consumed by `rotate` and arcs.
- **`let`** — named dimensions, file-scoped or footprint-scoped:

  ```stomp
  let e  = 0.65        # transcribe the datasheet's letter dimensions…
  let D  = 6.4
  let A1 = 0.05
  pins 20 dual pitch e # …then use them by name
  ```

  `let` names are single-assignment. Footprint-scoped `let`s shadow file-scoped ones.
  (`A1`-style names collide with BGA ball names only lexically, never semantically —
  ball references are always prefixed: `ball A1`.)
- **Text** — a `"string"` is a value too: `let part = "TPS7A02"`, a template argument,
  or a table cell. Text takes no part in arithmetic; it is used inside strings, through
  interpolation.
- **Interpolation** — inside any string, `{expr}` is replaced by the value of the
  expression: `name "QFN-{n}-1EP_{D}x{E}mm"`, `thermal pad "{n + 1}" …`. Plain numbers
  print in their shortest decimal form (`0.5`, `32`, `1.65`), lengths in the file's
  units, text as written; `{expr:.N}` prints exactly N decimals (`{e:.2}` → `0.50`).
  Interpolation is evaluated where the string is used, so it sees template parameters
  and footprint-scoped `let`s.

## 8. Objects and anchors

### 8.1 Object kinds

| kind | introduced by | notes |
|---|---|---|
| `pad` | `pad` statements, generators | copper (SMD or plated through-hole) |
| `hole` | `hole` statements | non-plated (NPTH), round or slot |
| `row` | `row` statements, generators | an ordered run of pads at a pitch |
| `group` | `group` statements | arbitrary set of objects, bounding-box anchored |
| `side` | generators (`pins … dual/quad/sides`) | auto-group of one package side's pads |
| `body` | `body` statement | the physical outline; one per footprint |
| `origin` | implicit | zero-size point at the footprint origin |

All names live in **one namespace per footprint**; a pad and a group cannot share a
name. In references the kind keyword is normally written (`pad 3`, `side left`,
`row A`) but may be omitted where unambiguous (`3 is 4.56 right of 1` is legal;
house style keeps the prefix).

### 8.2 Anchors

Dimensions in drawings are one-dimensional projections, so anchors are
**per-axis**, written as a bare word after the reference:

```
pad 8 outer      side left inner      body left      pad 1        (= pad 1 center)
```

| anchor | meaning on the measurement axis |
|---|---|
| `center` | center coordinate (the default; never needs writing) |
| `inner` | the edge **facing the other object** in the relation |
| `outer` | the edge facing **away** from the other object |
| `left` `right` `top` `bottom` | absolute bounding-box edge (must match the axis: `left`/`right` with horizontal relations, `top`/`bottom` with vertical) |

`inner`/`outer` are what make span/gap dimensions transcribable: in `B outer is 6.0
right of A outer`, A's outer is its far-left edge and B's outer its far-right edge —
the classic lead-span `D` dimension, entered verbatim. Mixed measurements fall out
for free: `pad 2 inner is 3.81 above pad 1` (edge-to-center).

Edges are those of the object's **axis-aligned bounding box after rotation** — of the
copper for pads, the hole for `hole`s, the outline for `body`, the union of member
boxes for rows/groups/sides. `origin` has only `center`.

## 9. Placement and dimensioning

Sizes and shapes are static properties; **positions are solved from constraints**.
Each statement below contributes constraints.

### 9.1 Absolute: `at`

```stomp
pad 1 at (0, 2.2)
hole M1 at (-3.5, 0)
```

Constrains both axes of the object's center. Rotation is a property of the object
(`rotate`, §10.3), not part of placement.

### 9.2 Directional relations: `is … of`

The workhorse. General form:

```
TARGET [anchor] is DIST left of|right of|above|below REFERENCE [anchor]
```

```stomp
pad 3 is 4.56 right of pad 1                 # center-to-center
pad 8 outer is 6.0 right of pad 1 outer      # span, outer-to-outer
pad 2 inner is 0.4 right of pad 1 inner      # gap, inner-to-inner (facing edges)
pad 2 inner is 3.81 above pad 1              # mixed: edge-to-center
hole M1 is 2.89 left of pad 1 and 0.55 below pad 1    # chained with `and`
```

Precise meaning of `T tA is d DIR of R tR`, with axis *m* (x for `left`/`right`, y
for `above`/`below`) and sign *s* (+1 for `right`/`above`, −1 for `left`/`below`):

> *coord*(T, tA) = *coord*(R, tR) + s·d  on axis m,
> where `inner` on R is R's edge in direction +s (toward T), `outer` the edge in −s;
> `inner` on T is T's edge in direction −s (toward R), `outer` the edge in +s.

A negative `d` (e.g. from an expression) flips the direction; no warning.

**Cross-axis default:** a directional relation also *weakly* aligns the target's
center with the reference's center on the perpendicular axis. Weak constraints are
discarded the moment any explicit statement constrains that axis, so

```stomp
pad 2 is 1.27 right of pad 1        # pad 2 fully placed: y defaults to pad 1's y
```

is one line for the common "same row" case, while adding `pad 2 is 0.3 above pad 3`
silently replaces the default. ⟨decision: weak cross-axis alignment; alternative was
"one axis constrained, other axis is an error until stated", which doubles the line
count of every real footprint.⟩

### 9.3 Chains with `and`

`TARGET is CLAUSE and CLAUSE [and …]` — each clause carries its own distance,
direction, and reference; clauses may reference different objects:

```stomp
pad "SH1" is 1.2 left of pad 1 and 0.35 below body bottom
```

### 9.4 Symmetry: `mirrors`, and measured pairs: `span` / `gap` / `pitch`

```stomp
pad 8 mirrors pad 1 across y        # position and shape mirrored about the y axis
span pad 1 to pad 8 is 6.0          # outer edge to outer edge
gap  pad 4 to pad 5 is 0.4          # facing edge to facing edge
pitch pad 1 to pad 2 is 1.27        # center to center
```

`mirrors … across x|y` mirrors geometry and position about the footprint axis. If
the prototype's position is not yet fixed, the pair becomes a symmetric unknown that
a single `span`/`gap`/`pitch` measurement then pins down — exactly how packages are
dimensioned ("leads symmetric about centerline, span 6.0"). In that case the
prototype (the object *being mirrored*, i.e. the right-hand operand) takes the −x
side for `across y` and the +y side for `across x` — consistent with pin 1 sitting
left/top — so the pair is fully determined.

`span`/`gap`/`pitch` statements are **unsigned, symmetric** constraints. Their axis
is inferred from an existing relation or mirror between the two objects; if no
relative orientation is known, append `horizontally` or `vertically`.

### 9.5 Centering and alignment

```stomp
pad 2 is centered between pad 1 and pad 3               # both axes (midpoint of centers)
pad 2 is centered between pad 1 and pad 3 horizontally  # x only
pad "EP" is centered on body                            # both axes
align pad 7 with pad 2 horizontally                     # same y — they lie on one horizontal line
align hole M2 with hole M1 vertically                   # same x — one vertical line
```

`horizontally` always means "along a shared horizontal line" (equal y), and
`vertically` "along a shared vertical line" (equal x). English is ambiguous here;
stomp is not — this definition holds everywhere the two adverbs appear.

### 9.6 Rows and groups

```stomp
row L pads 1..4 pitch 1.27 going down       # 1 at top, consecutive centers 1.27 apart
group mounting = hole M1, hole M2, pad "SH1", pad "SH2"
```

A `row` places its member pads relative to each other (pitch, center-to-center, in
the `going` direction) and is itself one object: place the row with any §9
statement (`row L outer is …`, `row L at (…)`). `..` ranges run either direction
(`8..5`). A `group` adds no constraints; it only creates a shared bounding box to
dimension against.

### 9.7 Constraint semantics

⟨decision — chosen for solvability and error quality; revisit if a full solver is
ever wanted:⟩

- **Single assignment per axis.** Each object axis takes its position from exactly
  one strong constraint. A second strong constraint on the same axis is an
  **over-constraint error** citing both statements — which is a feature: it catches
  mis-transcribed datasheets at compile time rather than as a subtly wrong pad.
- Weak constraints (§9.2 cross-axis, generator default placements §11) fill any axis
  not strongly constrained; explicit always beats generated.
- An axis with no constraint at all is an **under-constraint error** naming the
  object and axis.
- Constraint order in the file is irrelevant; references may point forward. Cycles
  that are not resolvable (A places B places A, other than via `mirrors` +
  measurement) are errors listing the cycle.

## 10. Pads and holes

### 10.1 Pad definition

```
pad NAME [tht] SHAPE [PROPERTY …]        # inline form
pad NAME { PROPERTY-STATEMENTS }         # block form (equivalent)
```

Shapes:

```stomp
pad 1  rect 0.6 x 1.5
pad 2  oval 0.6 x 1.5                    # obround
pad 3  circle 0.45                       # diameter
pad 4  roundrect 0.6 x 1.5 r 25%         # corner radius: % of smaller dimension, or absolute (r 0.1)
pad 5  dshape 0.6 x 1.5 flat left        # "D" pad: one flat side, other end full radius
pad 6  polygon (0,0) (1.2,0) (1.2,0.8) (0.5,0.8) (0.5,2.0) (0,2.0)   # vertices, own local origin at centroid
```

Through-hole (`tht`) pads add a drill; the shape/size describe the copper annulus:

```stomp
pad 1 tht rect 1.7 x 1.7 drill 1.0       # square pad, classic pin-1
pad 2 tht circle 1.7 drill 1.0
pad 7 tht oval 1.7 x 2.4 drill slot 1.0 x 1.7   # slotted hole
```

Non-plated holes are their own kind:

```stomp
hole M1 0.85                             # NPTH, diameter
hole M2 slot 0.85 x 1.4                  # NPTH slot
```

### 10.2 Pad properties

Valid in either form, after the shape or as block statements:

```stomp
rotate 45                    # about the pad center, CCW degrees
mask +0.05                   # solder-mask expansion per side (default: stack rule)
mask none                    # no mask opening
mask defined                 # solder-mask-defined pad (mask sets the land)
paste -0.05                  # paste contraction per side
paste none
paste divide 2 x 2 coverage 68%          # windowpane stencil (thermal pads)
paste divide 3 x 3 gutter 0.3            # alternative: fixed gutter between windows
vias 3 x 3 drill 0.3 pitch 1.1           # thermal via array within the pad
```

### 10.3 Defaults, selectors, overrides, deletion

```stomp
default pad rect 0.4 x 1.4        # prototype for every pad without its own geometry
                                  # (including generator-created pads)
pad 5 { width 2.0 }               # partial override: keep everything else, widen pad 5
pads 1..4, 9 { mask +0.1 }        # bulk override by selector
delete pad 11                     # remove a generated object (depopulated variants)
```

Partial-override property names: `width`, `length`, `shape`, `size W x L`, plus any
§10.2 property. A `pad NAME shape …` statement for an already-generated name
*replaces* its geometry outright.

## 11. Parametric part description

Part mode describes the component; the tool derives pads (IPC-7351 style, `density
nominal` by default) and the 3D model. All generated objects are ordinary, named,
overridable ([§2](#2-design-principles) pt. 5).

### 11.1 Body

```stomp
body 5 x 5 x 0.9                 # W x L x H box (molded, default draft/chamfer)
body cylinder d 8 h 11.5         # radial can
body 9.5 x 6.5                   # height optional (no 3D height ⇒ flat model)
```

### 11.2 Pins — count and arrangement

```stomp
pins 8 dual pitch 1.27           # left+right sides, CCW from top-left (pin 1 top-left)
pins 32 quad pitch 0.5           # four sides, CCW from top-left
pins 2 horizontal                # two-terminal chip, pin 1 left
pins 2 vertical                  # pin 1 top
pins 3 single bottom pitch 0.95  # all pins on one side
pins grid 5 x 2 pitch 2.54       # NX columns x NY rows (x-count first, like sizes)
balls 8 x 8 pitch 0.8            # sugar: grid + `lead ball` + `numbering bga`
```

Inline clauses on any `pins`/`balls` statement: `pitch P [x PY]` (per-axis pitch for
grids), `pad SHAPE SIZE …` (per-statement default pad), `span S [QUAL]`, `numbering
…`, `start …`.

Explicit sides, for irregular parts — a block whose entries are `SIDE: positions
[pitch P]`, positions listed in **CCW walk order** (left: top→bottom, bottom:
left→right, right: bottom→top, top: right→left), `nc` reserving an empty position:

```stomp
pins {
  left: 1, 2, 3 pitch 0.95
  right: 4, nc, 5                # SOT-23-5: pins 4/5 at the outer positions
}
```

Each side's occupied+`nc` run is centered on its side. Numbering is whatever you
listed — no scheme applies.

Numbering schemes for the regular forms: `numbering ccw` (default for
dual/quad/single), `cw`, `zigzag` (default for `grid`: 1-2 across the short pitch,
then advance — the 0.1" box-header convention), `row-major`, `col-major`, `bga`
(default for `balls`: rows lettered A, B, C… skipping I O Q S X Z per JEDEC, columns
numbered from 1; ball names like `A1` are pad names). `start top-left` (default),
`start top-right`, etc., reorient any scheme.

Depopulation:

```stomp
omit A1, H8, rows D..E cols 4..5        # by name and/or rectangular region
only rows A..B, rows G..H               # inverse: keep only the listed region(s)
```

### 11.3 Leads

```stomp
lead gullwing 0.41 x 1.04 span 6.0   # width x foot-length; span outer-to-outer
lead jlead 0.5 x 0.9 span 8.6
lead flat 0.25 x 0.4                 # leadless lands (QFN/DFN/LGA); span optional (defaults to body edge)
lead endcap 0.35                     # chip terminations; width defaults to body width
lead ball 0.4                        # BGA ball diameter
lead pin d 0.64                      # THT round pin; also: lead pin 0.64 x 0.64 (square)
lead wire d 0.6                      # axial/radial wire leads
lead tab 5.5 x 6.2                   # DPAK-style tab (becomes highest-numbered pin unless named)
lead castellated d 0.6               # half-hole edge castellations
```

`span` qualifiers, wherever a symmetric across-the-package distance appears (`lead …
span`, bare `span`, `pins … span`): **`outer`** (default — lead span as datasheets
draw it), **`inner`**, **`centers`**. Bare statements `span 5.4 centers` / `gap 4.0`
(≡ `span 4.0 inner`) size the land-pattern row spacing directly in land mode, or
override the derived spacing in part mode. In part mode `span` measures the *leads*;
in land mode (no `lead`), it measures the *pads*.

⟨decision: pad synthesis precedence is explicit `pad NAME` > `default pad` / `pins …
pad` clause > IPC-derived-from-`lead` > error "no pad geometry".⟩

### 11.4 Thermal / exposed pad

```stomp
thermal pad 3.7 x 3.7                          # named EP by default, centered on body
thermal pad 33 3.7 x 3.7 {                     # or give it its pin number
  paste divide 2 x 2 coverage 68%
  vias 3 x 3 drill 0.3 pitch 1.1
}
```

### 11.5 Pin 1 marker and polarity

```stomp
pin1 dot          # silk dot outside the corner nearest pin 1 (default for dual/quad)
pin1 chamfer      # chamfered silk corner (QFN convention)
pin1 notch        # DIP-style notch on the pin-1 end
pin1 bar          # bar across the pin-1 end (tantalum/diode style)
pin1 none
polarized         # two-terminal polarity: pin 1 is positive/anode; adds bar marker
                  # on the cathode side and the 3D stripe
density most      # IPC density level: least | nominal | most
```

## 12. Graphic layers

Everything here defaults to `auto` and rarely needs writing:

- **silk** `auto`: body outline pulled back from copper, plus the `pin1` marker;
- **courtyard** `auto`: convex land ∪ body extents + IPC clearance for the density
  level (`courtyard auto 0.5` overrides the clearance);
- **assembly** `auto`: body outline + refdes.

Manual work combines predictably: within one footprint, `auto` / `none` set the
layer's base (last one wins) and any `{ … }` blocks **accumulate on top of the
base** — so a lone `silk { text … }` adds to the auto outline, while `silk none`
followed by `silk { … }` is fully manual.

Manual additions/overrides:

```stomp
silk {
  outline body offset 0.15            # derive from the body, pushed out
  line (-2.5, 1.0) (-2.5, -1.0) width 0.12
  arc (0,0) r 1.5 from 30 to 150 width 0.12
  circle (0, 2.1) d 0.3 fill
  text ">CATHODE" at (1.8, 0) size 0.6
}
silk none                             # or suppress entirely
courtyard rect 7.4 x 7.4
courtyard { polygon (…) (…) (…) }
assembly none
text ref at (0, 0) size 1.0           # refdes/value fields; layer defaults: ref→silk, value→assembly
text value at (0, -1.2) size 0.8 layer assembly
```

## 13. 3D model

With a `body` and a `lead`, the 3D model is generated automatically: molded box or
cylinder body, correct lead geometry per lead form (gullwing bend profile, balls,
endcaps, pins extended below board), IPC-ish default standoff, sensible default
materials (black body, tin leads). Overrides:

```stomp
model {
  standoff 0.05
  height 0.85                      # overrides body height for the 3D part only
  body color "#20232a"             # hex or named: black gray white tin gold copper …
  leads color tin
  pin1 dimple                      # molded pin-1 dimple; also: pin1 stripe
  step "models/QFN32.step" offset (0,0,0) rotate (0,0,90) scale 1.0   # external override
}
no model                           # suppress 3D output
```

`step` replaces the generated body entirely (transform maps the file into footprint
space, z up, origin at board surface under the footprint origin).

## 14. Templates, tables and inheritance

### 14.1 Templates are functions

A template takes parameters and produces a footprint:

```stomp
template soic(n, lspan = 6.0, e = 1.27, bw = 3.9) {   # params are plain identifiers;
  body bw x (n/2 - 1) * e + 2.0 x 1.5                 # keywords (span, pitch, …) cannot
  pins n dual pitch e                                 # be parameter names
  lead gullwing 0.41 x 1.04 span lspan
  pin1 dot
}

footprint "SOIC-8"  from soic(8)
footprint "SOIC-16" from soic(16)
footprint "SOIC-16W" from soic(16, lspan = 10.3, bw = 7.5)
```

Template parameters are plain identifiers bound as footprint-scoped `let`s; keywords
cannot be parameter names. A default may refer to other parameters (`E = D`).
Arguments are positional, named, or both (`qfn(32, 5, D2 = 3.45)`), and a parameter
without a default must be given. A call may also carry a `{ … }` block of additional
overrides. No control flow (conditionals/loops) in v1 — a template is a parameterized
body, and a table ([§14.3](#143-tables-footprints-from)) is how one template makes many
footprints.

### 14.2 Naming: `name`

A template can name the footprints it produces, usually by interpolating its
parameters ([§7](#7-values-expressions-let)):

```stomp
template qfn(n, D, D2, e = 0.5, E = D, E2 = D2) {
  name "QFN-{n}-1EP_{D}x{E}mm_P{e}mm_EP{D2}x{E2}mm"
  description "QFN, {n} pins, {D} x {E} mm body, {e:.2} mm pitch"
  …
  thermal pad "{n + 1}" D2 x E2            # names interpolate too
}

footprint from qfn(32, 5, 3.45)            # named QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm
footprint "MY-QFN" from qfn(20, 4, 2.6)    # a name in the header wins
```

`name` belongs in templates, and in a call's override block to rename that one
footprint; an ordinary footprint is named in its header. A call with neither is an
error. Every footprint in a file needs a distinct name, generated ones included.

### 14.3 Tables: `footprints from`

A table calls a template once per row. The header row names the parameter each
column fills, and each following row is one footprint:

```stomp
footprints from qfn(e = 0.5) {   # arguments in the call apply to every row
  n    D    D2                   # header: parameter names
  12   3    1.65                 # a row: one footprint
  16   3    1.7
  32   5    3.45
}
```

- Cells are separated by whitespace, with one row per line (or `;`), and `#` comments
  are allowed anywhere. A cell is a number (with an optional unit suffix and an attached
  minus: `-0.1`, `20mil`), a `let` name, a `"string"`, or a parenthesized expression
  (`(D - 0.2)`). Arithmetic outside parentheses is an error, so a column never
  swallows its neighbour.
- Every row has one cell per column. Parameters not in the header take the call's
  arguments, then their defaults; a column may not repeat an argument of the call.
- The template names the footprints ([§14.2](#142-naming-name)) — a row has no header
  of its own.
- Rows are ordinary footprints: `extends` re-opens one by its generated name.

Tables transcribe datasheet variation tables (JEDEC MO-220, vendor package lists) the
way they are printed: one variant per row, the drawing's letters as columns.

### 14.4 Inheritance: `extends`

```stomp
footprint "SOIC-8-HS" extends "SOIC-8" {   # inheritance: re-open and override
  description "hand-solder variant"
  default pad rect 0.6 x 2.2               # longer pads
  courtyard auto 0.5
}
```

`extends` re-plays the parent then applies the child's statements under the usual
override rules (strong beats weak, later same-axis strong constraint on the *same*
object **replaces** the inherited one rather than over-constraining — inheritance is
the one place replacement is allowed). The parent can be any footprint, including one
a table generated.

## 15. Diagnostics

The syntax is designed so a checker can be blunt and specific. Required diagnostics:

- over-/under-constraint per object axis, citing statements (§9.7);
- unknown object name, with nearest-name suggestion;
- anchor/axis mismatch (`pad 1 left is … above …`);
- unit errors in expressions (length·length, bare ratio where length needed);
- `nc`/count mismatches in side blocks; duplicate names; `omit` of nonexistent balls;
- pad with no geometry after synthesis precedence (§11.3);
- suspicious-geometry *warnings* (zero-size pad, drill ≥ pad, overlapping same-net-unknown pads) — never errors, since intentional in edge cases;
- duplicate footprint names, generated ones included; a table row with the wrong number of cells; a column that names no parameter (nearest-name suggestion); a template that doesn't `name` the footprints a table or an unnamed call asks it for;
- an error inside a template body is reported on the call or table row whose arguments cause it, and once at the template when every call has it.

## 16. Formal grammar

The complete grammar is [`grammar.peg`](grammar.peg): a PEG (ordered choice, so it
maps 1:1 onto a PEGTL implementation later). Prose in this spec and the grammar file
are written to agree;
where they conflict, the grammar file wins for *syntax* and this spec wins for
*meaning*.

## 17. Open questions

1. **Name.** Settled: the language and repo are `stomp` — a stomp leaves a
   footprint — and files are `.stomp`.
2. **Weak cross-axis alignment** (§9.2) — keep, or require explicit second axis?
   Current choice optimizes for terseness; the failure mode (surprising default
   alignment) is mitigated by the under-constraint error never firing when it's active.
3. **IPC synthesis surface** — is `density least|nominal|most` enough control, or do
   toe/heel/side goals need per-footprint override syntax (`ipc toe 0.35 heel 0.35
   side 0.03`)? Leaning: add the long form later, it's purely additive.
4. **Arc/curved pads** (RF, rotary encoders) — `polygon` covers them badly. Possible
   future `ring`/`arcpad` shapes.
5. **Multi-footprint packages** (e.g. DNP variants sharing a body) — `extends` +
   `delete` covers it; is that enough?
6. **Should `balls`' letter/number order be overridable** for non-JEDEC grids
   (some FPGAs)? Probably `numbering bga letters "ABCDEFGHJK…"` later.
7. **Castellated semantics** — the `lead castellated` syntax is reserved; the
   half-hole plating/paste rules need their own mini-spec before implementation.
8. **Embedded checks** — a `check` statement (`check gap pad 1 to pad 2 is 0.4`)
   asserting a redundant datasheet dimension without constraining. Cheap to add,
   great for transcription confidence. ⟨leaning: yes, v1.1⟩
9. **External tables** — `footprints from qfn table "qfn.tsv"`, reading rows from a
   file next to the source, for vendor data that already lives in a spreadsheet.
   Purely additive.
10. **Interpolation formats** — `{x:.N}` covers fixed decimals, and IPC-7351 names
    (`QFN50P500X500X90-33N`) can be built with arithmetic (`{e * 100}`). Zero padding
    or unit conversion in the format may be wanted later.

## 18. Example index

| file | shows |
|---|---|
| [`examples/r0402.stomp`](examples/r0402.stomp) | minimal land mode; part mode of the same part |
| [`examples/led0603.stomp`](examples/led0603.stomp) | `polarized`, custom silk |
| [`examples/soic8.stomp`](examples/soic8.stomp) | canonical dual gullwing, 4 lines |
| [`examples/tssop20.stomp`](examples/tssop20.stomp) | `let` datasheet letters; `extends` hand-solder variant |
| [`examples/qfn32.stomp`](examples/qfn32.stomp) | quad leadless, thermal pad, paste windowing, vias, `pin1 chamfer` |
| [`examples/bga64.stomp`](examples/bga64.stomp) | ball grid, JEDEC lettering, `omit` |
| [`examples/sot23-5.stomp`](examples/sot23-5.stomp) | explicit sides block, `nc` |
| [`examples/to252.stomp`](examples/to252.stomp) | relational dimensioning showcase (DPAK) |
| [`examples/dip8.stomp`](examples/dip8.stomp) | THT dual, oval pads, square pin 1, `pin1 notch` |
| [`examples/hdr2x5.stomp`](examples/hdr2x5.stomp) | THT grid, zigzag numbering, selector overrides |
| [`examples/usb_microb.stomp`](examples/usb_microb.stomp) | the gnarly one: mixed SMD/NPTH/slots, `mirrors`, chained relations, polygon pad |
| [`examples/cp_radial.stomp`](examples/cp_radial.stomp) | cylinder body, THT, polarized, 3D overrides |
| [`examples/soic_family.stomp`](examples/soic_family.stomp) | `template` / `from` / `extends` |
| [`examples/qfn_library.stomp`](examples/qfn_library.stomp) | templates as functions: interpolated `name` / `description` / pad names, `footprints from` tables, an unnamed call, `extends` of a generated footprint |
| [`examples/syntax_zoo.stomp`](examples/syntax_zoo.stomp) | synthetic sweep of everything else; future parser fixture |
