# stomp

An external DSL for describing PCB component footprints. One `.stomp` source file
yields a **2D land pattern** (copper, mask, paste, silk, courtyard, assembly) and,
when you want it, a **3D model** of the physical part.

> **Status: design draft.** The syntax and grammar are specified. A JavaScript prototype
> of the whole pipeline powers the [live demo](demo/); the reference implementation is
> still to come. Read [`SPEC.md`](SPEC.md) for the full language, and
> [`grammar.peg`](grammar.peg) for the formal grammar.

## Live demo

[`demo/`](demo/) is a browser editor for stomp: type on the left and the footprint
redraws on the right as you type. It draws copper, paste, mask, silk, courtyard and fab
layers, and shows the dimension of whichever placement your cursor is on. Open
`demo/index.html` in a browser; it needs no install, server or build. See
[`demo/README.md`](demo/README.md) for details, including the semantic choices the
prototype had to make where the draft is open.

## Why

Datasheet mechanical drawings dimension everything as a web of offsets — this edge
to that center, that center to some other edge — and transcribing a footprint means
manually resolving the whole network to a common origin. stomp's core feature is
**relational dimensioning**: state that one object is a given distance, in a given
direction, from another, measured center-to-center, edge-to-edge, or mixed, and
enter every number exactly as the drawing gives it:

```stomp
footprint "TO-252" {                    # DPAK
  pad 1 rect 1.1 x 1.6
  pad 3 rect 1.1 x 1.6
  pad 2 rect 5.5 x 6.2                  # the tab

  pad 3 is 4.56 right of pad 1          # center-to-center
  pad 2 is centered between pad 1 and pad 3 horizontally
  pad 2 inner is 1.9 above pad 1        # tab's NEAR edge to pin-row centers
}
```

`inner`/`outer` resolve automatically as the edge facing toward/away from the other
object, so span (outer-to-outer), gap (inner-to-inner), pitch (center-to-center),
and mixed dimensions all transcribe verbatim.

Common packages don't need any of that — a parametric layer covers pins per side,
pitch, lead form, spans, thermal pads, ball grids, and pin-1 markers, with
IPC-7351-style pad synthesis from part dimensions:

```stomp
footprint "SOIC-8" {
  body 3.9 x 4.9 x 1.5
  pins 8 dual pitch 1.27
  lead gullwing 0.41 x 1.04 span 6.0
  pin1 dot
}
```

Generated objects are ordinary named objects, so "standard package, except…" is a
generator plus a line or two of overrides — and templates (`template` / `from` /
`extends`) handle whole families and variants.

## Repository layout

| path | contents |
|---|---|
| [`SPEC.md`](SPEC.md) | the language specification (design, semantics, statement reference) |
| [`grammar.peg`](grammar.peg) | formal PEG grammar, sized for a PEGTL implementation |
| [`examples/`](examples/) | 14 example footprints, from a 3-line 0402 to a USB micro-B "offset torture test"; [`syntax_zoo.stomp`](examples/syntax_zoo.stomp) is a synthetic full-coverage parser fixture |
| [`demo/`](demo/) | the in-browser live editor and its JavaScript prototype engine, with tests |

## Name

A stomp leaves a footprint.
