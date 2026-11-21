# stomp

A small language for describing PCB footprints. One `.stomp` file gives you the
**2D land pattern** (copper, mask, paste, silk, courtyard, assembly) and, if you want
it, a **3D model** of the part.

> **Status: design draft.** The syntax and grammar are written down. A JavaScript
> prototype of the whole pipeline runs the [live demo](demo/); the real implementation
> doesn't exist yet. See [`SPEC.md`](SPEC.md) for the language and
> [`grammar.peg`](grammar.peg) for the formal grammar.

## Live demo

[`demo/`](demo/) is a stomp editor that runs in the browser. Type on the left and the
footprint redraws on the right. It draws the copper, paste, mask, silk, courtyard and fab
layers, and shows the dimension of the placement under your cursor. Switch to **3D** to
see the part's model on a board. **Export to KiCad** saves the file as a KiCad 9
footprint library, with each footprint's 3D model embedded.

Open `demo/index.html` in a browser. There's nothing to install, serve or build. The
libraries in the example picker each build a whole family of footprints from tables:
chip passives, SOT, SOP, QFP, QFN, DFN, BGA and CGA, diodes, tantalums, polymer caps,
power inductors, crystals, LEDs, DIPs and pin headers. See [`demo/README.md`](demo/README.md) for
details, including the choices the prototype made where the draft is open.

## Why

Datasheet drawings dimension everything as a web of offsets: this edge to that center,
that center to some other edge. Turning one into a footprint means working the whole web
back to one origin by hand. stomp's main feature is **relational dimensioning**. You say
that one object is some distance in some direction from another, measured center to
center, edge to edge or mixed, and you type every number as the drawing gives it:

```stomp
footprint "TO-252" {                    # DPAK
  pad 1 rect 1.1 x 1.6
  pad 3 rect 1.1 x 1.6
  pad 2 rect 5.5 x 6.2                  # the tab

  pad 3 is 4.56 right of pad 1          # center to center
  pad 2 is centered between pad 1 and pad 3 horizontally
  pad 2 inner is 1.9 above pad 1        # the tab's near edge to the pin centers
}
```

`inner` is the edge facing the other object and `outer` the edge facing away, so span
(outer to outer), gap (inner to inner), pitch (center to center) and mixed dimensions all
go in exactly as drawn.

Numbers are in mm unless the file, a footprint or the number itself says otherwise
(`units mil`, `50mil`). When a drawing gives a pad's height first, mark the sides:
`pad 2 rect 6.2h x 5.5w` is the same pad as `pad 2 rect 5.5 x 6.2`. Marks can be your
own: define a `feature` once, such as a "+", and use it as `pin1 plus`.

Common packages don't need any of that. Generators cover pins per side, pitch, lead
form, span, thermal pads, ball grids and pin-1 marks, and size the pads from the part's
dimensions the way IPC-7351 does:

```stomp
footprint "SOIC-8" {
  body 3.9 x 4.9 x 1.5
  pins 8 dual pitch 1.27
  lead gullwing 0.41 x 1.04 span 6.0
  pin1 dot
}
```

Generated pads are ordinary named objects, so "a standard package, except..." is a
generator plus a line or two of overrides. Templates (`template`, `from`, `extends`)
handle families and variants.

Templates work like functions. They build each footprint's name and description from
their parameters, and a table calls one once per row. A whole library is a template plus
the datasheet's table of variations:

```stomp
template qfn(n, D, D2, e = 0.5) {
  name "QFN-{n}-1EP_{D}x{D}mm_P{e}mm_EP{D2}x{D2}mm"
  body D x D x 0.9
  pins n quad pitch e
  lead flat e / 2 x 0.4
  thermal pad "{n + 1}" D2 x D2
}

footprints from qfn {           # one footprint per row
  n    D    D2
  16   3    1.7
  32   5    3.45
  48   7    5.6
}
```

The same lines also describe the part in 3D. The body, pin layout and lead form are
enough to build the model: gull-wing leads bend down from the parting line to the span,
leadless terminals sit flush under a sawn block, balls hang under a BGA substrate, and a
through-hole wire bends down through the board. A `model` block adjusts the rest, and
one pin can differ from the others:

```stomp
footprint "SOT-223" {
  body 6.5 x 3.5 x 1.8
  pins {
    bottom: 1, 2, 3 pitch 2.3
    top: 4
  }
  lead gullwing 0.7 x 0.9 span 7.0
  lead 4 gullwing 3.0 x 0.9          # the wide tab lead; its land follows
  model { leads thickness 0.3 }      # optional: standoff, height, draft, colors, extra solids
}
```

## Repository layout

| path | contents |
|---|---|
| [`SPEC.md`](SPEC.md) | the language spec: design, meaning, and every statement |
| [`grammar.peg`](grammar.peg) | the formal PEG grammar, written to map onto PEGTL |
| [`examples/`](examples/) | 17 single parts, from a 3-line 0402 to a USB micro-B with every feature measured from something else, and 15 libraries with over 200 footprints between them. [`syntax_zoo.stomp`](examples/syntax_zoo.stomp) isn't a real part; it covers the syntax the others don't use. |
| [`demo/`](demo/) | the browser editor and its JavaScript engine, with tests |

## Name

A stomp leaves a footprint.
