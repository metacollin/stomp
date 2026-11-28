// Writing the build's typed values as records, in the shapes the JavaScript engine gave them.
#include "builder.hpp"

namespace stomp::compiler {

Val pt_val(Pt p) { return list({p.x, p.y}); }

Val poly_val(const Poly& pts) {
  ArrP a = list();
  a->a.reserve(pts.size());
  for (const Pt& p : pts) a->a.push_back(pt_val(p));
  return a;
}

Val contour_val(const Contour& c) {
  ArrP a = list();
  a->a.reserve(c.size());
  for (const auto& e : c) {
    if (e.arc)
      a->a.push_back(rec({{K_t, u"A"}, {K_c, pt_val(e.c)}, {K_r, e.r}, {K_a0, e.a0}, {K_a1, e.a1}, {K_a, pt_val(e.a)}, {K_b, pt_val(e.b)}}));
    else
      a->a.push_back(rec({{K_t, u"L"}, {K_a, pt_val(e.a)}, {K_b, pt_val(e.b)}}));
  }
  return a;
}

Val box_val(const geom::Box& b) { return rec({{K_x0, b.x0}, {K_y0, b.y0}, {K_x1, b.x1}, {K_y1, b.y1}}); }

Val shape_val(const geom::Shape& s) {
  ObjP o = rec({{K_kind, geom::kind_name(s.kind)}});
  switch (s.kind) {
    case geom::Kind::Rect:
    case geom::Kind::Oval:
      o->set(K_w, s.w);
      o->set(K_l, s.l);
      break;
    case geom::Kind::Roundrect:
      o->set(K_w, s.w);
      o->set(K_l, s.l);
      if (s.r_pct) o->set(K_rPct, *s.r_pct);
      o->set(K_r, s.r);
      break;
    case geom::Kind::Dshape:
      o->set(K_w, s.w);
      o->set(K_l, s.l);
      o->set(K_flat, s.flat);
      break;
    case geom::Kind::Circle: o->set(K_d, s.d); break;
    case geom::Kind::Polygon: o->set(K_pts, poly_val(s.pts)); break;
  }
  return o;
}

Val nodes_val(const std::vector<ObjP>& v) {
  ArrP a = list();
  for (const auto& n : v) a->a.push_back(n ? Val(n) : Val());
  return a;
}

Val spec_val(const Spec& s) {
  Val drill = nullptr;
  if (s.drill) drill = s.drill->d ? Val(rec({{K_d, *s.drill->d}})) : Val(rec({{K_slot, rec({{K_w, s.drill->slotW}, {K_l, s.drill->slotL}})}}));
  Val mask = nullptr;
  if (s.mask) mask = s.mask->mode == u"expand" ? Val(rec({{K_mode, s.mask->mode}, {K_v, s.mask->v}})) : Val(rec({{K_mode, s.mask->mode}}));
  Val paste = nullptr;
  if (s.paste) {
    const Paste& p = *s.paste;
    if (p.mode == u"expand") paste = rec({{K_mode, p.mode}, {K_v, p.v}});
    else if (p.mode == u"divide")
      paste = rec({{K_mode, p.mode},
                   {K_nx, p.nx},
                   {K_ny, p.ny},
                   {K_coverage, p.coverage ? Val(*p.coverage) : Val(nullptr)},
                   {K_gutter, p.gutter ? Val(*p.gutter) : Val(nullptr)}});
    else paste = rec({{K_mode, p.mode}});
  }
  Val vias = nullptr;
  if (s.vias) vias = rec({{K_nx, s.vias->nx}, {K_ny, s.vias->ny}, {K_drill, s.vias->drill}, {K_pitch, s.vias->pitch}});
  ObjP o = rec({{K_shape, shape_val(s.shape)}, {K_tht, s.tht}, {K_drill, drill}, {K_rot, s.rot}, {K_mask, mask}, {K_paste, paste}, {K_vias, vias}});
  if (s.ipc) o->set(K_ipc, *s.ipc);
  if (s.castellated) o->set(K_castellated, *s.castellated);
  if (s.missing) o->set(K_missing, *s.missing);
  if (s.src) o->set(K_src, nodes_val(*s.src));
  return o;
}

Val gfx_val(const Gfx& g) {
  ObjP o = rec({{K_type, g.type}});
  if (g.pts) o->set(K_pts, poly_val(*g.pts));
  if (g.c) {
    o->set(K_c, pt_val(*g.c));
    o->set(K_r, g.r);
  }
  if (g.fill) o->set(K_fill, true);
  if (g.w) o->set(K_w, *g.w);
  if (g.at) o->set(K_at, pt_val(*g.at));
  if (g.size) o->set(K_size, *g.size);
  if (g.str) o->set(K_str, *g.str);
  if (!g.src.undef()) o->set(K_src, g.src);
  if (!g.field.undef()) o->set(K_field, g.field);
  if (g.clear) o->set(K_clear, true);
  if (g.auto_) o->set(K_auto, true);
  if (g.layer) o->set(K_layer, *g.layer);
  return o;
}

Val gfxs_val(const Gfxs& g) {
  ArrP a = list();
  a->a.reserve(g.size());
  for (const auto& it : g) a->a.push_back(gfx_val(it));
  return a;
}

Val frame_val(const geom::Frame& M) {
  ArrP a = list();
  for (double v : M) a->a.push_back(v);
  return a;
}

Val color_val(const Color& c) {
  return rec({{K_rgb, list({c.rgb[0], c.rgb[1], c.rgb[2]})}, {K_metal, c.metal}, {K_name, c.name ? Val(*c.name) : Val(nullptr)}});
}

Val ev_val(const EV& v) {
  static const char16_t* names[] = {u"num", u"ratio", u"len", u"str", u"color"};
  ObjP o = rec({{K_k, names[static_cast<int>(v.k)]}});
  if (v.k == VK::Str) o->set(K_v, v.s);
  else if (v.k == VK::Color) o->set(K_v, color_val(*v.c));
  else o->set(K_v, v.v);
  return o;
}

}  // namespace stomp::compiler
