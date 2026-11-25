// The docs: the Markdown converter, where links go, and that every example in the
// tutorial and the reference works.
// Run: node --test demo/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, slugify, plain } from '../tools/md.mjs';
import { DOCS, docsLink, docsPages, GITHUB } from '../tools/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const { compile } = require('../js/compile.js');
const L = require('../js/lexer.js'), P = require('../js/parser.js');
const pages = docsPages();

test('headings get GitHub\'s ids, made unique, and the contents lists h2 and h3', () => {
  assert.equal(slugify('9.2 Directional relations: `is … of`'), '92-directional-relations-is--of');
  assert.equal(slugify('14.3 Tables: `footprints from`'), '143-tables-footprints-from');
  assert.equal(slugify('Pin 1, polarity and the *silkscreen*'), 'pin-1-polarity-and-the-silkscreen');
  assert.equal(plain('[the `lead` statement](x.md) and **bold**'), 'the lead statement and bold');
  const r = render('# Title\n\n## Pads\n\n### Shapes\n\n## Pads\n\n#### Deep\n', { prefix: 'p-' });
  assert.equal(r.title, 'Title');
  assert.deepEqual(r.toc.map((t) => `${t.level} ${t.id}`), ['2 p-pads', '3 p-shapes', '2 p-pads-1']);
  assert.match(r.html, /<h4 id="p-deep">Deep<a class="anchor" href="#p-deep"/);
});

test('lists: nested, loose and tight, with code and tables inside items', () => {
  const md = [
    '- one',
    '- two',
    '  - nested *a*',
    '  - nested b',
    '- three, with code:',
    '',
    '  ```stomp',
    '  pad 1 at (0, 0)',
    '  ```',
    '',
    '  | a | b |',
    '  |---|--:|',
    '  | 1 | 2 |',
    '',
    '1. first',
    '2. second',
    '   lazily continued',
  ].join('\n');
  const { html } = render(md);
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two\n<ul>/);
  assert.match(html, /<ul>\n<li>nested <em>a<\/em><\/li>\n<li>nested b<\/li>\n<\/ul>/);
  assert.match(html, /<li>three, with code:\n<div class="code-wrap"><pre class="code" data-lang="stomp" data-i="0"><code>pad 1 at \(0, 0\)<\/code><\/pre><\/div>/);
  assert.match(html, /<th>a<\/th><th class="al-r">b<\/th>/);
  assert.match(html, /<ol>\n<li>first<\/li>\n<li>second\nlazily continued<\/li>\n<\/ol>/);
  // a blank line between items makes a loose list, its items in paragraphs
  assert.match(render('- a\n\n- b').html, /<li><p>a<\/p><\/li>\n<li><p>b<\/p><\/li>/);
  assert.match(render('3. c\n4. d').html, /<ol start="3">/);
});

test('inline: code spans, escapes, links, emphasis; raw HTML is text', () => {
  const html = render('Use `` a`b ``, `x | y`, \\*not em\\*, **bold** and *em*. A <b>tag</b> & <https://example.com>.').html;
  assert.match(html, /<code>a`b<\/code>/);
  assert.match(html, /<code>x \| y<\/code>/);
  assert.match(html, /\*not em\*/);
  assert.match(html, /<strong>bold<\/strong> and <em>em<\/em>/);
  assert.match(html, /A &lt;b&gt;tag&lt;\/b&gt; &amp; <a href="https:\/\/example.com" target="_blank" rel="noopener">/);
  // a pipe in a table cell: escaped, or inside code
  const t = render('| a | b |\n|---|---|\n| `p \\| q` | x \\| y |').html;
  assert.match(t, /<td><code>p \| q<\/code><\/td><td>x \| y<\/td>/);
  // a stomp block that makes a footprint can be tried; one with … can't
  const s = render('```stomp\nfootprint "A"\n  pad 1 rect 1 x 1\nend\n```\n\n```stomp\nfootprint "B"\n  …\nend\n```').snippets;
  assert.deepEqual(s.map((x) => x.runnable), [true, false]);
});

test('links lead to pages, headings, files to open, or GitHub', () => {
  const ref = docsLink(DOCS.find((d) => d.key === 'reference'));
  assert.deepEqual(ref('#pads'), { href: '#reference-pads' });
  assert.deepEqual(ref('../SPEC.md#92-directional-relations-is--of'), { href: '#spec-92-directional-relations-is--of' });
  assert.deepEqual(ref('tutorial.md'), { href: '#tutorial' });
  assert.deepEqual(ref('../stdlib/README.md'), { href: '#library' });
  assert.deepEqual(ref('../examples/tht_parts.stomp'), { href: `${GITHUB}/blob/HEAD/examples/tht_parts.stomp`, external: true, open: 'tht_parts.stomp' });
  assert.deepEqual(ref('../stdlib/cans.stomp'), { href: `${GITHUB}/blob/HEAD/stdlib/cans.stomp`, external: true, open: 'stdlib/cans.stomp' });
  assert.deepEqual(ref('../grammar.peg'), { href: `${GITHUB}/blob/HEAD/grammar.peg`, external: true });
  assert.deepEqual(ref('../examples/'), { href: `${GITHUB}/tree/HEAD/examples`, external: true });
  assert.deepEqual(ref('https://example.com/x'), { href: 'https://example.com/x', external: true });
});

test('every page is built, and every link in them leads somewhere', () => {
  assert.deepEqual(pages.map((p) => p.key), DOCS.map((d) => d.key));
  const ids = new Set();
  for (const p of pages) {
    ids.add(p.key);
    for (const m of p.html.matchAll(/ id="([^"]+)"/g)) ids.add(m[1]);
  }
  for (const p of pages) {
    for (const m of p.html.matchAll(/href="#([^"]*)"/g)) assert.ok(ids.has(m[1]), `${p.file}: #${m[1]} leads nowhere`);
    for (const m of p.html.matchAll(/data-open="([^"]+)"/g)) {
      const file = m[1].startsWith('stdlib/') ? join(repo, m[1]) : join(repo, 'examples', m[1]);
      assert.ok(existsSync(file), `${p.file}: opens ${m[1]}, which doesn't exist`);
    }
  }
});

test('every example in the tutorial and the reference works', () => {
  const parses = (src) => {
    const wraps = [src, `footprint "X"\n${src}\nend`, `feature f\n${src}\nend`, `footprint "X"\n  model\n${src}\n  end\nend`];
    return wraps.some((w) => { const d = []; P.parse(L.lex(w, d).tokens, d); return !d.some((x) => x.severity === 'error'); });
  };
  for (const key of ['tutorial', 'reference']) {
    const page = pages.find((p) => p.key === key);
    assert.ok(page.snippets.length > 0, `${key} has examples`);
    for (const [i, s] of page.snippets.entries()) {
      const where = `${key}, example ${i + 1} (${s.heading})`;
      if (/^\s*footprints?\b/m.test(s.code) && !/…/.test(s.code)) {
        assert.ok(s.runnable, `${where} doesn't compile on its own`);
        const out = compile(s.code, { cache: false });
        assert.deepEqual(out.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message), [], where);
        if (key === 'tutorial') assert.deepEqual(out.diagnostics.map((d) => d.message), [], `${where}: no warnings in the tutorial`);
      } else {
        assert.ok(parses(s.code.replace(/^\s*…\s*$/gm, '').replace(/…/g, '1')), `${where} doesn't parse`);
      }
    }
  }
  // the tutorial's steps all open in the editor
  assert.ok(pages.find((p) => p.key === 'tutorial').snippets.every((s) => s.runnable));
});

test('the docs\' Markdown is the subset the converter reads', () => {
  for (const d of DOCS) {
    const md = readFileSync(join(repo, d.file), 'utf8');
    let fence = false;
    md.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) { fence = !fence; return; }
      if (fence) return;
      const text = line.replace(/`[^`]*`/g, '');
      assert.doesNotMatch(text, /<\/?(div|span|br|img|a|p|details|summary)\b/i, `${d.file}:${i + 1}: raw HTML is shown as text`);
      if (d.file.startsWith('docs/')) {
        assert.doesNotMatch(text, /—|→/, `${d.file}:${i + 1}: no em dashes or arrows in the docs' prose`);
      }
    });
    assert.ok(!fence, `${d.file}: a code block isn't closed`);
  }
});
