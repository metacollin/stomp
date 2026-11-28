// What the 3D engine calls to have features drawn (compile.js hooksApi): the standard
// library's bodies and leads, or the user's own. Problems found while drawing are reported
// into a sink of their own, at the statement each part comes from.
#include "../jsrt.hpp"
#include "builder.hpp"

namespace stomp::compiler {

/** Evaluate on behalf of `trig` (a { s, e } range in the user's file), with bound on the stack. */
template <typename F>
auto Builder::hookRun(const BoundP& bound, const ObjP& trig, F&& fn) -> decltype(fn()) {
  CDiags* outerSink = diagSink;
  ObjP outerTrigger = trigger;
  std::vector<BoundP> outerStack = stack;
  diagSink = &hookSink;
  trigger = trig ? trig : range(decl->get(K_nameS).num(), decl->get(K_nameE).num());
  stack = bound ? std::vector<BoundP>{bound} : std::vector<BoundP>{};
  struct Restore {
    Builder* b;
    CDiags* sink;
    ObjP trig;
    std::vector<BoundP> stack;
    ~Restore() {
      b->diagSink = sink;
      b->trigger = std::move(trig);
      b->stack = std::move(stack);
    }
  } restore{this, outerSink, std::move(outerTrigger), std::move(outerStack)};
  try {
    return fn();
  } catch (const StompError& err) {
    if (!err.silent) report(true, err.message, err.node, err.related);
    throw HookError(err.message);
  }
}

bool Builder::hookIsLib(const U& n) const {
  const ObjP f = lookupFeature(n);
  return f && f->get(K_lib).truthy();
}

std::vector<U> Builder::hookParams(const U& n) const {
  std::vector<U> out;
  if (const ObjP f = lookupFeature(n))
    for (const Val& q : f->get(K_params).arr()->a) out.push_back(q.obj()->get(K_name).str());
  return out;
}

Flags Builder::hookFlags(const U& n) {
  const ObjP f = lookupFeature(n);
  return f ? *flagsOf(f) : Flags{};
}

/** A color the standard library names (`solid_color`). */
Color Builder::hookLibColor(const U& n) {
  return hookRun(nullptr, nullptr, [&] { return to_color(file->lib->lets->lookup(n, decl), decl); });
}

/**
 * Bind a feature for the engine. `values` and `flags` the feature doesn't declare are dropped.
 * `written` is a `body shape` or `leads shape` statement's { call, unit, node }, whose own
 * arguments and flags come first.
 */
HookBindingP Builder::hookBind(const U& n, const std::vector<std::pair<U, EV>>& values, const std::vector<U>& flags, const ObjP& trig,
                               const Val& written) {
  return hookRun(nullptr, trig, [&] {
    const ObjP f = lookupFeature(n);
    if (!f) throw StompError(u"unknown feature " + tick(n), trig);
    std::vector<std::pair<U, EV>> declared;
    for (const Val& q : f->get(K_params).arr()->a) {
      const U& qn = q.obj()->get(K_name).str();
      for (const auto& [k, v] : values)
        if (k == qn) {
          declared.push_back({k, v});
          break;
        }
    }
    ObjP call;
    if (written.truthy()) {
      const ObjP& w = written.obj();
      call = std::make_shared<Obj>(*w->get(K_call).obj());
      call->set(K_name, n);
      call->set(K_s, w->get(K_node).obj()->get(K_s));
      call->set(K_e, w->get(K_node).obj()->get(K_e));
    } else {
      call = rec({{K_name, n}, {K_args, list()}, {K_s, trig ? trig->get(K_s) : Val()}, {K_e, trig ? trig->get(K_e) : Val()}});
    }
    BindOpts o;
    o.values = &declared;
    o.flags = &flags;
    o.unit = written.truthy() ? written.obj()->get(K_unit) : Val(nullptr);
    o.scope = scope;
    const BoundP bound = bindFeature(call, o);
    return std::make_shared<HookBinding>(this, bound, written.truthy() ? written.obj()->get(K_node).obj() : trig);
  });
}

/** The problems found since the last call. */
CDiags Builder::hookTake() {
  CDiags out = std::move(hookSink);
  hookSink.clear();
  libSeen.erase(&hookSink);   // a new sink: library problems are reported again
  return out;
}

// Bindings

HookBinding::HookBinding(Builder* b, BoundP bound, ObjP trigger)
    : b_(b), bound_(std::move(bound)), trigger_(std::move(trigger)), unitScale_(unit_scale(bound_->f->get(K_unit))) {}

const U& HookBinding::name() const { return bound_->f->get(K_name).str(); }

EV HookBinding::get(const U& n) {
  return b_->hookRun(bound_, trigger_, [&] {
    if (!bound_->scope->defs.has(n)) throw StompError(u"feature " + tick(name()) + u" has no " + tick(n), trigger_);
    return bound_->scope->lookup(n, trigger_);
  });
}

double HookBinding::len(const U& n) {
  const EV v = get(n);
  if (v.k == VK::Len) return v.v;
  if (v.k == VK::Num) return v.v * unitScale_;
  return b_->hookRun(bound_, trigger_, [&]() -> double {
    throw StompError(tick(n) + u" in " + tick(name()) + u" should be a length, but it's a " + kind_name(v.k), trigger_);
  });
}

double HookBinding::num(const U& n) {
  const EV v = get(n);
  if (v.k == VK::Num || v.k == VK::Ratio) return v.v;
  return b_->hookRun(bound_, trigger_, [&]() -> double {
    throw StompError(tick(n) + u" in " + tick(name()) + u" should be a plain number, but it's a " + kind_name(v.k), trigger_);
  });
}

U HookBinding::str(const U& n) {
  const EV v = get(n);
  if (v.k == VK::Str) return v.s;
  if (v.k == VK::Color) return v.c->name && !v.c->name->empty() ? *v.c->name : hex_of(v.c->rgb);
  return format_number(v.v, std::nullopt);
}

Color HookBinding::color(const U& n) {
  const EV v = get(n);
  return b_->hookRun(bound_, trigger_, [&] { return to_color(v, trigger_); });
}

std::optional<double> HookBinding::test(const U& n) {
  return b_->hookRun(bound_, trigger_, [&]() -> std::optional<double> {
    if (!bound_->scope->defs.has(n)) return std::nullopt;
    EV v;
    try {
      v = bound_->scope->lookup(n, trigger_);
    } catch (const StompError& err) {
      if (err.missing) return std::nullopt;
      throw;
    }
    if (v.k == VK::Len || v.k == VK::Ratio) return v.v;
    if (v.k == VK::Num) return v.v * unitScale_;
    throw StompError(tick(n) + u" in " + tick(name()) + u" should be a number, but it's a " + kind_name(v.k), trigger_);
  });
}

std::vector<ObjP> HookBinding::solids(const std::optional<geom::Frame>& M) {
  return b_->hookRun(bound_, trigger_, [&] { return b_->featureSolids(bound_, M); });
}

}  // namespace stomp::compiler
