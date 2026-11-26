# Using stomp

stomp runs in your browser: open `demo/index.html` from the repository, with nothing to
install, or use a copy someone has published. Everything happens on your computer.
Each time you pause typing, stomp parses the file, expands its templates, generates the
pads, solves the placements and draws every layer and the 3D model.

## The screen

- **Left:** your stomp file. Problems are underlined and listed under the code; click one
  to jump to it.
- **Right:** the footprint the cursor is in, as a drawing or in 3D, with a title block
  and a panel of facts and pad sizes underneath.
- **Top:** the **File** menu, the file picker, **Tutorial**, **Docs**, **Export to
  KiCad**, a link to the project on GitHub, and the theme button.

Drag the bar between the two sides to change their widths. On a narrow screen they
stack, the drawing first.

stomp is dark unless you choose light: the sun button switches to the light theme and
the moon switches back. The browser remembers your choice.

## Writing

- The drawing follows the footprint your cursor is in. With more than five footprints
  in a file, the tabs above the drawing become a dropdown grouped by table.
- **Put the cursor on a statement** to highlight what it makes or moves. A placement
  draws its dimension: `pad 3 is 4.56 right of pad 1` shows the 4.56 between the two
  pad centers.
- **Hover over a pad** to see its size, position, mask and paste; the lines behind it
  light up in the editor. **Click** it to jump to the statement that defines it.
- A half-typed line doesn't blank the drawing: while a footprint has a syntax error,
  the last version that parsed stays on screen, dimmed.

| key | does |
|---|---|
| Tab, Shift+Tab | indent, unindent the selected lines |
| Ctrl+/ (⌘/ on a Mac) | comment or uncomment the selected lines |
| Enter | a new line, indented; after a block's header, one level in |
| Esc, then Tab | leave the editor (Tab alone indents) |
| Ctrl+S (⌘S) | save your file, or save a copy of an example (see below) |
| Ctrl+Shift+S (⌘⇧S) | save as |
| Ctrl+O (⌘O) | open files from disk |

## The drawing

Drag to pan, scroll or pinch to zoom, and double-click (or **Fit**) to fit the
footprint. **mm** and **mil** switch the units of every number shown; the file's own
units don't change. The bar under the drawing turns layers on and off:

| layer | shows |
|---|---|
| Copper | pads, with their drills and thermal vias |
| Paste | stencil openings, including windowpanes |
| Mask | solder-mask openings (off at first) |
| Drills | plated and unplated holes |
| Silk | the outline, kept clear of copper, and the pin-1 and polarity marks |
| Courtyard | the keep-out rectangle around the lands and body |
| Fab | the assembly outline and reference |
| Numbers | pad names |
| Constraints | every placement's dimension at once, not only the one under the cursor |
| Grid | the background grid |

**Library**, above the drawing, shows every footprint in the file as a thumbnail,
grouped by the table that made it. Click one to open it, or move the cursor through a
table's rows to step through their footprints.

## 3D

**3D** shows the part's model on a piece of board. Drag to orbit, shift-drag or
right-drag to pan, scroll to zoom, and double-click to reset. The bar under it has
views from above, the front, the side and below (the board turns see-through, to check
balls and terminals), and toggles for the board and the courtyard. The statement under
the cursor tints the parts it makes: with the cursor on `lead 1, 3 gullwing …`, those
two leads light up.

**VRML** saves the model for KiCad (`.wrl`, in KiCad's 0.1-inch units) and **STL** as a
binary STL in millimeters. Where the page runs inside another site that saves files for
it, **Save .zip** saves both in one archive.

## Your files

Examples are yours to change: your edits to each one are kept, and **Reset** puts the
original back. Files of your own are under **My files** at the top of the file picker,
and the **File** menu works on them:

- **New file** starts one, and **Save as** keeps a copy of whatever is open, an
  example, a library file or code from the docs, under a name you choose.
- Your files are **saved as you type**: the name above the code says "saved in this
  browser" once a change is stored. **Save** (Ctrl+S) stores it at once.
- **Rename** and **Delete** work on the file that's open.
- **Save to disk** writes the open file to your computer as a `.stomp` file. Where the
  browser can (Chrome and Edge), it asks where to put it; elsewhere it downloads.
  **Save all my files to disk** puts every file of yours in one `.zip`.
- **Open from disk** reads `.stomp` files, or a `.zip` of them, into your files. You can
  also drop files anywhere on the page. A file named like one you have is kept under
  a new name, unless the two are the same.

### How long the browser keeps them

Your files are kept twice in this browser: in IndexedDB, the storage browsers keep
longest, and in a second copy in local storage, in case one of them fails. When you
first save a file, stomp asks the browser to keep this site's storage for good. Most
browsers decide without asking you, by how often you use the site; Firefox asks. The
File menu says what the browser answered.

Browser storage still ends when you clear the site's data, and Safari clears a site's
storage once you've browsed for seven days without visiting it. So keep anything that matters on disk
too: **Save all my files to disk** gives you every file in one go, and **Open from
disk** reads the `.zip` back.

Your files belong to the browser and the address you opened stomp at: the same page
opened from another address, or in a private window, has its own files. Two tabs share
them, and a change in one shows in the other.

Where the page is published inside another site that saves files for it, saving to
disk asks you first, and a single file arrives zipped (`NAME.zip`, with `NAME.stomp`
inside), since that host saves only some kinds of file.

## The standard library

The library's files, which draw every model and silk mark, are at the bottom of the
file picker. Edit one and every model that uses it follows; the drawing shows an
example that uses the file while it's open. Your edits apply to the other files too,
until you press **Reset**. To change a model for one file only, write a feature with the
library feature's name in that file instead. The [standard library page](../stdlib/README.md)
lists what's in it.

## Export to KiCad

**Export to KiCad** saves every footprint in the file as a KiCad 9 library: a zipped
`.pretty` folder with one `.kicad_mod` per footprint. Each footprint carries its own 3D
model, embedded, so there's no separate model folder to keep with it. Footprints with
errors are skipped, and the message says how many. Where the page can't save files, the
button copies the footprint on screen instead, to paste into a `.kicad_mod` file.

## The docs

**Tutorial** and **Docs** open these pages in place of the editor; **Back to the
editor**, or the same button again, returns to it. Every page and heading has its own
link: copy it from the `#` beside a heading.

**Try it** on an example turns it into an editor right on the page, with its footprint
drawn beside it, in 2D or 3D, as the editor proper draws it: every placement's
dimension shows, the cursor on a line highlights what it places, and problems are
listed underneath. Your changes are kept for next time; **Reset** puts the example
back. **Open in the editor** moves it to the editor, where **Back to the tutorial**
above the code returns you to where you were. The figures in the docs are drawn the
same way, by stomp, from the footprints they show.

## Choices this version makes

Where the [specification](../SPEC.md) leaves a meaning open, stomp picks one:

- **Generated pads are sized across × along.** For `pins …`, `W x L` is the width
  across the row by the length along the lead, and each side's pads turn to face
  outward. That's how `default pad rect 0.6 x 2.2` reads on a SOIC.
- **The origin rule places floating layouts.** A footprint placed only by relations
  (like the DPAK in the tutorial) has no fixed starting point, so it's solved from its
  first object, then centered on the body.
- **One coordinate frame.** `at (x, y)` and graphics use the same coordinates, and
  `origin` then moves the finished footprint's (0, 0).
- **IPC-style lands** use the IPC-7351B fillet goals with nominal part dimensions (no
  part tolerances), F = 0.05 mm and P = 0.025 mm, with corners rounded at 25%. Ball
  lands are 80% of the ball. The mask opens 0.05 mm per side by default.
- **Courtyards are rectangles:** the smallest around the lands and body, plus the IPC
  clearance for the density.
- **The body's height is the seated height** (JEDEC A), from the board to the top of the
  part. The body sits on its standoff (A1), which depends on the lead form: 0.1 mm for
  gull-wings, 0.02 mm for leadless parts, three quarters of the ball for a BGA.
- **Interpolated numbers print in their shortest form.** Lengths print in the file's
  units, and `{e:.2}` sets two decimals.
- **Small grammar extensions:** `omit` and `only` take name ranges (`only 1..5`), and
  sizes can be written without spaces (`0.6x1.5`).

## Not supported yet

`step:` files aren't loaded: a footprint that names one shows the generated model
instead, and its KiCad export points to the file rather than embedding a model.
Castellated leads get a temporary land until the spec settles them, though the model
draws their plating. Export is for KiCad 9 and later.
