# Language reference

stomp describes a PCB footprint in a text file: the land pattern (copper, drills, mask,
paste, silkscreen, courtyard, assembly drawing) and, if you want it, a 3D model. You give
the pads directly (*land mode*), describe the part and let stomp derive them (*part
mode*), or mix the two. This page lists every statement by task, with links to the
[specification](../SPEC.md) for the fine print; the [tutorial](tutorial.md) teaches the
language step by step, and [using stomp](using.md) covers the editor.

In syntax lines, CAPITALS are values you supply, `[ ]` marks an optional part, `…` means
more of the same, and `|` separates choices. Examples with a `footprint` line are
complete files.

## Contents

1. [File structure](#file-structure)
2. [Numbers, units and sizes](#numbers-units-and-sizes)
3. [Footprints and metadata](#footprints-and-metadata)
4. [Pads and holes](#pads-and-holes)
5. [Placement](#placement)
6. [Part mode](#part-mode)
7. [Pin 1 and polarity](#pin-1-and-polarity)
8. [Silk, assembly and courtyard](#silk-assembly-and-courtyard)
9. [Templates, tables and inheritance](#templates-tables-and-inheritance)
10. [Features](#features)
11. [The 3D model](#the-3d-model)
12. [Diagnostics](#diagnostics)

## File structure

A file holds footprints, `footprints` tables, templates, features, named values and
`units:` lines, in any order: a footprint can use a name, template or feature defined
further down. `#` starts a comment that runs to the end of the line. A statement takes a
line, and `;` separates statements that share one; a newline inside parentheses, or after
a `,` or an operator, doesn't end one. A block is a header line, its statements and
`end`. Blocks nest, and stomp goes by `end`, not indentation, so
`section fine; c = 0.15; end` is a whole block. [SPEC §4](../SPEC.md#4-lexical-structure)

```stomp
L = 1.6                                 # a name for the datasheet's L

footprint "R_0603_1608Metric"           # a block: its header line,
  description: "Resistor, {L} mm long"  # its statements,
  refdes: "R"
  body L x 0.8 x 0.45; pins 2 horizontal  # (two on one line)
  lead endcap 0.3
end                                     # then `end`
```

### Named values, keywords and names

A word with a colon names the value after it: `pitch: 1.27` (the space is optional).
Words that relate things (`at`, `is`, `of`, `to`, `with`, `and`, …) and flags (`fill`,
`tht`, `inner`, …) take none. Keywords count only where the grammar expects them, so
`draft` or `pitch` can name a value; only `x` and `end` are reserved everywhere.

`NAME = value` names a value for the file or one footprint, so a datasheet's letter
dimensions go in once. A name gets one value per level, and a footprint's hide the file's.
Pads, holes, rows and groups are named by a whole number, an identifier or a string
(`pad 14`, `hole M1`, `pad "D+"`); one named after a keyword is quoted: `pad "at"`.
[SPEC §7](../SPEC.md#7-values-expressions-names)

### Strings and interpolation

A string is `"…"` on one line, with the escapes `\"`, `\\`, `\{` and `\}`. In a string,
`{expr}` becomes its value: a number in its shortest form, a length in the units in
force, text as written; `{expr:.N}` prints N decimals. Footprint and pad names,
descriptions and text interpolate: `thermal pad "{n + 1}" 3.45 x 3.45`.

## Numbers, units and sizes

### Units

Lengths are in mm unless `units: mm|um|nm|mil|in` says otherwise: at the top level for
the lines after it, or as the first statement of a footprint or template for that block.
Any number can carry a unit, attached (`0.65mm`, `50mil`), and units mix freely. A plain
number takes a unit only where it's used as a length, so in a template that starts with
`units: mil`, a default or table cell of `375` is 375 mil.
[SPEC §6](../SPEC.md#6-coordinate-system-and-units)

### Sizes, side marks, percentages and angles

`W x L` is a 2D size: the width along x and the length along y, before any rotation
(generated pads read it [across the lead](#where-pad-geometry-comes-from)). If a drawing
gives the height first, mark a side `w` or `h`: `rect 1.6h x 1.1w` is `rect 1.1 x 1.6`.
The mark goes after any unit (`43milw`), and a name takes parentheses (`(D)h`); a `body`
or `box` is always `W x L x H`. A percentage (`25%`) sets a corner radius or a paste
coverage. Angles are degrees counterclockwise from +x: `45`, `45deg`, `0.7854rad`.
[SPEC §7](../SPEC.md#7-values-expressions-names)

### Expressions and functions

Expressions use `+ - * /` and parentheses: `(6.4 - 4.4) / 2`, `span / 2 - 0.3mm`. A
length times a length is a unit error, and a length over a length is a plain ratio. A
name touching its `(` is a call. `pi` is 3.14159…, and none of these names is reserved.

| function | gives |
|---|---|
| `min(a, …)`, `max(a, …)`, `clamp(v, lo, hi)` | the smallest or largest argument; v kept between lo and hi |
| `abs(a)`, `hypot(a, …)`, `sqrt(a)` | the absolute value; the square root of the sum of squares; the square root of a plain number (not a length) |
| `sin(a)`, `cos(a)`, `tan(a)` | of an angle in degrees, exact at right angles |
| `asin(a)`, `acos(a)`, `atan2(y, x)` | an angle in degrees |
| `mix(c1, c2, t)`, `metal(c)` | a color t of the way from c1 to c2 (t from 0 to 1); color c, rendered as shiny metal |

### Colors

A color is `"#rrggbb"`, a built-in name, a name from the library's
[palette](../stdlib/README.md#colorsstomp) (`can_blue`, `ferrite`, …), `mix(…)` or
`metal(…)`. The built-ins are `black`, `gray`, `white`, `red`, `green`, `blue`, `yellow`,
`orange`, `brown`, `tan`, `ceramic` and the shiny metals `tin`, `silver`, `gold`,
`copper` and `aluminum`. Your names come first, then the built-ins, then the palette.
Colors take no arithmetic. [SPEC §7](../SPEC.md#7-values-expressions-names)

## Footprints and metadata

`footprint "NAME"`, its statements, then `end`. Each footprint in a file needs a name of
its own; `extends` and `from` make one from another (see
[templates](#templates-tables-and-inheritance)). These statements are optional:
[SPEC §5](../SPEC.md#5-files-footprints-metadata)

| statement | holds |
|---|---|
| `description: "…"`, `datasheet: "…"` | a one-line description; the datasheet's URL |
| `manufacturer: "…"`, `mpn: "…"` | the maker and its part number |
| `refdes: "…"` | the reference designator prefix, the U of U3: the assembly label shows `U?`, and it sets the [part family](#part-families) |
| `tags: …` | keywords separated by commas: words, numbers or strings |
| `density: least\|nominal\|most` | the IPC-7351 density level |

IPC-7351 is the standard for surface-mount land patterns. Its `most` density gives the
largest lands and courtyard (hand soldering, rugged boards), `least` the smallest (dense
boards), and `nominal` is the default. The level also sizes through-hole drills.

### The origin

The origin, (0, 0), is the body's center for a part-mode package, and for a layout placed
only by relations, the center of its body or land pattern. Once you place something
`at (x, y)`, coordinates mean what you wrote. `origin at pad 1`, `origin at (x, y)` or
`origin centered between A and B` moves it, and `origin` is an object to measure from.
[SPEC §6](../SPEC.md#6-coordinate-system-and-units)

## Pads and holes

### Pad shapes and holes

`pad NAME [tht] SHAPE [PROPERTY …]` makes a pad. With `tht` it's a plated through-hole
pad: the shape is the copper around the hole, and `drill: D` or `drill: slot W x L` is
the hole (`pad 1 tht circle 6.4 drill: 3.2`). `hole NAME D` or `hole NAME slot W x L`
makes a non-plated hole (NPTH) for a peg or a screw; place it like a pad.
[SPEC §10](../SPEC.md#10-pads-and-holes)

| shape | draws |
|---|---|
| `rect W x L`, `oval W x L` | a rectangle; an obround, with fully rounded ends |
| `circle D` | a circle D across |
| `roundrect W x L r: R` | rounded corners: R is a length, or a percentage of the shorter side |
| `dshape W x L flat: SIDE` | a D, flat on SIDE (`left` if left out) and round at the other end |
| `polygon (x, y) (x, y) (x, y) …` | three or more corners, around their centroid |

### Pad properties and the default pad

Properties follow the shape in any order, or change a pad on a `pad NAME` line of their
own; a `mask:` or `paste:` value needs its sign. `default pad [tht] SHAPE [PROPERTY …]`
is the geometry of every pad without its own, generated pads included.
[SPEC §10.2](../SPEC.md#102-pad-properties)

| property | does |
|---|---|
| `rotate: A` | turns the pad counterclockwise about its center |
| `mask: +E`, `mask: -E` | grows or shrinks the solder-mask opening by E per side; by default it's 0.05 mm larger than the pad |
| `mask: none`, `mask: defined` | no opening; a solder-mask-defined pad, whose opening sets the land |
| `paste: +E`, `paste: -E`, `paste: none` | grows or shrinks the paste stencil opening, or leaves it out |
| `paste: divide NX x NY [coverage: P%]` | paste in NX x NY windows covering P% of the pad, 50% if left out |
| `paste: divide NX x NY gutter: G` | the same windows, G apart |
| `vias: NX x NY drill: D pitch: P` | an array of thermal vias in the pad |

### Changing and deleting pads

`pad NAME PROPERTY …` changes one pad and `pads SELECTOR PROPERTY …` several; a selector
lists names and ranges (`1..4, 9`, `A1..A8`, `8..5`). Both also take `width:`, `length:`,
`size: W x L`, `shape: SHAPE` and `drill:`. A `pad NAME SHAPE` line for a pad that
exists already replaces its geometry, and `delete pad|hole|ball NAME` removes one.
[SPEC §10.3](../SPEC.md#103-defaults-selectors-overrides-deletion)

```stomp
footprint "DIP-7_W7.62mm"               # an 8-pin DIP without pin 6, for creepage
  body 6.35 x 9.2 x 3.3
  pins 8 dual pitch: 2.54 span: 7.62 centers
  lead pin 0.46 x 0.25
  default pad tht oval 1.6 x 2.0 drill: 0.8
  pad 1 tht rect 1.6 x 2.0 drill: 0.8   # replaces pad 1: a square pin 1
  pads 5, 7 mask: +0.1
  delete pad 6
end
```

## Placement

Positions come from placements, in any order. +x is right and +y is up, seen from above,
relative to the origin. Objects are named by kind and name: `pad 3`, `hole M1`, `row A`,
`group G`, `ball A1`, `side left` (one side's pads), `body` and `origin`; the kind can go
where the name is unambiguous. [SPEC §9](../SPEC.md#9-placement-and-dimensioning)

```stomp
footprint "TO-252"
  pad 1 rect 1.1 x 1.6
  pad 3 rect 1.1 x 1.6
  pad 2 rect 5.5 x 6.2                  # the tab
  pad 3 is 4.56 right of pad 1          # center to center
  pad 2 is centered between pad 1 and pad 3 horizontally
  pad 2 inner is 1.9 above pad 1        # the tab's near edge to the pin centers
end
```

### At, relations and anchors

`OBJECT at (x, y)` fixes an object's center.
`TARGET [ANCHOR] is DIST left of|right of|above|below REF [ANCHOR]` puts the target DIST
from the reference on one axis, and weakly lines their centers up on the other until a
statement places it. `and` chains clauses, each with its own distance, direction and
reference: `hole PEG1 is 2.89 left of pad 1 and 0.55 below pad 1`. An anchor picks the
edge measured, on the box after rotation (for a row, group or side, the box around its
members). [SPEC §9.2](../SPEC.md#92-directional-relations-is--of),
[§8.2](../SPEC.md#82-anchors)

| anchor | measures | for example |
|---|---|---|
| none, or `center` | the center | `pad 3 is 4.56 right of pad 1` |
| `outer` | the edge facing away from the other object | `pad 8 outer is 6.0 right of pad 1 outer`: a span |
| `inner` | the edge facing the other object | `pad 2 inner is 0.4 right of pad 1 inner`: a gap |
| `left`, `right`, `top`, `bottom` | that edge, on the relation's axis | `body bottom is 1.1 above pad 1` |

### Mirrors and measured pairs

`A mirrors B across x|y` makes A the mirror image of B about the footprint's x or y axis,
creating A if needed. `span A to B is D`, `gap A to B is D` and `pitch A to B is D`
measure outer edges, facing edges and centers, along the axis of a mirror or `align`
between the two, or of `horizontally` or `vertically` added at the end. One measurement
places a mirrored pair not yet placed, B on the -x side for `across y` and the +y side
for `across x`: `pad "SH4" mirrors pad "SH3" across y` and `span pad "SH3" to pad "SH4"
is 8.0`. Otherwise it places whichever is free, B on A's positive side.
[SPEC §9.4](../SPEC.md#94-symmetry-mirrors-and-measured-pairs-span--gap--pitch)

### Centering, alignment, rows and groups

| statement | places |
|---|---|
| `T is centered between A and B [horizontally\|vertically]` | T at the midpoint of A's and B's centers |
| `T is centered on A [horizontally\|vertically]` | T's center on A's |
| `align A with B horizontally\|vertically` | A on one horizontal line with B (the same y), or one vertical line (the same x) |
| `row NAME pads SELECTOR pitch: P [going: right\|left\|up\|down]` | the pads in order, P apart, going right unless told; the row is one object to place |
| `group NAME = OBJECT, OBJECT, …` | nothing: it's one bounding box to measure against |

`horizontally` always means along a horizontal line: centering moves x, aligning shares
y. A row makes the pads it names, which then need a shape (`default pad`, say). Groups and
sides can't be placed: place their members. [SPEC §9.5](../SPEC.md#95-centering-and-alignment)

### Constraint rules

- Each axis of each object takes its position from exactly one strong statement: `at`,
  a relation, `centered`, `align`, `mirrors` or a measured pair. A second one is an
  over-constraint error that cites both statements.
- Weak defaults fill the axes left: a relation's cross-axis alignment, then generated
  positions. An axis with no position is an under-constraint error naming the object.
- Order doesn't matter, references can point forward, and circular placements are
  errors that list the cycle. [SPEC §9.7](../SPEC.md#97-constraint-semantics)

## Part mode

Describe the component as its drawing does, and stomp derives the pads, IPC-7351 style,
and the 3D model; explicit pads still win. The comments use JEDEC letters, which package
drawings use for dimensions: `e` the pitch, `b` the lead width, `L` the foot length, `A`
the seated height, `A1` the standoff. [SPEC §11](../SPEC.md#11-parametric-part-description)

```stomp
footprint "SOIC-8"
  body 3.9 x 4.9 x 1.5                  # E1 x D x A
  pins 8 dual pitch: 1.27               # e; pin 1 at the top left
  lead gullwing 0.41 x 1.04 span: 6.0   # b x L; the span E, tip to tip
  pin1: dot
end
```

### Body

One per footprint: it shapes the automatic silk, assembly outline, courtyard and 3D
model, and it's an object to measure from. Unless placed, it's centered on the generated
pins or the land pattern. `body W x L x H` is a box, with H the seated height; without H
the model is a flat plate. `body cylinder d: D h: H` is a can standing on the board, or
lying along its pins for end caps (a MELF) and for wires outside its circle (an axial
part). [SPEC §11.1](../SPEC.md#111-body)

### Pins

| form | pins |
|---|---|
| `pins N dual` | two rows, left and right, counterclockwise from pin 1 at the top left |
| `pins N quad` | four sides, counterclockwise from the top left; N a multiple of 4 |
| `pins 2 horizontal`, `pins 2 vertical` | two terminals, pin 1 on the left, or at the top |
| `pins N single SIDE` | one row along SIDE: `left`, `right`, `top` or `bottom` |
| `pins grid NX x NY` | NX columns by NY rows |
| `balls NX x NY` | a ball grid: a grid with `lead ball` and `numbering: bga` |

Without an arrangement, `pins 2` is horizontal and other counts dual. These clauses go on
a `pins` or `balls` line in any order: [SPEC §11.2](../SPEC.md#112-pins-count-and-arrangement)

| clause | sets |
|---|---|
| `pitch: P`, `pitch: PX x PY` | the pitch, center to center, one per axis on a grid (`pitch: P` also works on its own line) |
| `span: S [outer\|inner\|centers]` | the spacing across the package: see [span and gap](#span-and-gap) |
| `pad: SHAPE …` | the default pad for these pins |
| `numbering: ccw\|cw\|zigzag\|row-major\|col-major\|bga` | counterclockwise (the default), clockwise, in pairs across the short way as on box headers (the grid default), along each row, down each column, or JEDEC ball names (the default for balls: rows A, B, C, … skipping I, O, Q, S, X and Z, columns from 1) |
| `start: top-left\|top-right\|bottom-left\|bottom-right` | the corner numbering starts from; `top-left` by default |

### Side lists

For irregular parts, `pins` alone on its line lists the sides, one per line, then `end`:
`SIDE: NAME, NAME, … [pitch: P]`. Positions run counterclockwise: the left side top to
bottom, the bottom left to right, the right side bottom to top, the top right to left.
`nc` leaves a position empty (`right: 4, nc, 5`). Each run is centered on its side, a
side without `pitch:` takes the first one given, and the pins keep the names you list.

### Omit and only

`omit` removes generated pins and `only` keeps just the listed ones. Both take names,
name ranges and, on a grid, regions: `rows R1..R2 [cols C1..C2]` or `cols C1..C2`. The
rest keep their places: `omit A1, H8, rows D..E cols 4..5`.

### Leads

`lead FORM [SIZE] [span: S [outer|inner|centers]]` describes every lead. The size is
`W x L` (width by foot length), `d: D` for a round lead, or one number.
[SPEC §11.3](../SPEC.md#113-leads)

| form | for | size |
|---|---|---|
| `gullwing` | SOIC, SOP, QFP, SOT | `b x L` |
| `jlead` | PLCC, SOJ: the lead curls under the body | `b x L` |
| `lbend` | tantalums, SMA: the foot folds under the body | `b x L` |
| `straight` | SOD-123F, SMF: flat leads out of the body's bottom | `b x L` |
| `flat` | QFN, DFN and LGA terminals | `b x L` |
| `endcap` | chip passives and MELFs | the cap length T, as wide as the body; or `W x T` |
| `ball`, `column` | BGA balls; CGA (column grid array) columns | the diameter, or `d: D` |
| `pin`, `wire` | through-hole pins (DIPs, headers); axial and radial wires | `d: D` round, or `W x T` |
| `tab` | a DPAK-style tab, usually as a per-pin lead | `W x L` |
| `castellated` | plated half-holes on a module's edge; provisional, with a warning | `d: D` |

Gull-wing, J-lead and straight leads need a span, unless the part has two pins and a
`pitch:`. Flat, L-bend, end-cap and tab leads reach the body's edges unless a span says
otherwise. Through-hole rows need `span: S centers` unless they're a grid or two pins.

### Per-pin leads

`lead SELECTOR FORM [SIZE] [span: …]` gives the named pins a lead of their own, and
`lead SELECTOR none` leaves them without a 3D lead. A pin whose land comes from its lead
gets it from this one, on the same span; with no size, the lead takes the land's. In land
mode, per-pin leads only add 3D leads: `lead 1, 3 gullwing 0.75 x 1.0` on a DPAK.

```stomp
footprint "SOT-223"
  body 6.5 x 3.5 x 1.8
  pins                                  # a side list
    bottom: 1, 2, 3 pitch: 2.3
    top: 4                              # the tab, opposite pin 2
  end
  lead gullwing 0.7 x 0.9 span: 7.0
  lead 4 gullwing 3.0 x 0.9             # the wide tab lead: a wider land too
end
```

### Span and gap

A span measures across the package, between opposite rows: `outer` (the default, tip to
tip as datasheets draw it), `inner` (facing edges) or `centers`. It goes on a `lead` or
`pins` line, or alone (`span: 5.4 centers`); `gap: G` alone is `span: G inner`. With a
`lead`, a span measures the leads, otherwise the pads, as in a chip land pattern:
`pins 2 horizontal`, `default pad rect 0.5 x 0.6`, `gap: 0.5`. A `span:` or `gap:` line
sets the spacing outright, and in part mode the pads then need `default pad` or `pad:`.

### Thermal pads

`thermal pad [NAME] W x L [PROPERTY …]` adds an exposed pad centered on the body, named
`EP` unless you name it. Change or place it like any other pad.
[SPEC §11.4](../SPEC.md#114-thermal--exposed-pad)

```stomp
footprint "QFN-32_5x5mm_P0.5mm_EP3.7x3.7mm"
  body 5 x 5 x 0.9
  pins 32 quad pitch: 0.5
  lead flat 0.25 x 0.4                  # flush with the body's edges
  pin1: chamfer
  thermal pad 33 3.7 x 3.7 paste: divide 2 x 2 coverage: 68%
  pad 33 vias: 3 x 3 drill: 0.3 pitch: 1.1
end
```

### Where pad geometry comes from

A pad's geometry comes from, in order: its own `pad NAME SHAPE` line; a `pins … pad:`
clause or `default pad`; IPC sizing from the lead. With none, it's an error. Change lines
apply on top. Generated pads face out from their side, so for them `W x L` is the width
across the lead by the length along it: `default pad rect 0.6 x 2.2` on a SOIC is 0.6
along the row and 2.2 outward. Surface-mount lands use the IPC-7351 toe, heel and side
goals for the density, with corners rounded at 25%. Ball lands are 80% of the ball,
column lands 0.3 mm wider than the column, and through-hole drills 0.15 to 0.25 mm over
the lead, with a ring of 0.2 to 0.4 mm.

## Pin 1 and polarity

`pin1: dot|chamfer|notch|bar|none|FEATURE` picks the silk mark at pin 1: by default `dot`
for dual, quad, single and side-list packages, `none` for two-terminal parts and grids.
Pin 1 is pad `1` (`A1` on a ball grid), else the first pin in numbering order. The 3D
body gets a mark too: see the [model block](#the-model-block).
[SPEC §11.5](../SPEC.md#115-pin-1-marker-and-polarity)

| mark | draws |
|---|---|
| `dot` | a dot outside the corner nearest pin 1 |
| `chamfer` | a chamfered outline corner, the QFN convention |
| `notch` | a notch in the outline at the pin-1 end, DIP style |
| `bar` | a bar across the pin-1 end |
| a feature | its graphics where the dot would go, moved out to clear the copper: one of [yours](#features), or a library symbol, `pin1: triangle(a: -90)` |

`polarized` marks a two-terminal part whose pin 1 is positive (the anode) with a silk bar
and a 3D stripe at the end its family marks: the cathode (pin 2) of a diode or LED and
the negative lead (pin 2) of a can, but the positive end (pin 1) of a chip or molded
capacitor, as tantalums are marked. A round part gets a hatched half and a "+" instead.

## Silk, assembly and courtyard

### Automatic layers

Every footprint with a body gets, without another line:

- **silk:** the body outline, cut back to clear the copper, and the pin-1 and polarity
  marks;
- **assembly:** the body outline, chamfered at pin 1, and the refdes label, `U?`;
- **courtyard:** the room the part needs, which other courtyards mustn't overlap: the
  smallest rectangle around lands and body, plus 0.5, 0.25 or 0.1 mm for `most`,
  `nominal` or `least` density (less for chips under 1.6 mm), rounded out to 0.01 mm.

Graphics you write add to these. `silk: none` turns the automatic silk off and
`silk: auto` back on, and `assembly: none|auto` does the same for the assembly layer;
the last one wins. [SPEC §12](../SPEC.md#12-graphic-layers)

### Graphics and text

| graphic | draws |
|---|---|
| `line (x, y) (x, y)`, `polygon (x, y) (x, y) (x, y) …` | a line; a closed polygon |
| `arc (x, y) r: R from A to B` | an arc about (x, y), counterclockwise from angle A to B |
| `circle (x, y) d: D`, `rect (x, y) W x L` | a circle; a rectangle, each centered on (x, y) |
| `hatch (x, y) d: D from A to B pitch: P` | chords across the circle at (x, y), D across, at x offsets A, A + P, … below B |
| `outline body [offset: O]` | the body's outline, pushed out by O |
| `text "…"\|ref\|value at (x, y) [size: S]` | a string, the refdes field (`U?`) or the value field (the footprint's name), 1 mm tall unless sized |

Each takes `layer: silk` (the default) or `layer: assembly`; text can also go on
`copper` or `mask`, and `value` defaults to the assembly layer. Graphics take `width: W`
(0.12 mm on the silk, 0.1 mm on assembly, if left out); `fill`, for a circle, rect or
polygon, which then has no width; and `clear`, which cuts lines and outlines back from
the copper as the automatic outline is.

```stomp
footprint "LED_0603_1608Metric"
  refdes: "D"
  body 1.6 x 0.8 x 0.6
  pins 2 horizontal
  lead endcap 0.3
  polarized                             # a bar by the cathode, pin 2
  text ">K" at (1.9, 0) size: 0.5
  rect (0, 0) 2.4 x 1.2 width: 0.05 layer: assembly
end
```

### Courtyard

A courtyard is always one rectangle: `courtyard: auto [C]`, the automatic one with
clearance C; `courtyard: rect W x L`, centered on the body; `courtyard: rect (x, y)
W x L`; or `courtyard: polygon` with four corners and sides along x and y. The last
`courtyard:` line wins, and two in one footprint get a warning.

## Templates, tables and inheritance

### Templates and calls

`template NAME(PARAM, PARAM = DEFAULT, …)`, footprint statements, then `end`: a footprint
with parameters, names that get their values in each footprint it makes. A default can
use other parameters (`E = D`). `footprint "NAME" from TEMPLATE(ARGS)` makes one, with
arguments by position, by name (`lspan: 10.3`) or both; a parameter without a default
must be given. End the line with `with` to add statements, closed by `end`. There are no
conditionals or loops. [SPEC §14.1](../SPEC.md#141-templates-are-functions)

```stomp
template soic(n, lspan = 6.0, e = 1.27, bw = 3.9)
  body bw x (n / 2 - 1) * e + 2.0 x 1.5
  pins n dual pitch: e
  lead gullwing 0.41 x 1.04 span: lspan
end

footprint "SOIC-8" from soic(8)
footprint "SOIC-16W" from soic(16, lspan: 10.3, bw: 7.5) with
  description: "wide body"
end
footprint "SOIC-8-HS" extends "SOIC-8"
  default pad rect 0.6 x 2.2            # longer pads for hand soldering
  courtyard: auto 0.5
end
```

`name: "…"` in a template names its footprints, usually by interpolating parameters, so
`footprint from TEMPLATE(…)` needs no name. A name in the header wins, and `name:` in the
`with` block of an unnamed call renames that one. Every footprint, generated or not,
needs a name of its own. [SPEC §14.2](../SPEC.md#142-naming-name)

### Tables

`footprints from TEMPLATE[(ARGS)]`, a header row of parameter names, one row per
footprint, then `end`. Cells are separated by spaces; a cell is a number with an attached
unit or minus sign (`20mil`, `-0.1`), a name, a `"string"`, or an expression in
parentheses, `(D - 0.2)`. Call arguments apply to every row, a column can't repeat one,
and other parameters take their defaults. The template must name the footprints.
[SPEC §14.3](../SPEC.md#143-tables-footprints-from)

```stomp
template qfn(n, D, D2, e = 0.5)
  name: "QFN-{n}-1EP_{D}x{D}mm_P{e}mm_EP{D2}x{D2}mm"
  body D x D x 0.9
  pins n quad pitch: e
  lead flat e / 2 x 0.4
  thermal pad "{n + 1}" D2 x D2
end

footprints from qfn(e: 0.5)
  n    D    D2
  16   3    1.7
  48   7    (7 - 1.4)
end
```

### Inheritance

`footprint "NAME" extends "PARENT"`, statements, then `end`, replays the parent and
applies the child's statements on top, as `SOIC-8-HS` does above. Where a footprint takes
one statement (`body`, `pins`, `lead`, `default pad`, the courtyard, …), the child's
replaces the parent's, and so does a placement on the same axis of the same object.
Model blocks merge. The parent can be any footprint, a generated one included.
[SPEC §14.4](../SPEC.md#144-inheritance-extends)

## Features

A feature is a named set of graphics and solids drawn around its own origin: a mark, a
symbol, a body. `feature NAME[(PARAMS)]` at the left margin, its graphics, solids, names
and sections, then `end`, defines one. Graphics go on the silk unless they say
`layer: assembly`, text stays upright however the feature turns, and `outline body`
can't go in one. [SPEC §12.1](../SPEC.md#121-custom-features)

```stomp
feature plus(s = 0.7, w = 0.12)
  h = s / 2                             # a name, from a parameter
  line (-h, 0) (h, 0) width: w
  line (0, -h) (0, h) width: w
  section big
    s = 1.2                             # with this flag, a new default for s
    section bold; w = 0.2; end          # only with both flags
  end
  section ring, circled                 # with either flag
    circle (0, 0) d: 1.6 * s width: w
  end
end

footprint "CP_Tantalum_Case-B_EIA-3528-21"
  refdes: "C"
  body 3.5 x 2.8 x 1.9
  pins 2 horizontal
  lead lbend 2.2 x 0.8
  polarized
  pin1: plus                            # where the dot would go
  feature plus(big, ring) at (0, 2.6)   # s = 1.2, in a circle
end
```

### Placing a feature

`feature NAME[(ARGS)] at (x, y)|(x, y, z)|OBJECT [rotate: A] [on body]` in a footprint
draws its graphics on the footprint's layers and its solids in the 3D model. A z lifts
its origin above the board; `on body`, with or without `at`, rests it on the body.
`rotate: A` turns it about z, `rotate: (rx, ry, rz)` in 3D. `pin1: NAME(ARGS)` makes it
the pin-1 mark. A feature places another the same way, at a point, up to 32 deep. A plain
number argument takes the unit of the feature's statements: pass `40mil` from elsewhere.

### Sections and flags

A `section FLAG[, FLAG …]` block counts only when the call passes one of its flags: a
word in the call naming a section, before or after the values, never between them.
Sections are how a feature chooses; stomp has no `if`.

- `NAME = value` in a section gives a parameter or name a new value while it's on. A
  value in the call wins, then the innermost section that's on, then the default.
- A nested section needs all of its flags. Two sections that are on can set one name
  only if one is nested in the other.
- Flags flow down: a feature placed by another sees all the flags above it.
- To pass a value named like a flag, put it in parentheses: `plus((big))`.

### Replacing a library feature

A feature named like one of the standard library's replaces it everywhere in your file,
even where the library uses it: `feature pin1_dot(d = 0.3)`, its graphics and `end`
redraw every `pin1: dot`. Yours must take what the library passes; a parameter it never
fills gets a warning unless it has a default. The [standard library page](../stdlib/README.md)
lists the features and what each takes. [SPEC §13.5](../SPEC.md#135-the-standard-library)

## The 3D model

### What's generated

A footprint with a `body` has a 3D model without another line. z is up from the board,
H is the seated height (JEDEC A), and the body sits on the standoff (JEDEC A1) that the
lead form picks: 0.1 mm for gull-wings, 0.02 mm for leadless parts, three quarters of the
ball for a BGA. The form picks the body too: molded for gull-wing, J-lead, L-bend and
straight leads, sawn for flat ones, a chip or MELF for end caps, a BGA or CGA, a DIP or
header for pins, a can, LED or axial body for wires, a module for castellations. Leads
are tin, and through-hole leads reach 3 mm below the board.
[SPEC §13.1](../SPEC.md#131-the-generated-model)

### The model block

`model`, settings and solids, then `end`; a setting given twice gets a warning, and the
later wins. `no model` turns the 3D output off. Model blocks merge down an `extends`
chain: the child's settings replace the parent's and its solids add to them, and
`no model` ends the model until a later `model` block.
[SPEC §13.2](../SPEC.md#132-the-model-block)

| setting | sets |
|---|---|
| `standoff: Z`, `height: H` | the body's bottom above the board (JEDEC A1); the model's height, where it isn't the body's H |
| `draft: A` | a molded body's side draft, under 45 degrees; 0 is straight-sided |
| `body color: C`, `leads color: C` | the body's or the leads' [color](#colors) |
| `leads thickness: T` | the lead-frame thickness (JEDEC c) |
| `leads below: L`, `leads above: L` | how far through-hole leads reach below the board; how far grid pins rise above their housing (0 makes a socket) |
| `pin1: dimple\|dot\|notch\|stripe\|none` | the body's pin-1 mark |
| `body shape: FEATURE` | draws the body with a feature: yours, or a library package (`to92`, `to220`, `hc49`, `tact_switch`, `buzzer`) |
| `leads shape: FEATURE` | draws every lead with a feature |
| `step: "FILE" [offset: (x, y, z)] [rotate: (rx, ry, rz)] [scale: S]` | an external STEP model instead; the editor can't load one, so it shows the generated model |

```stomp
footprint "CP_Radial_D8.0mm_P3.50mm"
  refdes: "C"
  body cylinder d: 8 h: 11.5
  pins 2 horizontal pitch: 3.5
  lead wire d: 0.6
  polarized
  model
    body color: "#26476f"               # a dark blue sleeve
    leads below: 2
  end
end
```

### Solids

Solids add what the lead form doesn't describe, in a model block or a feature.
[SPEC §13.3](../SPEC.md#133-solids)

| solid | draws |
|---|---|
| `box W x L x H` | a box |
| `cylinder d: D h: H` | an upright cylinder; `d: D to D2` makes a cone |
| `sphere d: D [h: H]` | a sphere, squashed to H tall |
| `disc d: D [to D2]` | a flat disc, or a ring from D to D2 |
| `prism PATH h: H`, `face PATH` | a flat outline, H thick; one with no thickness, facing up |
| `loft W x L at Z, W x L at Z, …` | a solid through rectangles stacked at heights Z |
| `sweep W x T [fillet: R] along PATH` | a W x T strip along a path in x and z, as leads are drawn |
| `wire d: D [fillet: R] along PATH` | a round wire along a path in x and z |
| `slab W x L x T [castellated]` | a board, with a half-hole at each castellated lead |

Options, in any order: `at (x, y)` or `at (x, y, z)`; `on body`, in a model block;
`rotate: A` about z, or `rotate: (rx, ry, rz)` about x, y, then z; `color: C`;
`name: "…"` for the mesh in exports; `kind: body|lead|mark`, in a feature, for its
highlight; `segments: N`; `open`, `open top` or `open bottom` for a cylinder without
ends; `from A to B` for part of a cylinder or disc; `down` for a disc or face facing down.

In a model block a solid starts centered on the body, on the board, in the body's color:
`at (x, y)` moves its center, a z sets its bottom's height, and `on body` rests it on the
body. In a feature, `at` puts the solid's own origin (the middle of a box's, cylinder's
or sphere's bottom) at a point of the feature, and a size of zero or less draws nothing.

```stomp
model
  box 2.9 x 2.2 x 0.1 on body color: tin              # a lid on the body
  cylinder d: 2 h: 6 at (0, 0, 1) rotate: (0, 90, 0)  # its bottom 1 above the board
end
```

A path is points and arcs separated by commas: `(0, 0), (1, 0), arc (1, 1) r: 1 from -90
to 0 segments: 8, (2, 2)`. A prism's or face's path is in x and y, a sweep's or wire's in
x and z. `fillet: R` rounds the corners between points, in 10 degree steps
(`fillet: R step: 8` for 8); an arc's own points stay as they are.

### Part families

The refdes names the part's [family](../stdlib/README.md#families), which sets colors
and details: chip resistors are white with a black top, chip capacitors tan, inductors
ferrite; a crystal on a block body gets a metal lid, a round diode on wires is an LED, and
an axial resistor gets color bands. The longest prefix wins: `R` resistor, `C`
capacitor, `L` or `FB` inductor, `D` or `LED` diode, `Q` transistor, `U` or `IC` ic,
`Y` or `XTAL` crystal, `X`, `XO` or `OSC` oscillator, `S` or `SW` switch, `BZ` or `LS`
buzzer, `J`, `P`, `CON` or `CN` connector, `F` fuse.

## Diagnostics

Each problem is reported at the statement that causes it: an error, or a warning when it
may be intended. [SPEC §15](../SPEC.md#15-diagnostics)

- **Syntax:** a missing `end` (at its block's header), an `end` with nothing to close,
  braces, `pitch 1.27` without its colon or `at:` with one.
- **Names:** an unknown object, name, template, feature, flag, color or function, with
  the nearest match suggested; a name given two values; a duplicate pad or footprint.
- **Placement:** an over- or under-constrained axis, citing the statements; a circular
  placement; an anchor that doesn't fit the axis.
- **Values and part mode:** unit errors (a length times a length), a function given the
  wrong kind of value, a misplaced side mark; a pad with no geometry, a count that
  doesn't fit its arrangement, a table row with the wrong number of cells. A template's
  errors show on the call or row that causes them, and the library's at your statement
  that used it.
- **Warnings:** overlapping pads, a drill as large as its pad, a courtyard or model
  setting given twice, `polarized` on a part that isn't two-terminal, castellated leads.
