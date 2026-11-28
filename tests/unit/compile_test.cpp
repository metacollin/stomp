// The compiler and its geometry: a few results and messages here; tests/compare checks it
// against the JavaScript engine on every example and many random edits.
#include <stomp/stomp.hpp>

#include <cmath>

#include "check.hpp"
#include "compile/compile.hpp"
#include "geom.hpp"

using namespace stomp;
using namespace stomp::compiler;

namespace {
Compiled build(std::u16string_view src) {
  Options o;
  o.cache = false;
  return compile(src, o);
}
const Obj& result(const Compiled& c, std::size_t i) { return *c.footprints->a.at(i).obj()->get(K_result).obj(); }
const Arr& pads_of(const Compiled& c, std::size_t i) { return *result(c, i).get(K_pads).arr(); }
std::u16string message(const Compiled& c, std::size_t i) { return c.diagnostics->a.at(i).obj()->get(K_message).str(); }
}  // namespace

TEST(geometry_bounds_and_turns_are_exact) {
  geom::Shape sh;
  sh.kind = geom::Kind::Roundrect;
  sh.w = 2;
  sh.l = 1;
  sh.r = 0.25;
  const geom::Box bb = geom::contour_bbox(geom::shape_contour(sh, 0));
  CHECK_EQ(bb.x0, -1.0);
  CHECK_EQ(bb.x1, 1.0);
  CHECK_EQ(bb.y1, 0.5);
  const auto q = geom::cos_sin(90);
  CHECK_EQ(q[0], 0.0);
  CHECK_EQ(q[1], 1.0);
  CHECK(std::fabs(geom::poly_area({{0, 0}, {2, 0}, {2, 1}, {0, 1}}) - 2) < 1e-12);
}

TEST(a_chip_gets_ipc_lands_from_its_lead) {
  const Compiled c = build(u"footprint \"R0603\"\n  body 1.6 x 0.8\n  pins 2\n  lead endcap 0.3\nend\n");
  CHECK(c.diagnostics->a.empty());
  const Arr& pads = pads_of(c, 0);
  CHECK_EQ(pads.a.size(), std::size_t(2));
  const Obj& p1 = *pads.a[0].obj();
  CHECK(p1.get(K_name).str() == u"1");
  CHECK(p1.get(K_shape).obj()->get(K_kind).str() == u"roundrect");
  CHECK(p1.get(K_x).num() < 0);
  CHECK_EQ(p1.get(K_y).num(), 0.0);
}

TEST(values_take_units_and_names) {
  const Compiled c = build(u"units: mil\nw = 40\nfootprint \"A\"\n  pad 1 rect w x 2 * w\n  pad 1 at (0, 0)\nend\n");
  CHECK(c.diagnostics->a.empty());
  const Obj& sh = *pads_of(c, 0).a[0].obj()->get(K_shape).obj();
  CHECK(std::fabs(sh.get(K_w).num() - 1.016) < 1e-12);
  CHECK(std::fabs(sh.get(K_l).num() - 2.032) < 1e-12);
}

TEST(an_unplaced_pad_is_reported) {
  const Compiled c = build(u"footprint \"A\"\n  pad 1 rect 1 x 1\n  pad 2 rect 1 x 1\n  pad 1 at (0, 0)\nend\n");
  CHECK_EQ(c.diagnostics->a.size(), std::size_t(1));
  CHECK(message(c, 0).find(u"pad 2 has no x and y position") == 0);
}

TEST(an_unknown_name_has_a_hint) {
  const Compiled c = build(u"width = 1\nfootprint \"A\"\n  pad 1 rect widtth x 1\n  pad 1 at (0, 0)\nend\n");
  CHECK(!c.diagnostics->a.empty());
  CHECK(message(c, 0) == u"unknown name `widtth` — did you mean `width`?");
}

TEST(duplicate_names_are_renamed_and_reported) {
  const Compiled c = build(u"footprint \"A\"\n  pad 1 rect 1 x 1\n  pad 1 at (0, 0)\nend\nfootprint \"A\"\n  pad 1 rect 1 x 1\n  pad 1 at (0, 0)\nend\n");
  CHECK_EQ(c.footprints->a.size(), std::size_t(2));
  CHECK(c.footprints->a[1].obj()->get(K_name).str() == u"A #2");
  CHECK(message(c, 0).find(u"footprint name \"A\" is already used") == 0);
}

TEST(the_cache_reuses_an_unchanged_footprint) {
  clear_cache();
  const std::u16string src = u"footprint \"A\"\n  pad 1 rect 1 x 1\n  pad 1 at (0, 0)\nend\n";
  const Compiled a = compile(src), b = compile(src);
  CHECK(result(a, 0).get(K_name).str() == u"A");
  CHECK(a.results[0] == b.results[0]);   // the same result, not a rebuild
  clear_cache();
}
