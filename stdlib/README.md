# The standard library

These stomp files are loaded before every file, in the order below. They draw every 3D
model and the automatic silk marks, and they hold shapes, symbols, packages and colors
for your own files to use. They're written in mm, with angles in degrees. How the 3D
model calls them, and with what, is in [SPEC §13.5](../SPEC.md#135-the-standard-library).

## Using it

- **Place a feature** in a footprint or in a feature of your own:
  `feature rounded_box(2, 1, 0.5, r: 0.2, color: nickel) at (0, 0, 1)`. A footprint
  places its solids in the 3D model and its graphics in the silk.
- **Name a package** for a footprint's body: `body shape: to220` in its `model` block.
- **Mark pin 1 with a symbol**, `pin1: triangle`, or put one anywhere,
  `feature arrow at pad 1 rotate: 90`.
- **Use a color** wherever a color goes: `color: led_green`, `body color: nickel`.
- **Replace a feature** by defining one with the same name in your file. Yours is used
  everywhere in that file, including where the library places it itself, so
  `feature resistor_bands(…)` recolors every axial resistor in the file.

[`examples/tht_parts.stomp`](../examples/tht_parts.stomp) uses the packages, shapes and
symbols; [`examples/custom_models.stomp`](../examples/custom_models.stomp) replaces
library features and writes a body of its own.

## Families

The refdes's first letters name the part's family, the longest match first. The family
is a flag for every body, lead and silk mark feature, which is how these details come
without being asked for:

| refdes | family | what the library does with it |
|---|---|---|
| `R` | `resistor` | an axial body gets color bands; a chip a black film |
| `C` | `capacitor` | chips are tan; a chip or molded body marks its positive end |
| `L`, `FB` | `inductor` | chip and sawn bodies are ferrite |
| `D`, `LED` | `diode` | a round body on wires is an LED; a J-lead body is a PLCC LED; chips get a lens |
| `Y`, `XTAL` | `crystal` | a sawn or block body is a ceramic package under a metal lid |
| `X`, `XO`, `OSC` | `oscillator` | as a crystal |
| `Q` | `transistor` | |
| `U`, `IC` | `ic` | |
| `S`, `SW` | `switch` | |
| `BZ`, `LS` | `buzzer` | |
| `J`, `P`, `CON`, `CN` | `connector` | |
| `F` | `fuse` | |

## Files

### [`colors.stomp`](colors.stomp)

The palette. These names work in your files too, unless you define the name yourself.
The built-in names (`black`, `white`, `red`, `tin`, `gold`, `aluminum`, …) are in
[SPEC §7](../SPEC.md).

| name | for |
|---|---|
| `epoxy` | black molded plastic |
| `solder` | balls and columns (a metal) |
| `alumina` | white ceramic: chip resistors, CGA bodies |
| `thick_film` | the resistive layer of a chip resistor |
| `mlcc` | ceramic capacitors |
| `ferrite` | inductors |
| `led_white`, `led_lens`, `led_mark` | a chip LED's body, a white LED's lens, a chip LED's green cathode mark |
| `led_red`, `led_green`, `led_yellow`, `led_orange`, `led_blue`, `led_clear` | radial LED lenses |
| `laminate`, `pcb_blue` | a BGA's substrate, a module's board |
| `can_blue`, `rubber`, `vent_metal` | an electrolytic's sleeve, its seal, its vent |
| `marking`, `band`, `etch` | printed stripes, an axial cathode band, an etched pin-1 dot |
| `resistor_tan`, `diode_black`, `cap_blue`, `inductor_green` | axial bodies |
| `melf_blue`, `melf_red`, `glass_band` | MELF bodies, a glass MELF's band |
| `nickel` | lids and covers (a metal) |
| `solid_color` | a model block's solids, when the part has no body |

### [`shapes.stomp`](shapes.stomp)

Solids to build with. Each is drawn around its own origin, and each also takes
`color` and `name` (the mesh's name in the model and the exports).

| feature | draws |
|---|---|
| `rounded_box(W, L, H, r = 0.1)` | a box with its vertical edges rounded to radius r, its origin in the middle of its bottom |
| `chamfered_box(W, L, H, c = 0.1)` | a box with its vertical edges cut at 45 degrees, c back from each corner |
| `beveled_box(W, L, H, b = 0.1)` | a box with its top edges beveled, b in and b down |
| `dome(d, h, segments = 32)` | a dome d across and h tall above its origin; the rest of the ellipsoid lies below, hidden in what it sits on |
| `torus(d, wd, segments = 12)` | a flat ring of round wire d across its outside and wd thick, centered on its origin |
| `hex_prism(af, h)` | a hexagonal prism af across its flats, which face +y and -y: a nut, a standoff |
| `post(b, T = b, z0 = 0, z1 = 1, bevel = …)` | a pin from z0 up to z1 with beveled ends: round and b across, or b x T with the flag `square` |

### [`symbols.stomp`](symbols.stomp)

Silk symbols, drawn around their own origin.

| feature | draws |
|---|---|
| `triangle(s = 0.6, a = 0)` | a filled triangle s along each side, pointing a degrees from +x |
| `arrow(len = 1.2, head = 0.4)` | an arrow len long with a filled head, its tip at the origin, pointing +x |
| `plus(s = 0.5)`, `minus(s = 0.5)`, `cross(s = 0.5)` | a "+", a "-", an "x" |
| `ring(d = 0.6)` | a circle d across |
| `frame(W, L)` | a W x L rectangle |
| `corners(W, L, len = 0.6)` | the corners of a W x L rectangle, arms len long, its sides left open |
| `corner_mark(len)` | one of those corners: arms down and left from the origin |

### [`marks.stomp`](marks.stomp)

The marks on a body's top: `top_marks` places `mark_dimple`, `mark_dot`, `mark_notch`
or `mark_stripe` by the flag the model passes. `polarity` says which pin a polarity
stripe or bar marks (`stripe_at`): pin 2 of a diode or an electrolytic, pin 1 of a
chip or molded capacitor.

### [`molded.stomp`](molded.stomp)

| feature | draws |
|---|---|
| `body_molded`, `body_dip` | a molded body, drafted above and below the parting line, with its top marks (`molded_block`); a PLCC LED's is white with a lens on top |
| `body_block` | a plain block, for a body with no lead form; a crystal's or oscillator's gets a lid |
| `body_radial` | a box body standing on its wires |
| `lead_gullwing`, `lead_jlead`, `lead_lbend`, `lead_straight` | the leads of a molded body |
| `lead_tab` | a plate on the board under the body, as a DPAK's drain tab |

### [`leadless.stomp`](leadless.stomp)

| feature | draws |
|---|---|
| `body_sawn` | a sawn block on its terminals; a crystal or oscillator is ceramic under a metal lid, an inductor ferrite |
| `package_lid(W, L, t, inset = …)` | the metal lid on a ceramic package, t thick, inset from its edges |
| `lead_flat`, `lead_endcap`, `lead_contact` | flat terminals, end caps, contacts with no side |
| `exposed_pad` | a plate under the body, for each thermal pad |

### [`chips.stomp`](chips.stomp)

| feature | draws |
|---|---|
| `body_chip` | a chip passive or LED: a ceramic block between metal caps (`chip_parts`) |
| `body_melf` | a MELF, lying on its caps (`melf_parts`) |
| `body_axial` | an axial body with rounded shoulders, lying on its wires (`axial_parts`), with a cathode band (`axial_band`) when it's polarized, and color bands when it's a resistor |
| `resistor_bands(len, D, first = brown, second = black, multiplier = red, tolerance = gold)` | an axial resistor's four bands, 1 kOhm at 5% unless you replace it |
| `color_band(D, bw, color = marking)` | one band bw wide around a cylinder lying along x |

### [`arrays.stomp`](arrays.stomp)

`body_bga` (a laminate substrate under a molded cap), `body_cga` (a ceramic body),
`lead_ball` and `lead_column`.

### [`cans.stomp`](cans.stomp)

| feature | draws |
|---|---|
| `body_can` | a can, sleeved or bare (in a metal color), with its seal and lid; an SMD can stands on a base |
| `can_vent(D)` | the cross scored in a sleeved can's lid |
| `can_stripe(D, h)` | the printed stripe down the sleeve |
| `lid_mark(D)` | a bare can's mark: a dark segment across its lid |
| `can_base(D, h, ma = 0)` | an SMD can's plastic base, its corners cut on the + side |

### [`leds.stomp`](leds.stomp)

| feature | draws |
|---|---|
| `body_led` | a radial LED: a lens with a domed top on a flange whose flat marks the cathode, red unless `body color:` says otherwise |
| `plcc_lens(W, L, color = led_lens)` | the round window on a PLCC LED's top |

### [`through_hole.stomp`](through_hole.stomp)

| feature | draws |
|---|---|
| `body_header` | a header's housing: one pitch tall, or as tall as the part (a socket) |
| `lead_header` | a header pin (`post`), or a socket's pin under the opening it sits in |
| `lead_dip`, `lead_axial`, `lead_tht` | a DIP's leads, an axial part's wires, plain pins and wires |

### [`packages.stomp`](packages.stomp)

Bodies to name with `body shape:`. Each gets the values the library's own body would
(`W`, `L`, `H`, `z0`, `body_color`, `ma`, …), and the leads are drawn as usual.

| feature | draws | for example |
|---|---|---|
| `to92(face = -90)` | a TO-92: round at the back, its flat face toward `face` degrees | `body 4.8 x 3.8 x 5.8`, `lead wire 0.45 x 0.4` |
| `to220(t = …)` | a TO-220, standing: the body, and the metal tab behind it with its hole | `body 10.2 x 4.5 x 15.6`, `lead wire 0.8 x 0.5` |
| `hc49(rim = …)` | an HC-49 crystal's metal can on its rim | `body 11.5 x 4.65 x 3.5`, `lead wire d: 0.43` |
| `tact_switch(cap = …)` | a tact switch: a base, its metal cover, and the actuator | `body 6 x 6 x 5`, `lead wire 0.7 x 0.3` |
| `buzzer` | a round buzzer with its sound hole, and a "+" when it's polarized | `body cylinder d: 12 h: 9.5`, `lead wire d: 0.6` |
| `slot_prism(W, L, h)` | a prism W x L with round ends, which `hc49` is built from | |
| `top_plus(s)` | a printed "+" on a top face | |

### [`modules.stomp`](modules.stomp)

`body_module` (a board, under a shield can when it's over 1.2 mm tall) and
`lead_castellated`.

### [`silk.stomp`](silk.stomp)

The automatic silk marks: `pin1_dot`, `pin1_bar`, `polarity_bar`, `polarity_hatch`
(a round part's) and `polarity_plus`. They get the style and family flags, so a
replacement can draw an LED's mark differently from a capacitor's.
