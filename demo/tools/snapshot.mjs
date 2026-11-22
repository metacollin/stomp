#!/usr/bin/env node
// Model snapshots. Records what every example and corpus footprint builds, in
// 3D and in the automatic silk and assembly, so a change to the engine or the
// standard library can be checked against the last recording.
//
//   node demo/tools/snapshot.mjs                 compare with demo/test/fixtures/models.jsonl
//   node demo/tools/snapshot.mjs --write         record the fixture again
//   node demo/tools/snapshot.mjs --time          also print build times
//   node demo/tools/snapshot.mjs --only TEXT     only footprints whose file or name holds TEXT
//   node demo/tools/snapshot.mjs --against DIR   compare mesh by mesh with the engine in DIR
//                                                (a copy of demo/js), vertex for vertex
//
// A record keeps, per mesh: name, kind, color, triangle and vertex counts, and
// its surface's area, bounding box, centroid and second moments. The moments
// are exact integrals over the triangles, so they don't depend on vertex order
// or on how a flat face is split into triangles. Leads are summed into one
// entry, with the first few kept in full.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const demo = resolve(here, '..');
const repo = resolve(demo, '..');
const require = createRequire(import.meta.url);
export const FIXTURE = join(demo, 'test', 'fixtures', 'models.jsonl');
export const CORPUS = join(demo, 'test', 'fixtures', 'corpus.stomp');

/** The sources to record: every example, then the corpus. */
export function sources() {
  const ex = join(repo, 'examples');
  const list = readdirSync(ex).filter((f) => f.endsWith('.stomp')).sort().map((f) => ({ file: f, text: readFileSync(join(ex, f), 'utf8') }));
  if (existsSync(CORPUS)) list.push({ file: 'corpus.stomp', text: readFileSync(CORPUS, 'utf8') });
  return list;
}

/** The engine in a directory: { compile, M }. */
export function engine(dir) {
  const d = resolve(dir || join(demo, 'js'));
  for (const k of Object.keys(require.cache)) if (k.startsWith(d)) delete require.cache[k];
  return { compile: require(join(d, 'compile.js')).compile, M: require(join(d, 'model3d.js')) };
}

const r5 = (v) => { const r = Math.round(v * 1e5) / 1e5; return Object.is(r, -0) ? 0 : r; };
const r4 = (v) => { const r = Math.round(v * 1e4) / 1e4; return Object.is(r, -0) ? 0 : r; };
const hexOf = (c) => c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
/** Mesh names in order; a long list is kept as its count and a hash. */
const namesOf = (meshes) => {
  const s = meshes.map((x) => x.name).join('|');
  if (s.length <= 160) return s;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${meshes.length} names, hash ${h.toString(16)}`;
};

/** Area, bounding box, centroid and second moments of a set of triangles. */
function moments(meshes) {
  let A = 0;
  const S = [0, 0, 0], Q = [0, 0, 0];
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let tris = 0, verts = 0;
  for (const m of meshes) {
    const P = m.pos, I = m.idx;
    tris += I.length / 3; verts += P.length / 3;
    for (let k = 0; k < P.length; k += 3) {
      for (let j = 0; j < 3; j++) { bb[j] = Math.min(bb[j], P[k + j]); bb[j + 3] = Math.max(bb[j + 3], P[k + j]); }
    }
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      A += ar;
      for (let j = 0; j < 3; j++) {
        const p = P[a + j], q = P[b + j], r = P[c + j];
        S[j] += ar * (p + q + r) / 3;
        Q[j] += ar * (p * p + q * q + r * r + p * q + q * r + r * p) / 6;
      }
    }
  }
  const cen = S.map((s) => (A > 0 ? s / A : 0));
  const mom = Q.map((q, j) => (A > 0 ? q / A - cen[j] * cen[j] : 0));
  return { tris, verts, area: A, bb, cen, mom };
}

const meshRow = (m) => {
  const k = moments([m]);
  return [m.name, m.kind, hexOf(m.color), m.metal, k.tris, k.verts, r5(k.area), k.bb.map(r5), k.cen.map(r5), k.mom.map(r5)];
};

/** The silk or assembly items, short: type, width or radius, points, length, extent. */
function items2d(list) {
  return (list || []).map((it) => {
    if (it.type === 'text') return ['text', it.str, r4(it.size), it.at.map(r4)];
    if (it.type === 'circle') return ['circle', it.fill ? 'fill' : r4(it.w), r4(it.r), it.c.map(r4)];
    const pts = it.pts || [];
    let len = 0;
    for (let i = 0; i + 1 < pts.length; i++) len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of pts) { bb[0] = Math.min(bb[0], q[0]); bb[1] = Math.min(bb[1], q[1]); bb[2] = Math.max(bb[2], q[0]); bb[3] = Math.max(bb[3], q[1]); }
    return [it.type, it.fill ? 'fill' : r4(it.w || 0), pts.length, r4(len), bb.map(r4)];
  });
}

/** One footprint's record. */
export function recordOf(file, fp, M) {
  const rec = { file, name: fp.name };
  const res = fp.result;
  if (!res) { rec.failed = true; return rec; }
  const m = M.build(res, { strict: false });
  const leads = m.meshes.filter((x) => /^lead /.test(x.name));
  const others = m.meshes.filter((x) => !/^lead /.test(x.name));
  const keep = m.meshes.length <= 12 ? m.meshes : others.concat(leads.slice(0, 3), leads.slice(-1));
  const order = new Map(m.meshes.map((x, i) => [x, i]));
  keep.sort((a, b) => order.get(a) - order.get(b));
  const v = M.toVRML(m, fp.name);
  rec.model = {
    none: m.none, style: m.style, mark: m.mark || null, short: m.short || null, summary: m.summary, leadCount: m.leadCount || 0,
    H: r5(m.H), standoff: r5(m.standoff), top: m.top, triangles: m.triangles, meshCount: m.meshes.length,
    names: namesOf(m.meshes),
    meshes: keep.map(meshRow),
    leads: leads.length ? (() => { const k = moments(leads); return [leads.length, k.tris, k.verts, r5(k.area), k.bb.map(r5), k.cen.map(r5), k.mom.map(r5)]; })() : null,
    vrml: [(v.match(/DEF S/g) || []).length, (v.match(/USE S/g) || []).length],
    notes: m.notes,
  };
  rec.silk = items2d(res.silk);
  rec.fab = items2d(res.assembly);
  return rec;
}

/** Records for every source, in order. */
export function recordAll(opts) {
  const o = opts || {};
  const E = o.engine || engine();
  const out = [];
  for (const { file, text } of o.sources || sources()) {
    const c = E.compile(text, { cache: false });
    for (const fp of c.footprints) {
      if (o.only && !`${file}:${fp.name}`.includes(o.only)) continue;
      out.push(recordOf(file, fp, E.M));
    }
  }
  return out;
}

export function readFixture(path) {
  return readFileSync(path || FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Differences between two values, as "path: old -> new" lines. Numbers within tolerance match. */
function diffValue(a, b, path, out) {
  if (out.length > 40) return;
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = 2e-5 + 2e-5 * Math.abs(a);
    if (!(Math.abs(a - b) <= tol) && !(Number.isNaN(a) && Number.isNaN(b))) out.push(`${path}: ${a} -> ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${path}: ${a.length} entries -> ${b.length}`); }
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffValue(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffValue(a[k], b[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}

/** Compare recordings: { missing, added, changed: [{ key, diffs }] }. */
export function compare(oldRecs, newRecs) {
  const key = (r) => `${r.file}:${r.name}`;
  const A = new Map(oldRecs.map((r) => [key(r), r])), B = new Map(newRecs.map((r) => [key(r), r]));
  const out = { missing: [], added: [], changed: [] };
  for (const k of A.keys()) if (!B.has(k)) out.missing.push(k);
  for (const k of B.keys()) if (!A.has(k)) out.added.push(k);
  for (const [k, a] of A) {
    const b = B.get(k);
    if (!b) continue;
    const diffs = [];
    diffValue(a, b, '', diffs);
    if (diffs.length) out.changed.push({ key: k, diffs });
  }
  return out;
}

/** Mesh-by-mesh comparison with another engine: every vertex, normal and index. */
function against(dir, only) {
  const A = engine(dir), B = engine();
  let n = 0, bad = 0;
  for (const { file, text } of sources()) {
    const ca = A.compile(text, { cache: false }), cb = B.compile(text, { cache: false });
    for (let i = 0; i < ca.footprints.length; i++) {
      const fa = ca.footprints[i], fb = cb.footprints[i];
      if (only && !`${file}:${fa.name}`.includes(only)) continue;
      if (!fa.result || !fb || !fb.result) continue;
      n++;
      const ma = A.M.build(fa.result, {}), mb = B.M.build(fb.result, {});
      const msgs = [];
      if (ma.meshes.length !== mb.meshes.length) msgs.push(`${ma.meshes.length} meshes -> ${mb.meshes.length}`);
      for (let j = 0; j < Math.min(ma.meshes.length, mb.meshes.length) && msgs.length < 8; j++) {
        const x = ma.meshes[j], y = mb.meshes[j];
        if (x.name !== y.name || x.kind !== y.kind) { msgs.push(`mesh ${j}: ${x.name}/${x.kind} -> ${y.name}/${y.kind}`); continue; }
        if (hexOf(x.color) !== hexOf(y.color) || x.metal !== y.metal) msgs.push(`${x.name}: color ${hexOf(x.color)}/${x.metal} -> ${hexOf(y.color)}/${y.metal}`);
        if (x.pos.length !== y.pos.length || x.idx.length !== y.idx.length) { msgs.push(`${x.name}: ${x.pos.length / 3} vertices, ${x.idx.length / 3} triangles -> ${y.pos.length / 3}, ${y.idx.length / 3}`); continue; }
        let dp = 0, dn = 0, di = 0;
        for (let k = 0; k < x.pos.length; k++) { dp = Math.max(dp, Math.abs(x.pos[k] - y.pos[k])); dn = Math.max(dn, Math.abs(x.nrm[k] - y.nrm[k])); }
        for (let k = 0; k < x.idx.length; k++) if (x.idx[k] !== y.idx[k]) di++;
        if (dp > 1e-5 || dn > 1e-4 || di) msgs.push(`${x.name}: positions off by ${dp.toExponential(2)}, normals by ${dn.toExponential(2)}, ${di} indices differ`);
      }
      if (msgs.length) { bad++; console.log(`${file}:${fa.name}\n  ${msgs.join('\n  ')}`); }
    }
  }
  console.log(`${n} footprints compared, ${bad} differ`);
  return bad;
}

function timings() {
  const E = engine();
  const all = sources();
  const results = [];
  for (const { text } of all) for (const fp of E.compile(text, { cache: false }).footprints) if (fp.result) results.push(fp);
  for (const fp of results) E.M.build(fp.result, {});
  let t = process.hrtime.bigint();
  for (const fp of results) E.M.build(fp.result, {});
  const allMs = Number(process.hrtime.bigint() - t) / 1e6;
  const bga = results.find((f) => /^BGA-484/.test(f.name));
  let bgaMs = null;
  if (bga) {
    for (let i = 0; i < 3; i++) E.M.build(bga.result, {});
    t = process.hrtime.bigint();
    for (let i = 0; i < 10; i++) E.M.build(bga.result, {});
    bgaMs = Number(process.hrtime.bigint() - t) / 1e7;
  }
  t = process.hrtime.bigint();
  for (const { text } of all) E.compile(text, { cache: false });
  const compileMs = Number(process.hrtime.bigint() - t) / 1e6;
  return { footprints: results.length, allMs, bgaMs, compileMs };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const only = opt('--only');
  if (args.includes('--against')) process.exit(against(opt('--against'), only) ? 1 : 0);
  if (args.includes('--write')) {
    const recs = recordAll();
    writeFileSync(FIXTURE, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`wrote ${recs.length} records to ${FIXTURE}`);
  } else {
    const old = readFixture().filter((r) => !only || `${r.file}:${r.name}`.includes(only));
    const now = recordAll({ only });
    const d = compare(old, now);
    for (const k of d.missing) console.log(`missing: ${k}`);
    for (const k of d.added) console.log(`new: ${k}`);
    for (const c of d.changed) console.log(`changed: ${c.key}\n  ${c.diffs.slice(0, 12).join('\n  ')}${c.diffs.length > 12 ? '\n  …' : ''}`);
    const bad = d.missing.length + d.added.length + d.changed.length;
    console.log(bad ? `${bad} of ${old.length} records differ` : `all ${old.length} records match`);
    if (bad) process.exitCode = 1;
  }
  if (args.includes('--time')) {
    const t = timings();
    console.log(`${t.footprints} models: ${t.allMs.toFixed(0)} ms; BGA-484: ${t.bgaMs == null ? '-' : t.bgaMs.toFixed(1)} ms; compiling everything: ${t.compileMs.toFixed(0)} ms`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
