// One footprint's build (compile.js FootprintBuilder): expand templates and parents
// into one list of statements, collect them, generate pads, pick each pad's geometry,
// solve the placements, then build the layers. Lengths are float mm.
//
// The builder's own state is typed; what the editor and the 3D engine read is written
// out as records (output.cpp) with the fields the JavaScript engine's objects had.
#ifndef STOMP_COMPILE_BUILDER_HPP
#define STOMP_COMPILE_BUILDER_HPP

#include <array>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "../geom.hpp"
#include "../ordered_map.hpp"
#include "../value.hpp"
#include "eval.hpp"
#include "keys.hpp"

namespace stomp::compiler {

using geom::Pt;
using geom::Poly;
using geom::Contour;

// Drawing defaults (compile.js D). The spec has no stack file yet, so these are fixed.
struct Defaults {
  double mask = 0.05, maskDefinedOverlap = 0.05, holeMask = 0.05;
  double silkW = 0.12, silkClear = 0.15, silkOffset = 0.11;
  double fabW = 0.1, crtW = 0.05, dot = 0.3;
  double tol;   // hypot(0.05, 0.025)
};
const Defaults& D();

/** IPC-7351B-style fillet goals [most, nominal, least] (mm). */
struct IpcTable {
  const char16_t* name;
  std::array<double, 3> toe, heel, side, cy;
};
namespace ipc {
extern const IpcTable gullwing, gullwingFine, jlead, lbend, straight, flat, chip, chipSmall;
}

/** An ordered set of strings (JavaScript's Set). */
class Flags {
 public:
  bool has(const U& s) const { return m_.has(s); }
  void add(const U& s) { if (!m_.has(s)) m_.set(s, 0); }
  std::size_t size() const { return m_.size(); }
  std::vector<U> list() const { return m_.keys(); }
 private:
  OrderedMap<U, char> m_;
};

// Statements, as the build sees them: { s: statement, level } (level = how far down an
// extends chain it comes from; a template's body is level 0)
struct Item {
  ObjP s;
  int level = 0;
};

struct MetaEntry {
  Val value;
  ObjP node;
};

struct St {
  OrderedMap<U, MetaEntry> meta;
  std::optional<Item> body, gen, lead, density, pin1, polarized, defaultPad, origin, bareSpan, barePitch;
  std::vector<Item> omits, onlys, padStmts, padsStmts, holes, deletes, rows, groups, places, thermals, texts, silk,
      assembly, courtyard, pinLeads, models, features;
  std::vector<Item>& layer(V name) { return name == u"silk" ? silk : name == u"assembly" ? assembly : courtyard; }
};

struct Body {
  U kind;                     // box or cyl
  double w = 0, l = 0;
  std::optional<double> h;    // null when not given
  ObjP node;
  std::optional<char16_t> axial;
  std::optional<double> d;
  bool cylinder = false;
  std::optional<double> x, y;
};

struct LeadSpan {
  double v = 0;
  U qual;
  ObjP node;
};
struct Lead {
  U form;
  ObjP node;
  std::optional<double> d, w, l, v;
  std::optional<LeadSpan> span;
  bool perPin = false;
};
using LeadP = std::shared_ptr<Lead>;
struct PinLead {
  LeadP lead;
  ObjP sel;
};

// Pad geometry: a shape, its drill and its properties
struct Drill {
  std::optional<double> d;          // round, or a slot
  double slotW = 0, slotL = 0;
};
struct Mask {
  U mode;                           // expand (v), none, defined
  double v = 0;
};
struct Paste {
  U mode;                           // expand (v), divide (nx x ny), none
  double v = 0, nx = 0, ny = 0;
  std::optional<double> coverage, gutter;
};
struct Vias {
  double nx = 0, ny = 0, drill = 0, pitch = 0;
};
struct Spec {
  geom::Shape shape;
  bool tht = false;
  std::optional<Drill> drill;
  double rot = 0;
  std::optional<Mask> mask;
  std::optional<Paste> paste;
  std::optional<Vias> vias;
  std::optional<bool> ipc;                  // missing unless derived
  std::optional<double> castellated;
  std::optional<std::vector<ObjP>> src;     // the property statements applied
  std::optional<bool> missing;              // no geometry was given
};
using SpecP = std::shared_ptr<const Spec>;
Spec clone_spec(const Spec& s);

struct IpcLand {
  double Z = 0, G = 0, X = 0, len = 0;
  const IpcTable* table = nullptr;
  double L = 0, T = 0, W = 0;
};
struct Spacing {
  double C = 0;
  U how;
  std::optional<IpcLand> ipc;
  std::optional<double> castellated;
};

/** Grid numbering (numberGrid). */
struct GridNames {
  double cols = 0, rows = 0;
  U scheme, sch;
  bool leftToRight = true, topToBottom = true;
  double ci(double c) const { return leftToRight ? c : cols - 1 - c; }
  double ri(double r) const { return topToBottom ? r : rows - 1 - r; }
  double order(double c, double r) const;
  U name(double c, double r) const;
  U rowKey(double r) const;
  U colKey(double c) const;
};

/** A generated pin position. */
struct Pos {
  U name;
  double x = 0, y = 0;
  std::optional<U> side;
  double rot = 0;
  double col = 0, row = 0, order = 0, walk = 0;
  U rowKey, colKey;
  SpecP proto;
  std::optional<U> derived;          // ipc, tht, ball, cast
  std::optional<double> pitch;
  ObjP node;
  std::optional<char16_t> axis;
  std::optional<double> leadSpan;
  bool thermal = false;              // a thermal pad's own position
};
using PosP = std::shared_ptr<Pos>;

struct Grid {
  double nx = 0, ny = 0;
  U scheme, start;
  GridNames names;
};

struct Gen {
  ObjP node;
  U kind;                             // balls, grid, sides, two, dual, quad, single
  std::vector<PosP> positions;
  PosP pin1;
  SpecP proto;
  ObjP protoSrc;
  std::optional<Spacing> sx, sy;      // gen.spacing.x / .y
  bool hasSpacing = false;
  std::optional<std::vector<ObjP>> src;
  std::optional<Grid> grid;
  std::optional<std::vector<PosP>> omitted;
  const Spacing* spacing(char16_t a) const { return a == u'x' ? (sx ? &*sx : nullptr) : (sy ? &*sy : nullptr); }
};

struct Span1 {
  double lo = 0, hi = 0;
};
struct BB {
  Span1 x, y;
  Span1& operator[](char16_t a) { return a == u'x' ? x : y; }
  const Span1& operator[](char16_t a) const { return a == u'x' ? x : y; }
};
struct Off {
  double x = 0, y = 0;
  double operator[](char16_t a) const { return a == u'x' ? x : y; }
};

struct Unit;
struct Partial {
  ArrP stmts;
  ObjP stmt;
  int level = 0;
};
struct Explicit {
  Spec spec;
  int level = 0;
  ObjP node;
};
struct MirrorRef {
  U proto;
  U axis;
  ObjP node;
};
struct Via {
  double x, y, d;
};

struct Pad {
  U name;
  std::optional<Explicit> explicit_;
  std::vector<Partial> partials;
  std::optional<MirrorRef> mirror;
  std::vector<ObjP> src;
  PosP gen;
  bool generated = false, thermal = false, geomFailed = false;
  // geometry
  std::optional<Spec> spec;
  double sideRot = 0, rot = 0;
  BB bb;
  // placement
  Unit* unit = nullptr;
  Off off;
  std::optional<double> x, y;
  bool overlap = false;
  // layers
  Contour land, copper;
  std::optional<Contour> maskOpen;
  std::optional<std::vector<Contour>> paste;
  std::optional<Contour> drillShape;
  std::vector<Via> viaList;
};
using PadP = std::shared_ptr<Pad>;

struct Hole {
  U name;
  geom::Shape shape;
  bool slot = false;
  std::vector<ObjP> src;
  int level = 0;
  std::optional<MirrorRef> mirror;
  double rot = 0;
  BB bb;
  Unit* unit = nullptr;
  Off off;
  double x = 0, y = 0;
  Contour land, maskOpen;
};
using HoleP = std::shared_ptr<Hole>;

struct Row {
  U name;
  std::vector<PadP> members;
  double pitch = 0;
  U going;
  ObjP node;
  Unit* unit = nullptr;
  BB bb;
};
using RowP = std::shared_ptr<Row>;

struct Group {
  U name;
  ArrP refs;
  ObjP node;
};
using GroupP = std::shared_ptr<Group>;

// The solver (SPEC 9): one variable per unit and axis
struct Unit {
  int id = 0;
  U kind;   // body, origin, row, pad, hole
  U label;
  PadP pad;
  HoleP hole;
  RowP row;
  const std::vector<ObjP>* src() const { return pad ? &pad->src : hole ? &hole->src : nullptr; }
};
using Vals = std::vector<double>;
using Fn = std::function<double(const Vals&)>;

/** What a reference names, for placing and measuring. */
struct Info {
  enum Type { Single, RowT, Set } type = Single;
  Unit* unit = nullptr;
  Off off;
  BB bb;
  U label;
  PadP pad;
  HoleP hole;
  RowP row;
  std::vector<Info> members;
  bool has_obj() const { return pad || hole || row; }
};
struct Anchor {
  std::vector<int> deps;
  Fn f;
};

struct Viz {
  U kind;   // at, dim, between, on, align, mirror, measure
  char16_t axis = u'x';
  Info ri, ti, ai, bi, oi, pi;
  U rw, tw, which, word, text;
  double d = 0, sg = 0;
  bool plain = false;
  double px = 0, py = 0;   // at: the point
};
struct MirrorCon {
  Info pi, ti;
  U axis;
};
struct Con {
  int unit = 0;
  char16_t axis = u'x';
  U strength;   // gen, weak, strong
  double level = 0;
  std::vector<int> deps;
  bool abs = false;
  Fn f;
  ObjP node, clause;
  U label;
  std::optional<Viz> viz;
  std::optional<MirrorCon> mirror;
};

struct Under {
  std::vector<char16_t> axes;
  bool why = false;
};
struct Cycle {
  char16_t axis;
  std::vector<int> units;
  std::vector<ObjP> nodes;
};

/** A 2D graphic item: line, circle, poly or text. */
struct Gfx {
  U type;
  std::optional<Poly> pts;
  std::optional<Pt> c;
  double r = 0;
  bool fill = false;
  std::optional<double> w;
  std::optional<Pt> at;
  std::optional<double> size;
  std::optional<U> str;
  Val src;                    // the statement it comes from (undefined: none)
  Val field;                  // text statements: ref, value or null
  bool clear = false, auto_ = false;
  std::optional<U> layer;     // copper or mask text
};
using Gfxs = std::vector<Gfx>;
using MapFn = std::function<Pt(Pt)>;

struct Layers {
  Gfxs silk, courtyard, assembly, texts;
};

/** A feature call bound to its arguments (bindFeature). */
struct Bound {
  ObjP f;
  ScopeP scope;
  Flags flags;
  std::unordered_set<const Obj*> active;
  int depth = 0;
  bool lib = false;
  ObjP call;
};
using BoundP = std::shared_ptr<Bound>;

/** What the 3D engine passes a feature it calls (bindFeature's `o`). */
struct BindOpts {
  const std::vector<std::pair<U, EV>>* values = nullptr;
  const std::vector<U>* flags = nullptr;
  const Flags* inherit = nullptr;
  Val unit;
  ScopeP scope;
  int depth = 0;
};

struct FeatureItems {
  Gfxs silk, assembly;
  BoundP bound;
};

struct CyBase {
  U mode;                   // auto, rect, none, box
  Val clearance, size;
  ObjP node;
  ArrP items;
  std::optional<double> c, w, l;
  struct Box {
    double x0, y0, x1, y1;
    std::optional<double> w;
    ObjP node;
  };
  std::optional<Box> box;
};

/** Changes to a body outline: a pin-1 chamfer at a corner, or a notch in an edge. */
struct OutlineMods {
  struct Chamfer {
    U corner;
    double c;
  };
  struct Notch {
    U edge;
    double r;
  };
  std::optional<Chamfer> chamfer;
  std::optional<Notch> notch;
};

struct Pin1 {
  double x = 0, y = 0;
  PadP pad;
  std::optional<U> side;
};

struct Marks {
  struct Dot {
    std::optional<Gfxs> items;
    ObjP src;
  };
  struct Bar {
    U edge;
    std::optional<Gfxs> items;
    ObjP src;
  };
  struct Polarity {
    PadP mk, other;
    double cx = 0, cy = 0;
    bool horiz = false;
    ObjP src;
    std::optional<Gfxs> hatch, plus, bar;
    std::optional<double> half;
  };
  std::optional<Dot> dot;
  std::optional<Bar> bar;
  std::optional<Polarity> polarity;
};

// A diagnostic as the build reports it, before compile() finishes it
struct RelD {
  U message;
  Val s, e;
};
struct Inst {
  double s = 0, e = 0;
  U tmpl;
};
struct CDiag {
  bool error = true;
  U message;
  Val s, e;
  Val footprint;              // the footprint's name when reported (undefined: none)
  std::optional<std::vector<RelD>> related;
  std::optional<Inst> inst;
  Val file;                   // the standard library's diagnostics: the file
  bool syntax = false;
};
using CDiags = std::vector<CDiag>;

struct Library;
/** One file's names, templates, features and footprints (compile.js buildFile). */
struct File {
  ScopeP lets;
  OrderedMap<U, ObjP> templates, features, footprints;
  std::shared_ptr<Library> lib;
  std::unordered_map<const Obj*, std::shared_ptr<Flags>> flagMemo;
};
using FileP = std::shared_ptr<File>;

struct LibSource {
  U file;
  double base = 0;
  U source;
};
struct Library {
  int id = 0;
  ScopeP lets;
  OrderedMap<U, ObjP> features;
  CDiags diags;
  std::vector<LibSource> sources;
};

/** Thrown once a hook's problem is reported (compile.js: an error with `hook` set): the 3D
 *  engine stops drawing that part. */
struct HookError : std::exception {
  U message;
  explicit HookError(U m) : message(std::move(m)) {}
  const char* what() const noexcept override { return "hook"; }
};

class Builder;
/** A feature bound for the 3D engine, read on behalf of a statement (compile.js binding). */
class HookBinding {
 public:
  HookBinding(Builder* b, BoundP bound, ObjP trigger);
  const U& name() const;
  bool lib() const { return bound_->lib; }
  const Flags& flags() const { return bound_->flags; }
  bool has(const U& n) const { return bound_->scope->defs.has(n); }
  EV get(const U& n);
  double len(const U& n);
  double num(const U& n);
  U str(const U& n);
  Color color(const U& n);
  /** A `NAME_if` test: its value in mm, or null when it needs a value nobody gave. */
  std::optional<double> test(const U& n);
  std::vector<ObjP> solids(const std::optional<geom::Frame>& M);

 private:
  Builder* b_;
  BoundP bound_;
  ObjP trigger_;
  double unitScale_;
};
using HookBindingP = std::shared_ptr<HookBinding>;

class Builder : public std::enable_shared_from_this<Builder> {
  friend class HookBinding;

 public:
  Builder(ObjP decl, FileP file, U source);

  // What the 3D engine calls to have features drawn (hooks.cpp; compile.js hooksApi). Problems
  // found while drawing are collected, at the statement each part comes from, until take().
  bool hookHas(const U& n) const { return lookupFeature(n) != nullptr; }
  bool hookIsLib(const U& n) const;
  std::vector<U> hookParams(const U& n) const;
  Flags hookFlags(const U& n);
  Color hookLibColor(const U& n);
  HookBindingP hookBind(const U& n, const std::vector<std::pair<U, EV>>& values, const std::vector<U>& flags, const ObjP& trig,
                        const Val& written);
  CDiags hookTake();

  ObjP decl;
  FileP file;
  CDiags diags;
  U src;
  std::optional<U> name;
  ScopeP scope;
  std::optional<Inst> tmpl;    // the template a `from` call is built from: {s, e, name} (tmpl.tmpl is its name)

  // Reporting (builder.cpp)
  void report(bool error, U msg, ObjP node, const Rels& related = {});
  void err(U msg, ObjP node, const Rels& related = {}) { report(true, std::move(msg), std::move(node), related); }
  void warn(U msg, ObjP node, const Rels& related = {}) { report(false, std::move(msg), std::move(node), related); }
  U stmtText(const ObjP& node) const;
  double lineAt(double off) const;
  template <typename F>
  auto guard(const ObjP& node, F&& fn) -> std::optional<decltype(fn())>;
  template <typename F>
  void guard_void(const ObjP& node, F&& fn);

  // Values
  Env env(const ObjP& stmt) const;
  EV val(const Val& x, const ObjP& stmt) const;
  double len(const Val& x, const ObjP& stmt) const;
  double plen(const Val& x, const ObjP& stmt, V what);
  double countOf(const ObjP& c, const ObjP& stmt) const;
  double deg(const Val& x, const ObjP& stmt) const;
  double num(const Val& x, const ObjP& stmt) const;
  double angleOf(const ObjP& a, const ObjP& stmt) const;
  double countIn(const Val& x, const ObjP& stmt, double lo, double hi, V what) const;
  Color colorValue(const Val& c, const ObjP& node) const;

  // Build
  void prepare();
  std::optional<U> computeName();
  std::optional<U> nameOf(const Val& n, const Val& unit);
  ObjP resolveStmt(const ObjP& stmt);
  ObjP build();   // the result record, or throws

 private:
  // builder.cpp
  struct Flat {
    std::vector<Item> items;
    std::vector<std::pair<ObjP, ObjP>> params;   // (template, decl)
    int max = 0;
  };
  Flat flatten(const ObjP& decl, std::vector<U> chain);
  void bindParams(const std::vector<std::pair<ObjP, ObjP>>& list);
  void defineLets();

  // gather.cpp
  void gather();
  LeadP leadFrom(const ObjP& n);
  geom::Shape shapeFrom(const ObjP& sh, const ObjP& stmt);
  Drill drillFrom(const ObjP& d, const ObjP& stmt);
  void applyProp(Spec& spec, const ObjP& p, const ObjP& stmt);
  Spec specFromGeom(const ObjP& g, const ObjP& stmt);
  void applyBlock(Spec& spec, const ArrP& stmts, const ObjP& stmt);
  void resize(Spec& spec, std::optional<double> w, std::optional<double> l, const ObjP& node);

  // generate.cpp
  void generate();
  void runGenerator(const ObjP& node);
  void applyPinLeads();
  void decideAxial();
  void makeAxial(char16_t axis);
  Spec ipcGridSpec(bool isBalls, const ObjP& node);
  Spec thtSpec(const Lead& lead);
  struct SpacingCtx {
    ObjP node;
    bool twoPin = false;
    std::optional<double> pitch;
    std::vector<ObjP>* src;
  };
  Spacing rowSpacing(char16_t axis, const SpecP& proto, SpacingCtx& ctx);
  IpcLand ipcLand(const IpcTable& table, double L, double T, double W) const;
  Spec ipcSpec(const IpcLand& ipc) const;
  struct Slot {
    bool nc = false;
    U name;
    ObjP node;
  };
  struct SideEntry {
    U side;
    std::vector<Slot> slots;
    std::optional<double> pitch, pitchGiven;
    ObjP node;
  };
  void countLayout(const ObjP& node, const std::optional<std::pair<double, std::optional<double>>>& pitch, const SpecP& proto,
                   const std::optional<U>& scheme, const U& start);
  void sidesLayout(const ObjP& node, const std::optional<std::pair<double, std::optional<double>>>& pitch, const SpecP& proto);
  void layoutSides(const ObjP& node, std::vector<SideEntry>& entries, const SpecP& proto, bool twoPin, std::optional<double> pitch);
  void depopulate();

  // objects.cpp
  void makeObjects();
  PadP newPad(const U& name);
  void unknown(const ObjP& r, const ObjP& node);
  void resolveGeometry();
  const Spec* resolvePad(const PadP& p, std::vector<Pad*> chain);

  // solve.cpp
  void solve();
  Info info(const ObjP& r, const ObjP& node = nullptr);
  Info padInfo(const PadP& p);
  Info groupInfo(const GroupP& g, std::vector<Group*> chain);
  Anchor anchor(const Info& inf, char16_t axis, const U& which);
  double toff(const Info& inf, char16_t axis, const U& which) const;
  U which(const ObjP& ref, char16_t axis, double s, V role);
  U whichStatic(const ObjP& ref, char16_t axis);
  Info target(const ObjP& r);
  void constrain(const Item& it);
  void resolveMeasures();
  void constrainOrigin();
  void solveAxes();
  void solveAxis(char16_t axis);
  Con& add(Con c);

  // layers.cpp
  void layers();
  void manualLayers();
  Pt featureAt(const ObjP& u);
  std::optional<U> mainFormNow() const;
  std::optional<U> styleNow() const;
  std::optional<U> familyNow() const;
  std::vector<U> markFlags() const;
  std::optional<Gfxs> markItems(const U& name, const std::vector<std::pair<U, EV>>& values, const std::vector<U>& flags,
                                const ObjP& trigger);
  U polarityPin(const ObjP& trigger);
  Marks evalMarks();
  std::optional<U> pin1Corner() const;
  U pin1End(const std::optional<U>& corner) const;
  void padLayers(Pad& p);
  std::vector<Contour> pasteWindows(const Spec& s, const std::function<Contour(const Contour&)>& at);
  void holeLayers(Hole& h);
  void pin1Info();
  Poly bodyOutline(double o, const OutlineMods* mods) const;
  U layerBase(V layer) const;
  U refLabel() const;
  void gfx(const ArrP& items, V layer, Gfxs& out, double defW, const MapFn* map = nullptr, const Bound* bound = nullptr);
  void gfxItem(const ObjP& g, V layer, Gfxs& out, double defW, const MapFn& M, const MapFn* map);
  void textItem(const ObjP& t, const std::optional<U>& layerDefault, Gfxs& outDefault);
  U textOf(const ObjP& t);
  void textLayer();
  std::optional<CyBase::Box> courtyardBox(const ArrP& items, const ObjP& node);
  std::optional<geom::Box> landBox() const;
  void checks();

  // hooks.cpp
  template <typename F>
  auto hookRun(const BoundP& bound, const ObjP& trig, F&& fn) -> decltype(fn());

  // features.cpp
  ObjP lookupFeature(const U& name) const;
  std::vector<U> featureNames() const;
  std::shared_ptr<Flags> flagsOf(const ObjP& f, std::unordered_set<const Obj*>* visiting = nullptr);
  BoundP bindFeature(const ObjP& call, const BindOpts& o);
  void eachItem(const Bound& bound, const std::function<void(const ObjP&)>& fn);
  template <typename F>
  auto inFeature(const BoundP& bound, F&& fn) -> decltype(fn());
  Gfxs featureLayer(const BoundP& bound, V layer, const MapFn& map);
  Gfxs placedLayer(const ObjP& u, const BoundP& bound, V layer, const MapFn& map);
  FeatureItems featureItems(const ObjP& use, const ObjP& node);
  std::vector<ObjP> featureSolids(const BoundP& bound, const std::optional<geom::Frame>& M);
  geom::Frame placement3(const ObjP& q);
  ArrP pathPts(const ArrP& path, const ObjP& stmt, ArrP* arcs);
  Val solidName(const ObjP& p);
  ObjP solidDesc(const ObjP& p, const std::optional<geom::Frame>& M, bool inFeature);

  // output.cpp
  ObjP output();
  ObjP modelInfo();
  std::vector<ObjP> featureUseSolids(const ObjP& u);
  ObjP footprintSolid(const ObjP& p);
  ArrP leads3d();

 public:
  // lazy.cpp: the automatic silk, assembly and courtyard, on first use
  void finishLayers();
  ObjP lazyFields();   // { silk, assembly, courtyard, bbox, courtyardBox, courtyardClearance }
  // output.cpp: the pads' and holes' outlines, which records get only when asked
  // res with each pad's land, copper, mask, paste, drillShape and each hole's land, mask (or
  // with nulls in their places, for the browser, which loads them when first used)
  ObjP withOutlines(const ObjP& res, bool placeholders = false) const;
  ObjP outlines() const;                      // { pads: [[land, copper, mask, paste, drillShape]], holes: [[land, mask]] }

 private:
  void silkLayer();
  void assemblyLayer();
  void courtyardLayer();
  double chamferSize(const std::optional<U>& corner);
  std::optional<Pt> pin1Spot(double r);

 public:
  // state (public for compile.cpp, output.cpp and the hooks)
  bool prepared = false;
  int ownLevel = 0;
  std::vector<Item> items;
  std::unordered_map<const void*, std::unordered_set<U>> libSeen;
  CDiags* diagSink = nullptr;
  ObjP trigger;
  std::vector<BoundP> stack;
  int errorCount = 0;

  St st;
  std::unordered_set<U> broken;
  U density;
  int lv = 1;
  std::optional<Body> body;
  bool bodyFailed = false;
  LeadP lead;
  OrderedMap<U, PinLead> pinLeads;
  std::optional<Spec> defaultSpec;
  bool polarized = false;
  std::shared_ptr<Gen> gen;
  std::optional<U> ipcNote;
  std::optional<double> courtyardExcess;

  OrderedMap<U, PadP> pads;
  OrderedMap<U, HoleP> holes;
  OrderedMap<U, RowP> rows;
  OrderedMap<U, GroupP> groups;
  OrderedMap<U, std::vector<U>> sides;

  std::vector<std::shared_ptr<Unit>> units;
  Unit* bodyUnit = nullptr;
  Unit* originUnit = nullptr;
  std::deque<Con> cons;
  bool originUsed = false;
  OrderedMap<U, Con*> chosen;
  std::array<Vals, 2> vals;
  std::set<int> unplaced;
  bool floatX = false, floatY = false;
  OrderedMap<int, Under> under;
  std::vector<Cycle> cycles;
  std::array<std::unordered_set<int>, 2> varsByAxis;

  Off O;
  std::optional<U> originNote;
  Layers lay, manual;
  std::optional<CyBase> cyBase;
  std::optional<FeatureItems> pin1Feature;
  Marks marks2d;
  std::optional<Pin1> pin1;
  U pin1Style;

  CDiags hookSink;

  bool finished = false;
  std::vector<Poly> keepouts;
  std::optional<double> courtyardClearance;
  // output() keeps these for lazyFields()
  geom::Box core;

  Pt shift(Pt p) const { return {p.x - O.x, p.y - O.y}; }
};
using BuilderP = std::shared_ptr<Builder>;

// Helpers (helpers.cpp)
inline int ai(char16_t axis) { return axis == u'x' ? 0 : 1; }
inline char16_t other(char16_t axis) { return axis == u'x' ? u'y' : u'x'; }
U fmt_mm(double v);
U quote_name(const U& n);
U num_text(double v);
U tick(V s);
double ceil_to(double v, double q);
double floor_to(double v, double q);
inline double rad(double d) { return (d * geom::PI) / 180; }
std::vector<U> expand_range(const ObjP& a, const ObjP& b, const ObjP& node);
U jedec_row(double i);
double jedec_index(const U& s);
GridNames number_grid(double cols, double rows, const U& scheme, const U& start, std::optional<double> px, std::optional<double> py);
std::vector<int> walk_order(const std::vector<PosP>& pos, const U& scheme, const U& start, bool single);
double to_outer(const LeadSpan& span, double T);
BB bb_of(const geom::Shape& shape, double rotDeg);
BB bb_of_body(const Body& b);
std::optional<U> family_of(const Val& refdes);
U style_of(const Body& b, const std::optional<U>& form, const Gen* gen, const std::optional<U>& family);
Gfxs map_items(const Gfxs& items, const MapFn& map, const Val& src);
Gfx rect_item(double x0, double y0, double x1, double y1, double w);
double min_dist_to_poly(Pt p, const Poly& poly);
const Val& F(const ObjP& o, Key k);
inline bool is(const Val& v, V s) { return v.is_str() && v.str() == s; }
U text_of(const U& src, const Val& x);   // exprText: the source text of a node

// Writing records (out.cpp)
Val pt_val(Pt p);
Val poly_val(const Poly& pts);
Val contour_val(const Contour& c);
Val box_val(const geom::Box& b);
Val shape_val(const geom::Shape& s);
Val spec_val(const Spec& s);
Val gfx_val(const Gfx& g);
Val gfxs_val(const Gfxs& g);
Val frame_val(const geom::Frame& M);
Val color_val(const Color& c);
Val ev_val(const EV& v);
Val nodes_val(const std::vector<ObjP>& v);

// Builder templates

template <typename F>
auto Builder::guard(const ObjP& node, F&& fn) -> std::optional<decltype(fn())> {
  try {
    return fn();
  } catch (const StompError& e) {
    if (!e.silent) err(e.message, e.node ? e.node : node, e.related);
    return std::nullopt;
  }
}

template <typename F>
void Builder::guard_void(const ObjP& node, F&& fn) {
  try {
    fn();
  } catch (const StompError& e) {
    if (!e.silent) err(e.message, e.node ? e.node : node, e.related);
  }
}

template <typename F>
auto Builder::inFeature(const BoundP& bound, F&& fn) -> decltype(fn()) {
  ScopeP outer = scope;
  ObjP outerTrigger = trigger;
  scope = bound->scope;
  if (!is_lib(bound->call)) trigger = bound->call;
  stack.push_back(bound);
  struct Restore {
    Builder* b;
    ScopeP outer;
    ObjP trig;
    ~Restore() {
      b->stack.pop_back();
      b->scope = outer;
      b->trigger = trig;
    }
  } restore{this, std::move(outer), std::move(outerTrigger)};
  return fn();
}

}  // namespace stomp::compiler

#endif  // STOMP_COMPILE_BUILDER_HPP
