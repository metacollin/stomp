// The public API (include/stomp/stomp.hpp) over the compiler, the 3D engine and the KiCad
// writer: what the stomp tool and other C++ programs use.
#include <stomp/stomp.hpp>

#include <optional>
#include <stdexcept>
#include <tuple>
#include <unordered_set>
#include <utility>

#include "compile/compile.hpp"
#include "jsrt.hpp"
#include "kicad.hpp"
#include "model3d.hpp"

namespace stomp {

struct Footprint::Impl {
  std::string name;
  std::u16string name16;
  compiler::ResultP result;   // null if it didn't build
  bool ok = false;
  mutable std::optional<model3d::Model> model;   // built when first asked for

  const model3d::Model& built() const {
    if (!result) throw std::logic_error("stomp: footprint " + name + " didn't build");
    if (!model) model = model3d::build(*result);
    return *model;
  }
  bool hasModel() const {
    const model3d::Model& m = built();
    return !m.none && !m.meshes.empty();
  }
};

Footprint::Footprint(std::shared_ptr<Impl> impl) : impl_(std::move(impl)) {}

const std::string& Footprint::name() const { return impl_->name; }
bool Footprint::built() const { return impl_->result != nullptr; }
bool Footprint::ok() const { return impl_->ok; }

std::string Footprint::vrml() const {
  if (!impl_->result || !impl_->hasModel()) return {};
  return model3d::to_vrml(impl_->built(), impl_->name16);
}

std::vector<std::uint8_t> Footprint::stl() const {
  if (!impl_->result || !impl_->hasModel()) return {};
  return model3d::to_stl(impl_->built(), impl_->name16);
}

KicadFile Footprint::kicad() const {
  const model3d::Model& m = impl_->built();
  // the embedded model is named as the file is (exports.cpp stomp_kicad does the same)
  std::string vrml;
  const bool embed = !m.none && !m.meshes.empty();
  if (embed) vrml = model3d::to_vrml(m, kicad::safe_name(impl_->name16));
  const kicad::Footprint k = kicad::footprint(impl_->result->full(), impl_->name16, embed ? &vrml : nullptr);
  return {to_utf8(k.file), to_utf8(k.text), k.embedded > 0};
}

bool Compiled::has_errors() const {
  for (const Diagnostic& d : diagnostics)
    if (d.error) return true;
  return false;
}

namespace {

/** Line and column (from 1, in UTF-16 units) of offsets into one text. */
class Lines {
 public:
  explicit Lines(std::u16string_view text) {
    for (std::size_t i = 0; i < text.size(); ++i)
      if (text[i] == u'\n') starts_.push_back(i + 1);
  }
  std::pair<std::size_t, std::size_t> at(double offset) const {
    const std::size_t off = offset > 0 ? static_cast<std::size_t>(offset) : 0;
    std::size_t lo = 0, hi = starts_.size() - 1;
    while (lo < hi) {
      const std::size_t mid = (lo + hi + 1) / 2;
      if (starts_[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return {lo + 1, off - starts_[lo] + 1};
  }

 private:
  std::vector<std::size_t> starts_{0};
};

std::size_t one_based(const Val& v) { return v.is_num() && v.num() >= 1 ? static_cast<std::size_t>(v.num()) : 1; }
std::string text(const Val& v) { return v.is_str() ? to_utf8(v.str()) : std::string(); }

/** A finished diagnostic record (with its lines and columns) as the API's. */
Diagnostic diagnostic(const Obj& o) {
  Diagnostic d;
  d.error = !(o.get(K_severity).is_str() && o.get(K_severity).str() == u"warning");
  d.message = text(o.get(K_message));
  d.line = one_based(o.get(K_line));
  d.column = one_based(o.get(K_col));
  d.end_line = one_based(o.get(K_endLine));
  d.end_column = one_based(o.get(K_endCol));
  d.footprint = text(o.get(K_footprint));
  if (o.get(K_related).is_arr())
    for (const Val& r : o.get(K_related).arr()->a)
      d.notes.push_back({text(r.obj()->get(K_message)), one_based(r.obj()->get(K_line)), one_based(r.obj()->get(K_col))});
  return d;
}

}  // namespace

Compiled compile(std::u16string_view source, const Options& options) {
  compiler::Options o;
  o.cache = options.cache;
  std::vector<compiler::LibFile> lib;
  for (const LibraryFile& f : options.library) lib.push_back({from_utf8(f.name), f.source});
  if (!lib.empty()) o.stdlib = &lib;
  const compiler::Compiled c = compiler::compile(source, o);

  Compiled out;
  std::unordered_set<std::string> failing;   // footprints an error is about
  for (const Val& v : c.diagnostics->a) {
    out.diagnostics.push_back(diagnostic(*v.obj()));
    const Diagnostic& d = out.diagnostics.back();
    if (d.error && !d.footprint.empty()) failing.insert(d.footprint);
  }
  // the library's own problems, at their places in its files
  for (const Val& v : c.libraryDiagnostics->a) {
    const Obj& r = *v.obj();
    Diagnostic d;
    d.error = !(r.get(K_severity).is_str() && r.get(K_severity).str() == u"warning");
    d.message = text(r.get(K_message));
    d.file = text(r.get(K_file));
    for (const LibraryFile& f : options.library.empty() ? builtin_library() : options.library) {
      if (f.name != d.file) continue;
      const Lines lines(f.source);
      std::tie(d.line, d.column) = lines.at(r.get(K_s).is_num() ? r.get(K_s).num() : 0);
      std::tie(d.end_line, d.end_column) = lines.at(r.get(K_e).is_num() ? r.get(K_e).num() : 0);
      break;
    }
    out.library_diagnostics.push_back(std::move(d));
  }
  for (std::size_t i = 0; i < c.footprints->a.size(); ++i) {
    auto impl = std::make_shared<Footprint::Impl>();
    const Val& name = c.footprints->a[i].obj()->get(K_name);
    impl->name16 = name.is_str() ? name.str() : std::u16string();
    impl->name = to_utf8(impl->name16);
    impl->result = c.results[i];
    impl->ok = impl->result && !failing.count(impl->name);
    out.footprints.emplace_back(std::move(impl));
  }
  return out;
}

Compiled compile(std::string_view utf8, const Options& options) { return compile(from_utf8(utf8), options); }

}  // namespace stomp
