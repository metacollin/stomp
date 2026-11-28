// demo/js/kicad.js, function for function: S-expressions in KiCad's layout, graphics,
// pads, holes, fields and the embedded model.
#include "kicad.hpp"

#include <stomp/stomp.hpp>

#include <cmath>
#include <functional>

#include "compile/keys.hpp"
#include "encode.hpp"
#include "geom.hpp"
#include "jsrt.hpp"

namespace stomp::kicad {

namespace {

using U = std::u16string;
using V = std::u16string_view;
using namespace stomp::encode;

// S-expressions. A node is a list: a head and children. A child is a list, a number, a bare
// symbol or a quoted string. KiCad's layout: atoms stay on the head's line, and each child
// list goes on its own line, one tab deeper.
struct SX {
  enum Kind { Num, Sym, Quo, List, Data } kind = List;
  double num = 0;
  U text;
  std::vector<SX> kids;
};
SX N(double v) { return {SX::Num, v, {}, {}}; }
SX S(U s) { return {SX::Sym, 0, std::move(s), {}}; }
SX Q(U s) { return {SX::Quo, 0, std::move(s), {}}; }
SX L(U head, std::vector<SX> kids = {}) { return {SX::List, 0, std::move(head), std::move(kids)}; }
SX D(U data) { return {SX::Data, 0, std::move(data), {}}; }

U num_text(double v) {
  const double r = js::round(v * 1e6) / 1e6;
  return r == 0 ? U(u"0") : js::to_u16string(r);
}
U quote(const U& s) {
  U out = u"\"";
  for (char16_t c : s) {
    if (c == u'\\') out += u"\\\\";
    else if (c == u'"') out += u"\\\"";
    else if (c == u'\n') out += u"\\n";
    else out += c;
  }
  return out + u"\"";
}
U atom(const SX& a) { return a.kind == SX::Num ? num_text(a.num) : a.kind == SX::Sym ? a.text : quote(a.text); }
bool is_list(const SX& c) { return c.kind == SX::List || c.kind == SX::Data; }

U print(const SX& node, int depth) {
  const U pad(static_cast<std::size_t>(depth), u'\t');
  if (node.kind == SX::Data) {
    // (data |...|): 76-character lines; the first starts after "|", the last ends with "|"
    const U& d = node.text;
    std::vector<U> lines;
    for (std::size_t i = 0; i < d.size(); i += 76) lines.push_back(d.substr(i, 76));
    if (lines.empty()) lines.push_back(U());
    lines.front() = u"|" + lines.front();
    lines.back() += u"|";
    U s = pad + u"(data " + lines[0];
    for (std::size_t i = 1; i < lines.size(); ++i) s += u"\n" + pad + u"\t" + lines[i];
    return s + u"\n" + pad + u")";
  }
  U s = pad + u"(" + node.text;
  std::vector<const SX*> lists;
  for (const SX& c : node.kids) {
    if (is_list(c)) lists.push_back(&c);
    else s += u" " + atom(c);
  }
  if (lists.empty()) return s + u")";
  if (node.text == u"pts") {
    // points, several to a line
    std::vector<U> xy;
    for (const SX* c : lists) {
      U t = u"(" + c->text;
      for (const SX& k : c->kids) t += u" " + atom(k);
      xy.push_back(t + u")");
    }
    U rows;
    for (std::size_t i = 0; i < xy.size(); i += 6) {
      if (i) rows += u"\n";
      rows += pad + u"\t";
      for (std::size_t j = i; j < xy.size() && j < i + 6; ++j) rows += (j > i ? U(u" ") : U()) + xy[j];
    }
    return s + u"\n" + rows + u"\n" + pad + u")";
  }
  for (const SX* c : lists) s += u"\n" + print(*c, depth + 1);
  return s + u"\n" + pad + u")";
}

// Reading the result's records
const Val& F(const Val& o, Key k) {
  static const Val undef;
  return o.is_obj() ? o.obj()->get(k) : undef;
}
double n_of(const Val& v) { return v.is_num() ? v.num() : NAN; }
const std::vector<Val>& items(const Val& v) {
  static const std::vector<Val> none;
  return v.is_arr() ? v.arr()->a : none;
}
geom::Pt pt(const Val& v) { return {n_of(items(v).size() > 0 ? items(v)[0] : Val()), n_of(items(v).size() > 1 ? items(v)[1] : Val())}; }
U str_of(const Val& v) {
  if (v.is_str()) return v.str();
  if (v.is_num()) return js::to_u16string(v.num());
  if (v.null()) return u"null";
  if (v.undef()) return u"undefined";
  if (v.is_bool()) return v.boolean() ? u"true" : u"false";
  return u"[object Object]";
}
geom::Shape shape_of(const Val& sh) {
  geom::Shape s;
  if (auto k = geom::kind_of(F(sh, K_kind).is_str() ? F(sh, K_kind).str() : U())) s.kind = *k;
  s.w = n_of(F(sh, K_w));
  s.l = n_of(F(sh, K_l));
  s.r = n_of(F(sh, K_r));
  if (F(sh, K_rPct).is_num()) s.r_pct = F(sh, K_rPct).num();
  s.d = n_of(F(sh, K_d));
  s.flat = F(sh, K_flat).is_str() ? F(sh, K_flat).str() : U();
  for (const Val& p : items(F(sh, K_pts))) s.pts.push_back(pt(p));
  return s;
}
geom::Contour contour_of(const Val& c) {
  geom::Contour out;
  for (const Val& e : items(c)) {
    geom::Edge ed;
    ed.arc = F(e, K_t).is_str() && F(e, K_t).str() == u"A";
    ed.a = pt(F(e, K_a));
    ed.b = pt(F(e, K_b));
    if (ed.arc) {
      ed.c = pt(F(e, K_c));
      ed.r = n_of(F(e, K_r));
      ed.a0 = n_of(F(e, K_a0));
      ed.a1 = n_of(F(e, K_a1));
    }
    out.push_back(ed);
  }
  return out;
}

bool near(double a, double b) { return std::fabs(a - b) < 1e-9; }
double or_default(const Val& v, double d) { return v.is_num() && js::truthy(v.num()) ? v.num() : d; }

const char16_t* layer_name(const U& l) {
  if (l == u"silk") return u"F.SilkS";
  if (l == u"assembly") return u"F.Fab";
  if (l == u"courtyard") return u"F.CrtYd";
  if (l == u"copper") return u"F.Cu";
  if (l == u"mask") return u"F.Mask";
  return nullptr;
}

std::string utf8(const U& s) { return to_utf8(s); }
std::span<const std::uint8_t> bytes_of(const std::string& s) { return {reinterpret_cast<const std::uint8_t*>(s.data()), s.size()}; }

/** Deterministic UUIDs, so exporting twice gives the same files. (Plain MurmurHash3: KiCad's
 *  variant ignores some tails, and `name#k` would land on one.) */
struct Uuids {
  U seed;
  int k = 0;
  SX operator()() {
    const std::string in = utf8(seed + u"#" + js::to_u16string(k++));
    const auto h16 = murmur3x64(bytes_of(in), 0x5704);
    static const char16_t* hex = u"0123456789abcdef";
    U h;
    for (std::uint8_t b : h16) {
      h += hex[b >> 4];
      h += hex[b & 15];
    }
    const int d16 = h[16] <= u'9' ? h[16] - u'0' : h[16] - u'a' + 10;
    const U v = h.substr(0, 12) + u"4" + h.substr(13, 3) + U(1, hex[(d16 & 3) | 8]) + h.substr(17, 15);
    return Q(v.substr(0, 8) + u"-" + v.substr(8, 4) + u"-" + v.substr(12, 4) + u"-" + v.substr(16, 4) + u"-" + v.substr(20, 12));
  }
};

SX stroke(double w) { return L(u"stroke", {L(u"width", {N(w)}), L(u"type", {S(u"solid")})}); }
SX font(double size) {
  return L(u"effects", {L(u"font", {L(u"size", {N(size), N(size)}), L(u"thickness", {N(js::max(0.05, js::round(size * 0.15 * 1000) / 1000))})})});
}

struct Text {
  Val it;
  U layer;
};

/** Graphic items of one stomp layer as fp_* nodes. */
void graphics(const Val& list, const U& layer, Uuids& uid, std::vector<SX>& out, std::vector<Text>& texts) {
  for (const Val& it : items(list)) {
    const Val& type = F(it, K_type);
    const auto& ptsv = items(F(it, K_pts));
    const auto is_type = [&](V t) { return type.is_str() && type.str() == t; };
    if (is_type(u"line") && F(it, K_pts).truthy() && ptsv.size() >= 2) {
      std::vector<geom::Pt> pts;
      for (const Val& p : ptsv) pts.push_back(pt(p));
      const bool closed = pts.size() >= 4 && near(pts.front().x, pts.back().x) && near(pts.front().y, pts.back().y);
      bool rect = closed && pts.size() == 5;
      for (int i = 0; rect && i < 4; i++) rect = near(pts[i].x, pts[i + 1].x) != near(pts[i].y, pts[i + 1].y);
      const double w = or_default(F(it, K_w), 0.1);
      if (rect) {
        // an axis-aligned rectangle: KiCad's fp_rect keeps its four corners
        double x0 = pts[0].x, x1 = pts[0].x, y0 = pts[0].y, y1 = pts[0].y;
        for (const auto& q : pts) {
          x0 = js::min(x0, q.x);
          x1 = js::max(x1, q.x);
          y0 = js::min(y0, q.y);
          y1 = js::max(y1, q.y);
        }
        out.push_back(L(u"fp_rect", {L(u"start", {N(x0), N(-y1)}), L(u"end", {N(x1), N(-y0)}), stroke(w), L(u"fill", {S(u"no")}),
                                     L(u"layer", {Q(layer)}), L(u"uuid", {uid()})}));
      } else if (closed) {
        SX ps = L(u"pts");
        for (std::size_t i = 0; i + 1 < pts.size(); ++i) ps.kids.push_back(L(u"xy", {N(pts[i].x), N(-pts[i].y)}));
        out.push_back(L(u"fp_poly", {ps, stroke(w), L(u"fill", {S(u"no")}), L(u"layer", {Q(layer)}), L(u"uuid", {uid()})}));
      } else {
        for (std::size_t i = 0; i + 1 < pts.size(); ++i) {
          if (near(pts[i].x, pts[i + 1].x) && near(pts[i].y, pts[i + 1].y)) continue;
          out.push_back(L(u"fp_line", {L(u"start", {N(pts[i].x), N(-pts[i].y)}), L(u"end", {N(pts[i + 1].x), N(-pts[i + 1].y)}), stroke(w),
                                       L(u"layer", {Q(layer)}), L(u"uuid", {uid()})}));
        }
      }
    } else if (is_type(u"circle")) {
      const geom::Pt c = pt(F(it, K_c));
      const double r = n_of(F(it, K_r));
      const bool fill = F(it, K_fill).truthy();
      out.push_back(L(u"fp_circle", {L(u"center", {N(c.x), N(-c.y)}), L(u"end", {N(c.x + r), N(-c.y)}),
                                     stroke(fill ? 0 : or_default(F(it, K_w), 0.1)), L(u"fill", {S(fill ? u"yes" : u"no")}),
                                     L(u"layer", {Q(layer)}), L(u"uuid", {uid()})}));
    } else if (is_type(u"poly") && F(it, K_pts).truthy() && ptsv.size() >= 3) {
      SX ps = L(u"pts");
      for (const Val& p : ptsv) {
        const geom::Pt q = pt(p);
        ps.kids.push_back(L(u"xy", {N(q.x), N(-q.y)}));
      }
      out.push_back(L(u"fp_poly", {ps, stroke(0), L(u"fill", {S(u"yes")}), L(u"layer", {Q(layer)}), L(u"uuid", {uid()})}));
    } else if (is_type(u"text")) {
      texts.push_back({it, layer});
    }
  }
}

/** The pad's KiCad shape: kind, size, corner ratio, and for a custom pad its outline (pad-local, KiCad axes). */
struct PadShape {
  U kind;
  double w = 0, h = 0, rratio = 0;
  std::vector<geom::Pt> poly;
};
PadShape pad_shape(const Val& shv) {
  const U kind = F(shv, K_kind).is_str() ? F(shv, K_kind).str() : U();
  const double w = n_of(F(shv, K_w)), l = n_of(F(shv, K_l));
  if (kind == u"rect") return {u"rect", w, l, 0, {}};
  if (kind == u"roundrect") {
    const double m = js::min(w, l);
    const double r = js::min(or_default(F(shv, K_r), 0), m / 2);
    if (r > 1e-9) return {u"roundrect", w, l, js::min(0.5, r / m), {}};
    return {u"rect", w, l, 0, {}};
  }
  if (kind == u"circle") {
    const double d = n_of(F(shv, K_d));
    return {u"circle", d, d, 0, {}};
  }
  if (kind == u"oval") return near(w, l) ? PadShape{u"circle", w, w, 0, {}} : PadShape{u"oval", w, l, 0, {}};
  const geom::Shape sh = shape_of(shv);
  PadShape out;
  out.kind = u"custom";
  for (const geom::Pt& p : geom::dedupe(geom::contour_to_poly(geom::shape_contour(sh, 0), geom::deg(10)), true)) out.poly.push_back({p.x, -p.y});
  const geom::Box bb = geom::contour_bbox(geom::shape_contour(sh, 0));
  out.w = bb.x1 - bb.x0;
  out.h = bb.y1 - bb.y0;
  return out;
}

double jsmod(double a, double b) { return std::fmod(a, b); }

/** One stomp pad as KiCad pads: the pad, plus paste-only windows and via pads. */
void pads(const Val& p, bool balls, double maskOverlap, Uuids& uid, std::vector<SX>& out) {
  const Val& s = F(p, K_spec);
  const PadShape shape = pad_shape(F(p, K_shape));
  double rot = jsmod(jsmod(n_of(F(p, K_rot)), 360) + 360, 360);
  double w = shape.w, h = shape.h;
  Val drillv = F(s, K_drill).truthy() ? F(s, K_drill) : F(p, K_drill).truthy() ? F(p, K_drill) : Val(nullptr);
  const bool slot = drillv.truthy() && F(drillv, K_slot).truthy();
  double sw = slot ? n_of(F(F(drillv, K_slot), K_w)) : 0, sl = slot ? n_of(F(F(drillv, K_slot), K_l)) : 0;
  // a symmetric pad turned by a quarter is the same pad with its sides swapped
  const bool quarter = std::fabs(rot / 90 - js::round(rot / 90)) < 1e-9;
  if (shape.kind != u"custom" && quarter) {
    if (jsmod(js::round(rot / 90), 2) == 1) {
      std::swap(w, h);
      if (slot) std::swap(sw, sl);
    }
    rot = 0;
  }
  const U maskMode = F(s, K_mask).truthy() ? F(F(s, K_mask), K_mode).str() : U(u"default");
  if (maskMode == u"defined") {
    w += 2 * maskOverlap;
    h += 2 * maskOverlap;
  }
  const bool tht = F(p, K_tht).truthy();
  const U pasteMode = F(s, K_paste).truthy() ? F(F(s, K_paste), K_mode).str() : U(tht ? u"none" : u"default");
  SX at = L(u"at", {N(n_of(F(p, K_x))), N(-n_of(F(p, K_y)))});
  if (js::truthy(rot)) at.kids.push_back(N(rot));
  const U name = str_of(F(p, K_name));
  SX node = L(u"pad", {Q(name), S(tht ? u"thru_hole" : u"smd"), S(shape.kind), at, L(u"size", {N(w), N(h)})});
  if (tht && drillv.truthy()) node.kids.push_back(slot ? L(u"drill", {S(u"oval"), N(sw), N(sl)}) : L(u"drill", {N(n_of(F(drillv, K_d)))}));
  const bool thermal = F(p, K_thermal).truthy();
  if (!F(s, K_castellated).nullish()) node.kids.push_back(L(u"property", {S(u"pad_prop_castellated")}));
  else if (balls && !thermal) node.kids.push_back(L(u"property", {S(u"pad_prop_bga")}));
  else if (thermal) node.kids.push_back(L(u"property", {S(u"pad_prop_heatsink")}));
  SX layers = L(u"layers", {Q(tht ? u"*.Cu" : u"F.Cu")});
  if (maskMode != u"none") layers.kids.push_back(Q(tht ? u"*.Mask" : u"F.Mask"));
  if (!tht && (pasteMode == u"default" || pasteMode == u"expand")) layers.kids.push_back(Q(u"F.Paste"));
  node.kids.push_back(layers);
  if (tht) node.kids.push_back(L(u"remove_unused_layers", {S(u"no")}));
  if (shape.kind == u"roundrect") node.kids.push_back(L(u"roundrect_rratio", {N(js::round(shape.rratio * 1e4) / 1e4)}));
  if (maskMode == u"expand") node.kids.push_back(L(u"solder_mask_margin", {N(n_of(F(F(s, K_mask), K_v)))}));
  if (maskMode == u"defined") node.kids.push_back(L(u"solder_mask_margin", {N(-maskOverlap)}));
  if (pasteMode == u"expand") node.kids.push_back(L(u"solder_paste_margin", {N(n_of(F(F(s, K_paste), K_v)))}));
  if (shape.kind == u"custom") {
    const bool inside = geom::point_in_poly({0, 0}, shape.poly);
    const double k = inside ? js::min(js::min(0.1, w / 4), h / 4) : 0.01;
    node.kids[4] = L(u"size", {N(k), N(k)});
    node.kids.push_back(L(u"options", {L(u"clearance", {S(u"outline")}), L(u"anchor", {S(u"rect")})}));
    SX ps = L(u"pts");
    for (const auto& q : shape.poly) ps.kids.push_back(L(u"xy", {N(q.x), N(q.y)}));
    node.kids.push_back(L(u"primitives", {L(u"gr_poly", {ps, L(u"width", {N(0)}), L(u"fill", {S(u"yes")})})}));
  }
  node.kids.push_back(L(u"uuid", {uid()}));
  out.push_back(std::move(node));
  // divided paste: one paste-only pad per window
  if (pasteMode == u"divide") {
    for (const Val& win : items(F(p, K_paste))) {
      const auto c = geom::contour_to_poly(contour_of(win), geom::deg(30));
      if (c.size() < 4) continue;
      const double cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4, cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
      double ww = js::hypot({c[1].x - c[0].x, c[1].y - c[0].y}), wh = js::hypot({c[2].x - c[1].x, c[2].y - c[1].y});
      double a = jsmod((js::atan2(c[1].y - c[0].y, c[1].x - c[0].x) * 180) / geom::PI + 360, 360);
      if (std::fabs(a / 90 - js::round(a / 90)) < 1e-6) {
        if (jsmod(js::round(a / 90), 2) == 1) std::swap(ww, wh);
        a = 0;
      }
      SX wat = L(u"at", {N(cx), N(-cy)});
      if (js::truthy(a)) wat.kids.push_back(N(js::round(a * 1e4) / 1e4));
      out.push_back(L(u"pad", {Q(U()), S(u"smd"), S(u"rect"), wat, L(u"size", {N(ww), N(wh)}), L(u"layers", {Q(u"F.Paste")}), L(u"uuid", {uid()})}));
    }
  }
  // thermal vias: plated holes with the pad's number, tented
  for (const Val& v : items(F(p, K_vias))) {
    const double d = n_of(F(v, K_d));
    out.push_back(L(u"pad", {Q(name), S(u"thru_hole"), S(u"circle"), L(u"at", {N(n_of(F(v, K_x))), N(-n_of(F(v, K_y)))}), L(u"size", {N(d + 0.2), N(d + 0.2)}),
                             L(u"drill", {N(d)}), L(u"layers", {Q(u"*.Cu")}), L(u"remove_unused_layers", {S(u"no")}), L(u"uuid", {uid()})}));
  }
}

}  // namespace

U safe_name(const U& n) {
  U out;
  for (char16_t c : n) {
    const bool bad = c == u'\\' || c == u'/' || c == u':' || c == u'*' || c == u'?' || c == u'"' || c == u'<' || c == u'>' || c == u'|' || c < 0x20;
    out += bad ? u'_' : c;
  }
  out = js::trim(out);
  return out.empty() ? U(u"footprint") : out;
}

Footprint footprint(const ObjP& resp, const U& nameIn, const std::string* vrml) {
  const Val res = resp;
  const U name = safe_name(!nameIn.empty() ? nameIn : F(res, K_name).truthy() ? str_of(F(res, K_name)) : U(u"footprint"));
  Uuids uid{name};
  const Val& meta = F(res, K_meta);
  Footprint result;
  SX fp = L(u"footprint", {Q(name), L(u"version", {N(VERSION)}), L(u"generator", {Q(u"stomp")}), L(u"generator_version", {Q(u"0.1")}),
                           L(u"layer", {Q(u"F.Cu")})});
  if (F(meta, K_description).truthy()) fp.kids.push_back(L(u"descr", {Q(str_of(F(meta, K_description)))}));
  const Val& tagsv = F(meta, K_tags);
  U tags;
  if (tagsv.is_arr()) {
    for (std::size_t i = 0; i < tagsv.arr()->a.size(); ++i) {
      const Val& t = tagsv.arr()->a[i];
      tags += (i ? U(u" ") : U()) + (t.nullish() ? U() : str_of(t));
    }
  } else if (tagsv.truthy()) tags = str_of(tagsv);
  if (!tags.empty()) fp.kids.push_back(L(u"tags", {Q(tags)}));
  // graphics first, so ref/value text placements are known
  std::vector<SX> gfx;
  std::vector<Text> texts;
  graphics(F(res, K_silk), u"F.SilkS", uid, gfx, texts);
  graphics(F(res, K_assembly), u"F.Fab", uid, gfx, texts);
  graphics(F(res, K_courtyard), u"F.CrtYd", uid, gfx, texts);
  for (const Val& t : items(F(res, K_extraTexts))) {
    const char16_t* l = F(t, K_layer).is_str() ? layer_name(F(t, K_layer).str()) : nullptr;
    texts.push_back({t, l ? U(l) : U(u"F.SilkS")});
  }
  // Reference above the part, Value below it, unless the source placed them
  const Val box = F(res, K_courtyardBox).truthy() ? F(res, K_courtyardBox)
                  : F(res, K_bbox).truthy()       ? F(res, K_bbox)
                  : F(res, K_coreBox).truthy()    ? F(res, K_coreBox)
                                                  : Val(rec({{K_x0, -1}, {K_y0, -1}, {K_x1, 1}, {K_y1, 1}}));
  struct Field {
    geom::Pt at;
    U layer;
    double size;
  };
  Field ref{{0, n_of(F(box, K_y1)) + 1.0}, u"F.SilkS", 1};
  Field val{{0, n_of(F(box, K_y0)) - 1.0}, u"F.Fab", 1};
  std::vector<Text> userTexts;
  for (const auto& [it, layer] : texts) {
    const Val& field = F(it, K_field);
    if (field.is_str() && field.str() == u"ref") ref = {pt(F(it, K_at)), layer, n_of(F(it, K_size))};
    else if (field.is_str() && field.str() == u"value") val = {pt(F(it, K_at)), layer, n_of(F(it, K_size))};
    else userTexts.push_back({it, layer});
  }
  const auto field = [&](V key, const U& value, const Field& f, bool hidden) {
    SX n = L(u"property", {Q(U(key)), Q(value), L(u"at", {N(f.at.x), N(-f.at.y), N(0)})});
    if (hidden) n.kids.push_back(L(u"unlocked", {S(u"yes")}));
    n.kids.push_back(L(u"layer", {Q(f.layer)}));
    if (hidden) n.kids.push_back(L(u"hide", {S(u"yes")}));
    n.kids.push_back(L(u"uuid", {uid()}));
    n.kids.push_back(font(f.size));
    return n;
  };
  fp.kids.push_back(field(u"Reference", u"REF**", ref, false));
  fp.kids.push_back(field(u"Value", name, val, false));
  fp.kids.push_back(field(u"Datasheet", F(meta, K_datasheet).truthy() ? str_of(F(meta, K_datasheet)) : U(), {{0, 0}, u"F.Fab", 1.27}, true));
  fp.kids.push_back(field(u"Description", F(meta, K_description).truthy() ? str_of(F(meta, K_description)) : U(), {{0, 0}, u"F.Fab", 1.27}, true));
  bool tht = false;
  for (const Val& p : items(F(res, K_pads))) tht = tht || F(p, K_tht).truthy();
  if (tht) fp.kids.push_back(L(u"attr", {S(u"through_hole")}));
  else if (!items(F(res, K_pads)).empty()) fp.kids.push_back(L(u"attr", {S(u"smd")}));
  for (auto& g : gfx) fp.kids.push_back(std::move(g));
  for (const auto& [it, layer] : userTexts) {
    // the fab reference label is KiCad's ${REFERENCE}
    const U str = F(it, K_auto).truthy() && layer == u"F.Fab" ? U(u"${REFERENCE}") : str_of(F(it, K_str));
    const geom::Pt at = pt(F(it, K_at));
    fp.kids.push_back(L(u"fp_text", {S(u"user"), Q(str), L(u"at", {N(at.x), N(-at.y), N(0)}), L(u"layer", {Q(layer)}), L(u"uuid", {uid()}),
                                     font(or_default(F(it, K_size), 1))}));
  }
  // pads, holes
  const Val& lead = F(res, K_lead);
  const bool gridLead = lead.truthy() && (F(lead, K_form).is_str() && (F(lead, K_form).str() == u"ball" || F(lead, K_form).str() == u"column"));
  const Val& gen = F(res, K_generator);
  const U gk = F(gen, K_kind).is_str() ? F(gen, K_kind).str() : U();
  const bool balls = gen.truthy() && (gk == u"balls" || (gk == u"grid" && gridLead));
  for (const Val& p : items(F(res, K_pads))) pads(p, balls, 0.05, uid, fp.kids);
  for (const Val& h : items(F(res, K_holes))) {
    const Val& sh = F(h, K_shape);
    const U kind = F(sh, K_kind).is_str() ? F(sh, K_kind).str() : U();
    const bool round = kind == u"circle" || (kind == u"oval" && near(n_of(F(sh, K_w)), n_of(F(sh, K_l))));
    const double d = kind == u"circle" ? n_of(F(sh, K_d)) : n_of(F(sh, K_w));
    const SX at = L(u"at", {N(n_of(F(h, K_x))), N(-n_of(F(h, K_y)))});
    SX node = round ? L(u"pad", {Q(U()), S(u"np_thru_hole"), S(u"circle"), at, L(u"size", {N(d), N(d)}), L(u"drill", {N(d)})})
                    : L(u"pad", {Q(U()), S(u"np_thru_hole"), S(u"oval"), at, L(u"size", {N(n_of(F(sh, K_w))), N(n_of(F(sh, K_l)))}),
                                 L(u"drill", {S(u"oval"), N(n_of(F(sh, K_w))), N(n_of(F(sh, K_l)))})});
    node.kids.push_back(L(u"layers", {Q(u"*.Cu"), Q(u"*.Mask")}));
    node.kids.push_back(L(u"uuid", {uid()}));
    fp.kids.push_back(std::move(node));
  }
  // the 3D model: embedded, or a reference to the source's STEP file
  const Val& md = F(res, K_model);
  const Val& step = F(md, K_step);
  if (step.truthy()) {
    const auto xyz = [&](const Val& v, double dflt) {
      SX x = L(u"xyz");
      if (v.truthy())
        for (const Val& n : items(v)) x.kids.push_back(N(n_of(n)));
      else
        for (int i = 0; i < 3; i++) x.kids.push_back(N(dflt));
      return x;
    };
    const double k = F(step, K_scale).nullish() ? 1 : n_of(F(step, K_scale));
    const U file = str_of(F(step, K_file));
    fp.kids.push_back(L(u"model", {Q(file), L(u"offset", {xyz(F(step, K_offset), 0)}), L(u"scale", {L(u"xyz", {N(k), N(k), N(k)})}),
                                   L(u"rotate", {xyz(F(step, K_rotate), 0)})}));
    result.notes.push_back(u"references " + file + u" (not embedded)");
  } else if (vrml) {
    U fname;
    bool run = false;
    for (char16_t c : name) {
      const bool ok = (c >= u'a' && c <= u'z') || (c >= u'A' && c <= u'Z') || (c >= u'0' && c <= u'9') || c == u'_' || c == u'.' || c == u'+' || c == u'-';
      if (ok) {
        fname += c;
        run = false;
      } else if (!run) {
        fname += u'_';
        run = true;
      }
    }
    fname += u".wrl";
    const auto bytes = bytes_of(*vrml);
    fp.kids.push_back(L(u"embedded_fonts", {S(u"no")}));
    fp.kids.push_back(L(u"embedded_files", {L(u"file", {L(u"name", {Q(fname)}), L(u"type", {S(u"model")}), D(js::u16(base64(zstd_frame(bytes)))),
                                                         L(u"checksum", {Q(js::u16(kicad_checksum(bytes)))})})}));
    fp.kids.push_back(L(u"model", {Q(u"kicad-embed://" + fname), L(u"offset", {L(u"xyz", {N(0), N(0), N(0)})}), L(u"scale", {L(u"xyz", {N(1), N(1), N(1)})}),
                                   L(u"rotate", {L(u"xyz", {N(0), N(0), N(0)})})}));
    result.embedded = vrml->size();
  }
  result.name = name;
  result.file = name + u".kicad_mod";
  result.text = print(fp, 0) + u"\n";
  return result;
}

}  // namespace stomp::kicad
