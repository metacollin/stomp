# stomp: a footprint description language

*A stomp leaves a footprint. Files use the `.stomp` extension.*

**Status: draft 1, syntax and grammar only.** This document pins down the language you
write. Parsing (probably with PEGTL), constraint solving, IPC pad synthesis and 2D/3D
generation are out of scope for this revision. Where the syntax forces a decision about
meaning, the spec states the default and marks it as a decision. Open items are
collected in [§17 Open questions](#17-open-questions).

The formal grammar is in [`grammar.peg`](grammar.peg), and worked examples are in
[`examples/`](examples/). The 3D models and the automatic silk marks are drawn by a
standard library written in stomp itself, in [`stdlib/`](stdlib/)
([§13.5](#135-the-standard-library)). Every construct in this spec appears in at least one example
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
7.  [Values, expressions, names](#7-values-expressions-names)
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
   inner), edge offsets, letter dimensions (`e = 0.65`). Variation tables go in the
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
5. **Generated defaults are weak.** A generator (`pins 8 dual pitch: 1.27 …`) makes
   ordinary objects with *default* positions and geometry. Any explicit statement about
   a generated object overrides the default. So "a standard package, except pad 5 is
   wider and there's a mounting hole" is a generator plus two lines, not a full
   description by hand.
6. **Reads like English, but small.** Statements read aloud (`pad 3 is 4.56 right of
   pad 1`), yet the grammar is a deterministic PEG. Words that relate things read as a
   sentence, and a value with a name says it, with a colon (`pitch: 1.27`). A block is
   its header line, its statements and `end`. There are no optional filler words, and
   there's one way to write each construct.
7. **The models are stomp too.** Every body, lead and mark the tool draws comes from a
   standard library of stomp features. A file can replace any of them, so the way a
   part looks is code you can read and change, not something built into the tool.

## 3. Quick tour

A passive in land mode: pad sizes plus one inner-edge gap, as land-pattern drawings
give them:

```stomp
footprint "R0402"
  pins 2 horizontal
  default pad rect 0.5 x 0.6
  gap: 0.5                     # inner edge to inner edge between the two pads
  body 1.0 x 0.5 x 0.35        # optional: enables silk, courtyard and 3D
end
```

A block is a header line, the statements under it, and `end`. A value with a name
takes a colon (`gap: 0.5`); words that relate things, like `x` in `rect 0.5 x 0.6` or
`is` and `of` in a placement, don't.

An IC in part mode: you describe the component and the pads are derived (IPC density
`nominal` unless you say otherwise):

```stomp
footprint "SOIC-8"
  body 3.9 x 4.9 x 1.5
  pins 8 dual pitch: 1.27
  lead gullwing 0.41 x 1.04 span: 6.0  # lead width x foot length; span outer to outer
  pin1: dot
end
```

A DPAK in relational mode: dimensions copied straight off the drawing, each measured
the way the drawing measured it:

```stomp
footprint "TO-252"
  pad 1 rect 1.1 x 1.6
  pad 3 rect 1.1 x 1.6
  pad 2 rect 5.5 x 6.2                              # the tab

  pad 3 is 4.56 right of pad 1                      # center to center
  pad 2 is centered between pad 1 and pad 3 horizontally
  pad 2 inner is 1.9 above pad 1                    # the tab's near edge to the pin centers
end
```

`pad 2 inner` is the tab edge *facing* pad 1. `inner` and `outer` follow from the
direction of the relation, so you never have to work out which absolute edge a drawing
meant.

A library, one footprint per row. The template builds each footprint's name from its
parameters, and a table calls it once per row:

```stomp
template qfn(n, D, D2, e = 0.5)
  name: "QFN-{n}-1EP_{D}x{D}mm_P{e}mm_EP{D2}x{D2}mm"
  body D x D x 0.9
  pins n quad pitch: e
  lead flat e / 2 x 0.4
  thermal pad "{n + 1}" D2 x D2
end

footprints from qfn
  n    D    D2
  16   3    1.7
  32   5    3.45
  48   7    5.6
end
```

## 4. Lexical structure

- **Encoding:** UTF-8. Non-ASCII characters are allowed only in quoted strings and
  comments.
- **Comments:** `#` to the end of the line. There are no block comments.
- **Statements:** one per line, ended by the newline. Several statements can share a
  line, separated by `;`. Newlines don't count inside parentheses `( … )` or right
  after `,` or an infix operator, which is enough to wrap long statements naturally.
  There is no continuation character.
- **Blocks:** a header line (`footprint "SOIC-8"`, `feature tick(n = 1)`,
  `section long`, `model`, …), the statements under it, then the word `end`. Blocks
  nest. The parser goes by `end`, not by indentation, so a short block fits on one line
  with `;`: `section fine; c = 0.15; end`. There are no braces.
- **Named values:** a word followed by a colon names the value after it: `pitch: 1.27`,
  `description: "…"`, `color: tin`. The space after the colon is optional. Words that
  relate one thing to another (`at`, `is`, `of`, `from`, `to`, `along`, `between`,
  `across`, `with`, `and`, `on`) and flags (`fill`, `clear`, `open`, `down`,
  `castellated`, `tht`, `polarized`, `inner`, `outer`, `centers`) take none.
- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive.
- **Keywords are contextual.** A keyword means something only where the grammar expects
  it, so `draft`, `below`, `top`, `d` or `pitch` can name a parameter or a value. Only
  `x` (the size separator) and `end` are reserved everywhere. Objects are the
  exception: a pad, hole, row or group named after a keyword is quoted (`pad "at"`),
  since a bare one would read as part of the statement.
- **Names** (of pads, holes, rows, groups, footprints and templates): an identifier, an
  unsigned integer (`1`, `14`: by far the most common pad name), or a quoted string for
  anything else: `pad "D+"`, `footprint "SOIC-8_3.9x4.9mm_P1.27mm"`.
- **Strings:** `"…"` with `\"`, `\\`, `\{` and `\}` escapes. A `{…}` in any string
  interpolates an expression ([§7](#7-values-expressions-names)), so a literal brace is
  written `\{`. Strings end at the end of the line.
- **Numbers:** decimal, with an optional exponent: `1`, `0.65`, `.5`, `1e-9`, `2.5E3`.
  A number can carry a suffix, attached with no space:
  - the length units `mm` `um` `nm` `mil` `in` (e.g. `50mil`, `0.65mm`);
  - `%` for ratios (`25%`);
  - `deg` (the default) or `rad` for angles;
  - a side mark, `w` or `h`, after any unit: `1.1w`, `43milw` (§7). A closing
    parenthesis can carry one too: `(a + b)h`.

## 5. Files, footprints, metadata

A file holds any number of file-level `units:` lines and named values (`NAME = value`),
`template` declarations ([§14](#14-templates-tables-and-inheritance)), `footprint` declarations
and `footprints` tables ([§14.3](#143-tables-footprints-from)), and `feature` definitions
([§12.1](#121-custom-features)). Related footprints
(variants, a family, a whole library) usually share one file. A footprint or
template can also start with its own `units:` ([§6](#6-coordinate-system-and-units)).

```stomp
units: mm                                # the file's default unit (mm if not given)

footprint "QFN-32"
  …
end

footprint "QFN-32-HS" extends "QFN-32"   # inherit and override (§14)
  …
end

footprint "SOIC-16" from soic(16)        # a template call (§14)

footprints from qfn                      # one footprint per table row (§14.3)
  …
end
```

Metadata statements are all optional, and all take a string except `tags:`:

```stomp
description: "32-lead 5x5 mm QFN, 0.5 mm pitch, exposed pad"
datasheet: "https://example.com/qfn32.pdf"
manufacturer: "Acme"
mpn: "ACME-32Q"
refdes: "U"                       # reference designator prefix
tags: qfn, leadless, ipc
```

## 6. Coordinate system and units

- **+x is right and +y is up.** Angles are in degrees, counterclockwise, with `0°`
  along +x. (This matches Gerber. The y-down convention of some EDA tools is rejected
  on purpose.)
- The footprint is described **from the top side, seen from above**. Placing or
  mirroring it on the bottom side is the layout tool's job, not the footprint's.
- **The default length unit is mm.** A file can change it (`units: mil`), and any number
  can override it (`0.3mm`, or `12mil` in the middle of an expression; units mix
  freely). Internally, everything becomes int64 nanometers.
- **A footprint or template can set its own unit** with `units:` as its first
  statement. It lasts until the block's `end`:

  ```stomp
  template dip(n, D, E = 300)
    units: mil                           # everything in here is in mils
    body 250 x D x 130
    pins n dual pitch: 100 span: E centers
  end
  ```

  A plain number has no unit until it's used as a length. Then it takes the unit of
  the footprint or template that uses it, so a table cell of `375` is 375 mil in the
  template above, and so is the default `E = 300`. A number written with a unit keeps
  it. Every statement keeps the unit of the block it's written in, so a footprint
  that `extends` a parent in mils can add statements in mm.
- **The origin** defaults to the center of the body if there is one, else the center
  of the land pattern's bounding box. You can move it:

  ```stomp
  origin at pad 1                        # e.g. connectors dimensioned from pin 1
  origin at (0, -1.25)
  origin centered between pad 1 and pad 2
  ```

  All `(x, y)` coordinates in the footprint are relative to the final origin. `origin`
  is also an object you can refer to, with zero size ([§8](#8-objects-and-anchors)).

## 7. Values, expressions, names

- **Length expressions:** `+ - * /`, parentheses, numbers with optional unit suffixes,
  and names: `(6.4 - 4.4) / 2`, `e * 3`, `span/2 - foot`. Multiplying two lengths
  is a unit error; dividing two lengths gives a plain ratio.
- **Sizes:** `WIDTH x LENGTH`, two length expressions joined by the keyword `x`:
  `0.6 x 1.5`, `(a+b) x 1.5`. The width is the x size and the length the y size,
  *before* any `rotate`.
- **Side marks:** either side of a size can be marked, `w` for the width and `h` for
  the height (the length). A marked side goes in its slot wherever it's written, so
  `rect 1.6h x 1.1w` is `rect 1.1 x 1.6`, and one mark is enough: `1.6h x 1.1`. The
  mark goes at the end of the side, after any unit: `43milw`, `(D - 0.2)h`. A name
  needs parentheses, since `Dw` would be a different name: `(D)w`. Marks are for 2D
  sizes only (pads, drills, holes, leads, thermal pads and rectangles); a `body` or
  `box` is always `W x L x H`.
- **Points:** `(x, y)`. 3D points `(x, y, z)` appear only where solids go: in `model`
  blocks, and in features and their placements.
- **Percentages:** `25%`, used for the round-rect corner ratio and paste coverage.
- **Angles:** degrees, counterclockwise: `45`, `45deg`, `0.7854rad`, or any expression
  (`a + 90`, `atan2(1, 2)`). `rotate:`, arcs, `draft:` and the 3D solids use them.
- **Functions:** a name touching its `(` is a call, so a table cell `D (D - 1)` is
  still two cells:

  | function | gives |
  |---|---|
  | `min(a, …)`, `max(a, …)`, `clamp(v, lo, hi)`, `abs(a)`, `hypot(a, …)` | as `+` would combine the arguments: lengths, or plain numbers |
  | `sqrt(a)` | of a plain number or a ratio, not a length |
  | `sin(a)`, `cos(a)`, `tan(a)` | of an angle in degrees; exact at right angles |
  | `asin(a)`, `acos(a)`, `atan2(y, x)` | an angle in degrees |
  | `mix(c1, c2, t)` | a color part way, t from 0 to 1, from c1 to c2 |
  | `metal(c)` | the color, rendered as a shiny metal |

  `pi` is a name for 3.14159…. Neither it nor the function names are reserved; a name
  given its own value hides `pi`.
- **Colors** are values too: `"#rrggbb"`, a built-in name (`tin`, `gold`, `black`;
  §13.2), a palette name from the standard library (`can_blue`,
  `ferrite`, [§13.5](#135-the-standard-library)), `metal(…)` or `mix(…)`. A name is
  looked up as a name or parameter first, then as a built-in color, then in the
  palette. Colors can't take part in arithmetic.
- **Names:** `NAME = value` gives a name a value, for the whole file or for one
  footprint:

  ```stomp
  e  = 0.65              # type in the datasheet's letter dimensions...
  D  = 6.4
  A1 = 0.05
  pins 20 dual pitch: e  # ...then use them by name
  ```

  A name gets one value at each level: giving it two in one file, footprint or feature
  is an error. A footprint's names hide the file's, a child footprint's (`extends`, or a
  `from … with` block) replace its parent's, and a feature's sections can give its names
  other values ([§12.1](#121-custom-features)). A name can be any word but `x` and
  `end`, keywords included (§4). (Names like `A1` look like BGA ball names but never
  mean them: a ball reference always has its prefix, as in `ball A1`.)
- **Text:** a `"string"` is a value too: `part = "TPS7A02"`, a template argument or
  a table cell. Text can't be used in arithmetic; it goes inside strings, through
  interpolation.
- **Interpolation:** in any string, `{expr}` is replaced by the expression's value:
  `name: "QFN-{n}-1EP_{D}x{E}mm"`, `thermal pad "{n + 1}" …`. Plain numbers print in
  their shortest decimal form (`0.5`, `32`, `1.65`), lengths in the file's units, and
  text as written. `{expr:.N}` prints exactly N decimals (`{e:.2}` gives `0.50`).
  Interpolation is evaluated where the string is used, so it sees template parameters
  and the footprint's names.

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
row L pads 1..4 pitch: 1.27 going: down     # 1 at the top, centers 1.27 apart
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
pad NAME [tht] SHAPE [PROPERTY …]        # a pad: its shape, then any properties
pad NAME PROPERTY [PROPERTY …]           # change a pad: its shape, size or properties
```

Shapes:

```stomp
pad 1  rect 0.6 x 1.5
pad 2  oval 0.6 x 1.5                    # obround
pad 3  circle 0.45                       # diameter
pad 4  roundrect 0.6 x 1.5 r: 25%        # corner radius: % of the smaller side, or absolute (r: 0.1)
pad 5  dshape 0.6 x 1.5 flat: left       # "D" pad: one flat side, the other end fully round
pad 6  polygon (0,0) (1.2,0) (1.2,0.8) (0.5,0.8) (0.5,2.0) (0,2.0)   # vertices; local origin at the centroid
```

Through-hole (`tht`) pads add a drill; the shape and size describe the copper around
the hole:

```stomp
pad 1 tht rect 1.7 x 1.7 drill: 1.0      # square pad, the classic pin 1
pad 2 tht circle 1.7 drill: 1.0
pad 7 tht oval 1.7 x 2.4 drill: slot 1.0 x 1.7  # slotted hole
```

Non-plated holes are their own kind:

```stomp
hole M1 0.85                             # NPTH, diameter
hole M2 slot 0.85 x 1.4                  # NPTH slot
```

### 10.2 Pad properties

These go after a pad's shape, in any order, or on a `pad NAME` line of their own to
change a pad:

```stomp
rotate: 45                   # about the pad center, CCW degrees
mask: +0.05                  # solder-mask expansion per side (default: the stack rule)
mask: none                   # no mask opening
mask: defined                # solder-mask-defined pad (the mask sets the land)
paste: -0.05                 # paste shrink per side
paste: none
paste: divide 2 x 2 coverage: 68%        # windowpane stencil (thermal pads)
paste: divide 3 x 3 gutter: 0.3          # or a fixed gutter between windows
vias: 3 x 3 drill: 0.3 pitch: 1.1        # thermal via array inside the pad
```

### 10.3 Defaults, selectors, overrides, deletion

```stomp
default pad rect 0.4 x 1.4        # the prototype for every pad without its own geometry
                                  # (generated pads included)
pad 5 width: 2.0                  # change one property: keep everything else, widen pad 5
pads 1..4, 9 mask: +0.1           # change several pads by selector
delete pad 11                     # remove a generated object (depopulated variants)
```

The properties that change a pad: `width:`, `length:`, `size: W x L`, `shape: SHAPE`,
`drill:`, and the §10.2 ones. A `pad NAME rect …` line, with a shape of its own, for a
pad that's already generated *replaces* its geometry outright.

## 11. Parametric part description

Part mode describes the component, and the tool derives the pads (IPC-7351 style,
`density: nominal` by default) and the 3D model. All generated objects are ordinary
named objects that you can override ([§2](#2-design-principles), point 5).

### 11.1 Body

```stomp
body 5 x 5 x 0.9                 # W x L x H box (molded, default draft and chamfer)
body cylinder d: 8 h: 11.5       # radial can
body 9.5 x 6.5                   # height optional (no height: a flat model)
```

### 11.2 Pins: count and arrangement

```stomp
pins 8 dual pitch: 1.27          # left and right sides, CCW from the top left (pin 1 top left)
pins 32 quad pitch: 0.5          # four sides, CCW from the top left
pins 2 horizontal                # two-terminal chip, pin 1 left
pins 2 vertical                  # pin 1 top
pins 3 single bottom pitch: 0.95 # all pins on one side
pins grid 5 x 2 pitch: 2.54      # NX columns x NY rows (x count first, like sizes)
balls 8 x 8 pitch: 0.8           # shorthand for grid + `lead ball` + `numbering: bga`
```

Clauses that can go on any `pins` or `balls` statement: `pitch: P [x PY]` (a pitch per
axis, for grids), `pad: SHAPE SIZE …` (a default pad for this statement),
`span: S [QUAL]`, `numbering: …` and `start: …`.

Explicit sides, for irregular parts: `pins` alone on its line, one line per side,
`SIDE: positions [pitch: P]`, then `end`. Positions are listed **counterclockwise**
(left: top to bottom, bottom: left to right, right: bottom to top, top: right to left),
and `nc` leaves a position empty:

```stomp
pins
  left: 1, 2, 3 pitch: 0.95
  right: 4, nc, 5                # SOT-23-5: pins 4 and 5 at the outer positions
end
```

Each side's run of positions, `nc` included, is centered on that side. The numbering is
whatever you listed; no scheme applies.

Numbering schemes for the regular forms: `numbering: ccw` (the default for dual, quad
and single), `cw`, `zigzag` (the default for `grid`: 1-2 across the short pitch, then
advance, as on 0.1" box headers), `row-major`, `col-major`, and `bga` (the default for
`balls`: rows lettered A, B, C, ... skipping I O Q S X Z as JEDEC does, and columns
numbered from 1; ball names like `A1` are pad names). `start: top-left` (the default),
`start: top-right` and so on turn any scheme to start from another corner.

Depopulation:

```stomp
omit A1, H8, rows D..E cols 4..5        # by name and/or rectangular region
only rows A..B, rows G..H               # the reverse: keep only the listed regions
```

### 11.3 Leads

```stomp
lead gullwing 0.41 x 1.04 span: 6.0  # width x foot length; span outer to outer
lead jlead 0.5 x 0.9 span: 8.6
lead lbend 1.2 x 0.8                 # inward L-bend (tantalums, SMA): the foot folds under the body; span optional
lead straight 0.85 x 0.55 span: 3.6  # flat leads straight out of the bottom of the body (SOD-123F, SMF)
lead flat 0.25 x 0.4                 # leadless lands (QFN/DFN/LGA); span optional (defaults to the body edge)
lead endcap 0.35                     # chip terminations; width defaults to the body width
lead ball 0.4                        # BGA ball diameter
lead column d: 0.51                  # CGA solder column diameter; on a grid, like ball
lead pin d: 0.64                     # THT round pin; also: lead pin 0.64 x 0.64 (square)
lead wire d: 0.6                     # axial or radial wire leads
lead tab 5.5 x 6.2                   # DPAK-style tab (becomes highest-numbered pin unless named)
lead castellated d: 0.6              # half-hole edge castellations
```

A pin whose lead differs from the rest gets its own `lead` statement that names it:

```stomp
lead gullwing 0.7 x 0.9 span: 7.0    # SOT-223: pins 1 to 3...
lead 4 gullwing 3.0 x 0.9            # ...and the wide tab lead, pin 4
lead 2 none                          # a pin cut off at the body: no 3D lead
```

The named pins take this lead instead of the general one. Where a pin's land is derived
from its lead, it's derived from this one, measured on the same span, so pin 4's land
comes out wider without a `pad 4 size: …` override. A per-pin lead with no size takes its
size from the pin's land. In land mode (explicit pads, no general `lead`), per-pin leads
put leads on those pads for the 3D model ([§13](#13-3d-model)) and leave the pads alone:
`lead 1, 3 gullwing 0.75 x 1.0` on a DPAK.

`span` qualifiers, wherever a symmetric distance across the package appears
(`lead … span:`, `span:` on its own line, `pins … span:`): **`outer`** (the default:
lead span as datasheets draw it), **`inner`** and **`centers`**. The statements `span: 5.4 centers`
and `gap: 4.0` (the same as `span: 4.0 inner`) set the spacing of the land-pattern rows
directly in land mode, or override the derived spacing in part mode. In part mode,
`span` measures the *leads*; in land mode (no `lead`), it measures the *pads*.

*Decision:* a pad's geometry comes from, in order: an explicit `pad NAME`, then
`default pad` or a `pins … pad:` clause, then IPC sizing from the `lead`. If none of
these applies, it's an error ("no pad geometry").

### 11.4 Thermal / exposed pad

```stomp
thermal pad 3.7 x 3.7                          # named EP by default, centered on the body
thermal pad 33 3.7 x 3.7 paste: divide 2 x 2 coverage: 68%   # or give it its pin number
pad 33 vias: 3 x 3 drill: 0.3 pitch: 1.1       # and change it like any other pad
```

### 11.5 Pin 1 marker and polarity

```stomp
pin1: dot         # silk dot outside the corner nearest pin 1 (default for dual and quad)
pin1: chamfer     # chamfered silk corner (the QFN convention)
pin1: notch       # DIP-style notch at the pin-1 end
pin1: bar         # bar across the pin-1 end (tantalum or diode style)
pin1: none
pin1: triangle    # a feature (§12.1), yours or the library's, drawn where the dot would go
polarized         # two-terminal polarity: pin 1 is positive (the anode); adds a silk bar
                  # and the 3D stripe at the end the part's family marks (§13.1)
density: most     # IPC density level: least | nominal | most
```

The silk marks these draw (the dot, the bar, a polarized part's bar, or a round part's
hatching and "+") are features of the standard library, `pin1_dot`, `pin1_bar`,
`polarity_bar`, `polarity_hatch` and `polarity_plus`, and which end a polarity mark
goes on is its `polarity` feature's to say ([§13.5](#135-the-standard-library)). They
get the same style and family flags as the 3D model's features, so one can draw an LED
differently from a can. A file can replace any of them. The chamfer and the notch
reshape the outline itself, so they stay built in. The library's symbols, `triangle`,
`arrow`, `plus`, `minus`, `cross`, `ring`, `frame` and `corners`, work as `pin1:` marks
and anywhere a feature goes.

## 12. Graphic layers

Everything here defaults to `auto` and rarely needs writing:

- **silk** `auto`: the body outline, kept clear of copper, plus the `pin1` marker;
- **courtyard** `auto`: the smallest rectangle around the lands and body, plus the IPC
  clearance for the density level, rounded out to 0.01 mm (`courtyard: auto 0.5`
  overrides the clearance);
- **assembly** `auto`: the body outline plus the refdes.

Graphics written in a footprint **add to** the automatic ones. A graphic goes on the
silk unless it says `layer: assembly`. `silk: none` turns the automatic silk off, and
`silk: auto` back on (the last one wins), so `silk: none` and lines of your own is fully
manual; `assembly:` works the same way.

A courtyard is always one rectangle: `courtyard: auto`, `courtyard: rect W x L`
(centered on the body), `courtyard: rect (x, y) W x L`, or `courtyard: polygon` with
four corners and sides along x and y. The last courtyard statement wins.

Manual additions and overrides:

```stomp
outline body offset: 0.15             # follow the body outline, pushed out
line (-2.5, 1.0) (-2.5, -1.0) width: 0.12
line (-3, 0) (3, 0) clear             # cut back from the copper, as the auto outline is
arc (0, 0) r: 1.5 from 30 to 150 width: 0.12
circle (0, 2.1) d: 0.3 fill
hatch (0, 0) d: 4 from 1 to 2 pitch: 0.25   # chords across x of the circle (0, 0) d 4,
                                            # at x = 1, 1.25, ... while x < 2
rect (0, 0) 3 x 2 layer: assembly     # on the assembly layer instead
text ">CATHODE" at (1.8, 0) size: 0.6
silk: none                            # no automatic silk
courtyard: rect 7.4 x 7.4
courtyard: rect (0, 0.5) 7.4 x 8.0
assembly: none
text ref at (0, 0) size: 1.0          # refdes and value fields; default layers: ref on silk, value on assembly
text value at (0, -1.2) size: 0.8 layer: assembly
```

Every graphic takes `width: W` and `layer: silk` or `layer: assembly`. A circle, rect
or polygon can `fill`, and a line, arc, outline, rect, polygon or hatch marked `clear`
is cut back from the copper. Text takes `size:` and `layer:`, which can also be
`copper` or `mask` in a footprint.

### 12.1 Custom features

A feature is a named set of graphics and solids, drawn around its own origin, that any
footprint in the file can use. Define it at the top level: its graphics (on the silk
unless they say `layer: assembly`) and its solids ([§13.3](#133-solids)) go straight in
it, and it takes parameters as a template does:

```stomp
feature plus(s = 0.7)
  line (-s / 2, 0) (s / 2, 0)
  line (0, -s / 2) (0, s / 2)
end

footprint "CP-A"
  body 3.2 x 1.6 x 1.6
  pins 2 horizontal
  lead lbend 1.2 x 0.8
  pin1: plus                            # the pin-1 mark, where the dot would go
  feature plus(0.5) at pad 2 rotate: 45 # or anywhere: at a point or an object
end
```

`pin1: NAME` draws the feature's graphics as the pin-1 mark, centered where the dot
would go and moved out by its own size to clear the copper. Like the other pin-1 marks,
it's part of the automatic silk. `feature NAME at (x, y)`, `at (x, y, z)` or `at pad 3`
places all of a feature anywhere: its graphics on the footprint's layers, and its
solids in the 3D model, z up from the board ([§13.3](#133-solids)). `rotate: A` turns
it, and `on body`, with or without an `at`, rests its solids on the body top. Text in it
stays upright. Arguments work as in a template call
([§14.1](#141-templates-are-functions)): a plain number takes the unit of the feature's
statements, so pass `40mil` from a footprint in other units. `outline body` can't go in
a feature, since a feature has no body.

A feature places another the same way, at a point of its own: `feature NAME at (x, y)`,
or `at (x, y, z) rotate: (rx, ry, rz)` to place its solids in 3D. A line with `at` (or
`on body`) places a feature; at the left margin and without one, it starts a feature's
definition. A feature can place itself only so deep: 32 levels is an error.

A feature can also give names values (`half = len / 2`), which see its parameters, and
hold **sections**: blocks included only when the call passes a **flag** with the
section's name. Sections are how a feature makes choices; stomp has no `if`.

```stomp
feature tick(len = 1, w2 = 0.12)
  half = len / 2
  section long
    len = 2                           # with the flag, a new default for len
    section bold; len = 3; end        # both flags: nested sections need all of theirs
  end
  section bold, heavy; w2 = 0.3; end  # either flag turns it on
  line (-half, 0) (half, 0) width: w2
  section boxed
    rect (0, 0) len x 0.5             # drawn only with the flag
  end
end

footprint "T"
  …
  feature tick(long, bold) at (0, 2)  # len 3, w2 0.3
  feature tick(0.5, boxed) at (0, 3)  # len 0.5: the value given wins
end
```

- **Flags** are words in the call, before or after the values but never between them,
  in any order: `tick(long, 0.5)` or `tick(0.5, long)`. A flag is any word that names a
  section of the feature, or of a feature it places (`dot` and `gullwing` work too). A
  lone word that names no section is a value; to pass a value whose name is also a
  flag, put it in parentheses: `tick((long))`.
- **Flags flow down.** A feature placed by another sees the flags of everything that
  placed it, so a flag given once reaches every feature that needs it.
- **`NAME = value` in a section** gives a parameter of the feature, or a name it
  defines, that value while the section is on. A value the call gives wins; otherwise the innermost
  section that's on; otherwise the default. Two sections that are both on and set the
  same name must be nested, one in the other; side by side, they're an error.
- A section holds `NAME = value` lines, other sections, graphics, solids and placed
  features. In a section, `NAME = value` gives a name that exists a new value; a
  feature defines its names at its top level. Footprints and templates have no
  sections.

The standard library's features place the same way: its shapes (`rounded_box`,
`dome`, `hex_prism`, …) and symbols (`arrow`, `corners`, …) are there to build with
([§13.5](#135-the-standard-library)). A feature named like one of the library's replaces
it for the whole file, including where the library uses it itself.

## 13. 3D model

A footprint with a `body` has a 3D model without another line: the body, the pins and
the lead form already describe the part. A `model` block adjusts what that
description can't say and adds anything else; `no model` turns it off. Every part of
the model is drawn by a stomp feature from the standard library
([§13.5](#135-the-standard-library)), which a file can replace.

### 13.1 The generated model

The model uses the footprint's x and y ([§6](#6-coordinate-system-and-units)), with z
up from the board surface: z = 0 is the top of the board. The body's H is the seated
height, JEDEC *A*: the top of the part above the board. The body's bottom sits at the
standoff, JEDEC *A1*. A body without an H is drawn as a flat plate.

The lead form picks the rest. This table is what the standard library draws:

| lead | body | leads | standoff | pin-1 mark |
|---|---|---|---|---|
| `gullwing` | molded, 8° draft, parting line at mid-body | leave the parting line, bend down to a foot on the board; toes at the span | 0.1 | dimple |
| `jlead` | molded, 8° draft | leave the parting line, run down the body side and curl under it | 0.5 | dimple |
| `lbend` | molded, 8° draft | leave the end face low, run down it and fold flat under the body | 0.15 | dimple |
| `straight` | molded, 8° draft | flat strips straight out of the bottom of the body, on the board | 0.05 | dimple |
| `flat` | sawn block; a can on flat leads stands on a plastic base | terminals flush with the body's bottom and edge (or at the span); exposed pads under the body | 0.02 | dot |
| `endcap` | chip; a cylinder body is a MELF, lying along the pins | metal caps over each end, T long | 0 | — |
| `ball` | laminate substrate and mold cap | balls d wide, collapsed to the standoff | 0.75 d | dot |
| `column` | ceramic block | solder columns d wide from the board up into the body | 2.2 | dot |
| `pin`, `dual` | molded DIP | shoulders down to the board, then the lead through it | 0.5 | dimple |
| `pin`, other | housing one pitch tall when H is over two pitches, else H: a socket, with an opening over each pin | straight pins from below the board to H | 0 | — |
| `wire` | cylinder: a can, an LED for a diode, or an axial body when the pins lie outside it | wires down through the board; axial wires leave the body's ends | 0.5 / 0 | — |
| `castellated` | module board, plus a shield can when H > 1.2 | plated half-holes in the board edge | 0 | dot |
| `tab` | — | a metal slab under its pad | — | — |
| no `lead` | plain block | — | 0 | as `pin1` |

- **Leads** are tin. Gull-wings are 0.15 thick below a 1 mm pitch, 0.2 up to 2 mm and
  0.3 above. J-leads are 0.2, or 0.25 at a 1.27 mm pitch or more. Flat terminals are
  0.2, and L-bends and straight leads 0.12. Grid pins are gold. Through-hole leads reach 3 mm below the board. A gull-wing's
  foot is the lead's foot length, shortened if the bend needs the room.
- **Pin 1.** The mark goes on the body top at the corner nearest pin 1. `pin1: notch`
  gives a notch at the pin-1 end, `pin1: bar` a stripe, and `pin1: none` no mark.
- **Polarity.** A `polarized` part gets a stripe at its marked end: the cathode (pin 2)
  of a diode or LED and the negative lead of a can, but the positive end (pin 1) of a
  chip or molded capacitor, which is how tantalums are marked. The silk bar goes on the
  same end. A can in a metal `body color:` is bare, as polymer caps are: it has no vent,
  and its mark is a dark segment on the lid instead of a stripe on a sleeve.
- **Colors** follow the part family, from the `refdes` ([§13.5](#135-the-standard-library)).
  Chip resistors are white ceramic with a black top, chip capacitors are tan, inductors
  ferrite gray, and chip LEDs white with a clear lens. Molded bodies are black. The
  colors are the standard library's palette.
- **Families** add their own details. A crystal or oscillator (`Y`, `X`) on a sawn or
  block body is a ceramic package under a metal lid, all within H. A diode on wires
  with a round body is an LED: a lens with a domed top, on a flange whose flat marks
  the cathode, red unless `body color:` says otherwise. A J-lead diode is a PLCC LED: a
  white housing with the leads folded flat under it and a round lens on top. An axial
  resistor has color bands.

Omitted pins have no lead. Per-pin `lead` statements ([§11.3](#113-leads)) change one
pin's lead, remove it (`lead 2 none`), or, in land mode, put leads on explicit pads.

### 13.2 The `model` block

`model` alone on its line, its settings and solids, then `end`. Every setting is
optional:

```stomp
model
  standoff: 0.05             # the body's bottom above the board (JEDEC A1)
  height: 0.85               # the model's height, where it isn't the body's H
  draft: 0                   # molded-body side draft (0: a straight-sided block)
  body color: "#20232a"      # any color (§7): "#rrggbb", a name, mix(…), metal(…)
  leads color: gold
  leads thickness: 0.2       # lead-frame thickness (JEDEC c)
  leads below: 3.5           # through-hole leads: length below the board
  leads above: 0             # grid pins: height above the housing (0: a socket)
  pin1: dot                  # the body mark: dimple | dot | notch | stripe | none
  body shape: drum(shielded) # draw the body with this feature (§13.5)
  leads shape: thin_lead     # draw every lead with this one
end
```

Named colors: `black`, `gray`, `white`, `red`, `green`, `blue`, `yellow`, `orange`,
`brown`, `tan`, `ceramic`, and the metals `tin`, `silver`, `gold`, `copper` and
`aluminum`. Metals render shiny. The standard library's palette adds names of its own.

`body shape: NAME(…)` and `leads shape: NAME(…)` draw this footprint's body or leads with
another feature than the library would pick: one of your own, or one of the library's
packages, `to92`, `to220`, `hc49`, `tact_switch` and `buzzer`
([`examples/tht_parts.stomp`](examples/tht_parts.stomp)). The feature gets the values and
flags the library's would ([§13.5](#135-the-standard-library)); the arguments written
in the statement come first.

### 13.3 Solids

Anything the lead form doesn't describe can be built from solids, in a footprint's
`model` block or straight in a feature:

| solid | draws |
|---|---|
| `box W x L x H` | a box |
| `cylinder d: D h: H` | an upright cylinder; `cylinder d: D to D2 h: H` is a cone |
| `sphere d: D` | a sphere; `sphere d: D h: H` is squashed to H |
| `disc d: D` | a flat disc; `disc d: D to D2` is a ring from D to D2 |
| `prism PATH h: H` | a flat outline, H thick |
| `face PATH` | a flat outline with no thickness, facing up |
| `loft W x L at Z, W x L at Z, …` | a solid through rectangles stacked at heights Z |
| `sweep W x T along PATH` | a W x T strip along a path in x and z, as a lead is |
| `wire d: D along PATH` | a round wire along a path in x and z |
| `slab W x L x T castellated` | a board, with a half-hole cut wherever the part has a castellated lead |

A PATH is points and arcs, joined by commas:
`(0, 0), (1, 0), arc (1, 1) r: 1 from -90 to 0 segments: 8, (2, 2)`. A prism's or
face's path is an outline in x and y; a sweep's or wire's runs in x and z. `fillet: R`
before `along` rounds the corners between points with radius R, in steps of 10°
(`fillet: R step: 8` for 8°); an arc's own points stay as they are.

Each solid takes these, in any order:

- `at (x, y)` or `at (x, y, z)`: where it goes (below);
- `rotate: (rx, ry, rz)` in degrees, about x, then y, then z; `rotate: A` turns it about z;
- `color: C`: any color (§7);
- `name: "…"`: the name of its mesh in the model and the exports; a parameter or
  other name that holds text works too, and empty text means no name;
- `kind: body`, `kind: lead` or `kind: mark`, in a feature: what it's highlighted with,
  and where it goes in the model's order (§13.5);
- `segments: N`: how many sides a round solid has;
- `open`, `open top` or `open bottom`: a cylinder without its ends, or one of them;
- `from A to B`: part of a cylinder or disc, between two angles;
- `down`: a disc or face that faces down.

**In a feature,** `at` puts the solid's own origin at a point of the feature, then
`rotate` turns it about that point. A box's, cylinder's or sphere's origin is the
middle of its bottom; a path's is (0, 0). A size of zero or less draws nothing, so a
feature can leave out a part with arithmetic. A footprint places a feature's solids
by placing the feature, `feature NAME(…) at (x, y, z) rotate: (…)` (§12.1), its origin at
that point: z from the board, or from the body's top with `on body`.

**In a footprint's model block,** a solid starts centered on the body (or on the
origin, if there's no body), resting on the board. `at (x, y)` moves its center; a
third coordinate sets the height of its bottom, and `on body` rests it on the body top
instead. `rotate` turns the solid about its center before it's placed. A solid takes
the body's color unless it names one.

```stomp
model
  box 2.9 x 2.2 x 0.1 on body color: tin              # a lid, centered on the body top
  box 6.6 x 6.6 x 0.5 color: black                    # a base plate on the board
  cylinder d: 0.8 h: 0.2 at (1.0, 0.6) on body        # at (x, y): the solid's center
  cylinder d: 2 h: 6 at (0, 0, 1) rotate: (0, 90, 0)  # at (x, y, z): z is its bottom
end
feature heatsink(5, 5, 3) on body                     # a feature's solids, on the body top
```

(`heatsink` is in [`examples/custom_models.stomp`](examples/custom_models.stomp).)

### 13.4 External models, inheritance

```stomp
model
  step: "models/QFN32.step" offset: (0, 0, 0) rotate: (0, 0, 90) scale: 1.0
end
no model                           # no 3D output at all
```

`step:` replaces the generated model, and the transform maps the file into the model's
frame. Model blocks merge down an `extends` chain: a later level's settings replace
earlier ones, and its solids add to theirs. `no model` at any level ends the model
there, and a later `model` block starts it again.

### 13.5 The standard library

The model in §13.1 and the automatic silk marks of §11.5 are drawn by the **standard
library**: stomp files of features and named values in [`stdlib/`](stdlib/), loaded
before every file. It's written in `units: mm`, so the values the 3D model passes are mm, and
its angles are degrees.

| file | holds |
|---|---|
| [`colors.stomp`](stdlib/colors.stomp) | the palette: `epoxy`, `can_blue`, `ferrite`, `solder`, `led_red`, … |
| [`shapes.stomp`](stdlib/shapes.stomp) | solids to build with: `rounded_box`, `chamfered_box`, `beveled_box`, `dome`, `torus`, `hex_prism`, `post` |
| [`symbols.stomp`](stdlib/symbols.stomp) | silk symbols: `triangle`, `arrow`, `plus`, `minus`, `cross`, `ring`, `frame`, `corners` |
| [`marks.stomp`](stdlib/marks.stomp) | `top_marks` and the marks it draws; `polarity` |
| [`molded.stomp`](stdlib/molded.stomp) | molded, DIP, block and radial bodies; gull-wing, J-lead, L-bend, straight and tab leads |
| [`leadless.stomp`](stdlib/leadless.stomp) | sawn bodies; flat, end-cap and grid-contact leads; exposed pads |
| [`chips.stomp`](stdlib/chips.stomp) | chip, MELF and axial bodies |
| [`arrays.stomp`](stdlib/arrays.stomp) | BGA and CGA bodies; balls and columns |
| [`cans.stomp`](stdlib/cans.stomp) | cans, and their vent, stripe, lid mark and SMD base |
| [`leds.stomp`](stdlib/leds.stomp) | radial LEDs, and a PLCC LED's lens |
| [`through_hole.stomp`](stdlib/through_hole.stomp) | header housings; header, DIP, axial and plain through-hole leads |
| [`packages.stomp`](stdlib/packages.stomp) | bodies to name with `body shape:`: `to92`, `to220`, `hc49`, `tact_switch`, `buzzer` |
| [`modules.stomp`](stdlib/modules.stomp) | module boards and castellations |
| [`silk.stomp`](stdlib/silk.stomp) | the silk's pin-1 and polarity marks |

**Replacing a feature.** A feature in your file named like one of the library's
replaces it everywhere in your file, including where the library's own features place
it. So `feature can_vent(D)` (its solids, then `end`) changes the vent of every can,
and `feature pin1_dot(d = 0.3)` every `pin1: dot`. The full list, with what each
feature takes, is [`stdlib/README.md`](stdlib/README.md). A replacement must take what the
library passes it; a parameter the library never gives a value gets a warning unless it
has a default. Library features see the library's names; your file sees them too,
after its own, so `color: can_blue` works anywhere.

**What the model calls.** The 3D model measures the part, then calls one feature for
the body and one per lead, by name:

| feature | for | values passed (by name, each only if the feature declares it) |
|---|---|---|
| `body_STYLE` | the body: `body_molded`, `body_dip`, `body_block`, `body_radial`, `body_sawn`, `body_chip`, `body_melf`, `body_axial`, `body_bga`, `body_cga`, `body_can`, `body_led`, `body_header`, `body_module` | `W`, `L`, `H` (the body), `z0` (the standoff), `draft` (`draft:`), `body_color`, `lead_color`, `e` (the pitch), `above` (`leads above:`), `ball_d`, `cast_d` (the widest castellation), `turn` (0, or 90 for a part along y), `T` (an end cap's length), and for the marks `sx`, `sy` (toward pin 1's corner), `nx`, `ny` (toward the notched end), `ex`, `ey` (toward the striped end) and `ma` (the striped lead's direction, in degrees) |
| `lead_FORM` | each lead: `lead_gullwing`, `lead_jlead`, `lead_lbend`, `lead_straight`, `lead_flat`, `lead_endcap`, `lead_tab`, `lead_contact` (no side), `lead_ball`, `lead_column`, `lead_castellated`, and for pins and wires `lead_dip`, `lead_axial`, `lead_header` or `lead_tht` | `edge` (the body's edge), `pad_u` (the pad's center), `toe` (the lead's tip, if the span gives it), `across` (the length of the body's side), `b`, `T`, `d` (the lead statement's sizes), `drill`, `pad_across`, `pad_along`, `z0`, `H`, `e`, `c` (`leads thickness:`), `below` (`leads below:`), `lead_color`, and what the body exports: `zp`, `housing`, `zc`, `len`, `ts` |
| `exposed_pad` | each thermal pad | `w`, `l` (the pad), `z0`, `H`, `c`, `lead_color` |
| `polarity` | which pin a stripe or bar marks: its `stripe_at` | (flags only) |

The silk's marks are called the same way: `pin1_dot`, `pin1_bar(len, depth)`,
`polarity_bar(len)`, `polarity_hatch(r)` and `polarity_plus`, with the style and family
flags.

A body is drawn with the body's center at the origin. A lead with a side is drawn in
its side's frame: x outward from the body's center, y along the side, z up, so `edge`,
`pad_u` and `toe` are x positions; the left and top sides are mirror images of the
right and bottom. A ball, column, grid contact, header pin or plain pin is drawn around
its pad's center. An end cap of a chip or MELF is drawn by the body, not by a lead.

**Flags passed.** The style (`molded`, `chip`, `led`, …), the main lead form
(`gullwing`, …), the family (below), the mark asked for (`dimple`, `dot`, `notch` or
`stripe`), `bare` or `sleeved` (whether the body color is a metal), and `silk_mark`
when the silk marks pin 1 with a dot or a chamfer. A lead gets its form, the style and
the family, and a pin or wire `round` or `square`. A feature gets only the flags it has
sections for; a mark it can't draw is reported as none.

The **family** comes from the refdes's first letters, the longest match first:

| refdes | family | | refdes | family |
|---|---|---|---|---|
| `R` | `resistor` | | `Y`, `XTAL` | `crystal` |
| `C` | `capacitor` | | `X`, `XO`, `OSC` | `oscillator` |
| `L`, `FB` | `inductor` | | `S`, `SW` | `switch` |
| `D`, `LED` | `diode` | | `BZ`, `LS` | `buzzer` |
| `Q` | `transistor` | | `J`, `P`, `CON`, `CN` | `connector` |
| `U`, `IC` | `ic` | | `F` | `fuse` |

**Flags worked out.** Some flags depend on the part's measurements in ways the library
decides. A feature that defines `NAME_if = …` gets flag NAME when that value is
above zero, and its partner, if it has one, otherwise; one it can't work out (a value
nobody gave) gets neither. They're worked out in this order, each seeing the ones
before it:

- for bodies: `drafted` / `plain`, `tall`, `shield` / `unshielded`, `vented`;
- for leads: `fine`, `wide`, `coarse` (pitch classes), `straddle`, `flush`,
  `bent` / `cramped`, `under` / `beyond`, `socket`.

For example, a gull-wing lead with no room to bend lies flat:

```stomp
foot = min(T, room - max(1.2 * c, 0.25 * room))
bent_if = min(room - 2.5 * c, foot - c)
section bent
  sweep b x c fillet: 1.5 * c along …
end
section cramped
  sweep b x c along …
end
```

**Values read back.** Before drawing, the model reads the body feature's `z0` (the
standoff, then lowered if it reaches the top), `body_color`, and `pin1_mark` (the mark a
style gets by default, as text). After it, it reads what the body exports to the leads:
`zp` (where leads leave a molded body), `housing` (a header's), `zc` (an axial body's
center), `len` (its length), `ts` (a module board's thickness), and `top` (where
`on body` rests, if not H).

**Meshes.** Solids of one name, kind and color in one feature call form one mesh. A
body's solids are named `body` unless they say otherwise; a lead's are `lead N` (or
`NAME N` with `name: "NAME"`), and an exposed pad's `exposed pad N`. A body's solids of
`kind: mark` come after the leads and exposed pads, then the extra solids. A body's
solids highlight with the `body` statement, a lead's with its `lead` statement, and
marks with `pin1`, `polarized` and the model block. A lead's marks (a socket's
openings) highlight with its `lead` statement.

## 14. Templates, tables and inheritance

### 14.1 Templates are functions

A template takes parameters and makes a footprint:

```stomp
template soic(n, lspan = 6.0, e = 1.27, bw = 3.9)   # a default takes `=`
  body bw x (n/2 - 1) * e + 2.0 x 1.5
  pins n dual pitch: e
  lead gullwing 0.41 x 1.04 span: lspan
  pin1: dot
end

footprint "SOIC-8"  from soic(8)
footprint "SOIC-16" from soic(16)
footprint "SOIC-16W" from soic(16, lspan: 10.3, bw: 7.5)   # a named argument takes `:`
```

A template's parameters are names, given their values in each footprint it makes; any
word but `x` and `end` can be one. A default can refer to other parameters (`E = D`).
Arguments are positional, named, or both (`qfn(32, 5, D2: 3.45)`), and a parameter
without a default must be given. A call that ends its line with `with` takes statements
of its own, then `end`, to add to the footprint or change it:

```stomp
footprint "SOIC-8-WIDE-CY" from soic(8) with
  courtyard: auto 0.5
end
```

There's no control flow (conditionals or loops) in v1: a template is a footprint body with
parameters, and a table ([§14.3](#143-tables-footprints-from)) is how one template
makes many footprints. The one way to choose is a feature's sections, turned on by
flags ([§12.1](#121-custom-features)); a template takes values only, never flags.

### 14.2 Naming: `name`

A template can name the footprints it makes, usually by interpolating its parameters
([§7](#7-values-expressions-names)):

```stomp
template qfn(n, D, D2, e = 0.5, E = D, E2 = D2)
  name: "QFN-{n}-1EP_{D}x{E}mm_P{e}mm_EP{D2}x{E2}mm"
  description: "QFN, {n} pins, {D} x {E} mm body, {e:.2} mm pitch"
  …
  thermal pad "{n + 1}" D2 x E2            # names interpolate too
end

footprint from qfn(32, 5, 3.45)            # named QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm
footprint "MY-QFN" from qfn(20, 4, 2.6)    # a name in the header wins
```

`name:` belongs in templates, and in a call's `with` block to rename that one
footprint. An ordinary footprint is named in its header. A call with neither is an
error. Every footprint in a file needs its own name, generated ones included.

### 14.3 Tables: `footprints from`

A table calls a template once per row. The header row names the parameter each column
fills, and each row after it is one footprint:

```stomp
footprints from qfn(e: 0.5)      # arguments in the call apply to every row
  n    D    D2                   # header: parameter names
  12   3    1.65                 # a row: one footprint
  16   3    1.7
  32   5    3.45
end
```

- Cells are separated by spaces or tabs, one row per line (or `;`), and `#` comments
  can go anywhere. A cell is a number (with an optional unit suffix, and a minus sign
  attached: `-0.1`, `20mil`), a name, a `"string"`, or an expression in
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
footprint "SOIC-8-HS" extends "SOIC-8"   # inherit: reopen and override
  description: "hand-solder variant"
  default pad rect 0.6 x 2.2             # longer pads
  courtyard: auto 0.5
end
```

`extends` replays the parent, then applies the child's statements under the usual
override rules: strong beats weak, and a later strong constraint on the same axis of the
*same* object **replaces** the inherited one instead of over-constraining it.
Inheritance is the one place where replacement is allowed. The parent can be any
footprint, including one a table generated.

## 15. Diagnostics

The syntax is designed so a checker can be blunt and specific. Required diagnostics:

- a missing `end`, at its block's header, before the item that shows it's missing (a
  `footprint` line, a feature declaration at the left margin, the end of the file, a
  footprint statement after a `model` line); when an inner block was closed by an `end`
  that lines up with an outer header, at the inner block. An `end` with nothing to
  close, and braces;
- a named value without its colon (`pitch 1.27`: write `pitch: 1.27`), a colon on a word
  that takes none (`at:`), and a named value a statement doesn't take (with the nearest
  one suggested); `let`; a name given two values at one level;
- over- and under-constraint, per object axis, citing the statements (§9.7);
- an unknown object name, with the nearest name suggested;
- an anchor that doesn't match the axis (`pad 1 left is … above …`);
- unit errors in expressions (length·length, a bare ratio where a length is needed);
- `nc` and count mismatches in `pins` side lists; duplicate names; `omit` of balls that don't exist;
- a pad with no geometry after the precedence rules (§11.3);
- suspicious-geometry *warnings* (a zero-size pad, a drill as large as its pad or larger, overlapping pads whose nets aren't known), never errors, since each can be intended;
- duplicate footprint names, generated ones included; a table row with the wrong number of cells; a column that names no parameter (with the nearest name suggested); a template that doesn't `name` the footprints a table or an unnamed call needs from it;
- an error inside a template body, reported on the call or table row whose arguments cause it, and once at the template when every call has it;
- a courtyard that isn't one rectangle, and a courtyard set twice in one footprint (a warning); an unknown feature (with the nearest name suggested), a feature defined twice, and missing or unknown feature arguments;
- a side mark outside a 2D size, in the middle of a side, or on both sides with the same letter; `units:` after other statements in a footprint or template;
- 3D: a per-pin `lead` naming a pin that doesn't exist or was omitted; `leads below:` or `leads above:` on leads that can't use them; a solid or color that can't be built; a model setting given twice in one block; a feature placed in a model block, which belongs in the footprint;
- features: an unknown flag (with the nearest flag suggested), a flag between values or given twice, two sections that are both on and set one name side by side, a section setting a name the feature doesn't have, a feature placing itself too deep; an unknown function (with the nearest suggested), a wrong number of arguments, a value of the wrong kind (`sqrt` of a length, `asin(2)`, a color in arithmetic); an unknown color (with the nearest suggested);
- a feature that replaces the standard library's but has a parameter the library never gives a value (a warning);
- a problem inside the standard library's code is reported at the statement that used it (the `body`, the `lead`, the `pin1:`, a `body shape:`), naming the library features it went through. The 3D model's problems are found when it's built, so the demo lists them for the footprint on screen.

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
3. **IPC synthesis controls.** Is `density: least|nominal|most` enough, or do toe,
   heel and side goals need syntax to override them per footprint
   (`ipc toe: 0.35 heel: 0.35 side: 0.03`)? Leaning: add the long form later; it's
   purely additive.
4. **Arc and curved pads** (RF, rotary encoders): `polygon` handles them badly. There
   could be `ring` or `arcpad` shapes later.
5. **Multi-footprint packages** (for example DNP variants that share a body):
   `extends` plus `delete` covers them. Is that enough?
6. **Should the letter and number order of `balls` be overridable** for non-JEDEC grids
   (some FPGAs)? Probably `numbering: bga letters: "ABCDEFGHJK…"` later.
7. **Castellated semantics.** The `lead castellated` syntax is reserved, and the 3D
   model draws each half-hole's plating, but the land's plating and paste rules for
   half-holes need their own mini-spec.
8. **Embedded checks.** A `check` statement (`check gap pad 1 to pad 2 is 0.4`) that
   asserts a redundant datasheet dimension without constraining anything. Cheap to add,
   and great for confidence in a transcription. Leaning: yes, in v1.1.
9. **External tables.** `footprints from qfn table: "qfn.tsv"`, reading rows from a file
   next to the source, for vendor data that already lives in a spreadsheet. Purely
   additive.
10. **Interpolation formats.** `{x:.N}` covers fixed decimals, and IPC-7351 names
    (`QFN50P500X500X90-33N`) can be built with arithmetic (`{e * 100}`). Zero padding or
    unit conversion in the format may be wanted later.
11. **Body detail.** Molded bodies have one draft angle and square edges; real ones also
    have a pin-1 bevel, rounded corners and ejector-pin marks. These can now be written
    as library features (§13.5); past some point `step` may still be the right answer.
12. **Polarity conventions.** Settled: the silk bar follows the same `polarity` feature
    as the 3D stripe (§13.5), so a tantalum's band and bar both mark pin 1, and an axial
    or MELF capacitor's both mark pin 2.
13. **Repetition.** Sections choose; nothing repeats. Five heatsink fins are five
    solids, and a feature can't draw n of something. A `repeat N` for solids, or arrays
    of placements, would be the smallest addition; loops in general stay out.
14. **Library versions.** The standard library is part of the language: a file that
    replaces `can_vent` relies on the library still calling it with `D`. The hook tables
    in §13.5 should be versioned with the spec, and the library could say which version
    it implements.
15. **Outlines from the library.** The chamfered and notched silk outlines are still
    built in, since they change the outline the rest of the silk is cut against. A hook
    that returns an outline would move them into the library too.
16. **Indentation.** Blocks close with `end`, and indentation only helps the checker
    point at the block that's missing one. Making indentation significant would drop
    `end`, at the cost of whitespace that matters. Leaning: keep `end`.

## 18. Example index

| file | shows |
|---|---|
| [`examples/r0402.stomp`](examples/r0402.stomp) | the smallest land mode, and part mode for the same part |
| [`examples/led0603.stomp`](examples/led0603.stomp) | `polarized`, custom silk |
| [`examples/soic8.stomp`](examples/soic8.stomp) | the standard dual gull-wing, in 4 lines |
| [`examples/tssop20.stomp`](examples/tssop20.stomp) | named values for the datasheet letters; an `extends` hand-solder variant |
| [`examples/qfn32.stomp`](examples/qfn32.stomp) | quad leadless, thermal pad, paste windows, vias, `pin1: chamfer` |
| [`examples/bga64.stomp`](examples/bga64.stomp) | ball grid, JEDEC lettering, `omit` |
| [`examples/sot23-5.stomp`](examples/sot23-5.stomp) | a `pins` side list, `nc` |
| [`examples/to252.stomp`](examples/to252.stomp) | relational dimensioning (DPAK); per-pin leads on explicit pads for the 3D model |
| [`examples/dip8.stomp`](examples/dip8.stomp) | THT dual, oval pads, square pin 1, `pin1: notch` |
| [`examples/hdr2x5.stomp`](examples/hdr2x5.stomp) | THT grid, zigzag numbering, selector overrides |
| [`examples/usb_microb.stomp`](examples/usb_microb.stomp) | the hardest one: mixed SMD, NPTH and slots, `mirrors`, chained relations, a polygon pad |
| [`examples/cp_radial.stomp`](examples/cp_radial.stomp) | cylinder body, THT, polarized, a 3D color override |
| [`examples/soic_family.stomp`](examples/soic_family.stomp) | `template`, `from`, `extends` |
| [`examples/qfn_library.stomp`](examples/qfn_library.stomp) | templates as functions: interpolated `name`, `description` and pad names, `footprints from` tables, an unnamed call, `extends` of a generated footprint |
| [`examples/sot223.stomp`](examples/sot223.stomp) | per-pin lead: the wide tab lead widens its own land and 3D lead |
| [`examples/do41.stomp`](examples/do41.stomp) | axial through-hole: a cylinder body lying down, bent wires, a cathode band |
| [`examples/crystal3225.stomp`](examples/crystal3225.stomp) | a family's details: for a `Y` refdes, a ceramic package with a metal lid |
| [`examples/tht_parts.stomp`](examples/tht_parts.stomp) | through-hole parts: the library's packages by name (TO-92, TO-220, HC-49, tact switch, buzzer), radial LEDs, a resistor's bands, and an encoder of your own from the library's shapes, with symbols in its silk |
| [`examples/custom_models.stomp`](examples/custom_models.stomp) | features of your own: replacing the library's `can_vent` and `pin1_dot`, a `body shape:` with sections and flags, a feature's solids placed on a body |
| [`examples/syntax_zoo.stomp`](examples/syntax_zoo.stomp) | not a real part: covers everything else, and can double as a parser test |

Libraries, each a template or two and a table per family:

| file | shows |
|---|---|
| [`examples/chip_library.stomp`](examples/chip_library.stomp) | chip resistors, capacitors and inductors, 0201 to 2512; one template, three tables, quoted size codes |
| [`examples/sot_library.stomp`](examples/sot_library.stomp) | SOT-23, SC-70, SOT-523 and SOT-563, one template per pin layout |
| [`examples/sop_library.stomp`](examples/sop_library.stomp) | SOIC, MSOP, TSSOP, SSOP and QSOP from one template, family values in each call |
| [`examples/qfp_library.stomp`](examples/qfp_library.stomp) | LQFP and TQFP, 32 to 208 pins; a default computed from another parameter |
| [`examples/dfn_library.stomp`](examples/dfn_library.stomp) | two-row leadless packages with exposed pads |
| [`examples/bga_library.stomp`](examples/bga_library.stomp) | ball grids from 9 to 484 balls and two column grids; `{x:.1}` names; rows past Z |
| [`examples/diode_library.stomp`](examples/diode_library.stomp) | SOD, flat-lead SOD and SMF, SMA/SMB/SMC and MELF; four lead forms |
| [`examples/tantalum_library.stomp`](examples/tantalum_library.stomp) | tantalum cases A to E: `lbend` leads, and a custom `+` feature as the pin-1 mark |
| [`examples/polymer_cap_library.stomp`](examples/polymer_cap_library.stomp) | aluminum polymer caps, SMD and radial, in bare cans |
| [`examples/inductor_library.stomp`](examples/inductor_library.stomp) | shielded power inductors with bottom terminals, in ferrite |
| [`examples/crystal_library.stomp`](examples/crystal_library.stomp) | four-pad crystals and oscillators with a ceramic base and metal lid |
| [`examples/led_library.stomp`](examples/led_library.stomp) | chip LEDs, and PLCC LEDs, which the library draws with a lens |
| [`examples/dip_library.stomp`](examples/dip_library.stomp) | DIPs from 6 to 48 pins, written in mils with `units: mil` in the template |
| [`examples/header_library.stomp`](examples/header_library.stomp) | 2.54, 2.0 and 1.27 mm pin headers in one and two rows |

The standard library ([§13.5](#135-the-standard-library)) is in [`stdlib/`](stdlib/):
every body, lead and mark in these examples comes from it.
