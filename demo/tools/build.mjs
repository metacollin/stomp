#!/usr/bin/env node
// Demo build script. No dependencies.
//
//   node demo/tools/build.mjs                 rebuild demo/js/examples.js from examples/*.stomp
//   node demo/tools/build.mjs --check         fail if demo/js/examples.js is out of date
//   node demo/tools/build.mjs --bundle FILE   also write the whole demo as one HTML file
//         [--fragment]                        leave out <html>, <head> and <body>, for hosts that add
//                                             their own. Those hosts sandbox the page, so exports
//                                             go through the host or the clipboard.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const demo = resolve(here, '..');
const repo = resolve(demo, '..');
const exDir = join(repo, 'examples');

// Order in the example picker. Files not listed go last, by name. The picker
// puts files named *_library.stomp in a group of their own.
const ORDER = [
  'to252.stomp', 'usb_microb.stomp', 'soic8.stomp', 'qfn32.stomp', 'sot23-5.stomp', 'sot223.stomp',
  'tssop20.stomp', 'soic_family.stomp', 'bga64.stomp', 'dip8.stomp', 'hdr2x5.stomp', 'r0402.stomp', 'led0603.stomp',
  'cp_radial.stomp', 'do41.stomp', 'crystal3225.stomp', 'syntax_zoo.stomp',
  'qfn_library.stomp', 'chip_library.stomp', 'sot_library.stomp', 'sop_library.stomp', 'qfp_library.stomp',
  'dfn_library.stomp', 'bga_library.stomp', 'diode_library.stomp', 'tantalum_library.stomp', 'inductor_library.stomp',
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
    html = html.replace(/\/\* @plain-download \*\/[\s\S]*?\/\* @end-plain-download \*\/\n?/, '');
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

const args = process.argv.slice(2);
const target = join(demo, 'js', 'examples.js');
const fresh = examplesJs();
if (args.includes('--check')) {
  const cur = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (cur !== fresh) {
    console.error('demo/js/examples.js is out of date. Run: node demo/tools/build.mjs');
    process.exit(1);
  }
  console.log('demo/js/examples.js is up to date');
} else {
  writeFileSync(target, fresh);
  console.log(`wrote ${target}`);
}
const bi = args.indexOf('--bundle');
if (bi >= 0) {
  const out = resolve(args[bi + 1] || join(demo, 'stomp-live.html'));
  writeFileSync(out, bundle(args.includes('--fragment')));
  console.log(`wrote ${out}`);
}
