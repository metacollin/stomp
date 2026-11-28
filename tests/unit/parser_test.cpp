// The parser: a few shapes and messages here; tests/compare checks it against the
// JavaScript parser on every example and 100,000 random edits.
#include <stomp/stomp.hpp>

#include "check.hpp"
#include "lexer.hpp"
#include "parser.hpp"

using namespace stomp;

namespace {
struct Parsed {
  ObjP ast;
  Diags diags;
};
Parsed parse_text(std::u16string_view src) {
  Parsed p;
  const Lexed lx = lex(src, nullptr);
  p.ast = parse(lx.stream, p.diags);
  return p;
}
const Obj& item(const Parsed& p, std::size_t i) { return *p.ast->get(K_items).arr()->a.at(i).obj(); }
}  // namespace

TEST(parses_a_footprint_with_its_statements) {
  const Parsed p = parse_text(u"footprint \"A\"\n  pad 1 rect 1 x 2\n  pad 2 is 2 right of pad 1\nend\n");
  CHECK(p.diags.empty());
  const Obj& fp = item(p, 0);
  CHECK(fp.get(K_type).str() == u"Footprint");
  CHECK(fp.get(K_name).str() == u"A");
  const auto& body = fp.get(K_body).arr()->a;
  CHECK_EQ(body.size(), std::size_t(2));
  CHECK(body[0].obj()->get(K_type).str() == u"Pad");
  CHECK(body[1].obj()->get(K_type).str() == u"Is");
  CHECK(body[1].obj()->get(K_unit).str() == u"mm");
}

TEST(reports_a_missing_end_at_the_header_and_reads_on) {
  const Parsed p = parse_text(u"footprint \"A\"\n  pad 1 rect 1 x 2\nfootprint \"B\"\n  pad 1 rect 1 x 2\nend\n");
  CHECK_EQ(p.diags.size(), std::size_t(1));
  CHECK(p.diags[0].message == u"missing `end` for this `footprint` before line 3");
  CHECK_EQ(p.diags[0].s, Offset(0));
  CHECK_EQ(p.ast->get(K_items).arr()->a.size(), std::size_t(2));
}

TEST(messages_name_what_was_expected) {
  const Parsed p = parse_text(u"footprint \"A\"\n  pad 1 rect 1 x\nend\n");
  CHECK_EQ(p.diags.size(), std::size_t(1));
  CHECK(p.diags[0].message == u"expected a number after `x`");
}

TEST(keywords_are_names_where_no_keyword_is_expected) {
  const Parsed p = parse_text(u"draft = 3\nfootprint \"A\"\n  pad 1 rect draft x 2\nend\n");
  CHECK(p.diags.empty());
  CHECK(item(p, 0).get(K_type).str() == u"Let");
  CHECK(item(p, 0).get(K_name).str() == u"draft");
}

TEST(deep_nesting_is_an_error_not_a_crash) {
  std::u16string src = u"a = ";
  src.append(100000, u'(');
  src += u"1";
  src.append(100000, u')');
  src += u"\nfootprint \"A\"\n  pad 1 rect 1 x 1\nend\n";
  const Parsed p = parse_text(src);
  CHECK(!p.diags.empty());
  CHECK(p.diags[0].message == u"this is nested too deeply to read");
  CHECK(item(p, 0).get(K_type).str() == u"Footprint");   // and the rest of the file is read
}
