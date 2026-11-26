<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/stomp-logo-dark.svg">
    <img alt="stomp" src="docs/logo/stomp-logo.svg" width="250">
  </picture>
</h1>

A small language for describing PCB footprints. One `.stomp` file gives you the
**2D land pattern** (copper, mask, paste, silk, courtyard, assembly) and, if you want
it, a **3D model** of the part.

> **Status: early.** The language is written down in [`SPEC.md`](SPEC.md), with the
> formal grammar in [`grammar.peg`](grammar.peg). stomp itself runs in the browser:
> the editor in [`demo/`](demo/) parses, checks, draws and exports every part of it.

## The editor

[`demo/`](demo/) is stomp: an editor that runs in the browser. Type on the left and the
footprint redraws on the right. It draws the copper, paste, mask, silk, courtyard and fab
layers, and shows the dimension of the placement under your cursor. Switch to **3D** to
see the part's model on a board. **Export to KiCad** saves the file as a KiCad 9
footprint library, with each footprint's 3D model embedded.

Open `demo/index.html` in a browser. There's nothing to install, serve or build. Your
files are saved in the browser as you type, and the **File** menu saves them to disk and
opens them again. The libraries in the file picker each build a whole family of
footprints from tables: chip passives, SOT, SOP, QFP, QFN, DFN, BGA and CGA, diodes,
tantalums, polymer caps, power inductors, crystals, LEDs, DIPs and pin headers. See
[`demo/README.md`](demo/README.md) for how it's built and tested.

## Documentation

The same pages open in the editor, under **Tutorial** and **Docs**:

- [Tutorial](docs/tutorial.md): from a two-pad resistor to a library with 3D models, in
  twelve steps you can try as you read.
- [Language reference](docs/reference.md): every statement, with an example.
- [Using stomp](docs/using.md): the editor, your files, 3D and KiCad export.
- [Standard library](stdlib/README.md): the shapes, symbols, packages and colors stomp's
  models are built from.
- [Specification](SPEC.md): the language in full, with the reasons for its choices.

## Why

Datasheet drawings dimension everything as a web of offsets: this edge to that center,
that center to some other edge. Turning one into a footprint means working the whole web
back to one origin by hand. stomp's main feature is **relational dimensioning**. You say
that one object is some distance in some direction from another, measured center to
center, edge to edge or mixed, and you type every number as the drawing gives it:

```stomp
footprint "TO-252"                      # DPAK
  pad 1 rect 1.1 x 1.6
  pad 3 rect 1.1 x 1.6
  pad 2 rect 5.5 x 6.2                  # the tab

  pad 3 is 4.56 right of pad 1          # center to center
  pad 2 is centered between pad 1 and pad 3 horizontally
  pad 2 inner is 1.9 above pad 1        # the tab's near edge to the pin centers
end
```

`inner` is the edge facing the other object and `outer` the edge facing away, so span
(outer to outer), gap (inner to inner), pitch (center to center) and mixed dimensions all
go in exactly as drawn.

A block is a header line, its statements and `end`. A value with a name takes a colon
(`pitch: 1.27`), and `e = 0.65` gives a name a value. Numbers are in mm unless the file,
a footprint or the number itself says otherwise (`units: mil`, `50mil`). When a drawing
gives a pad's height first, mark the sides: `pad 2 rect 6.2h x 5.5w` is the same pad as
`pad 2 rect 5.5 x 6.2`. Marks can be your own: define a `feature` once, such as a "+",
and use it as `pin1: plus`.

Common packages don't need any of that. Generators cover pins per side, pitch, lead
form, span, thermal pads, ball grids and pin-1 marks, and size the pads from the part's
dimensions the way IPC-7351 does:

```stomp
footprint "SOIC-8"
  body 3.9 x 4.9 x 1.5
  pins 8 dual pitch: 1.27
  lead gullwing 0.41 x 1.04 span: 6.0
  pin1: dot
end
```

Generated pads are ordinary named objects, so "a standard package, except..." is a
generator plus a line or two of overrides. Templates (`template`, `from`, `extends`)
handle families and variants.

Templates work like functions. They build each footprint's name and description from
their parameters, and a table calls one once per row. A whole library is a template plus
the datasheet's table of variations:

```stomp
template qfn(n, D, D2, e = 0.5)
  name: "QFN-{n}-1EP_{D}x{D}mm_P{e}mm_EP{D2}x{D2}mm"
  body D x D x 0.9
  pins n quad pitch: e
  lead flat e / 2 x 0.4
  thermal pad "{n + 1}" D2 x D2
end

footprints from qfn             # one footprint per row
  n    D    D2
  16   3    1.7
  32   5    3.45
  48   7    5.6
end
```

The same lines also describe the part in 3D. The body, pin layout and lead form are
enough to build the model: gull-wing leads bend down from the parting line to the span,
leadless terminals sit flush under a sawn block, balls hang under a BGA substrate, and a
through-hole wire bends down through the board. A `model` block adjusts the rest, and
one pin can differ from the others:

```stomp
footprint "SOT-223"
  body 6.5 x 3.5 x 1.8
  pins
    bottom: 1, 2, 3 pitch: 2.3
    top: 4
  end
  lead gullwing 0.7 x 0.9 span: 7.0
  lead 4 gullwing 3.0 x 0.9          # the wide tab lead; its land follows
  model                              # optional: standoff, height, draft, colors, extra solids
    leads thickness: 0.3
  end
end
```

## Models in stomp

stomp draws its own 3D models. Every body, lead and mark the tool generates comes from a
standard library of stomp features in [`stdlib/`](stdlib/), so the vent in a can's lid
is a few lines you can read:

```stomp
feature can_vent(D)
  vl = D / 2 * 0.9
  vw = max(0.06, D / 2 * 0.04)
  box vl x vw x 0.006 color: vent_metal name: "vent"
  box vw x vl x 0.006 color: vent_metal name: "vent"
end
```

Define a feature with the same name in your file and every can in it gets yours. A
feature chooses between versions of itself with **sections**, turned on by flags in the
call, with no `if` needed: the library's can is `bare` or `sleeved`, `vented` or not,
and the model passes the flags that fit the part.

The refdes tells the library what the part is, so details come without asking: a `Y`
crystal gets a metal lid, a `D` on wires is an LED with a domed lens, an axial `R` gets
color bands, and a header as tall as its pins is a socket. For parts that need more,
the library has packages to name (`body shape: to220`), and shapes and silk symbols to
build your own from:

```stomp
feature encoder(W, L, H, z0 = 0)
  feature rounded_box(W, L, 6.5, r: 0.8, color: epoxy) at (0, 0, z0)
  feature hex_prism(9, 1.8, color: nickel, name: "nut") at (0, 0, z0 + 6.5)
  cylinder d: 6 h: H - z0 - 8.3 at (0, 0, z0 + 8.3) color: aluminum name: "shaft"
end
```

`body shape: encoder` in a footprint's `model` block then draws that footprint's body
with it. [`stdlib/README.md`](stdlib/README.md) lists everything in the library; see also
SPEC §12.1 and §13.5, [`examples/tht_parts.stomp`](examples/tht_parts.stomp) and
[`examples/custom_models.stomp`](examples/custom_models.stomp).
