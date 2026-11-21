/* Generated from examples/*.stomp by demo/tools/build.mjs. Don't edit. */
(function (root) {
  (root.Stomp = root.Stomp || {}).examples = [
  {
    "file": "to252.stomp",
    "title": "TO-252 / DPAK",
    "blurb": "dimensions entered the way the drawing gives them",
    "source": "# TO-252 / DPAK: dimensions entered the way the drawing gives them.\n#\n# DPAK drawings measure each feature from something different: the pins center\n# to center, the tab from the pin row by its near edge, the body from the pin\n# row again. Enter each number as drawn and let stomp work out the positions.\n\nfootprint \"TO-252\" {\n  description \"DPAK, 2 leads + tab\"\n  refdes \"Q\"\n\n  pad 1 rect 1.1 x 1.6\n  pad 3 rect 1.1 x 1.6\n  pad 2 rect 5.5 x 6.2                       # the tab (drain)\n\n  pad 3 is 4.56 right of pad 1               # center to center across the pin row\n  pad 2 is centered between pad 1 and pad 3 horizontally\n  pad 2 inner is 1.9 above pad 1             # tab's near edge, 1.9 above the pin centers\n\n  # Or, symmetric about the centerline:\n  #   pad 3 mirrors pad 1 across y\n  #   pitch pad 1 to pad 3 is 4.56\n\n  body 6.6 x 6.1 x 2.3\n  body bottom is 1.1 above pad 1             # body edge, also measured from the pin row\n  body is centered on pad 2 horizontally     # otherwise SPEC 9.2 lines it up with pad 1\n  pin1 none\n\n  # 3D: leads on the explicit pads. The pads keep their sizes.\n  lead 1, 3 gullwing 0.75 x 1.0              # b x L of the two outer leads\n  lead 2 tab                                 # the drain tab under the body\n  model { leads thickness 0.5 }\n}\n"
  },
  {
    "file": "usb_microb.stomp",
    "title": "USB micro-B receptacle (generic)",
    "blurb": "every feature measured from a different reference",
    "source": "# USB micro-B receptacle (generic): every feature measured from a different reference.\n#\n# Signal pads, shield legs, locating pegs (NPTH) and slots are each measured\n# from something else: the pegs from pin 1, the shield slots from the pegs, the\n# front tabs by their span about the centerline. Every number is entered as\n# drawn. (Illustrative dimensions, not a specific vendor's.)\n\nunits mm\n\nfootprint \"USB-MICRO-B\" {\n  description \"USB micro-B receptacle, SMD signals + through-hole shield\"\n  refdes \"J\"\n  tags usb, connector\n\n  let e  = 0.65        # signal pitch (\"e\" on the drawing)\n  let C1 = 2.89        # peg to pin 1 center, x (\"C1\")\n  let C2 = 0.55        # peg below the pin row, y (\"C2\")\n\n  # Signal pads\n  default pad rect 0.4 x 1.35\n  row sig pads 1..5 pitch e going right\n  pad 3 at (0, 0)                          # the D+ pin is on the origin\n\n  # Locating pegs (NPTH)\n  hole PEG1 0.85\n  hole PEG1 is C1 left of pad 1 and C2 below pad 1\n  hole PEG2 mirrors hole PEG1 across y     # symmetric about the centerline\n\n  # Shield legs: plated slots, measured from the pegs\n  pad \"SH1\" tht oval 1.2 x 1.9 drill slot 0.6 x 1.3\n  pad \"SH1\" is 1.05 left of hole PEG1 and 0.25 above hole PEG1\n  pad \"SH2\" mirrors pad \"SH1\" across y\n\n  # Front shell tabs: L-shaped SMD pads, placed by span and symmetry\n  pad \"SH3\" polygon (0, 0) (1.05, 0) (1.05, 1.45) (0.6, 1.45) (0.6, 2.2) (0, 2.2)\n  pad \"SH4\" mirrors pad \"SH3\" across y     # SH3 is on the -x side\n  span pad \"SH3\" to pad \"SH4\" is 8.0       # outer edge to outer edge\n  pad \"SH3\" is 0.9 above pad \"SH1\"\n\n  pads \"SH1\", \"SH2\", \"SH3\", \"SH4\" { mask +0.1 }\n\n  # Body, measured from the shield pads\n  group shield = pad \"SH1\", pad \"SH2\", pad \"SH3\", pad \"SH4\"\n  body 7.6 x 5.0 x 2.45\n  body is centered on group shield horizontally\n  body top is 0.5 above hole PEG1\n\n  # Graphics and 3D\n  silk {\n    line (-4.1, -2.6) (-4.1, -1.2) width 0.12    # marks the mating-face corners\n    line (4.1, -2.6) (4.1, -1.2) width 0.12\n  }\n  courtyard auto 0.5\n\n  model {\n    step \"models/usb_microb.step\" offset (0, 0, 0) rotate (0, 0, -90) scale 1.0\n  }\n}\n"
  },
  {
    "file": "qfn_library.stomp",
    "title": "QFN library",
    "blurb": "one template, two tables, a footprint for every row",
    "source": "# QFN library: one template, two tables, a footprint for every row.\n#\n# A template works like a function: it takes parameters and returns a\n# footprint. This one also builds each footprint's name and description from\n# its parameters, so a table row only holds the numbers that change. Columns\n# use the JEDEC MO-220 letters:\n#\n#   n         pin count             e         pitch\n#   D x E     body                  D2 x E2   exposed (thermal) pad\n#   b x L     terminal width x length (b defaults to half the pitch)\n\ntemplate qfn(n, D, D2, e = 0.5, E = D, E2 = D2, b = e / 2, L = 0.4, A = 0.9) {\n  name \"QFN-{n}-1EP_{D}x{E}mm_P{e}mm_EP{D2}x{E2}mm\"\n  description \"QFN, {n} pins, {D} x {E} mm body, {e:.2} mm pitch, {D2} x {E2} mm exposed pad\"\n  refdes \"U\"\n  tags qfn, leadless\n\n  body D x E x A\n  pins n quad pitch e\n  lead flat b x L                     # IPC lands; the span is the body edge\n  pin1 chamfer\n  thermal pad \"{n + 1}\" D2 x E2 {     # numbered after the last pin\n    paste divide 2 x 2 coverage 65%\n  }\n}\n\n# 0.5 mm pitch for every row, so only n, D and D2 change.\nfootprints from qfn(e = 0.5) {\n  n    D    D2\n  12   3    1.65\n  16   3    1.7\n  20   4    2.6\n  24   4    2.7\n  28   5    3.35\n  32   5    3.45\n  36   6    4.1\n  40   6    4.6\n  44   7    5.15\n  48   7    5.6\n  56   8    6.0\n  64   9    7.15\n}\n\n# Other pitches: any parameter can be a column.\nfootprints from qfn {\n  n    D    e      D2\n  16   4    0.65   2.1\n  24   5    0.65   3.25\n  48   6    0.4    4.6\n  68   8    0.4    6.4\n}\n\n# A single call. The template names it too. This one has a rectangular pad.\nfootprint from qfn(24, 4, 2.45, E2 = 2.65)\n\n# Generated footprints are normal footprints: extend one by name.\nfootprint \"QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm_HandSolder\" extends \"QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm\" {\n  description \"QFN-32, 5 x 5 mm, longer terminals for hand soldering\"\n  default pad roundrect 0.25 x 1.0 r 25%\n  courtyard auto 0.5\n}\n"
  },
  {
    "file": "soic8.stomp",
    "title": "SOIC-8",
    "blurb": "standard two-row gull-wing package in four lines",
    "source": "# SOIC-8: standard two-row gull-wing package in four lines.\n\nfootprint \"SOIC-8\" {\n  description \"8-lead SOIC, 3.9 mm body, 1.27 mm pitch\"\n  refdes \"U\"\n\n  body 3.9 x 4.9 x 1.5\n  pins 8 dual pitch 1.27               # left and right rows, counterclockwise, pin 1 top left\n  lead gullwing 0.41 x 1.04 span 6.0   # lead width x foot length; span is tip to tip\n  pin1 dot\n}\n"
  },
  {
    "file": "qfn32.stomp",
    "title": "QFN-32",
    "blurb": "quad leadless package with an exposed pad, paste windows and thermal vias",
    "source": "# QFN-32: quad leadless package with an exposed pad, paste windows and thermal vias.\n\nfootprint \"QFN-32\" {\n  description \"32-lead 5x5 mm QFN, 0.5 mm pitch, exposed pad\"\n  datasheet \"https://example.com/qfn32.pdf\"\n  refdes \"U\"\n  tags qfn, leadless\n\n  body 5 x 5 x 0.9\n  pins 32 quad pitch 0.5       # four sides, counterclockwise from top left\n  lead flat 0.25 x 0.4         # the span defaults to the body edge\n  pin1 chamfer\n\n  thermal pad 33 3.7 x 3.7 {   # exposed pad, pin 33, centered on the body\n    paste divide 2 x 2 coverage 68%\n    vias 3 x 3 drill 0.3 pitch 1.1\n  }\n}\n"
  },
  {
    "file": "sot23-5.stomp",
    "title": "SOT-23-5",
    "blurb": "irregular pins, placed with a sides block",
    "source": "# SOT-23-5: irregular pins, placed with a sides block.\n\nfootprint \"SOT-23-5\" {\n  description \"SOT-23-5 (JEDEC MO-178): 3 pins one side, 2 opposite at the outer positions\"\n  refdes \"U\"\n\n  body 1.6 x 2.9 x 1.1\n  pins {\n    left: 1, 2, 3 pitch 0.95   # the left side runs top to bottom,\n    right: 4, nc, 5            # the right side bottom to top. `nc` leaves the\n  }                            # middle empty, so pins 4 and 5 are 1.9 apart\n  lead gullwing 0.4 x 0.6 span 2.8\n  pin1 dot\n}\n"
  },
  {
    "file": "sot223.stomp",
    "title": "SOT-223",
    "blurb": "three gull-wing leads and a wide tab. A per-pin lead line sizes pin 4's land and 3D lead",
    "source": "# SOT-223: three gull-wing leads and a wide tab. A per-pin lead line sizes pin 4's land and 3D lead.\n\nfootprint \"SOT-223\" {\n  description \"SOT-223 (JEDEC TO-261AA): 3 leads + tab lead, 2.3 mm pitch\"\n  refdes \"U\"\n  tags regulator, sot\n\n  body 6.5 x 3.5 x 1.8              # D x E1 x A\n  pins {\n    bottom: 1, 2, 3 pitch 2.3       # pin 1 bottom left\n    top: 4                          # the tab, opposite pin 2\n  }\n  lead gullwing 0.7 x 0.9 span 7.0  # b x L, span E (tip to tip)\n  lead 4 gullwing 3.0 x 0.9         # b2: the tab is 3 mm wide\n  pin1 dot\n}\n"
  },
  {
    "file": "tssop20.stomp",
    "title": "TSSOP-20",
    "blurb": "dimensions entered by their JEDEC MO-153 letters, plus a hand-solder variant",
    "source": "# TSSOP-20: dimensions entered by their JEDEC MO-153 letters, plus a hand-solder variant.\n\nlet e  = 0.65        # pitch\nlet D  = 6.5         # body length\nlet E1 = 4.4         # body width\nlet E  = 6.4         # lead span, tip to tip\nlet b  = 0.25        # lead width\nlet L  = 0.6         # foot length\n\nfootprint \"TSSOP-20\" {\n  refdes \"U\"\n\n  body E1 x D x 1.2\n  pins 20 dual pitch e\n  lead gullwing b x L span E\n  pin1 dot\n}\n\nfootprint \"TSSOP-20-HS\" extends \"TSSOP-20\" {\n  description \"hand-solder variant: longer pads, roomier courtyard\"\n  default pad rect 0.4 x 1.8\n  courtyard auto 0.5\n}\n"
  },
  {
    "file": "soic_family.stomp",
    "title": "SOIC family",
    "blurb": "several packages from one template",
    "source": "# SOIC family: several packages from one template.\n# Parameters are plain names (keywords like `span` or `pitch` can't be used),\n# and act like `let`s inside each footprint.\n\ntemplate soic(n, lspan = 6.0, e = 1.27, bw = 3.9) {\n  body bw x (n/2 - 1) * e + 2.0 x 1.5\n  pins n dual pitch e\n  lead gullwing 0.41 x 1.04 span lspan\n  pin1 dot\n}\n\nfootprint \"SOIC-8\"  from soic(8)\nfootprint \"SOIC-14\" from soic(14)\nfootprint \"SOIC-16\" from soic(16)\n\nfootprint \"SOIC-16W\" from soic(16, lspan = 10.3, bw = 7.5) {\n  description \"wide-body 300 mil variant\"\n}\n\n# Inheritance works with templates too:\nfootprint \"SOIC-8-HS\" extends \"SOIC-8\" {\n  description \"hand-solder variant\"\n  default pad rect 0.6 x 2.2\n  courtyard auto 0.5\n}\n"
  },
  {
    "file": "bga64.stomp",
    "title": "BGA-64",
    "blurb": "ball grid with JEDEC row letters and two empty corners",
    "source": "# BGA-64: ball grid with JEDEC row letters and two empty corners.\n\nfootprint \"BGA-64\" {\n  description \"64-ball BGA, 0.8 mm pitch, rows A..H\"\n  refdes \"U\"\n\n  body 8 x 8 x 1.2\n  balls 8 x 8 pitch 0.8        # a grid with ball leads and BGA numbering\n  lead ball 0.4                # ball diameter. The land would default to 80% of it,\n  default pad circle 0.35      # but we set it here (NSMD)\n  omit A1, H8                  # no balls at these corners\n  pin1 dot                     # silk dot at the A1 corner\n\n  # A region works too: omit rows D..E cols 4..5\n}\n\n# A variant without ball D4\nfootprint \"BGA-64-DEPOP\" extends \"BGA-64\" {\n  description \"BGA-64 with D4 unballed\"\n  delete ball D4               # `ball` is another name for a grid pad\n}\n"
  },
  {
    "file": "dip8.stomp",
    "title": "DIP-8",
    "blurb": "through-hole, two rows, mixed units, square pin 1",
    "source": "# DIP-8: through-hole, two rows, mixed units, square pin 1.\n\nfootprint \"DIP-8\" {\n  description \"8-lead PDIP, 0.3 in row spacing\"\n  refdes \"U\"\n\n  body 6.35 x 9.2 x 3.3\n  pins 8 dual pitch 100mil span 300mil centers   # rows 300 mil apart, center to center\n  lead pin 0.46 x 0.25                           # rectangular leg\n  default pad tht oval 1.6 x 2.0 drill 0.8\n  pad 1 tht rect 1.6 x 2.0 drill 0.8             # square pad marks pin 1\n  pin1 notch\n}\n"
  },
  {
    "file": "hdr2x5.stomp",
    "title": "2x5 pin header",
    "blurb": "through-hole grid with box-header numbering",
    "source": "# 2x5 pin header: through-hole grid with box-header numbering.\n\nfootprint \"HDR-2x5-2.54\" {\n  description \"2x5 pin header, 2.54 mm grid\"\n  refdes \"J\"\n\n  body 12.7 x 5.08 x 8.5\n  pins grid 5 x 2 pitch 2.54 numbering zigzag start top-left\n                               # zigzag: 1 above 2, then the next column,\n                               # as on box (IDC) headers\n  lead pin 0.64 x 0.64\n  default pad tht circle 1.7 drill 1.02\n  pad 1 tht rect 1.7 x 1.7 drill 1.02\n  pin1 dot\n\n  origin at pad 1              # headers are usually placed by pin 1\n}\n"
  },
  {
    "file": "r0402.stomp",
    "title": "Chip resistor, 0402 (1005 metric)",
    "blurb": "the same part described two ways",
    "source": "# Chip resistor, 0402 (1005 metric): the same part described two ways.\n\nunits mm\n\n# Land mode: enter the recommended land pattern.\nfootprint \"R0402\" {\n  description \"RES 0402, land pattern entered directly\"\n  refdes \"R\"\n\n  pins 2 horizontal            # pin 1 left\n  default pad rect 0.5 x 0.6\n  gap 0.5                      # inner edge to inner edge, as drawn\n  body 1.0 x 0.5 x 0.35        # optional; adds silk, courtyard and a 3D box\n}\n\n# Part mode: describe the part and let the pads be derived (IPC-7351 style).\nfootprint \"R0402-IPC\" {\n  description \"RES 0402, pads derived from part dimensions\"\n  refdes \"R\"\n\n  body 1.0 x 0.5 x 0.35\n  pins 2 horizontal\n  lead endcap 0.25             # end cap length; the width defaults to the body width\n  density nominal\n}\n"
  },
  {
    "file": "led0603.stomp",
    "title": "LED, 0603",
    "blurb": "polarized two-terminal part with extra silkscreen",
    "source": "# LED, 0603: polarized two-terminal part with extra silkscreen.\n\nfootprint \"LED0603\" {\n  description \"LED 0603; pin 1 = anode, pin 2 = cathode\"\n  refdes \"D\"\n\n  body 1.6 x 0.8 x 0.7\n  pins 2 horizontal\n  lead endcap 0.3\n  density nominal\n  polarized                    # cathode bar on silk, stripe on the 3D body\n\n  # A silk block adds to the automatic silk (SPEC 12)\n  silk {\n    text \">K\" at (1.9, 0) size 0.5      # cathode label right of the part\n  }\n}\n"
  },
  {
    "file": "cp_radial.stomp",
    "title": "Radial aluminum electrolytic",
    "blurb": "cylindrical can, polarized, through-hole",
    "source": "# Radial aluminum electrolytic: cylindrical can, polarized, through-hole.\n\nfootprint \"CP-RADIAL-8x11.5-P3.5\" {\n  description \"Radial electrolytic, 8 mm can, 3.5 mm lead spacing\"\n  refdes \"C\"\n\n  body cylinder d 8 h 11.5\n  pins 2 horizontal pitch 3.5\n  lead wire d 0.6\n  default pad tht circle 1.6 drill 0.9\n  pad 2 tht rect 1.6 x 1.6 drill 0.9   # square pad for the negative lead\n  polarized                            # pin 1 is positive; the stripe goes on pin 2's side\n  pin1 none                            # the stripe is the polarity mark\n\n  model {\n    body color \"#26476f\"               # dark blue sleeve\n    leads color tin\n  }\n}\n"
  },
  {
    "file": "do41.stomp",
    "title": "DO-41",
    "blurb": "axial diode. The body lies along its leads, which bend down through the board",
    "source": "# DO-41: axial diode. The body lies along its leads, which bend down through the board.\n\nfootprint \"D_DO-41_P10.16mm_Horizontal\" {\n  description \"DO-41 (SOD-81) axial diode, 10.16 mm lead spacing\"\n  refdes \"D\"\n\n  body cylinder d 2.7 h 5.2         # the pins are outside the circle, so it lies down\n  pins 2 horizontal pitch 10.16\n  lead wire d 0.86\n  polarized                         # pin 1 is the anode; the band marks the cathode (pin 2)\n}\n"
  },
  {
    "file": "crystal3225.stomp",
    "title": "Crystal, 3225",
    "blurb": "ceramic package with a metal lid, added in the model block",
    "source": "# Crystal, 3225: ceramic package with a metal lid, added in the model block.\n\nfootprint \"Crystal_SMD_3225-4Pin_3.2x2.5mm\" {\n  description \"SMD crystal, 3.2 x 2.5 mm ceramic package, 4 contacts\"\n  refdes \"Y\"\n\n  body 3.2 x 2.5 x 0.8              # 0.8 mm tall including the lid\n  pins {\n    bottom: 1, 2 pitch 2.2          # pin 1 bottom left, then counterclockwise\n    top: 3, 4\n  }\n  lead flat 1.4 x 1.1               # contacts at the package edge\n  pin1 none\n\n  model {\n    height 0.7                      # the ceramic base; the lid adds 0.1\n    body color ceramic\n    box 2.9 x 2.2 x 0.1 on body color tin    # the lid\n  }\n}\n"
  },
  {
    "file": "syntax_zoo.stomp",
    "title": "Syntax zoo",
    "blurb": "not a real part. Covers the syntax the other examples don't use",
    "source": "# Syntax zoo: not a real part. Covers the syntax the other examples don't use.\n# Every line is valid, and no position is set twice.\n\nunits mil            # default unit for this file; suffixes still work\n\nlet big = 200\n\n# 1. Pad shapes, mask and paste options, every kind of placement\nfootprint \"ZOO-SHAPES\" {\n  description \"grammar coverage fixture; do not manufacture\"\n  manufacturer \"n/a\"\n  mpn \"n/a\"\n\n  pad 1 roundrect 40 x 60 r 25%\n  pad 2 dshape 40 x 60 flat left rotate -90\n  pad 3 oval 40 x 60 mask defined\n  pad 4 rect 40 x 60 paste divide 2 x 2 gutter 8\n  pad 5 circle 30 mask none paste none\n  pad 6 rect 40 x 60 rotate 0.7854rad\n  pad 7 rect 40 x 60\n  pad 8 rect 40 x 60\n  pad 9 rect 40 x 60\n  hole Z1 slot 30 x 55\n\n  pad 1 at (0, 0)\n  pad 2 is 100 right of pad 1                       # sets x; y lines up with pad 1 by default\n  pad 3 is big below pad 2 and 50mil left of pad 2  # two relations with \"and\"; a unit suffix\n  pad 4 is 120 right of pad 3\n  align pad 4 with pad 1 horizontally               # replaces the default y\n  pad 5 is centered between pad 1 and pad 3\n  pad 7 mirrors pad 6 across x                      # pad 6 is on the +y side\n  gap pad 6 to pad 7 is 70                          # facing edges; the mirror sets the axis\n  align pad 6 with pad 5 vertically\n  pad 9 mirrors pad 8 across y                      # pad 8 is on the -x side\n  pitch pad 8 to pad 9 is 300\n  align pad 8 with pad 1 horizontally\n  hole Z1 is 80 above pad 1\n}\n\n# 2. Generator options, overrides, graphics, model settings\nfootprint \"ZOO-DUAL\" {\n  body 200 x 300 x 60\n  pins 10 dual pitch 50 span 260 inner numbering cw pad roundrect 30 x 45 r 8\n  lead jlead 20 x 35\n  density most\n  pin1 bar\n  thermal pad 90 x 140                 # unnamed, so it's called \"EP\"\n\n  pad 3 { size 34 x 52 }               # change some generated pads\n  pad 4 { width 40 }\n  pads 6..8 { mask +2 }\n  delete pad 10\n\n  pad \"TP1\" circle 30                  # a manual pad next to generated ones\n  pad \"TP1\" is 60 left of side left outer\n\n  text ref at (0, 190) size 40\n  text value at (0, -190) size 40 layer assembly\n  silk {\n    outline body offset 6\n    arc (0, 0) r 80 from 30 to 150 width 4\n    circle (0, 120) d 12 fill\n    rect (0, -120) 60 x 20 width 4\n    polygon (90, 90) (110, 90) (100, 110) fill\n  }\n  courtyard rect 320 x 380\n  lead 1 jlead 24 x 35                 # per-pin lead; 3D only, since the pins line sets the lands\n  lead 9 none                          # pin 9 has no lead\n  model {\n    standoff 2\n    height 55\n    draft 6deg\n    body color black\n    leads color \"#c8ccd0\"\n    leads thickness 8\n    pin1 dimple\n    box 120 x 160 x 4 on body color tin                      # extra solids\n    cylinder d 30 h 20 at (0, 0, 80) rotate (90, 0, 0) color gray\n  }\n}\n\n# 3. One row of pins, castellations, `only`\nfootprint \"ZOO-CASTELLATED\" {\n  description \"edge module: castellations along one side\"\n  body 400 x 300 x 40\n  pins 6 single bottom pitch 50\n  lead castellated d 24\n  density least\n  only 1..5                            # keep 1 to 5, drop position 6\n  pin1 dot\n}\n\n# 4. Grid with a different pitch per axis, layers turned off\nfootprint \"ZOO-GRID\" {\n  origin at (0, -25)\n  pins grid 3 x 2 pitch 50 x 80 numbering row-major start bottom-left\n  lead pin d 18\n  default pad tht circle 44 drill 24\n  pad 1 { drill 28 }                   # drill override in a block\n  pads 2..3 { mask -2 }\n  omit 5\n  silk none\n  assembly none\n  courtyard { polygon (-90, -70) (90, -70) (90, 70) (-90, 70) }\n  no model\n}\n\n# 5. Through-hole model settings\nfootprint \"ZOO-SOCKET\" {\n  body 400 x 100 x 340\n  pins grid 4 x 1 pitch 100\n  lead pin 25 x 25\n  model {\n    leads above 0                      # a socket: pins stay inside the housing\n    leads below 120\n    pin1 notch\n  }\n}\n"
  }
];
})(typeof self !== 'undefined' ? self : this);
