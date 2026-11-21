# stomp: a footprint description language

*A stomp leaves a footprint. Files use the `.stomp` extension.*

**Status: draft 1, syntax and grammar only.** This document pins down the language you
write. Parsing (probably with PEGTL), constraint solving, IPC pad synthesis and 2D/3D
generation are out of scope for this revision. Where the syntax forces a decision about
meaning, the spec states the default and marks it as a decision. Open items are
collected in [§17 Open questions](#17-open-questions).

The formal grammar is in [`grammar.peg`](grammar.peg), and worked examples are in
[`examples/`](examples/). Every construct in this spec appears in at least one example
file. Most appear in real parts; the rare ones are in
[`examples/syntax_zoo.stomp`](examples/syntax_zoo.stomp), which isn't a real part and
can double as a parser test later. Not every keyword *variant* is used; the grammar file
is the authority on those.

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

stomp is a small language for describing electronic component footprints. From one
source file, it must be able to generate:

- a **2D land pattern**: copper pads, drills, mask and paste, silkscreen, courtyard and
  assembly outline;
- optionally, a **3D model** of the part (body and leads) for MCAD export and board
  rendering.

There are two ways to write a footprint, and one footprint can mix them:

- **Land mode:** describe the pads directly (sizes and positions). Use it when the
  datasheet gives a recommended land pattern, or when you're copying an existing one.
- **Part mode:** describe the *component* (body size, pins per side, pitch, lead form,
  lead span, thermal pad, ...) and let the tool derive the land pattern (IPC-7351
  style) and the 3D model. Explicit pads always override derived ones.

The main feature is **relational dimensioning**: you can place any object by saying it
is some distance, in some direction, from another object. The distance can be measured
**center to center, edge to edge, or mixed (center to edge)**. Datasheets dimension
their drawings as a web of offsets between whatever features the drafter chose. stomp
lets you type those dimensions in *as drawn*, without converting them to a common
origin by hand.

## 2. Design principles

1. **Type the datasheet in directly.** Every number in a mechanical drawing should go
   in as written: pitches (center to center), spans (outer to outer), gaps (inner to
   inner), edge offsets, letter dimensions (`let e = 0.65`). Variation tables go in the
   same way, one row per variant ([§14.3](#143-tables-footprints-from)). If you have to
   do arithmetic while typing in a drawing, the language has failed.
2. **Short for the common case, explicit for the odd one.** A JEDEC-standard package
   takes 4 to 6 lines. An awkward connector takes more, but is never impossible: you
   drop from generators to primitives and relations without changing files or
   dialects.
3. **Declarative, and order mostly doesn't matter.** Statements are facts, not
   commands. The solver orders them. Contradictions and gaps are hard errors that cite
   both statements involved ([§9.7](#97-constraint-semantics)).
4. **One namespace, real names.** Pads, holes, rows, groups, the body and the origin
   are all named objects, and any of them can be a dimension reference.
5. **Generated defaults are weak.** A generator (`pins 8 dual pitch 1.27 …`) makes
   ordinary objects with *default* positions and geometry. Any explicit statement about
   a generated object overrides the default. So "a standard package, except pad 5 is
   wider and there's a mounting hole" is a generator plus two lines, not a full
   description by hand.
6. **Reads like English, but small.** Statements read aloud (`pad 3 is 4.56 right of
   pad 1`), yet the keyword set is closed and the grammar is a deterministic PEG. There
   are no optional filler words, and there's one way to write each construct.

## 3. Quick tour

A passive in land mode: pad sizes plus one inner-edge gap, as land-pattern drawings
give them:

```stomp
footprint "R0402" {
  pins 2 horizontal
  default pad rect 0.5 x 0.6
  gap 0.5                      # inner edge to inner edge between the two pads
  body 1.0 x 0.5 x 0.35        # optional: enables silk, courtyard and 3D
}
```

An IC in part mode: you describe the component and the pads are derived (IPC density
`nominal` unless you say otherwise):

```stomp
footprint "SOIC-8" {
  body 3.9 x 4.9 x 1.5
  pins 8 dual pitch 1.27
  lead gullwing 0.41 x 1.04 span 6.0   # lead width x foot length; span outer to outer
  pin1 dot
}
```

A DPAK in relational mode: dimensions copied straight off the drawing, each measured
the way the drawing measured it:

```stomp
footprint "TO-252" {
  pad 1 rect 1.1 x 1.6
  pad 3 rect 1.1 x 1.6
  pad 2 rect 5.5 x 6.2                              # the tab

  pad 3 is 4.56 right of pad 1                      # center to center
  pad 2 is centered between pad 1 and pad 3 horizontally
  pad 2 inner is 1.9 above pad 1                    # the tab's near edge to the pin centers
}
```

`pad 2 inner` is the tab edge *facing* pad 1. `inner` and `outer` follow from the
direction of the relation, so you never have to work out which absolute edge a drawing
meant.

A library, one footprint per row. The template builds each footprint's name from its
parameters, and a table calls it once per row:

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

- **Encoding:** UTF-8. Non-ASCII characters are allowed only in quoted strings and
  comments.
- **Comments:** `#` to the end of the line. There are no block comments.
- **Statements:** one per line, ended by the newline. Several statements can share a
  line, separated by `;`. Newlines don't count inside parentheses `( … )` or right
  after `{`, `,` or an infix operator, which is enough to wrap long statements
  naturally. There is no continuation character.
- **Blocks:** `{ … }` groups statements (footprint bodies, side lists, graphic layers,
  model settings). Blocks nest.
- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive. Keywords are reserved
  (listed in [`grammar.peg`](grammar.peg)). A pad can't be named a bare `span`, but
  `pad "span"` works because it's quoted.
- **Names** (of pads, holes, rows, groups, footprints and templates): an identifier, an
  unsigned integer (`1`, `14`: by far the most common pad name), or a quoted string for
  anything else: `pad "D+"`, `footprint "SOIC-8_3.9x4.9mm_P1.27mm"`.
- **Strings:** `"…"` with `\"`, `\\`, `\{` and `\}` escapes. A `{…}` in any string
  interpolates an expression ([§7](#7-values-expressions-let)), so a literal brace is
  written `\{`. Strings end at the end of the line.
- **Numbers:** decimal only: `1`, `0.65`, `.5`. No exponents (footprints don't need
  them). A number can carry a suffix, attached with no space:
  - the length units `mm` `um` `nm` `mil` `in` (e.g. `50mil`, `0.65mm`);
  - `%` for ratios (`25%`);
  - `deg` (the default) or `rad` for angles.
- **Reserved single letters:** `x` (the size separator, §7) and `d` and `h` (the
  diameter and height markers) can't be `let` names.

## 5. Files, footprints, metadata

A file holds any number of file-level `units` and `let` statements, `template`
declarations ([§14](#14-templates-tables-and-inheritance)), `footprint` declarations
and `footprints` tables ([§14.3](#143-tables-footprints-from)). Related footprints
(variants, a family, a whole library) usually share one file.

```stomp
units mm                          # the file's default unit (mm if not given)

footprint "QFN-32" { … }

footprint "QFN-32-HS" extends "QFN-32" {   # inherit and override (§14)
  …
}

footprint "SOIC-16" from soic(16)          # a template call (§14)

footprints from qfn { … }                  # one footprint per table row (§14.3)
```

Metadata statements are all optional, and all take a string except `tags`:

```stomp
description "32-lead 5x5 mm QFN, 0.5 mm pitch, exposed pad"
datasheet   "https://example.com/qfn32.pdf"
manufacturer "Acme"
mpn          "ACME-32Q"
refdes       "U"                  # reference designator prefix
tags qfn, leadless, ipc
```

## 6. Coordinate system and units

- **+x is right and +y is up.** Angles are in degrees, counterclockwise, with `0°`
  along +x. (This matches Gerber. The y-down convention of some EDA tools is rejected
  on purpose.)
- The footprint is described **from the top side, seen from above**. Placing or
  mirroring it on the bottom side is the layout tool's job, not the footprint's.
- **The default length unit is mm.** A file can change it (`units mil`), and any number
  can override it (`0.3mm`, or `12mil` in the middle of an expression; units mix
  freely). Internally, everything becomes int64 nanometers.
- **The origin** defaults to the center of the body if there is one, else the center
  of the land pattern's bounding box. You can move it:

  ```stomp
  origin at pad 1                        # e.g. connectors dimensioned from pin 1
  origin at (0, -1.25)
  origin centered between pad 1 and pad 2
  ```

  All `(x, y)` coordinates in the footprint are relative to the final origin. `origin`
  is also an object you can refer to, with zero size ([§8](#8-objects-and-anchors)).

## 7. Values, expressions, `let`

- **Length expressions:** `+ - * /`, parentheses, numbers with optional unit suffixes,
  and `let` names: `(6.4 - 4.4) / 2`, `e * 3`, `span/2 - foot`. Multiplying two lengths
  is a unit error; dividing two lengths gives a plain ratio.
- **Sizes:** `WIDTH x LENGTH`, two length expressions joined by the keyword `x`:
  `0.6 x 1.5`, `(a+b) x 1.5`. The width is the x size and the length the y size,
  *before* any `rotate`.
- **Points:** `(x, y)`. 3D points `(x, y, z)` appear only in `model` blocks.
- **Percentages:** `25%`, used for the round-rect corner ratio and paste coverage.
- **Angles:** `45`, `45deg`, `0.7854rad`. Only `rotate` and arcs use them.
- **`let`:** named dimensions, for the whole file or for one footprint:

  ```stomp
  let e  = 0.65        # type in the datasheet's letter dimensions...
  let D  = 6.4
  let A1 = 0.05
  pins 20 dual pitch e # ...then use them by name
  ```

  A `let` name can be assigned only once. A footprint's `let`s shadow the file's.
  (Names like `A1` look like BGA ball names but never mean them: a ball reference
  always has its prefix, as in `ball A1`.)
- **Text:** a `"string"` is a value too: `let part = "TPS7A02"`, a template argument or
  a table cell. Text can't be used in arithmetic; it goes inside strings, through
  interpolation.
- **Interpolation:** in any string, `{expr}` is replaced by the expression's value:
  `name "QFN-{n}-1EP_{D}x{E}mm"`, `thermal pad "{n + 1}" …`. Plain numbers print in
  their shortest decimal form (`0.5`, `32`, `1.65`), lengths in the file's units, and
  text as written. `{expr:.N}` prints exactly N decimals (`{e:.2}` gives `0.50`).
  Interpolation is evaluated where the string is used, so it sees template parameters
  and the footprint's `let`s.

## 8. Objects and anchors

### 8.1 Object kinds

| kind | made by | notes |
|---|---|---|
| `pad` | `pad` statements, generators | copper (SMD or plated through-hole) |
| `hole` | `hole` statements | non-plated (NPTH), round or slot |
| `row` | `row` statements, generators | a run of pads in order, at a pitch |
| `group` | `group` statements | any set of objects, measured by its bounding box |
| `side` | generators (`pins … dual/quad/sides`) | the pads on one side of the package, grouped automatically |
| `body` | `body` statement | the physical outline; one per footprint |
| `origin` | implicit | a zero-size point at the footprint origin |

All names share **one namespace per footprint**: a pad and a group can't have the same
name. References normally include the kind keyword (`pad 3`, `side left`, `row A`), but
it can be left out where that's unambiguous (`3 is 4.56 right of 1` is legal; house
style keeps the keyword).

### 8.2 Anchors

Dimensions in drawings measure along one axis, so anchors are **per axis**, written as
a bare word after the reference:

```
pad 8 outer      side left inner      body left      pad 1        (= pad 1 center)
```

| anchor | meaning on the measurement axis |
|---|---|
| `center` | the center (the default; you never need to write it) |
| `inner` | the edge **facing the other object** in the relation |
| `outer` | the edge facing **away** from the other object |
| `left` `right` `top` `bottom` | that edge of the bounding box (it must match the axis: `left` and `right` with horizontal relations, `top` and `bottom` with vertical ones) |

`inner` and `outer` are what let span and gap dimensions go in as drawn. In `B outer is
6.0 right of A outer`, A's outer edge is its far left edge and B's is its far right
edge: the classic lead-span `D` dimension, typed in as is. Mixed measurements come for
free: `pad 2 inner is 3.81 above pad 1` (edge to center).

Edges are those of the object's **axis-aligned bounding box after rotation**: the
copper's for pads, the hole's for `hole`s, the outline's for `body`, and the union of
the members' boxes for rows, groups and sides. `origin` has only `center`.

## 9. Placement and dimensioning

Sizes and shapes are fixed properties; **positions are solved from constraints**. Each
statement below adds constraints.

### 9.1 Absolute: `at`

```stomp
pad 1 at (0, 2.2)
hole M1 at (-3.5, 0)
```

Fixes both axes of the object's center. Rotation is a property of the object
(`rotate`, §10.2), not part of its placement.

### 9.2 Directional relations: `is … of`

The workhorse. The general form:

```
TARGET [anchor] is DIST left of|right of|above|below REFERENCE [anchor]
```

```stomp
pad 3 is 4.56 right of pad 1                 # center to center
pad 8 outer is 6.0 right of pad 1 outer      # span, outer to outer
pad 2 inner is 0.4 right of pad 1 inner      # gap, inner to inner (facing edges)
pad 2 inner is 3.81 above pad 1              # mixed: edge to center
hole M1 is 2.89 left of pad 1 and 0.55 below pad 1    # chained with `and`
```

The exact meaning of `T tA is d DIR of R tR`, with axis *m* (x for `left`/`right`, y
for `above`/`below`) and sign *s* (+1 for `right`/`above`, −1 for `left`/`below`):

> *coord*(T, tA) = *coord*(R, tR) + s·d  on axis m,
> where `inner` on R is R's edge in direction +s (toward T) and `outer` its edge in −s;
> `inner` on T is T's edge in direction −s (toward R) and `outer` its edge in +s.

A negative `d` (from an expression, say) flips the direction, with no warning.

**Cross-axis default:** a directional relation also *weakly* lines up the target's
center with the reference's center on the other axis. A weak constraint is dropped as
soon as any explicit statement constrains that axis, so

```stomp
pad 2 is 1.27 right of pad 1        # pad 2 fully placed: y defaults to pad 1's y
```

is one line for the common "same row" case, and adding `pad 2 is 0.3 above pad 3`
quietly replaces the default.

*Decision:* weak cross-axis alignment. The alternative was "one axis constrained, the
other an error until stated", which doubles the line count of every real footprint.

### 9.3 Chains with `and`

`TARGET is CLAUSE and CLAUSE [and …]`. Each clause has its own distance, direction and
reference, and clauses can refer to different objects:

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

`mirrors … across x|y` mirrors the geometry and position about the footprint's axis.
If the prototype's position isn't fixed yet, the pair becomes one symmetric unknown
that a single `span`, `gap` or `pitch` measurement then pins down. That's exactly how
packages are dimensioned ("leads symmetric about the centerline, span 6.0"). In that
case the prototype (the object *being mirrored*, the right-hand operand) takes the −x
side for `across y` and the +y side for `across x`, to match pin 1 sitting at the left
or top, so the pair is fully determined.

`span`, `gap` and `pitch` are **unsigned, symmetric** constraints. Their axis comes from
an existing relation or mirror between the two objects. If there's none, add
`horizontally` or `vertically`.

### 9.5 Centering and alignment

```stomp
pad 2 is centered between pad 1 and pad 3               # both axes (midpoint of centers)
pad 2 is centered between pad 1 and pad 3 horizontally  # x only
pad "EP" is centered on body                            # both axes
align pad 7 with pad 2 horizontally                     # same y: they lie on one horizontal line
align hole M2 with hole M1 vertically                   # same x: one vertical line
```

`horizontally` always means "along a shared horizontal line" (equal y), and
`vertically` "along a shared vertical line" (equal x). English is ambiguous here, but
stomp isn't: this meaning holds everywhere the two words appear.

### 9.6 Rows and groups

```stomp
row L pads 1..4 pitch 1.27 going down       # 1 at the top, centers 1.27 apart
group mounting = hole M1, hole M2, pad "SH1", pad "SH2"
```

A `row` places its pads relative to each other (at the pitch, center to center, in the
`going` direction) and is itself one object: place the row with any §9 statement
(`row L outer is …`, `row L at (…)`). `..` ranges run either way (`8..5`). A `group`
adds no constraints; it only gives a shared bounding box to dimension against.

### 9.7 Constraint semantics

*Decision:* these rules were chosen for solvability and clear errors. Revisit them if a
full solver is ever wanted.

- **Single assignment per axis.** Each axis of each object takes its position from
  exactly one strong constraint. A second strong constraint on the same axis is an
  **over-constraint error** that cites both statements. That's a feature: it catches a
  mistyped datasheet at compile time instead of as a subtly wrong pad.
- Weak constraints (the §9.2 cross-axis default, and generator default placements,
  §11) fill any axis without a strong constraint. Explicit always beats generated.
- An axis with no constraint at all is an **under-constraint error** that names the
  object and axis.
- The order of constraints in the file doesn't matter, and references can point
  forward. Cycles that can't be resolved (A places B places A, other than through
  `mirrors` plus a measurement) are errors that list the cycle.

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
pad 4  roundrect 0.6 x 1.5 r 25%         # corner radius: % of the smaller side, or absolute (r 0.1)
pad 5  dshape 0.6 x 1.5 flat left        # "D" pad: one flat side, the other end fully round
pad 6  polygon (0,0) (1.2,0) (1.2,0.8) (0.5,0.8) (0.5,2.0) (0,2.0)   # vertices; local origin at the centroid
```

Through-hole (`tht`) pads add a drill; the shape and size describe the copper around
the hole:

```stomp
pad 1 tht rect 1.7 x 1.7 drill 1.0       # square pad, the classic pin 1
pad 2 tht circle 1.7 drill 1.0
pad 7 tht oval 1.7 x 2.4 drill slot 1.0 x 1.7   # slotted hole
```

Non-plated holes are their own kind:

```stomp
hole M1 0.85                             # NPTH, diameter
hole M2 slot 0.85 x 1.4                  # NPTH slot
```

### 10.2 Pad properties

These work in either form, after the shape or as block statements:

```stomp
rotate 45                    # about the pad center, CCW degrees
mask +0.05                   # solder-mask expansion per side (default: the stack rule)
mask none                    # no mask opening
mask defined                 # solder-mask-defined pad (the mask sets the land)
paste -0.05                  # paste shrink per side
paste none
paste divide 2 x 2 coverage 68%          # windowpane stencil (thermal pads)
paste divide 3 x 3 gutter 0.3            # or a fixed gutter between windows
vias 3 x 3 drill 0.3 pitch 1.1           # thermal via array inside the pad
```

### 10.3 Defaults, selectors, overrides, deletion

```stomp
default pad rect 0.4 x 1.4        # the prototype for every pad without its own geometry
                                  # (generated pads included)
pad 5 { width 2.0 }               # partial override: keep everything else, widen pad 5
pads 1..4, 9 { mask +0.1 }        # override several pads by selector
delete pad 11                     # remove a generated object (depopulated variants)
```

Partial-override properties: `width`, `length`, `shape`, `size W x L`, and any §10.2
property. A `pad NAME shape …` statement for a name that's already generated
*replaces* its geometry outright.

## 11. Parametric part description

Part mode describes the component, and the tool derives the pads (IPC-7351 style,
`density nominal` by default) and the 3D model. All generated objects are ordinary
named objects that you can override ([§2](#2-design-principles), point 5).

### 11.1 Body

```stomp
body 5 x 5 x 0.9                 # W x L x H box (molded, default draft and chamfer)
body cylinder d 8 h 11.5         # radial can
body 9.5 x 6.5                   # height optional (no height: a flat model)
```

### 11.2 Pins: count and arrangement

```stomp
pins 8 dual pitch 1.27           # left and right sides, CCW from the top left (pin 1 top left)
pins 32 quad pitch 0.5           # four sides, CCW from the top left
pins 2 horizontal                # two-terminal chip, pin 1 left
pins 2 vertical                  # pin 1 top
pins 3 single bottom pitch 0.95  # all pins on one side
pins grid 5 x 2 pitch 2.54       # NX columns x NY rows (x count first, like sizes)
balls 8 x 8 pitch 0.8            # shorthand for grid + `lead ball` + `numbering bga`
```

Clauses that can go on any `pins` or `balls` statement: `pitch P [x PY]` (a pitch per
axis, for grids), `pad SHAPE SIZE …` (a default pad for this statement),
`span S [QUAL]`, `numbering …` and `start …`.

Explicit sides, for irregular parts: a block of `SIDE: positions [pitch P]` entries.
Positions are listed **counterclockwise** (left: top to bottom, bottom: left to right,
right: bottom to top, top: right to left), and `nc` leaves a position empty:

```stomp
pins {
  left: 1, 2, 3 pitch 0.95
  right: 4, nc, 5                # SOT-23-5: pins 4 and 5 at the outer positions
}
```

Each side's run of positions, `nc` included, is centered on that side. The numbering is
whatever you listed; no scheme applies.

Numbering schemes for the regular forms: `numbering ccw` (the default for dual, quad
and single), `cw`, `zigzag` (the default for `grid`: 1-2 across the short pitch, then
advance, as on 0.1" box headers), `row-major`, `col-major`, and `bga` (the default for
`balls`: rows lettered A, B, C, ... skipping I O Q S X Z as JEDEC does, and columns
numbered from 1; ball names like `A1` are pad names). `start top-left` (the default),
`start top-right` and so on turn any scheme to start from another corner.

Depopulation:

```stomp
omit A1, H8, rows D..E cols 4..5        # by name and/or rectangular region
only rows A..B, rows G..H               # the reverse: keep only the listed regions
```

### 11.3 Leads

```stomp
lead gullwing 0.41 x 1.04 span 6.0   # width x foot length; span outer to outer
lead jlead 0.5 x 0.9 span 8.6
lead flat 0.25 x 0.4                 # leadless lands (QFN/DFN/LGA); span optional (defaults to the body edge)
lead endcap 0.35                     # chip terminations; width defaults to the body width
lead ball 0.4                        # BGA ball diameter
lead pin d 0.64                      # THT round pin; also: lead pin 0.64 x 0.64 (square)
lead wire d 0.6                      # axial or radial wire leads
lead tab 5.5 x 6.2                   # DPAK-style tab (becomes highest-numbered pin unless named)
lead castellated d 0.6               # half-hole edge castellations
```

A pin whose lead differs from the rest gets its own `lead` statement that names it:

```stomp
lead gullwing 0.7 x 0.9 span 7.0     # SOT-223: pins 1 to 3...
lead 4 gullwing 3.0 x 0.9            # ...and the wide tab lead, pin 4
lead 2 none                          # a pin cut off at the body: no 3D lead
```

The named pins take this lead instead of the general one. Where a pin's land is derived
from its lead, it's derived from this one, measured on the same span, so pin 4's land
comes out wider without a `pad 4 { … }` override. A per-pin lead with no size takes its
size from the pin's land. In land mode (explicit pads, no general `lead`), per-pin leads
put leads on those pads for the 3D model ([§13](#13-3d-model)) and leave the pads alone:
`lead 1, 3 gullwing 0.75 x 1.0` on a DPAK.

`span` qualifiers, wherever a symmetric distance across the package appears (`lead …
span`, bare `span`, `pins … span`): **`outer`** (the default: lead span as datasheets
draw it), **`inner`** and **`centers`**. The bare statements `span 5.4 centers` and
`gap 4.0` (the same as `span 4.0 inner`) set the spacing of the land-pattern rows
directly in land mode, or override the derived spacing in part mode. In part mode,
`span` measures the *leads*; in land mode (no `lead`), it measures the *pads*.

*Decision:* a pad's geometry comes from, in order: an explicit `pad NAME`, then
`default pad` or a `pins … pad` clause, then IPC sizing from the `lead`. If none of
these applies, it's an error ("no pad geometry").

### 11.4 Thermal / exposed pad

```stomp
thermal pad 3.7 x 3.7                          # named EP by default, centered on the body
thermal pad 33 3.7 x 3.7 {                     # or give it its pin number
  paste divide 2 x 2 coverage 68%
  vias 3 x 3 drill 0.3 pitch 1.1
}
```

### 11.5 Pin 1 marker and polarity

```stomp
pin1 dot          # silk dot outside the corner nearest pin 1 (default for dual and quad)
pin1 chamfer      # chamfered silk corner (the QFN convention)
pin1 notch        # DIP-style notch at the pin-1 end
pin1 bar          # bar across the pin-1 end (tantalum or diode style)
pin1 none
polarized         # two-terminal polarity: pin 1 is positive (the anode); adds a bar
                  # on the cathode side, and the 3D stripe
density most      # IPC density level: least | nominal | most
```

## 12. Graphic layers

Everything here defaults to `auto` and rarely needs writing:

- **silk** `auto`: the body outline, kept clear of copper, plus the `pin1` marker;
- **courtyard** `auto`: the convex hull of the lands and body, plus the IPC clearance
  for the density level (`courtyard auto 0.5` overrides the clearance);
- **assembly** `auto`: the body outline plus the refdes.

Manual work combines predictably. Within one footprint, `auto` and `none` set the
layer's base (the last one wins), and any `{ … }` blocks **add to the base**. So a lone
`silk { text … }` adds to the auto outline, while `silk none` followed by `silk { … }`
is fully manual.

Manual additions and overrides:

```stomp
silk {
  outline body offset 0.15            # follow the body outline, pushed out
  line (-2.5, 1.0) (-2.5, -1.0) width 0.12
  arc (0,0) r 1.5 from 30 to 150 width 0.12
  circle (0, 2.1) d 0.3 fill
  text ">CATHODE" at (1.8, 0) size 0.6
}
silk none                             # or turn it off entirely
courtyard rect 7.4 x 7.4
courtyard { polygon (…) (…) (…) }
assembly none
text ref at (0, 0) size 1.0           # refdes and value fields; default layers: ref on silk, value on assembly
text value at (0, -1.2) size 0.8 layer assembly
```

## 13. 3D model

A footprint with a `body` has a 3D model without another line: the body, the pins and
the lead form already describe the part. A `model { … }` block adjusts what that
description can't say and adds anything else; `no model` turns it off.

### 13.1 The generated model

The model uses the footprint's x and y ([§6](#6-coordinate-system-and-units)), with z
up from the board surface: z = 0 is the top of the board. The body's H is the seated
height, JEDEC *A*: the top of the part above the board. The body's bottom sits at the
standoff, JEDEC *A1*. A body without an H is drawn as a flat plate.

The lead form picks the rest:

| lead | body | leads | standoff | pin-1 mark |
|---|---|---|---|---|
| `gullwing` | molded, 8° draft, parting line at mid-body | leave the parting line, bend down to a foot on the board; toes at the span | 0.1 | dimple |
| `jlead` | molded, 8° draft | leave the parting line, run down the body side and curl under it | 0.5 | dimple |
| `flat` | sawn block | terminals flush with the body's bottom and edge (or at the span); exposed pads under the body | 0.02 | dot |
| `endcap` | chip; a cylinder body is a MELF, lying along the pins | metal caps over each end, T long | 0 | — |
| `ball` | laminate substrate and mold cap | balls d wide, collapsed to the standoff | 0.75 d | dot |
| `pin`, `dual` | molded DIP | shoulders down to the board, then the lead through it | 0.5 | dimple |
| `pin`, other | housing one pitch tall when H is over two pitches, else H | straight pins from below the board to H | 0 | — |
| `wire` | cylinder: a can, or an axial body when the pins lie outside it | wires down through the board; axial wires leave the body's ends | 0.5 / 0 | — |
| `castellated` | module board, plus a shield can when H > 1.2 | plated half-holes in the board edge | 0 | dot |
| `tab` | — | a metal slab under its pad | — | — |
| no `lead` | plain block | — | 0 | as `pin1` |

- **Leads** are tin. Gull-wings are 0.15 thick below a 1 mm pitch, 0.2 up to 2 mm and
  0.3 above. J-leads are 0.2, or 0.25 at a 1.27 mm pitch or more. Flat terminals are
  0.2. Grid pins are gold. Through-hole leads reach 3 mm below the board. A gull-wing's
  foot is the lead's foot length, shortened if the bend needs the room.
- **Pin 1.** The mark goes on the body top at the corner nearest pin 1. `pin1 notch`
  gives a notch at the pin-1 end, `pin1 bar` a stripe, and `pin1 none` no mark.
- **Polarity.** A `polarized` part gets a stripe at its marked end: the cathode (pin 2)
  of a diode or LED and the negative lead of a can, but the positive end (pin 1) of a
  chip capacitor, which is how tantalums are marked.
- **Colors** follow the part family, from the `refdes` letter. Chip resistors are white
  ceramic with a black top, chip capacitors are tan, inductors gray, and chip LEDs white
  with a clear lens. Molded bodies are black.

Omitted pins have no lead. Per-pin `lead` statements ([§11.3](#113-leads)) change one
pin's lead, remove it (`lead 2 none`), or, in land mode, put leads on explicit pads.

### 13.2 `model { … }`

Every property is optional:

```stomp
model {
  standoff 0.05             # the body's bottom above the board (JEDEC A1)
  height 0.85               # the model's height, where it isn't the body's H
  draft 0                   # molded-body side draft (0: a straight-sided block)
  body color "#20232a"      # "#rrggbb", or a name (below)
  leads color gold
  leads thickness 0.2       # lead-frame thickness (JEDEC c)
  leads below 3.5           # through-hole leads: length below the board
  leads above 0             # grid pins: height above the housing (0: a socket)
  pin1 dot                  # the body mark: dimple | dot | notch | stripe | none
}
```

Named colors: `black`, `gray`, `white`, `red`, `green`, `blue`, `yellow`, `orange`,
`brown`, `tan`, `ceramic`, and the metals `tin`, `silver`, `gold`, `copper` and
`aluminum`. Metals render shiny.

### 13.3 Extra solids

Anything the lead form doesn't describe can be built from boxes and cylinders:

```stomp
model {
  box 2.9 x 2.2 x 0.1 on body color tin            # a lid, centered on the body top
  box 6.6 x 6.6 x 0.5 color black                  # a base plate on the board
  cylinder d 0.8 h 0.2 at (1.0, 0.6) on body       # at (x, y): the solid's center
  cylinder d 2 h 6 at (0, 0, 1) rotate (0, 90, 0)  # at (x, y, z): z is its bottom
}
```

`box W x L x H` and `cylinder d D h H` (upright) start centered on the body (or on the
origin, if there's no body), resting on the board. `at (x, y)` moves the center. A
third coordinate sets the height of the solid's bottom, and `on body` rests it on the
body top instead. `rotate (rx, ry, rz)` turns the solid about its center, in degrees
(about x, then y, then z), before it is placed. A solid takes the body's color unless
it names one.

### 13.4 External models, inheritance

```stomp
model {
  step "models/QFN32.step" offset (0, 0, 0) rotate (0, 0, 90) scale 1.0
}
no model                           # no 3D output at all
```

`step` replaces the generated model, and the transform maps the file into the model's
frame. Model blocks merge down an `extends` chain: a later level's settings replace
earlier ones, and its solids add to theirs. `no model` at any level ends the model
there, and a later `model { … }` starts it again.

## 14. Templates, tables and inheritance

### 14.1 Templates are functions

A template takes parameters and makes a footprint:

```stomp
template soic(n, lspan = 6.0, e = 1.27, bw = 3.9) {   # parameters are plain identifiers;
  body bw x (n/2 - 1) * e + 2.0 x 1.5                 # keywords (span, pitch, ...) can't
  pins n dual pitch e                                 # be parameter names
  lead gullwing 0.41 x 1.04 span lspan
  pin1 dot
}

footprint "SOIC-8"  from soic(8)
footprint "SOIC-16" from soic(16)
footprint "SOIC-16W" from soic(16, lspan = 10.3, bw = 7.5)
```

Template parameters are plain identifiers, bound as the footprint's `let`s; keywords
can't be parameter names. A default can refer to other parameters (`E = D`). Arguments
are positional, named, or both (`qfn(32, 5, D2 = 3.45)`), and a parameter without a
default must be given. A call can also carry a `{ … }` block of extra overrides. There's
no control flow (conditionals or loops) in v1: a template is a footprint body with
parameters, and a table ([§14.3](#143-tables-footprints-from)) is how one template
makes many footprints.

### 14.2 Naming: `name`

A template can name the footprints it makes, usually by interpolating its parameters
([§7](#7-values-expressions-let)):

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
footprint. An ordinary footprint is named in its header. A call with neither is an
error. Every footprint in a file needs its own name, generated ones included.

### 14.3 Tables: `footprints from`

A table calls a template once per row. The header row names the parameter each column
fills, and each row after it is one footprint:

```stomp
footprints from qfn(e = 0.5) {   # arguments in the call apply to every row
  n    D    D2                   # header: parameter names
  12   3    1.65                 # a row: one footprint
  16   3    1.7
  32   5    3.45
}
```

- Cells are separated by spaces or tabs, one row per line (or `;`), and `#` comments
  can go anywhere. A cell is a number (with an optional unit suffix, and a minus sign
  attached: `-0.1`, `20mil`), a `let` name, a `"string"`, or an expression in
  parentheses (`(D - 0.2)`). Arithmetic outside parentheses is an error, so a column
  never swallows its neighbor.
- Every row has one cell per column. Parameters not in the header take the call's
  arguments, then their defaults. A column can't repeat an argument of the call.
- The template names the footprints ([§14.2](#142-naming-name)); a row has no header of
  its own.
- Rows are ordinary footprints: `extends` can reopen one by its generated name.

Tables take in datasheet variation tables (JEDEC MO-220, vendor package lists) the way
they're printed: one variant per row, with the drawing's letters as columns.

### 14.4 Inheritance: `extends`

```stomp
footprint "SOIC-8-HS" extends "SOIC-8" {   # inherit: reopen and override
  description "hand-solder variant"
  default pad rect 0.6 x 2.2               # longer pads
  courtyard auto 0.5
}
```

`extends` replays the parent, then applies the child's statements under the usual
override rules: strong beats weak, and a later strong constraint on the same axis of the
*same* object **replaces** the inherited one instead of over-constraining it.
Inheritance is the one place where replacement is allowed. The parent can be any
footprint, including one a table generated.

## 15. Diagnostics

The syntax is designed so a checker can be blunt and specific. Required diagnostics:

- over- and under-constraint, per object axis, citing the statements (§9.7);
- an unknown object name, with the nearest name suggested;
- an anchor that doesn't match the axis (`pad 1 left is … above …`);
- unit errors in expressions (length·length, a bare ratio where a length is needed);
- `nc` and count mismatches in side blocks; duplicate names; `omit` of balls that don't exist;
- a pad with no geometry after the precedence rules (§11.3);
- suspicious-geometry *warnings* (a zero-size pad, a drill as large as its pad or larger, overlapping pads whose nets aren't known), never errors, since each can be intended;
- duplicate footprint names, generated ones included; a table row with the wrong number of cells; a column that names no parameter (with the nearest name suggested); a template that doesn't `name` the footprints a table or an unnamed call needs from it;
- an error inside a template body, reported on the call or table row whose arguments cause it, and once at the template when every call has it;
- 3D: a per-pin `lead` naming a pin that doesn't exist or was omitted; `leads below` or `leads above` on leads that can't use them; a solid or color that can't be built; a model property given twice in one block.

## 16. Formal grammar

The complete grammar is [`grammar.peg`](grammar.peg). It's a PEG (ordered choice), so
it maps one to one onto a PEGTL implementation later. This spec and the grammar file
are written to agree. Where they conflict, the grammar file wins for *syntax* and this
spec wins for *meaning*.

## 17. Open questions

1. **Name.** Settled: the language and repo are `stomp` (a stomp leaves a footprint),
   and files are `.stomp`.
2. **Weak cross-axis alignment** (§9.2): keep it, or require the second axis to be
   stated? The current choice favors short code. The failure mode, a surprising
   default alignment, is mitigated by the under-constraint error never firing while
   the default is active.
3. **IPC synthesis controls.** Is `density least|nominal|most` enough, or do toe, heel
   and side goals need syntax to override them per footprint (`ipc toe 0.35 heel 0.35
   side 0.03`)? Leaning: add the long form later; it's purely additive.
4. **Arc and curved pads** (RF, rotary encoders): `polygon` handles them badly. There
   could be `ring` or `arcpad` shapes later.
5. **Multi-footprint packages** (for example DNP variants that share a body):
   `extends` plus `delete` covers them. Is that enough?
6. **Should the letter and number order of `balls` be overridable** for non-JEDEC grids
   (some FPGAs)? Probably `numbering bga letters "ABCDEFGHJK…"` later.
7. **Castellated semantics.** The `lead castellated` syntax is reserved, but the
   plating and paste rules for half-holes need their own mini-spec before they're
   implemented.
8. **Embedded checks.** A `check` statement (`check gap pad 1 to pad 2 is 0.4`) that
   asserts a redundant datasheet dimension without constraining anything. Cheap to add,
   and great for confidence in a transcription. Leaning: yes, in v1.1.
9. **External tables.** `footprints from qfn table "qfn.tsv"`, reading rows from a file
   next to the source, for vendor data that already lives in a spreadsheet. Purely
   additive.
10. **Interpolation formats.** `{x:.N}` covers fixed decimals, and IPC-7351 names
    (`QFN50P500X500X90-33N`) can be built with arithmetic (`{e * 100}`). Zero padding or
    unit conversion in the format may be wanted later.
11. **Body detail.** Molded bodies have one draft angle and square edges; real ones also
    have a pin-1 bevel, rounded corners and ejector-pin marks. A `model` property per
    feature would be additive, but past some point `step` may be the right answer.
12. **Polarity conventions.** The 3D stripe follows the family's convention (§13.1),
    which isn't always the silk's: a tantalum's band marks pin 1. Should the silk bar
    follow it too?

## 18. Example index

| file | shows |
|---|---|
| [`examples/r0402.stomp`](examples/r0402.stomp) | the smallest land mode, and part mode for the same part |
| [`examples/led0603.stomp`](examples/led0603.stomp) | `polarized`, custom silk |
| [`examples/soic8.stomp`](examples/soic8.stomp) | the standard dual gull-wing, in 4 lines |
| [`examples/tssop20.stomp`](examples/tssop20.stomp) | `let` for the datasheet letters; an `extends` hand-solder variant |
| [`examples/qfn32.stomp`](examples/qfn32.stomp) | quad leadless, thermal pad, paste windows, vias, `pin1 chamfer` |
| [`examples/bga64.stomp`](examples/bga64.stomp) | ball grid, JEDEC lettering, `omit` |
| [`examples/sot23-5.stomp`](examples/sot23-5.stomp) | explicit sides block, `nc` |
| [`examples/to252.stomp`](examples/to252.stomp) | relational dimensioning (DPAK); per-pin leads on explicit pads for the 3D model |
| [`examples/dip8.stomp`](examples/dip8.stomp) | THT dual, oval pads, square pin 1, `pin1 notch` |
| [`examples/hdr2x5.stomp`](examples/hdr2x5.stomp) | THT grid, zigzag numbering, selector overrides |
| [`examples/usb_microb.stomp`](examples/usb_microb.stomp) | the hardest one: mixed SMD, NPTH and slots, `mirrors`, chained relations, a polygon pad |
| [`examples/cp_radial.stomp`](examples/cp_radial.stomp) | cylinder body, THT, polarized, a 3D color override |
| [`examples/soic_family.stomp`](examples/soic_family.stomp) | `template`, `from`, `extends` |
| [`examples/qfn_library.stomp`](examples/qfn_library.stomp) | templates as functions: interpolated `name`, `description` and pad names, `footprints from` tables, an unnamed call, `extends` of a generated footprint |
| [`examples/sot223.stomp`](examples/sot223.stomp) | per-pin lead: the wide tab lead widens its own land and 3D lead |
| [`examples/do41.stomp`](examples/do41.stomp) | axial through-hole: a cylinder body lying down, bent wires, a cathode band |
| [`examples/crystal3225.stomp`](examples/crystal3225.stomp) | extra 3D solids: a ceramic package with a metal lid |
| [`examples/syntax_zoo.stomp`](examples/syntax_zoo.stomp) | not a real part: covers everything else, and can double as a parser test |
