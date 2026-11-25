// Your files: names, merging the two copies, saving with either copy failing, other
// tabs, and reading .zip files.
// Run: node --test demo/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const St = require('../js/store.js');
const M = require('../js/model3d.js');

/** localStorage in memory, or one whose writes fail (full, or turned off). */
function storage(failing) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (failing) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}

/** Just enough IndexedDB for the store: one database, object stores of records by id. */
function fakeIdb(opts) {
  const o = opts || {};
  const dbs = new Map();
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    dbs,
    open(name) {
      const req = {};
      setTimeout(() => {
        if (o.failing) { req.error = new Error('IndexedDB is off'); if (req.onerror) req.onerror(); return; }
        let db = dbs.get(name);
        const fresh = !db;
        if (!db) { db = new Map(); dbs.set(name, db); }
        req.result = {
          objectStoreNames: { contains: (s) => db.has(s) },
          createObjectStore: (s) => { db.set(s, new Map()); },
          transaction(storeName) {
            const store = db.get(storeName);
            const t = {}, todo = [];
            const request = (fn) => { const r = {}; todo.push(() => { r.result = fn(); }); return r; };
            t.objectStore = () => ({
              getAll: () => request(() => [...store.values()].map(clone)),
              put: (v) => request(() => { store.set(v.id, clone(v)); return v.id; }),
              delete: (k) => request(() => { store.delete(k); return undefined; }),
            });
            setTimeout(() => { todo.forEach((f) => f()); if (t.oncomplete) t.oncomplete(); });
            return t;
          },
        };
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}
const records = (idb) => [...((idb.dbs.get('stomp') || new Map()).get('files') || new Map()).values()];
let clock = 1000;
const now = () => ++clock;

test('names: cleaned, made unique, and safe on disk', () => {
  assert.equal(St.cleanName('  My part.stomp '), 'My part');
  assert.equal(St.cleanName('notes.TXT'), 'notes');
  assert.equal(St.cleanName('a/b\\c\u0007d'), 'a b c d');
  assert.equal(St.cleanName('   '), null);
  assert.equal(St.cleanName('x'.repeat(100)).length, 80);
  assert.equal(St.uniqueName('Untitled', []), 'Untitled');
  assert.equal(St.uniqueName('Untitled', ['untitled', 'Untitled 2']), 'Untitled 3');
  assert.equal(St.uniqueName('part 2', ['Part 2']), 'part 3');
  assert.equal(St.diskName('QFN: 32 / 5x5?'), 'QFN- 32 - 5x5-.stomp');
  assert.equal(St.diskName('', 'zip'), 'untitled.zip');
  assert.equal(St.diskName('..hidden.'), 'hidden.stomp');
});

test('merging two copies: the newest of each file, and deletions stick', () => {
  const a = [{ id: '1', name: 'a', source: 'old', modified: 5 }, { id: '2', name: 'b', source: 'b', modified: 5 }];
  const b = [{ id: '1', name: 'a', source: 'new', modified: 9 }, { id: '3', name: 'c', source: 'c', modified: 5 }];
  const m = St.merge(a, b, { 2: 7, 3: 1 });
  assert.deepEqual([...m.keys()].sort(), ['1', '3']);
  assert.equal(m.get('1').source, 'new');
  assert.ok(m.has('3'), 'changed after it was deleted, so it stays');
  assert.equal(St.merge([{ id: 4 }, null, { id: '5', source: 1 }]).size, 0, 'not files');
});

test('saving, renaming and deleting, with only localStorage', async () => {
  const ls = storage();
  const s = St.createStore({ idb: null, ls, nav: null, now });
  assert.deepEqual(s.init(), []);
  const r = await s.create('Board parts.stomp', 'footprint "A"\nend\n');
  assert.equal(r.ok, true);
  assert.equal(r.file.name, 'Board parts');
  const twin = await s.create('board PARTS', '');
  assert.equal(twin.file.name, 'board PARTS 2', 'a name you already have gets a number');
  assert.equal((await s.save(r.file.id, 'footprint "B"\nend\n')).ok, true);
  assert.equal((await s.save(r.file.id, 'footprint "B"\nend\n')).same, true);
  assert.equal((await s.rename(r.file.id, 'Renamed')).ok, true);
  assert.deepEqual(s.list().map((f) => f.name), ['board PARTS 2', 'Renamed']);
  // the copy in localStorage is what another tab, or the next visit, reads
  const again = St.createStore({ idb: null, ls, nav: null, now });
  assert.deepEqual(again.init().map((f) => `${f.name}: ${f.source.split('\n')[0]}`), ['board PARTS 2: ', 'Renamed: footprint "B"']);
  assert.equal((await s.remove(twin.file.id)).ok, true);
  assert.deepEqual(St.createStore({ idb: null, ls, nav: null, now }).init().map((f) => f.name), ['Renamed']);
  assert.deepEqual(s.status(), { idb: false, mirror: true });
  assert.equal(await s.persist(), null, 'no navigator.storage: it can\'t say');
});

test('another tab\'s changes arrive through the storage event', async () => {
  const ls = storage();
  const one = St.createStore({ idb: null, ls, nav: null, now });
  const two = St.createStore({ idb: null, ls, nav: null, now });
  one.init(); two.init();
  const f = (await one.create('Shared', 'x')).file;
  const seen = [];
  two.onChange((ids) => seen.push(...ids));
  assert.equal(two.handleStorageEvent({ key: 'something else' }), false);
  assert.equal(two.handleStorageEvent({ key: St.MIRROR }), true);
  assert.deepEqual(seen, [f.id]);
  assert.equal(two.get(f.id).source, 'x');
  await one.remove(f.id);
  two.handleStorageEvent({ key: St.MIRROR });
  assert.equal(two.get(f.id), null, 'deleted in the other tab');
  assert.deepEqual(seen, [f.id, f.id]);
});

test('when neither copy can be written, saving says so', async () => {
  const s = St.createStore({ idb: fakeIdb({ failing: true }), ls: storage(true), nav: null, now });
  s.init();
  const r = await s.create('Lost', 'x');
  assert.equal(r.ok, false);
  assert.deepEqual(s.status(), { idb: false, mirror: false });
});

test('IndexedDB and localStorage: each gets what the other missed', async () => {
  const idb = fakeIdb();
  const ls = storage();
  const s = St.createStore({ idb, ls, nav: null, now });
  s.init();
  await s.load();
  const a = (await s.create('Alpha', 'a1')).file;
  const b = (await s.create('Beta', 'b1')).file;
  assert.deepEqual(records(idb).map((f) => f.name).sort(), ['Alpha', 'Beta']);
  assert.deepEqual(s.status(), { idb: true, mirror: true });

  // localStorage cleared: IndexedDB brings the files back, and the copy is rewritten
  const ls2 = storage();
  const t = St.createStore({ idb, ls: ls2, nav: null, now });
  assert.deepEqual(t.init(), []);
  assert.deepEqual(await t.load(), []);
  assert.deepEqual(t.list().map((f) => f.name), ['Alpha', 'Beta']);
  assert.equal(JSON.parse(ls2.getItem(St.MIRROR)).files.length, 2);

  // a newer copy in localStorage (IndexedDB's write was lost) goes back into IndexedDB
  const mirror = JSON.parse(ls2.getItem(St.MIRROR));
  mirror.files.find((f) => f.id === a.id).source = 'a2';
  mirror.files.find((f) => f.id === a.id).modified += 100;
  ls2.setItem(St.MIRROR, JSON.stringify(mirror));
  const u = St.createStore({ idb, ls: ls2, nav: null, now });
  u.init();
  await u.load();
  assert.equal(records(idb).find((f) => f.id === a.id).source, 'a2');

  // a newer copy in IndexedDB replaces what was shown: load() reports it
  const v = St.createStore({ idb, ls: ls2, nav: null, now });
  v.init();
  const w = St.createStore({ idb, ls: storage(), nav: null, now });
  w.init();
  await w.load();
  await w.save(a.id, 'a3');
  assert.deepEqual(await v.load(), [a.id]);
  assert.equal(v.get(a.id).source, 'a3');

  // deleted while IndexedDB was away: the deletion reaches it later
  const x = St.createStore({ idb: null, ls: ls2, nav: null, now });
  x.init();
  await x.remove(b.id);
  const y = St.createStore({ idb, ls: ls2, nav: null, now });
  y.init();
  await y.load();
  assert.equal(y.get(b.id), null);
  assert.ok(!records(idb).some((f) => f.id === b.id), 'gone from IndexedDB too');
});

test('asking the browser to keep the files', async () => {
  let asked = 0;
  const nav = (granted, persisted) => ({ storage: { persisted: async () => persisted, persist: async () => { asked++; return granted; } } });
  assert.equal(await St.createStore({ idb: null, ls: null, nav: nav(true, false) }).persist(), true);
  assert.equal(await St.createStore({ idb: null, ls: null, nav: nav(false, false) }).persist(), false);
  assert.equal(asked, 2);
  assert.equal(await St.createStore({ idb: null, ls: null, nav: nav(false, true) }).persist(), true, 'already kept: no need to ask');
  assert.equal(asked, 2);
  assert.equal(await St.createStore({ idb: null, ls: null, nav: nav(false, true) }).persisted(), true);
});

test('reading .zip files: stored and deflated, folders skipped', async () => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ours = M.toZip([{ name: 'a.stomp', data: enc.encode('footprint "A"\nend\n') }, { name: 'b/c.stomp', data: enc.encode('x') }]);
  assert.deepEqual((await St.readZip(ours)).map((f) => `${f.name}=${dec.decode(f.data)}`), ['a.stomp=footprint "A"\nend\n', 'b/c.stomp=x']);
  const theirs = await St.readZip(readFileSync(join(here, 'fixtures', 'files.zip')));
  assert.deepEqual(theirs.map((f) => f.name), ['parts/alpha.stomp', 'readme.txt']);
  assert.match(dec.decode(theirs[0].data), /^footprint "ALPHA"\n/);
  assert.equal(dec.decode(theirs[0].data).split('footprint').length - 1, 3);
  await assert.rejects(St.readZip(enc.encode('not a zip at all, just text')), /not a zip file/);
});
