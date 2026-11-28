// Field names of the compiler's records beyond the AST's (value.hpp STOMP_KEYS). Generated
// from the K_ names used in src/compile, src/dev, src/kicad, src/model3d and wasm by tools/gen-keys.py; run it after adding one.
#ifndef STOMP_COMPILE_KEYS_HPP
#define STOMP_COMPILE_KEYS_HPP

#include "../value.hpp"

#define STOMP_CKEYS(X) \
  X(C) X(M) X(a0) X(a1) X(above) X(assembly) X(auto) X(axial) X(bbox) X(below) X(bodyColor) X(bodyShape) \
  X(col) X(computedName) X(copper) X(coreBox) X(courtyard) X(courtyardBox) X(courtyardClearance) X(datasheet) \
  X(density) X(deps) X(description) X(diagnostics) X(draft) X(drillShape) X(embedded) X(empty) X(endCol) \
  X(endLine) X(explicit) X(extends) X(extraTexts) X(extras) X(family) X(files) X(floating) X(footprint) \
  X(footprints) X(generated) X(generator) X(grid) X(hdr) X(head) X(height) X(holes) X(hooks) X(how) X(inst) \
  X(ipc) X(ipcNote) X(k) X(keep) X(label) X(land) X(lead) X(leads) X(leadsColor) X(leadsShape) X(lib) \
  X(library) X(lift) X(mainForm) X(markSrc) X(mask) X(metal) X(missing) X(missingAt) X(model) X(node) \
  X(notes) X(o) X(obox) X(omitted) X(origin) X(originNote) X(originShift) X(outline) X(overlap) X(p) X(pad) \
  X(padAcross) X(padAlong) X(pads) X(parentName) X(paste) X(pbox) X(perPin) X(pin1) X(place) X(plain) \
  X(polarized) X(r0) X(r1) X(rPct) X(ra) X(rbox) X(refdes) X(related) X(result) X(rgb) X(rot) X(row) \
  X(rowIndex) X(silk) X(solids) X(spacing) X(spec) X(src) X(standoff) X(stmtE) X(stmtS) X(ta) X(table) \
  X(tableS) X(tables) X(tbox) X(templates) X(text) X(thermal) X(thickness) X(tmpl) X(toe) X(unplaced) \
  X(users) X(vias) X(x0) X(x1) X(y0) X(y1)

namespace stomp {
#define STOMP_CKEY_DECL(n) extern const Key K_##n;
STOMP_CKEYS(STOMP_CKEY_DECL)
#undef STOMP_CKEY_DECL
}  // namespace stomp

#endif  // STOMP_COMPILE_KEYS_HPP
