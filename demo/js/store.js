/* stomp: the files you save in this browser.
 *
 * Each file is kept twice. IndexedDB holds the main copy: it's the storage browsers
 * keep longest, and the page asks the browser to make it persistent (never cleared
 * to free space) the first time you save. localStorage holds a second copy, which
 * survives where IndexedDB fails or is turned off, and tells other tabs about
 * changes. Reading merges the two, the newest copy of each file winning, and writes
 * back whatever one of them missed. Clearing the site's data clears both, so the
 * editor also saves to and opens from disk.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Stomp = root.Stomp || {}).store = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DB_NAME = 'stomp', DB_STORE = 'files', MIRROR = 'stomp:files';

  /** A file name as typed: trimmed, no folders or control characters, no `.stomp`. Empty: null. */
  function cleanName(name) {
    let s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/\.(stomp|txt)$/i, '').trim();
    if (s.length > 80) s = s.slice(0, 80).trim();
    return s || null;
  }

  /** `base`, or `base 2`, `base 3`, … : the first that no name in `taken` has, ignoring case. */
  function uniqueName(base, taken) {
    const have = new Set([...taken].map((t) => String(t).toLowerCase()));
    if (!have.has(base.toLowerCase())) return base;
    const m = /^(.*?)(?: (\d+))?$/.exec(base);
    const stem = m[1] || base;
    for (let k = m[2] ? +m[2] + 1 : 2; ; k++) {
      const name = `${stem} ${k}`;
      if (!have.has(name.toLowerCase())) return name;
    }
  }

  /** The file name on disk for a stomp file's name. */
  function diskName(name, ext) {
    const s = String(name || 'untitled').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/^[\s.]+|[\s.]+$/g, '') || 'untitled';
    return `${s}.${ext || 'stomp'}`;
  }

  /**
   * Merge two lists of files: every id from either, the most recently modified copy
   * of each. Ids in `deleted` (from either side) are dropped unless a copy was
   * modified after it was deleted.
   */
  function merge(a, b, deleted) {
    const out = new Map();
    for (const f of [...(a || []), ...(b || [])]) {
      if (!f || typeof f.id !== 'string' || typeof f.source !== 'string') continue;
      const had = out.get(f.id);
      if (!had || (f.modified || 0) > (had.modified || 0)) out.set(f.id, f);
    }
    for (const [id, when] of Object.entries(deleted || {})) {
      const f = out.get(id);
      if (f && (f.modified || 0) <= when) out.delete(id);
    }
    return out;
  }

  const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  function safeLocalStorage() {
    try { const ls = typeof localStorage !== 'undefined' ? localStorage : null; if (ls) ls.getItem(MIRROR); return ls; } catch (e) { return null; }
  }

  /**
   * The store. `env` replaces the browser's pieces in tests: `idb` (an IndexedDB
   * factory, or null), `ls` (a Storage, or null), `nav` (for navigator.storage),
   * `now` (a clock).
   */
  function createStore(env) {
    const E = env || {};
    const idb = 'idb' in E ? E.idb : (typeof indexedDB !== 'undefined' ? indexedDB : null);
    const ls = 'ls' in E ? E.ls : safeLocalStorage();
    const nav = 'nav' in E ? E.nav : (typeof navigator !== 'undefined' ? navigator : null);
    const now = E.now || (() => Date.now());
    let files = new Map();
    let deleted = {};
    let db = null, dbFailed = !idb, mirrorFailed = !ls;
    const listeners = [];

    // localStorage: { v: 1, files: [...], deleted: { id: when } }
    function readMirror() {
      if (!ls) return { files: [], deleted: {} };
      try {
        const v = JSON.parse(ls.getItem(MIRROR) || 'null');
        return v && Array.isArray(v.files) ? { files: v.files, deleted: v.deleted && typeof v.deleted === 'object' ? v.deleted : {} } : { files: [], deleted: {} };
      } catch (e) { return { files: [], deleted: {} }; }
    }
    function writeMirror() {
      if (!ls) return false;
      // forget deletions older than 90 days: by then every tab has seen them
      const cut = now() - 90 * 864e5;
      for (const [id, when] of Object.entries(deleted)) if (when < cut) delete deleted[id];
      try {
        ls.setItem(MIRROR, JSON.stringify({ v: 1, files: [...files.values()], deleted }));
        mirrorFailed = false;
        return true;
      } catch (e) { mirrorFailed = true; return false; }
    }

    // IndexedDB
    function openDb() {
      if (db) return db;
      db = new Promise((resolve, reject) => {
        let req;
        try { req = idb.open(DB_NAME, 1); } catch (e) { reject(e); return; }
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE, { keyPath: 'id' }); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB would not open'));
        req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
      });
      db.catch(() => { dbFailed = true; });
      return db;
    }
    function tx(mode, fn) {
      if (!idb || dbFailed) return Promise.resolve(null);
      return openDb().then((d) => new Promise((resolve, reject) => {
        const t = d.transaction(DB_STORE, mode);
        const s = t.objectStore(DB_STORE);
        const out = fn(s);
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : true);
        t.onerror = () => reject(t.error || new Error('IndexedDB failed'));
        t.onabort = () => reject(t.error || new Error('IndexedDB aborted'));
      })).then((r) => { dbFailed = false; return r; }, (e) => { dbFailed = true; if (typeof console !== 'undefined') console.warn('stomp: IndexedDB:', e && e.message); return null; });
    }

    const sorted = () => [...files.values()].sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }));

    const api = {
      /** Read the localStorage copy now, so the list shows at once. */
      init() {
        const m = readMirror();
        deleted = Object.assign({}, m.deleted);
        files = merge(m.files, [], deleted);
        return sorted();
      },
      /** Read IndexedDB and merge it in. Resolves with the ids whose text changed. */
      async load() {
        const fromDb = await tx('readonly', (s) => s.getAll());
        const m = readMirror();
        Object.assign(deleted, m.deleted);
        const before = new Map([...files].map(([id, f]) => [id, f.source]));
        files = merge(merge(m.files, [...files.values()], deleted).values(), fromDb || [], deleted);
        // each side gets what it missed
        if (fromDb) {
          const have = new Map(fromDb.map((f) => [f.id, f.modified || 0]));
          const stale = [...files.values()].filter((f) => !have.has(f.id) || have.get(f.id) < (f.modified || 0));
          const gone = fromDb.filter((f) => !files.has(f.id)).map((f) => f.id);
          if (stale.length || gone.length) await tx('readwrite', (s) => { stale.forEach((f) => s.put(f)); gone.forEach((id) => s.delete(id)); });
        }
        writeMirror();
        return [...files.keys()].filter((id) => before.has(id) && before.get(id) !== files.get(id).source);
      },
      list: sorted,
      get: (id) => files.get(id) || null,
      byName: (name) => [...files.values()].find((f) => f.name.toLowerCase() === String(name).toLowerCase()) || null,
      names: () => [...files.values()].map((f) => f.name),
      /** A new file: resolves with it once saved (or with `saved: false` if neither copy took). */
      async create(name, source) {
        const t = now();
        const f = { id: newId(), name: uniqueName(cleanName(name) || 'Untitled', api.names()), source: String(source || ''), created: t, modified: t };
        files.set(f.id, f);
        return Object.assign({ file: f }, await write(f));
      },
      async save(id, source) {
        const f = files.get(id);
        if (!f) return { ok: false };
        if (f.source === source) return { ok: true, same: true };
        const g = Object.assign({}, f, { source: String(source), modified: Math.max(now(), (f.modified || 0) + 1) });
        files.set(id, g);
        return write(g);
      },
      async rename(id, name) {
        const f = files.get(id);
        const clean = cleanName(name);
        if (!f || !clean) return { ok: false };
        const g = Object.assign({}, f, { name: clean, modified: Math.max(now(), (f.modified || 0) + 1) });
        files.set(id, g);
        return write(g);
      },
      async remove(id) {
        if (!files.has(id)) return { ok: false };
        files.delete(id);
        deleted[id] = now();
        const mirrored = writeMirror();
        const r = await tx('readwrite', (s) => s.delete(id));
        return { ok: mirrored || r != null };
      },
      /** Ask the browser to keep this site's storage (no prompt in most browsers). true, false, or null if it can't say. */
      async persist() {
        const st = nav && nav.storage;
        if (!st || typeof st.persist !== 'function') return null;
        try { if (typeof st.persisted === 'function' && await st.persisted()) return true; return !!(await st.persist()); } catch (e) { return null; }
      },
      async persisted() {
        const st = nav && nav.storage;
        if (!st || typeof st.persisted !== 'function') return null;
        try { return !!(await st.persisted()); } catch (e) { return null; }
      },
      /** Where saving works: { idb, mirror }, each true while its last write took. */
      status: () => ({ idb: !!idb && !dbFailed, mirror: !!ls && !mirrorFailed }),
      /** Changes made in another tab: fn(changedIds). */
      onChange(fn) { listeners.push(fn); },
      /** Call with a `storage` event; true if it was ours. */
      handleStorageEvent(e) {
        if (!e || e.key !== MIRROR) return false;
        const m = readMirror();
        Object.assign(deleted, m.deleted);
        const before = new Map([...files].map(([id, f]) => [id, f.modified]));
        files = merge(m.files, [...files.values()], deleted);
        const changed = [...new Set([...before.keys(), ...files.keys()])].filter((id) => before.get(id) !== (files.get(id) && files.get(id).modified));
        if (changed.length) listeners.forEach((fn) => fn(changed));
        return true;
      },
    };

    async function write(f) {
      const mirrored = writeMirror();
      const stored = await tx('readwrite', (s) => s.put(f));
      return { ok: mirrored || stored != null, idb: stored != null, mirror: mirrored };
    }
    return api;
  }

  /**
   * The files in a .zip: [{ name, data: Uint8Array }]. Stored entries are read as they
   * are; deflated ones need the browser's DecompressionStream. Folders are skipped.
   */
  async function readZip(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('the zip file is damaged');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = u8.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8 && typeof DecompressionStream === 'function') {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error(`can't read ${name}: it's compressed in a way this browser can't open`);
      out.push({ name, data });
    }
    return out;
  }

  /** A .zip of stored (uncompressed) files. Takes [{ name, data: Uint8Array }], returns a Uint8Array. */
  let CRC = null;
  function crc32(u8) {
    if (!CRC) {
      CRC = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function toZip(files, when) {
    const d = when || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const enc = (t) => new TextEncoder().encode(t);
    const parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc(f.name), data = f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, off, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    }
    let cdSize = 0;
    for (const x of central) cdSize += x.length;
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(off + cdSize + 22);
    let k = 0;
    for (const x of all) { out.set(x, k); k += x.length; }
    return out;
  }

  return { createStore, cleanName, uniqueName, diskName, merge, readZip, toZip, MIRROR };
});
