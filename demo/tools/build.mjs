#!/usr/bin/env node
// Build script for the stomp editor in demo/. No dependencies.
//
//   node demo/tools/build.mjs                 rebuild demo/js/examples.js from examples/*.stomp,
//                                             demo/js/stdlib.js from stdlib/*.stomp,
//                                             docs/img/*.svg from tools/figures.mjs and
//                                             demo/js/docs.js from the docs (DOCS below)
//   node demo/tools/build.mjs --check         fail if any of them is out of date
//   node demo/tools/build.mjs --bundle FILE   also write the whole editor as one HTML file
//         [--fragment]                        leave out <html>, <head> and <body>, for hosts that add
//                                             their own. Those hosts sandbox the page, so exports
//                                             go through the host or the clipboard.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './md.mjs';
import { FIGURES, figureSvg } from './figures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const demo = resolve(here, '..');
const repo = resolve(demo, '..');
const exDir = join(repo, 'examples');
const libDir = join(repo, 'stdlib');

// The standard library, in load order (SPEC 13.5). Files not listed go last, by name.
// stdlib/ORDER: the order the library's files are read in (the C++ build reads it too)
const LIB_ORDER = readFileSync(join(repo, 'stdlib', 'ORDER'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));

// The documentation pages, in the order the docs view lists them. Each is a Markdown
// file of the repository, so it reads the same on GitHub. Its key starts its #links.
export const DOCS = [
  { key: 'tutorial', file: 'docs/tutorial.md', nav: 'Tutorial' },
  { key: 'reference', file: 'docs/reference.md', nav: 'Language reference' },
  { key: 'using', file: 'docs/using.md', nav: 'Using stomp' },
  { key: 'library', file: 'stdlib/README.md', nav: 'Standard library' },
  { key: 'spec', file: 'SPEC.md', nav: 'Specification' },
];
export const GITHUB = 'https://github.com/metacollin/stomp';

// Order in the example picker. Files not listed go last, by name. The picker
// puts files named *_library.stomp in a group of their own.
const ORDER = [
  'to252.stomp', 'usb_microb.stomp', 'soic8.stomp', 'qfn32.stomp', 'sot23-5.stomp', 'sot223.stomp',
  'tssop20.stomp', 'soic_family.stomp', 'bga64.stomp', 'dip8.stomp', 'hdr2x5.stomp', 'r0402.stomp', 'led0603.stomp',
  'cp_radial.stomp', 'do41.stomp', 'crystal3225.stomp', 'tht_parts.stomp', 'custom_models.stomp', 'syntax_zoo.stomp',
  'qfn_library.stomp', 'chip_library.stomp', 'sot_library.stomp', 'sop_library.stomp', 'qfp_library.stomp',
  'dfn_library.stomp', 'bga_library.stomp', 'diode_library.stomp', 'tantalum_library.stomp', 'polymer_cap_library.stomp', 'inductor_library.stomp',
  'crystal_library.stomp', 'led_library.stomp', 'dip_library.stomp', 'header_library.stomp',
];

function exampleList() {
  const files = readdirSync(exDir).filter((f) => f.endsWith('.stomp'));
  files.sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
  return files.map((file) => {
    const source = readFileSync(join(exDir, file), 'utf8');
    // The first comment line is "# Title: blurb". The title goes in the picker,
    // the blurb in its tooltip.
    const first = (source.split('\n').find((l) => l.startsWith('# ')) || `# ${file}`).slice(2).trim().replace(/\.$/, '');
    const at = first.indexOf(': ');
    const title = at < 0 ? first : first.slice(0, at);
    const blurb = at < 0 ? '' : first.slice(at + 2);
    const group = file.endsWith('_library.stomp') ? 'Libraries' : 'Parts';
    return { file, title, blurb, group, source };
  });
}

function stdlibList() {
  const files = readdirSync(libDir).filter((f) => f.endsWith('.stomp'));
  const at = (f) => { const i = LIB_ORDER.indexOf(f); return i < 0 ? LIB_ORDER.length : i; };
  files.sort((a, b) => at(a) - at(b) || a.localeCompare(b));
  return files.map((file) => {
    const source = readFileSync(join(libDir, file), 'utf8');
    const first = (source.split('\n').find((l) => l.startsWith('# ')) || `# ${file}`).slice(2).trim().replace(/\.$/, '');
    const i = first.indexOf(': ');
    return { file, title: i < 0 ? first : first.slice(0, i), blurb: i < 0 ? '' : first.slice(i + 2), source };
  });
}

function stdlibJs() {
  return `/* Generated from stdlib/*.stomp by demo/tools/build.mjs. Don't edit. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Stomp = root.Stomp || {}).stdlib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return ${JSON.stringify(stdlibList(), null, 2).replace(/\n/g, '\n  ')};
});
`;
}

/**
 * Where a link in a docs page goes: another page (`#key`, `#key-heading`), an example
 * or library file (opened in the editor, with GitHub as the fallback), or GitHub.
 */
export function docsLink(page) {
  const dir = posix.dirname(page.file);
  return (href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { href, external: true };
    const at = href.indexOf('#');
    const path = at < 0 ? href : href.slice(0, at), anchor = at < 0 ? '' : href.slice(at + 1);
    if (!path) return { href: anchor ? `#${page.key}-${anchor}` : `#${page.key}` };
    const rel = posix.normalize(posix.join(dir, path)).replace(/^\.\//, '').replace(/\/$/, '');
    const target = DOCS.find((d) => d.file === rel);
    if (target) return { href: anchor ? `#${target.key}-${anchor}` : `#${target.key}` };
    const abs = join(repo, rel);
    const isDir = path.endsWith('/') || (existsSync(abs) && statSync(abs).isDirectory());
    const url = `${GITHUB}/${isDir ? 'tree' : 'blob'}/HEAD/${rel}${anchor ? `#${anchor}` : ''}`;
    if (/^examples\/[\w.-]+\.stomp$/.test(rel)) return { href: url, external: true, open: rel.slice('examples/'.length) };
    if (/^stdlib\/[\w.-]+\.stomp$/.test(rel)) return { href: url, external: true, open: rel };
    return { href: url, external: true };
  };
}

/** A figure, by the docs image that shows it (`img/gap.svg` in docs/). */
function figureImage(page) {
  const dir = posix.dirname(page.file);
  return (src, alt) => {
    const rel = posix.normalize(posix.join(dir, src));
    const fig = FIGURES.find((f) => `docs/img/${f.id}.svg` === rel);
    if (!fig) throw new Error(`${page.file}: the image ${src} isn't a figure (demo/tools/figures.mjs)`);
    return `<figure class="fig" data-fig="${fig.id}">${figureSvg(fig, false).replace(/aria-label="[^"]*"/, `aria-label="${alt.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}"`)}</figure>`;
  };
}

/** The figures' files, for GitHub. */
export const figureFiles = () => FIGURES.map((f) => [join(repo, 'docs', 'img', `${f.id}.svg`), () => figureSvg(f, true)]);

/** Every docs page, rendered. A code block gets Try it only if it compiles on its own. */
export function docsPages() {
  const require = createRequire(import.meta.url);
  const js = join(demo, 'js');
  for (const k of Object.keys(require.cache)) if (k.startsWith(js)) delete require.cache[k];
  const { compile } = require(join(js, 'compile.js'));
  return DOCS.filter((d) => existsSync(join(repo, d.file))).map((d) => {
    const r = render(readFileSync(join(repo, d.file), 'utf8'), { prefix: `${d.key}-`, link: docsLink(d), image: figureImage(d) });
    for (const s of r.snippets) {
      if (!s.runnable) continue;
      const out = compile(s.code, { cache: false });
      s.runnable = out.footprints.length > 0 && !out.diagnostics.some((x) => x.severity === 'error');
    }
    return { key: d.key, nav: d.nav, title: r.title || d.nav, file: d.file, html: r.html, toc: r.toc, snippets: r.snippets };
  });
}

function docsJs() {
  return `/* Generated from the docs (${DOCS.map((d) => d.file).join(', ')}) by demo/tools/build.mjs. Don't edit. */
(function (root) {
  (root.Stomp = root.Stomp || {}).docs = ${JSON.stringify({ github: GITHUB, pages: docsPages() })};
})(typeof self !== 'undefined' ? self : this);
`;
}

function examplesJs() {
  const list = exampleList();
  return `/* Generated from examples/*.stomp by demo/tools/build.mjs. Don't edit. */
(function (root) {
  (root.Stomp = root.Stomp || {}).examples = ${JSON.stringify(list, null, 2)};
})(typeof self !== 'undefined' ? self : this);
`;
}

function bundle(fragment) {
  let html = readFileSync(join(demo, 'index.html'), 'utf8');
  const css = readFileSync(join(demo, 'style.css'), 'utf8');
  html = html.replace(/<link rel="stylesheet" href="style\.css">/, () => `<style>\n${css}</style>`);
  html = html.replace(/<script src="(js\/[\w.-]+\.js)"><\/script>/g, (_, src) => {
    const js = readFileSync(join(demo, src), 'utf8').replace(/<\/script/gi, '<\\/script');
    return `<script>\n${js}</script>`;
  });
  if (fragment) {
    // a host that takes a fragment sandboxes it, so exports go through the host
    // and the plain download code is left out
    html = html.replace(/<script>/, '<script>window.STOMP_SANDBOXED = true;</script>\n<script>');
    html = html.replace(/\/\* @plain-download \*\/[\s\S]*?\/\* @end-plain-download \*\/\n?/g, '');
    html = html
      .replace(/<!doctype html>\s*/i, '')
      .replace(/<html[^>]*>\s*/i, '').replace(/\s*<\/html>\s*$/i, '\n')
      .replace(/<head>\s*/i, '').replace(/\s*<\/head>\s*/i, '\n')
      .replace(/<body>\s*/i, '').replace(/\s*<\/body>\s*/i, '\n')
      .replace(/<meta charset="utf-8">\s*/i, '')
      .replace(/<meta name="viewport"[^>]*>\s*/i, '');
  }
  return html;
}

// run only as a script, so tests can import DOCS and docsPages
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function main() {
  const args = process.argv.slice(2);
  // docs.js last: its Try it buttons come from compiling with the library just written
  const outputs = [[join(demo, 'js', 'examples.js'), examplesJs], [join(demo, 'js', 'stdlib.js'), stdlibJs], ...figureFiles(), [join(demo, 'js', 'docs.js'), docsJs]];
  if (args.includes('--check')) {
    let stale = 0;
    for (const [target, make] of outputs) {
      const fresh = make();
      const cur = existsSync(target) ? readFileSync(target, 'utf8') : '';
      const rel = target.slice(repo.length + 1);
      if (cur !== fresh) { console.error(`${rel} is out of date. Run: node demo/tools/build.mjs`); stale++; } else console.log(`${rel} is up to date`);
    }
    if (stale) process.exit(1);
  } else {
    mkdirSync(join(repo, 'docs', 'img'), { recursive: true });
    for (const [target, make] of outputs) { writeFileSync(target, make()); console.log(`wrote ${target}`); }
  }
  const bi = args.indexOf('--bundle');
  if (bi >= 0) {
    const out = resolve(args[bi + 1] || join(demo, 'stomp.html'));
    writeFileSync(out, bundle(args.includes('--fragment')));
    console.log(`wrote ${out}`);
  }
}
