/* stomp: wires the editor, compiler, viewers, your files and the docs together. */
// The engine is WebAssembly (engine.js): everything starts once it has loaded
window.Stomp.ready.then(function () {
  'use strict';
  const S = window.Stomp;
  const $ = (id) => document.getElementById(id);
  const KEY = 'stomp:v1', OLD_KEY = 'stomp-live:v1';    // the editor's settings and example edits

  // Where to put the cursor when an example opens, so its most interesting
  // statement is already highlighted and dimensioned.
  const SHOWCASE = {
    'to252.stomp': 'pad 2 inner is 1.9 above pad 1',
    'usb_microb.stomp': 'span pad "SH3" to pad "SH4" is 8.0',
    'soic8.stomp': 'lead gullwing',
    'qfn32.stomp': 'paste: divide',
    'sot23-5.stomp': 'right: 4, nc, 5',
    'tssop20.stomp': 'lead gullwing b x L span: E',
    'soic_family.stomp': 'footprint "SOIC-16W"',
    'r0402.stomp': 'gap: 0.5',
    'bga64.stomp': 'omit A1, H8',
    'dip8.stomp': 'span: 300mil centers',
    'hdr2x5.stomp': 'origin at pad 1',
    'syntax_zoo.stomp': 'gap pad 6 to pad 7 is 70',
    'qfn_library.stomp': '  32   5    3.45',
    'sot223.stomp': 'lead 4 gullwing',
    'do41.stomp': 'body cylinder',
    'crystal3225.stomp': 'refdes: "Y"',
    'custom_models.stomp': 'feature can_vent(D)',
    'chip_library.stomp': '"0603"  "1608"  1.6   0.8   0.45',
    'sot_library.stomp': '"SOT-23"           1.3',
    'sop_library.stomp': '  8    4.9',
    'qfp_library.stomp': '  100   14   0.5   0.22',
    'dfn_library.stomp': '  8    3    3     0.65',
    'bga_library.stomp': '  8    8    0.8   8     0.4',
    'diode_library.stomp': '"SMA"  "DO-214AC"',
    'tantalum_library.stomp': '"B"   "3528-21"',
    'polymer_cap_library.stomp': '  6.3   5.4    0.65',
    'inductor_library.stomp': '  4.0   4.0   2.0',
    'crystal_library.stomp': '"3225"  3.2   2.5   0.7',
    'led_library.stomp': '  6    "5050"',
    'dip_library.stomp': '  8    375',
    'header_library.stomp': '  5\n  6\n  7\n  8\n  10',
    'tht_parts.stomp': 'body shape: to92',
  };
  // Libraries open on the Library view rather than a single footprint
  const opensInLibrary = (file) => file.endsWith('_library.stomp');
  // Examples about the 3D model, which open on it
  const OPEN_IN_3D = new Set(['sot223.stomp', 'do41.stomp', 'crystal3225.stomp', 'custom_models.stomp', 'tht_parts.stomp']);
  const TAB_LIMIT = 5;          // more footprints than this: a dropdown instead of tabs

  const store = {
    load() {
      try { return JSON.parse(localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY) || '{}') || {}; } catch (e) { return {}; }
    },
    save(v) {
      try { localStorage.setItem(KEY, JSON.stringify(v)); localStorage.removeItem(OLD_KEY); } catch (e) { /* storage unavailable: edits live for this visit only */ }
    },
  };
  const saved = store.load();
  const examples = S.examples || [];
  const byFile = new Map(examples.map((e) => [e.file, e]));
  // The standard library's files open as editable buffers too. Edits to them apply
  // everywhere, and while one is open the preview shows an example that uses it.
  const libFiles = S.stdlib || [];
  const byLib = new Map(libFiles.map((f) => [`stdlib/${f.file}`, Object.assign({}, f, { file: `stdlib/${f.file}`, name: f.file })]));
  // The example a library file previews with, and the footprint to show from it (first if none)
  const LIB_PREVIEW = {
    'colors.stomp': 'chip_library.stomp', 'marks.stomp': 'diode_library.stomp', 'molded.stomp': 'sop_library.stomp',
    'leadless.stomp': 'qfn_library.stomp', 'chips.stomp': 'chip_library.stomp', 'arrays.stomp': 'bga_library.stomp',
    'cans.stomp': 'cp_radial.stomp', 'through_hole.stomp': 'header_library.stomp', 'modules.stomp': 'syntax_zoo.stomp',
    'silk.stomp': 'tantalum_library.stomp', 'packages.stomp': 'tht_parts.stomp#TO-220-3_Vertical',
    'leds.stomp': 'tht_parts.stomp#LED_D5.0mm', 'shapes.stomp': 'tht_parts.stomp#RotaryEncoder_12x12mm_Vertical',
    'symbols.stomp': 'tht_parts.stomp#RotaryEncoder_12x12mm_Vertical',
  };
  const LIB_2D = new Set(['silk.stomp', 'symbols.stomp']);   // library files about the silk preview in 2D
  /** The open library file's preview: { file, fp }, or null outside the library. */
  const previewOf = () => {
    if (!inLib()) return null;
    const [file, fp] = (LIB_PREVIEW[byLib.get(state.file).name] || examples[0].file).split('#');
    return { file, fp: fp || null };
  };
  const inLib = () => byLib.has(state.file);

  // Your files, saved in this browser (store.js), open as `my:ID`
  const fstore = S.store.createStore();
  fstore.init();
  const MY = 'my:';
  const myId = (file) => (file && file.startsWith(MY) ? file.slice(MY.length) : null);
  // Code from the docs, opened with Try it, as `doc:PAGE:N`
  const docPages = (S.docs && S.docs.pages) || [];
  function docSource(file) {
    const m = /^doc:([a-z]+):(\d+)$/.exec(file || '');
    const page = m && docPages.find((p) => p.key === m[1]);
    const snip = page && page.snippets[+m[2]];
    return snip ? { file, source: snip.code, title: `${page.nav}: ${snip.heading || page.title}`, page, k: +m[2], snip } : null;
  }
  function sourceOf(file) {
    const id = myId(file);
    if (id) { const f = fstore.get(id); return f ? { file, source: f.source, title: f.name, my: f } : null; }
    return byFile.get(file) || byLib.get(file) || docSource(file);
  }
  /** 'my' (yours), 'example', 'lib' (the standard library) or 'doc' (code from the docs). */
  const kindOf = (file) => (myId(file) ? 'my' : byLib.has(file) ? 'lib' : /^doc:/.test(file || '') ? 'doc' : 'example');
  /** The standard library to compile with: null for the embedded one, else the files with their edits. */
  function stdlibNow() {
    let edited = false;
    const list = libFiles.map((f) => {
      const key = `stdlib/${f.file}`;
      const text = key === state.file ? editor.getValue() : state.buffers[key];
      if (text != null && text !== f.source) { edited = true; return { file: f.file, source: text }; }
      return f;
    });
    return edited ? list : null;
  }

  const state = {
    file: null,
    buffers: saved.buffers && typeof saved.buffers === 'object' ? saved.buffers : {},
    units: saved.units === 'mil' ? 'mil' : 'mm',
    out: null,
    active: null,
    lastGood: new Map(),
    hover: null,
    selected: null,
    cursor: 0,
    view: 'fp',           // 'fp' (one footprint) or 'lib' (every footprint in the file)
    dim: saved.dim === '3d' ? '3d' : '2d',      // the drawing, or the 3D model on a board
    board3d: saved.board3d !== false,
    crt3d: saved.crt3d !== false,
    saving: null,         // your file: 'pending', 'saved' or 'failed'
    persisted: null,      // whether the browser keeps this site's storage for good (null: can't say)
  };

  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.save({
      file: state.file, buffers: state.buffers, units: state.units, layers: viewer.layers(),
      dim: state.dim, board3d: state.board3d, crt3d: state.crt3d,
      split: document.querySelector('.panes').style.getPropertyValue('--src-w') || null,
    }), 250);
  }

  // Components
  const editor = S.createEditor($('editor'), {
    id: 'stomp-source',
    onChange(text) {
      if (myId(state.file)) scheduleSave();
      else {
        const ex = sourceOf(state.file);
        if (ex && text === ex.source) delete state.buffers[state.file]; else state.buffers[state.file] = text;
      }
      markEdited();
      persist();
      clearTimeout(compileTimer);
      compileTimer = setTimeout(compileNow, 120);
    },
    onCursor(pos, end) {
      state.cursor = pos;
      state.cursorEnd = end;
      followCursor();
      updateFocus();
    },
  });
  let compileTimer = 0;
  const srcReveal = (s, e, select) => { if (!inLib()) editor.reveal(s, e, select); };
  const srcMark = (lines) => { if (!inLib()) editor.markLines(lines); };

  const viewer = S.createViewer($('viewer'), {
    onHover(ob) {
      state.hover = ob;
      if (!ob || !ob.src) { srcMark([]); highlightRow(null); return; }
      srcMark(linesOf(ob.src));
      highlightRow(ob);
    },
    onPick(ob) {
      if (!ob) return;
      const r = ob.def || (ob.src && ob.src[0]);
      if (r) srcReveal(r.s, r.s, true);
      highlightRow(ob, true);
    },
    onCursor(p) {
      if (state.dim === '3d') return;
      $('tb-cursor').textContent = p ? `${fmt(p[0])}, ${fmt(p[1])} ${state.units}` : '—';
    },
    onCamera(cam) {
      if (state.dim === '3d') return;
      const ratio = cam.s / (96 / 25.4);   // screen pixels per mm, against a 96-dpi "real size"
      $('tb-scale').textContent = ratio >= 1 ? `≈ ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} : 1` : `≈ 1 : ${(1 / ratio).toFixed(1)}`;
      const g = viewer && viewer.gridStep ? viewer.gridStep() : null;
      $('tb-grid').textContent = g ? `${fmt(g)} ${state.units}` : '—';
    },
  });

  function fmt(v) { return S.fmtLen(v, state.units); }

  // The theme: dark unless you choose light. The choice is kept in this browser, and a
  // script in index.html's head applies it before anything is drawn.
  const THEME_KEY = 'stomp:theme';
  const isDark = () => document.documentElement.dataset.stompTheme !== 'light';
  function setTheme(light) {
    if (light) document.documentElement.dataset.stompTheme = 'light';
    else delete document.documentElement.dataset.stompTheme;
    try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch (e) { /* storage unavailable: for this visit only */ }
    syncTheme();
    document.dispatchEvent(new Event('stomp:theme'));   // the 3D views relight
  }
  function syncTheme() {
    const b = $('theme-btn');
    b.title = isDark() ? 'Use the light theme' : 'Use the dark theme';
    b.setAttribute('aria-label', b.title);
  }
  syncTheme();
  $('theme-btn').addEventListener('click', () => setTheme(isDark()));

  // 3D: the model on a board, built when first shown and cached with its result
  const view3 = S.createViewer3D($('viewer3d'), {
    dark: isDark,
    onCamera(c) {
      if (state.dim !== '3d') return;
      const a = ((Math.round(c.az) % 360) + 360) % 360, e = Math.round(c.el);
      $('tb-scale').textContent = e >= 89 ? 'from above' : e <= -89 ? 'from below' : `${a}° round, ${Math.abs(e)}° ${e >= 0 ? 'above' : 'below'}`;
    },
  });
  const models = new WeakMap();
  function modelFor(r) {
    let m = models.get(r);
    if (!m) {
      try {
        const model = S.model3d.build(r);
        m = { model, board: S.model3d.board(r, model) };
      } catch (err) {
        console.error(err);
        m = { model: { meshes: [], notes: ['the 3D model could not be built: ' + err.message], bbox: null }, board: null };
      }
      models.set(r, m);
    }
    return m;
  }

  // The picker: your files, the code from the docs that's open, the examples and the standard library
  const sel = $('example');
  const option = (value, text, title) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    if (title) o.title = title;
    return o;
  };
  function renderPicker() {
    sel.innerHTML = '';
    const mine = document.createElement('optgroup');
    mine.label = 'My files';
    const list = fstore.list();
    for (const f of list) mine.appendChild(option(MY + f.id, f.name, 'Your file, saved in this browser'));
    if (!list.length) { const o = option('', 'None yet: File, then New file or Save as'); o.disabled = true; mine.appendChild(o); }
    sel.appendChild(mine);
    const d = docSource(state.file);
    if (d) {
      const g = document.createElement('optgroup');
      g.label = 'From the docs';
      g.appendChild(option(d.file, d.title));
      sel.appendChild(g);
    }
    const groups = new Map();
    for (const ex of examples) {
      let g = groups.get(ex.group);
      if (!g) {
        g = document.createElement('optgroup');
        g.label = ex.group === 'Parts' ? 'Examples' : ex.group === 'Libraries' ? 'Example libraries' : ex.group || 'Examples';
        sel.appendChild(g);
        groups.set(ex.group, g);
      }
      g.appendChild(option(ex.file, ex.title, ex.blurb));
    }
    if (libFiles.length) {
      const g = document.createElement('optgroup');
      g.label = 'Standard library';
      for (const f of byLib.values()) g.appendChild(option(f.file, `stdlib: ${f.title}`, `${f.blurb ? f.blurb + '. ' : ''}Edit it to change every model that uses it.`));
      sel.appendChild(g);
    }
    sel.value = state.file || '';
  }
  sel.addEventListener('change', () => { if (sel.value) openFile(sel.value); });
  $('reset').addEventListener('click', () => {
    delete state.buffers[state.file];
    persist();
    openFile(state.file, true);
  });

  /** Open a file: yours, an example, a standard library file or code from the docs. */
  function openFile(file, fresh) {
    flushSave();
    const ex = sourceOf(file) || sourceOf(defaultFile());
    if (!ex) return;
    state.file = ex.file;
    const kind = kindOf(ex.file);
    const edited = kind === 'my' ? null : state.buffers[ex.file];
    editor.setValue(edited != null ? edited : ex.source);
    state.active = null;
    state.saving = kind === 'my' ? 'saved' : null;
    if (kind === 'lib') {
      // a library file: show the example it previews with, in 3D (its silk marks in 2D)
      state.view = 'fp';
      state.dim = LIB_2D.has(ex.name) ? '2d' : '3d';
    } else if (kind === 'example') {
      state.view = opensInLibrary(ex.file) && edited == null ? 'lib' : 'fp';
      if (OPEN_IN_3D.has(ex.file) && (edited == null || fresh)) state.dim = '3d';
    } else {
      state.view = 'fp';
    }
    renderPicker();
    markEdited();
    compileNow();
    if (kind === 'example' && (edited == null || fresh)) {
      const needle = SHOWCASE[ex.file];
      const at = needle ? ex.source.indexOf(needle) : -1;
      editor.reveal(at >= 0 ? at : 0, at >= 0 ? at : 0, false);
    } else {
      editor.reveal(0, 0, false);
    }
    persist();
  }
  const defaultFile = () => (byFile.has('to252.stomp') ? 'to252.stomp' : (examples[0] && examples[0].file));

  function markEdited() {
    const kind = kindOf(state.file);
    const ex = sourceOf(state.file);
    const edited = kind !== 'my' && ex && state.buffers[state.file] != null;
    const pv = previewOf();
    let label, title = '', status = '';
    if (kind === 'my') {
      label = `${ex.title}.stomp`;
      title = 'Your file, saved in this browser as you type. File, then Save to disk, keeps a copy on your computer.';
      status = state.saving === 'pending' ? 'saving…' : state.saving === 'failed' ? 'not saved' : 'saved in this browser';
    } else if (kind === 'doc') {
      label = ex.title;
      title = 'Code from the docs. File, then Save as, keeps a copy in your files.';
    } else if (kind === 'lib') {
      label = state.file;
      title = 'A standard library file: edit it and every model that uses it follows.';
    } else {
      label = `examples/${state.file}`;
      title = 'An example. Your edits are kept until you press Reset; File, then Save as, keeps a copy in your files.';
    }
    $('file-name').textContent = `${label}${edited ? ' •' : ''}${pv ? ` (shown on ${pv.file})` : ''}`;
    $('file-name').title = (edited ? 'Edited. Reset restores the original. ' : '') + title;
    $('file-status').textContent = status;
    $('file-status').classList.toggle('bad', state.saving === 'failed' && kind === 'my');
    const back = $('back-docs');
    back.hidden = kind !== 'doc';
    if (kind === 'doc') back.textContent = `Back to the ${ex.page.nav.toLowerCase()}`;
    $('reset').hidden = kind === 'my';
    $('reset').disabled = !edited;
    $('reset').title = kind === 'doc' ? 'Discard your edits to this code' : kind === 'lib' ? 'Discard your edits to this library file' : 'Discard your edits to this example';
  }

  // Compile
  function compileNow() {
    clearTimeout(compileTimer);
    const text = editor.getValue();
    const t0 = performance.now();
    const lib = stdlibNow();
    const opts = lib ? { stdlib: lib } : undefined;
    // a library file shows the example it previews with
    let src = text;
    const pv = previewOf();
    if (pv) src = state.buffers[pv.file] != null ? state.buffers[pv.file] : (byFile.get(pv.file) || examples[0]).source;
    let out;
    try {
      out = S.compile(src, opts);
    } catch (err) {
      out = { diagnostics: [{ severity: 'error', message: 'internal error: ' + err.message, s: 0, e: 0, line: 1, col: 1, endLine: 1, endCol: 1 }], footprints: [], templates: [] };
      console.error(err);
    }
    const ms = performance.now() - t0;
    state.out = out;
    state.srcText = src;
    $('compile-ms').textContent = `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
    if (!out.footprints.some((f) => f.name === state.active)) {
      const want = pv ? out.footprints.find((f) => f.name === pv.fp) : null;
      state.active = (want && want.name) || (pv ? null : fpAt(state.cursor)) || (out.footprints[0] && out.footprints[0].name) || null;
    }
    renderTabs();
    applyView();
    showActive();
  }

  /**
   * The problems to show: the file's own; the 3D model's, for the footprint on
   * screen (it's built only when shown); and those of any edited library file.
   * Those not in the editor's text have no line.
   */
  function refreshProblems(shown) {
    const out = state.out;
    if (!out) return;
    const lib = inLib();
    const text = editor.getValue();
    const libDiags = (out.library && out.library.diagnostics) || [];
    let here, away = [];
    if (lib) {
      const name = byLib.get(state.file).name;
      here = S.compiler.locate(libDiags.filter((d) => d.file === name), text);
      away = libDiags.filter((d) => d.file !== name).map((d) => Object.assign({}, d, { message: `stdlib/${d.file}: ${d.message}` }));
    } else {
      here = out.diagnostics.slice();
      away = libDiags.map((d) => Object.assign({}, d, { message: `stdlib/${d.file} (edited): ${d.message}` }));
    }
    if (shown && shown.model && !shown.model.none) {
      const md = (modelFor(shown).model.diagnostics || []).map((d) => Object.assign({}, d, { footprint: state.active }));
      if (lib) away = away.concat(md.map((d) => Object.assign({}, d, { message: `${state.active}: ${d.message}` })));
      else here = here.concat(S.compiler.locate(md, text));
    }
    editor.setDiagnostics(here);
    renderProblems(here.concat(away.map((d) => Object.assign({}, d, { line: null }))));
  }

  function fpAt(offset) {
    const out = state.out;
    if (!out) return null;
    const fp = out.footprints.find((f) => offset >= f.s && offset <= f.e);
    if (fp) return fp.name;
    // anywhere on a table row's line (e.g. in its leading spaces) counts as that row
    const text = editor.getValue();
    const ls = text.lastIndexOf('\n', offset - 1) + 1;
    let le = text.indexOf('\n', offset);
    if (le < 0) le = text.length;
    const row = out.footprints.find((f) => f.origin && f.origin.kind === 'row' && f.s >= ls && f.s <= le);
    if (row) return row.name;
    // a table's header (or a template) shows one of the footprints it makes
    const group = (out.tables || []).concat(out.templates || []).find((x) => offset >= x.s && offset <= x.e);
    if (group && group.users.length) return group.users.includes(state.active) ? state.active : group.users[0];
    return null;
  }

  function followCursor() {
    if (inLib()) return;
    const name = fpAt(state.cursor);
    if (name && name !== state.active) {
      state.active = name;
      renderTabs();
      showActive();
      if (state.view === 'lib') markActiveCard(true);
    }
  }

  function updateFocus() {
    if (inLib()) { viewer.setFocus([]); view3.setFocus([]); return; }
    const text = editor.getValue();
    const a = Math.min(state.cursor, state.cursorEnd == null ? state.cursor : state.cursorEnd);
    const b = Math.max(state.cursor, state.cursorEnd == null ? state.cursor : state.cursorEnd);
    const s = text.lastIndexOf('\n', a - 1) + 1;
    let e = text.indexOf('\n', b);
    if (e < 0) e = text.length;
    viewer.setFocus([{ s, e }]);
    view3.setFocus([{ s, e }]);
  }

  function showActive() {
    const fp = state.out && state.out.footprints.find((f) => f.name === state.active);
    const host = $('viewer');
    // A syntax error inside this footprint (or its template / parent) is almost
    // always a half-typed line: keep showing the last syntax-clean version.
    const syntaxHit = fp && state.out.diagnostics.some((d) => d.syntax && fp.deps.some((r) => d.s >= r.s && d.s <= r.e));
    let shown = null, stale = false;
    if (fp && fp.result && !syntaxHit) { shown = fp.result; state.lastGood.set(fp.name, fp.result); }
    else if (fp && state.lastGood.has(fp.name)) { shown = state.lastGood.get(fp.name); stale = true; }
    else if (fp) shown = fp.result;
    host.classList.toggle('stale', stale);
    $('viewer3d').classList.toggle('stale', stale);
    viewer.render(shown);
    state.shown = shown;
    $('tb-name').textContent = fp ? fp.name : '—';
    if (state.dim === '3d' && state.view === 'fp') show3d(fp, shown);
    renderDetails(fp, shown);
    refreshProblems(shown);
    updateFocus();
  }

  function show3d(fp, r) {
    if (!r) { view3.show(null, null, fp ? fp.name : null); $('tb-cursor').textContent = '—'; $('tb-grid').textContent = '—'; return; }
    const { model, board } = modelFor(r);
    view3.show(model, board, fp ? fp.name : null);
    $('tb-cursor').textContent = model.none ? 'none' : (model.short || '—');
    $('tb-grid').textContent = model.style && !model.none ? `${fmt(model.top != null ? model.top : model.H)} / ${fmt(model.standoff)} ${state.units}` : '—';
  }

  // Tabs
  function errorNames() {
    return new Set((state.out ? state.out.diagnostics : []).filter((d) => d.severity === 'error' && d.footprint).map((d) => d.footprint));
  }


  function renderTabs() {
    const tabs = $('tabs');
    const fps = state.out ? state.out.footprints : [];
    const errs = errorNames();
    const many = fps.length > TAB_LIMIT;
    const pick = $('fp-select');
    $('view-seg').hidden = fps.length < 2;
    $('lib-n').textContent = fps.length >= 2 ? String(fps.length) : '';
    if (fps.length < 2 && state.view === 'lib') state.view = 'fp';
    tabs.hidden = many || state.view === 'lib';
    pick.hidden = !many || state.view === 'lib';
    tabs.innerHTML = '';
    if (many) {
      // grouped by where each footprint comes from: tables, then everything else
      pick.innerHTML = '';
      let group = null, groupKey = null;
      for (const f of fps) {
        const key = f.origin && f.origin.kind === 'row' ? `t${f.origin.tableS}` : 'other';
        if (key !== groupKey) {
          groupKey = key;
          group = document.createElement('optgroup');
          const t = key === 'other' ? null : (state.out.tables || []).find((x) => x.s === f.origin.tableS);
          group.label = t ? `${t.head}: ${t.users.length} rows` : 'footprints';
          pick.appendChild(group);
        }
        const o = document.createElement('option');
        o.value = f.name;
        o.textContent = (errs.has(f.name) || !f.result ? '⚠ ' : '') + f.name;
        o.selected = f.name === state.active;
        group.appendChild(o);
      }
      return;
    }
    for (const f of fps) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(f.name === state.active));
      b.textContent = f.name;
      if (errs.has(f.name) || !f.result) {
        const dot = document.createElement('span');
        dot.className = 'bad';
        dot.title = 'has errors';
        b.appendChild(dot);
      }
      b.addEventListener('click', () => openFootprint(f.name));
      tabs.appendChild(b);
    }
    const on = tabs.querySelector('[aria-selected="true"]');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Show one footprint and put the editor on the statement (or table row) that makes it. */
  function openFootprint(name) {
    const f = state.out && state.out.footprints.find((x) => x.name === name);
    if (!f) return;
    state.active = name;
    state.view = 'fp';
    renderTabs();
    showActive();
    applyView();
    srcReveal(f.nameS, f.nameS, false);
  }
  $('fp-select').addEventListener('change', (e) => openFootprint(e.target.value));
  document.querySelectorAll('#view-seg [data-view]').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    renderTabs();
    applyView();
    if (state.view === 'fp') showActive();
  }));

  // Library
  function applyView() {
    const lib = state.view === 'lib';
    const d3 = state.dim === '3d';
    document.querySelectorAll('#view-seg [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    document.querySelectorAll('#dim-seg [data-dim]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dim === state.dim)));
    $('viewer').hidden = lib || d3;
    $('viewer3d').hidden = lib || !d3;
    $('layerbar').hidden = lib || d3;
    $('bar3d').hidden = lib || !d3;
    $('tb-k2').textContent = d3 ? 'Model' : 'Cursor';
    $('tb-k3').textContent = d3 ? 'Height / standoff' : 'Grid';
    $('tb-k4').textContent = d3 ? 'View' : 'Scale';
    $('titleblock').hidden = lib;
    $('details').hidden = lib;
    $('fit').hidden = lib;
    $('dim-seg').hidden = lib;
    $('library').hidden = !lib;
    if (lib) renderLibrary();
  }
  document.querySelectorAll('#dim-seg [data-dim]').forEach((b) => b.addEventListener('click', () => {
    if (state.dim === b.dataset.dim) return;
    state.dim = b.dataset.dim;
    applyView();
    showActive();
    if (state.dim === '2d') { $('tb-cursor').textContent = '—'; viewer.fit(); }   // the 2D readouts come back
    persist();
  }));

  const thumbs = new WeakMap();    // result to SVG markup (cached results keep their thumbnails)
  function thumb(r) {
    if (thumbs.has(r)) return thumbs.get(r);
    const P = S.svgPaths;
    const b = r.coreBox;
    const m = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.08 + 0.15;
    const vb = [b.x0 - m, -(b.y1 + m), b.x1 - b.x0 + 2 * m, b.y1 - b.y0 + 2 * m].map((v) => +v.toFixed(4));
    let svg = `<svg viewBox="${vb.join(' ')}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`;
    if (r.body) svg += `<path class="fab" d="${P.poly(r.body.outline, true)}"></path>`;
    for (const p of r.pads) svg += `<path class="pad" d="${P.contour(p.copper)}"></path>`;
    for (const p of r.pads) if (p.drillShape) svg += `<path class="drill" d="${P.contour(p.drillShape)}"></path>`;
    for (const h of r.holes) svg += `<path class="npth" d="${P.contour(h.land)}"></path>`;
    svg += '</svg>';
    thumbs.set(r, svg);
    return svg;
  }

  const lazyThumbs = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target;
      lazyThumbs.unobserve(el);
      if (el._result) el.innerHTML = thumb(el._result);
    }
  }, { root: $('library'), rootMargin: '200px' }) : null;

  function renderLibrary() {
    const box = $('library');
    const out = state.out;
    const fps = out ? out.footprints : [];
    const errs = errorNames();
    const U = state.units;
    const L = (v) => fmt(v);
    const bad = fps.filter((f) => errs.has(f.name) || !f.result).length;
    const tables = (out && out.tables) || [];
    const parts = [`<b>${fps.length} footprint${fps.length === 1 ? '' : 's'}</b>`];
    if (tables.length) parts.push(`${tables.reduce((n, t) => n + t.users.length, 0)} from ${tables.length} table${tables.length === 1 ? '' : 's'}`);
    if (bad) parts.push(`<span class="bad">${bad} with errors</span>`);
    parts.push('click one to open it');
    let html = `<div class="lib-head">${parts.join('<span aria-hidden="true">·</span>')}</div>`;
    let key = null;
    const cards = [];
    fps.forEach((f, i) => {
      const k = f.origin && f.origin.kind === 'row' ? `t${f.origin.tableS}` : 'other';
      if (k !== key) {
        if (key !== null) html += '</div>';
        key = k;
        const t = k === 'other' ? null : tables.find((x) => x.s === f.origin.tableS);
        const label = t ? escapeHtml(t.head) : (tables.length ? 'other footprints' : 'footprints');
        html += `<div class="lib-sec">${t ? `<button type="button" data-goto="${t.s}" title="Go to this table">${label}</button><span class="n">${t.users.length} row${t.users.length === 1 ? '' : 's'}</span>` : `<span class="n">${label}</span>`}</div><div class="lib-grid">`;
      }
      const r = f.result;
      let meta = '';
      if (r) {
        const dims = r.body ? (r.body.kind === 'cyl' ? `⌀${L(r.body.w)} ${U}` : `${L(r.body.w)} × ${L(r.body.l)} ${U}`) : '';
        meta = `${r.pads.length} pad${r.pads.length === 1 ? '' : 's'}${dims ? ' · ' + dims : ''}`;
      }
      const cls = ['card'];
      if (f.name === state.active) cls.push('on');
      if (errs.has(f.name)) cls.push('bad');
      if (!r) cls.push('none');
      html += `<button type="button" class="${cls.join(' ')}" data-i="${i}"><span class="thumb">${r ? '' : 'not drawn'}</span><span class="cname">${escapeHtml(f.name)}</span><span class="cmeta">${meta}</span></button>`;
      cards.push(f);
    });
    if (key !== null) html += '</div>';
    if (!fps.length) html += '<p class="lib-head">Nothing yet. Add a <code>footprint</code>, or a <code>footprints from TEMPLATE</code> table.</p>';
    box.innerHTML = html;
    box.querySelectorAll('.card').forEach((el) => {
      const f = fps[+el.dataset.i];
      const th = el.querySelector('.thumb');
      if (f.result) {
        if (thumbs.has(f.result) || !lazyThumbs) th.innerHTML = thumb(f.result);
        else { th._result = f.result; lazyThumbs.observe(th); }
      }
      el.addEventListener('click', () => openFootprint(f.name));
      el.addEventListener('mouseenter', () => srcMark(linesOf([{ s: f.s, e: f.e }])));
      el.addEventListener('mouseleave', () => srcMark([]));
    });
    box.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => srcReveal(+b.dataset.goto, +b.dataset.goto, true)));
    markActiveCard(false);
  }

  function markActiveCard(scroll) {
    const box = $('library');
    const fps = state.out ? state.out.footprints : [];
    box.querySelectorAll('.card').forEach((el) => {
      const on = fps[+el.dataset.i] && fps[+el.dataset.i].name === state.active;
      el.classList.toggle('on', on);
      if (on && scroll) el.scrollIntoView({ block: 'nearest' });
    });
  }

  // Problems
  function renderProblems(diags) {
    const list = $('problems-list');
    const nErr = diags.filter((d) => d.severity === 'error').length;
    const nWarn = diags.length - nErr;
    $('n-err').textContent = String(nErr);
    $('n-warn').textContent = String(nWarn);
    $('n-err').classList.toggle('zero', !nErr);
    $('n-warn').classList.toggle('zero', !nWarn);
    $('ok-note').hidden = diags.length > 0;
    const multi = state.out && state.out.footprints.length > 1;
    list.innerHTML = '';
    for (const d of diags) {
      const li = document.createElement('li');
      li.className = d.severity;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<span class="sev" aria-label="${d.severity}"></span><span class="where">${d.line != null ? `${d.line}:${d.col}` : '—'}</span><span class="msg">${codeify(d.message)}${multi && d.footprint ? ` <span class="fp">· ${escapeHtml(d.footprint)}</span>` : ''}</span>`;
      if (d.line != null) btn.addEventListener('click', () => editor.reveal(d.s, d.e, true));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }
  $('problems-toggle').addEventListener('click', () => {
    const p = $('problems');
    const collapsed = p.classList.toggle('collapsed');
    $('problems-toggle').setAttribute('aria-expanded', String(!collapsed));
  });

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function codeify(msg) { return escapeHtml(msg).replace(/`([^`]+)`/g, '<code>$1</code>'); }

  // Details
  function renderDetails(fp, shown) {
    const box = $('details');
    const r = shown;
    if (!fp) { box.innerHTML = '<div><h3>Footprint</h3><p class="desc">Add a <code>footprint "NAME"</code> block, closed with <code>end</code>, to see it here.</p></div>'; return; }
    if (!r) { box.innerHTML = `<div><h3>${escapeHtml(fp.name)}</h3><p class="desc">This footprint has errors that stop it from being drawn. See Problems.</p></div>`; return; }
    const U = state.units;
    const L = (v) => fmt(v);
    const m = r.meta;
    const facts = [];
    const fact = (k, v) => facts.push(`<dt>${k}</dt><dd>${v}</dd>`);
    if (r.template) {
      const o = fp.origin || {};
      const where = o.kind === 'row' ? `, row ${o.row} of the table on line ${lineOf(o.tableS)}` : '';
      fact('From', `template <b>${escapeHtml(r.template)}</b>${where ? `<span class="note">${where}</span>` : ''}`);
    }
    if (r.extends) fact('Extends', `"${escapeHtml(r.extends)}"`);
    const smd = r.pads.filter((p) => !p.tht).length, tht = r.pads.length - smd;
    fact('Pads', `${r.pads.length}${tht && smd ? ` <span class="note">(${smd} SMD, ${tht} THT)</span>` : tht ? ' <span class="note">through-hole</span>' : ''}${r.holes.length ? ` + ${r.holes.length} NPTH` : ''}${r.generator && r.generator.omitted.length ? ` <span class="note">(omitted ${escapeHtml(r.generator.omitted.join(', '))})</span>` : ''}`);
    if (r.body) {
      const b = r.body;
      fact('Body', b.axial ? `⌀${L(b.d)} × ${L(b.axial === 'x' ? b.w : b.l)} ${U} <span class="note">cylinder, lying along its leads</span>`
        : b.kind === 'cyl' ? `⌀${L(b.w)}${b.h ? ' × ' + L(b.h) : ''} ${U} <span class="note">cylinder</span>` : `${L(b.w)} × ${L(b.l)}${b.h ? ' × ' + L(b.h) : ''} ${U}`);
    }
    if (r.courtyardBox) {
      const c = r.courtyardBox;
      fact('Courtyard', `${L(c.x1 - c.x0)} × ${L(c.y1 - c.y0)} ${U}${r.courtyardClearance != null ? ` <span class="note">(+${L(r.courtyardClearance)} ${U} clearance)</span>` : ''}`);
    }
    if (r.generator && r.generator.spacing) {
      for (const [ax, sp] of Object.entries(r.generator.spacing)) {
        fact(ax === 'x' ? 'Rows (x)' : 'Rows (y)', `${L(sp.C)} ${U} <span class="note">apart, center to center (${escapeHtml(sp.how)})</span>`);
      }
    }
    if (r.ipcNote) fact('Lands', `<span class="note">${escapeHtml(r.ipcNote)}</span>`);
    fact('Origin', `<span class="note">${escapeHtml(r.originNote || '')}</span>`);
    if (m.refdes) fact('Refdes', escapeHtml(m.refdes));
    if (m.tags) fact('Tags', escapeHtml(m.tags.join(', ')));
    if (m.manufacturer || m.mpn) fact('Part', escapeHtml([m.manufacturer, m.mpn].filter(Boolean).join(' ')));
    if (m.datasheet) fact('Datasheet', `<a href="${escapeHtml(m.datasheet)}" target="_blank" rel="noopener">${escapeHtml(m.datasheet.replace(/^https?:\/\//, ''))}</a>`);
    const md = r.model;
    if (md) {
      let t;
      if (md.none) t = 'none (<code>no model</code>)';
      else if (!r.body && !(md.solids && md.solids.length)) t = '<span class="note">none. Add a <code>body</code> to generate one.</span>';
      else {
        const { model } = modelFor(r);
        const bits = [];
        if (model.style) bits.push(`${L(model.top != null ? model.top : model.H)} ${U} tall, standoff ${L(model.standoff)}`);
        const P = md.props;
        if (P.draft != null) bits.push(`draft ${+P.draft.toFixed(2)}°`);
        if (P.bodyColor) bits.push(`body ${escapeHtml(P.bodyColor.name)}`);
        if (P.leadsColor) bits.push(`leads ${escapeHtml(P.leadsColor.name)}`);
        if (P.thickness != null) bits.push(`leads ${L(P.thickness)} thick`);
        t = `${escapeHtml(model.summary || 'generated')}${bits.length ? ` <span class="note">(${bits.join(', ')})</span>` : ''}`;
        if (md.step) t += `<br><span class="note">uses <code>${escapeHtml(md.step.file)}</code>, which isn't loaded here, so the 3D view shows the generated model</span>`;
        if (state.dim !== '3d') t += ` <button type="button" class="linkish" data-show3d>show in 3D</button>`;
      }
      fact('3D model', t);
    }
    const rows = r.pads.map((p, i) => {
      const sh = p.shape;
      const rot = ((p.rot % 360) + 360) % 360;
      const square = Math.abs(rot / 90 - Math.round(rot / 90)) < 1e-9;
      // sizes along the board axes (x by y); odd angles show the shape's own size and the angle
      const swap = square && Math.round(rot / 90) % 2 === 1;
      const size = sh.kind === 'circle' ? `⌀${L(sh.d)}` : sh.kind === 'polygon' ? `${sh.pts.length}-gon`
        : swap ? `${L(sh.l)} × ${L(sh.w)}` : `${L(sh.w)} × ${L(sh.l)}`;
      const drill = p.drill ? (p.drill.d != null ? `⌀${L(p.drill.d)}` : swap ? `${L(p.drill.slot.l)} × ${L(p.drill.slot.w)}` : `${L(p.drill.slot.w)} × ${L(p.drill.slot.l)}`) : '';
      return `<tr data-i="${i}"><td>${escapeHtml(p.name)}${p.unplaced ? '<span class="badge">unplaced</span>' : ''}</td><td>${sh.kind}${square ? '' : ` <span class="note">↻${+rot.toFixed(2)}°</span>`}</td><td>${size}</td><td class="num">${L(p.x)}</td><td class="num">${L(p.y)}</td><td>${drill}</td></tr>`;
    }).join('');
    box.innerHTML = `
      <div>
        <h3>${escapeHtml(r.name)}</h3>
        ${m.description ? `<p class="desc">${escapeHtml(m.description)}</p>` : ''}
        <dl class="facts">${facts.join('')}</dl>
      </div>
      <div class="padtable-wrap">
        <h3>Pads <span class="note">(${U})</span></h3>
        <table class="padtable"><thead><tr><th>Pad</th><th>Shape</th><th>Size x × y</th><th class="num">X</th><th class="num">Y</th><th>Drill</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    const s3 = box.querySelector('[data-show3d]');
    if (s3) s3.addEventListener('click', () => { const b3 = document.querySelector('#dim-seg [data-dim="3d"]'); if (b3) b3.click(); });
    box.querySelectorAll('.padtable tbody tr').forEach((tr) => {
      const p = r.pads[+tr.dataset.i];
      tr.addEventListener('click', () => { const d = p.def || p.src[0]; if (d) srcReveal(d.s, d.s, true); });
      tr.addEventListener('mouseenter', () => { srcMark(linesOf(p.src)); });
      tr.addEventListener('mouseleave', () => { srcMark([]); });
    });
  }

  function highlightRow(ob, scroll) {
    const box = $('details');
    box.querySelectorAll('.padtable tr.on').forEach((tr) => tr.classList.remove('on'));
    if (!ob || ob.kind !== 'pad') return;
    const r = state.shown;
    if (!r) return;
    const i = r.pads.indexOf(ob);
    const tr = box.querySelector(`.padtable tr[data-i="${i}"]`);
    if (tr) { tr.classList.add('on'); if (scroll) tr.scrollIntoView({ block: 'nearest' }); }
  }

  function lineOf(offset) {
    const text = state.srcText || editor.getValue();
    let n = 1;
    for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }

  function linesOf(ranges) {
    const text = state.srcText || editor.getValue();
    const out = new Set();
    for (const r of ranges || []) {
      let line = 0;
      for (let i = 0; i < r.s && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
      let end = line;
      for (let i = r.s; i < r.e && i < text.length; i++) if (text.charCodeAt(i) === 10) end++;
      for (let l = line; l <= end; l++) out.add(l);
    }
    return [...out];
  }

  // Toolbar
  const LAYERS = [
    ['copper', 'Copper', 'cu'], ['paste', 'Paste', 'paste'], ['mask', 'Mask', 'mask'], ['drills', 'Drills', 'drill'],
    ['silk', 'Silk', 'silk'], ['courtyard', 'Courtyard', 'crt'], ['fab', 'Fab', 'fab'], ['labels', 'Numbers', 'lbl'],
    ['dims', 'Constraints', 'dim'], ['grid', 'Grid', 'grid'],
  ];
  const bar = $('layerbar');
  const savedLayers = saved.layers || {};
  for (const [k, label, sw] of LAYERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    if (k in savedLayers) viewer.setLayer(k, !!savedLayers[k]);
    b.setAttribute('aria-pressed', String(viewer.layers()[k]));
    b.innerHTML = `<i class="sw ${sw}">${sw === 'lbl' ? '12' : ''}</i>${label}`;
    if (k === 'dims') b.title = 'Draw every placement\'s dimension, not just the statement under the cursor';
    b.addEventListener('click', () => {
      const on = !viewer.layers()[k];
      viewer.setLayer(k, on);
      b.setAttribute('aria-pressed', String(on));
      persist();
    });
    bar.appendChild(b);
  }
  document.querySelectorAll('.seg [data-u]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.u === state.units));
    b.addEventListener('click', () => {
      state.units = b.dataset.u;
      document.querySelectorAll('.seg [data-u]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      viewer.setUnits(state.units);
      showActive();
      if (state.view === 'lib') renderLibrary();
      persist();
    });
  });
  viewer.setUnits(state.units);
  $('fit').addEventListener('click', () => (state.dim === '3d' ? view3.fit() : viewer.fit()));

  // Saving files
  // Opened on its own, the page downloads files directly. Embedded by a host (the
  // --fragment build) it can't, but the host's `downloads` capability saves some
  // file types, .zip among them, once the viewer agrees. With neither, exports
  // copy text to the clipboard instead.
  const files = { plain: null, host: null, listeners: [] };
  /* @plain-download */
  files.plain = (filename, data) => {
    const url = URL.createObjectURL(new Blob([data]));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  // Where the browser lets a page ask where to save a file (Chromium, in its own tab),
  // the page asks. True once it's handled, a cancel included.
  files.pick = async (filename, text) => {
    if (typeof window.showSaveFilePicker !== 'function' || window.top !== window) return false;
    try {
      const h = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'stomp file', accept: { 'text/plain': ['.stomp'] } }] });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      toast(`Saved ${h.name}`);
      return true;
    } catch (e) { return !!(e && e.name === 'AbortError'); }
  };
  /* @end-plain-download */
  files.canSave = () => !!(files.plain || files.host);
  files.save = async (filename, data) => {
    if (files.plain) { files.plain(filename, data); return; }
    if (files.host) { await files.host.save({ filename, data: new Blob([data]) }); return; }
    const err = new Error('saving files is not available here');
    err.code = 'unavailable';
    throw err;
  };
  files.onChange = (fn) => files.listeners.push(fn);
  if (!files.plain && window.claude && typeof window.claude.use === 'function') {
    window.claude.use('downloads').then((d) => { if (d) { files.host = d; files.listeners.forEach((fn) => fn()); } }).catch(() => {});
  }
  function saveFailed(e) {
    const code = e && e.code;
    if (code === 'declined') return;
    toast(code === 'rate_limited' ? 'Another save is still waiting for an answer: try again in a moment' : 'This page can\'t save files here', true);
  }

  let toastTimer = 0;
  function toast(text, bad) {
    const t = $('toast');
    t.textContent = text;
    t.classList.toggle('bad', !!bad);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5200);
  }

  // KiCad
  // Every footprint in the file as a KiCad 9 library (.pretty), each with its 3D
  // model embedded. Where nothing can be saved, copy the shown footprint instead.
  const kicadBtn = $('export-kicad');
  const syncKicad = () => {
    const save = files.canSave();
    kicadBtn.textContent = save ? 'Export to KiCad' : 'Copy for KiCad';
    kicadBtn.title = save
      ? 'Save every footprint in this file as a KiCad 9 library (.pretty, zipped), each with its 3D model embedded'
      : 'Copy the shown footprint as a KiCad 9 .kicad_mod, with its 3D model embedded';
  };
  syncKicad();
  files.onChange(syncKicad);
  kicadBtn.addEventListener('click', async () => {
    const out = state.out;
    if (!out || !out.footprints.length) { toast('There are no footprints to export', true); return; }
    const errs = errorNames();
    if (!files.canSave()) {
      const fp = out.footprints.find((f) => f.name === state.active);
      const r = fp && fp.result;
      if (!r || errs.has(fp.name)) { toast('Fix this footprint\'s errors before exporting it', true); return; }
      const o = S.kicad.footprint(r, { name: fp.name, model: modelFor(r).model });
      try {
        await navigator.clipboard.writeText(o.text);
        toast(`Copied ${o.file}: paste it into a file of that name inside a .pretty folder`);
      } catch (e) { toast('Copying to the clipboard failed', true); }
      return;
    }
    const fps = out.footprints.map((f) => {
      const skip = !f.result || errs.has(f.name) ? 'it has errors' : null;
      return { name: f.name, result: f.result, skip, model: skip ? null : modelFor(f.result).model };
    });
    const lib = fileStem();
    const L = S.kicad.library(fps, { lib, source: sourceLabel() });
    if (!L.count) { toast('Nothing to export: every footprint has errors', true); return; }
    try {
      await files.save(`${L.lib}.pretty.zip`, S.store.toZip(L.files));
      const parts = [`${L.count} footprint${L.count === 1 ? '' : 's'}`];
      parts.push(L.models === L.count ? (L.count === 1 ? 'with its 3D model' : 'each with its 3D model') : `${L.models} with a 3D model`);
      toast(`Saved ${L.lib}.pretty.zip: ${parts.join(', ')}${L.skipped.length ? `. Skipped ${L.skipped.length} with errors` : ''}`);
    } catch (e) { saveFailed(e); }
  });

  // 3D bar: board and courtyard, preset views, export
  (function bar3d() {
    const b3 = $('bar3d');
    const chip = (label, on, sw, title, click) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      if (on != null) b.setAttribute('aria-pressed', String(on));
      b.innerHTML = (sw ? `<i class="sw ${sw}"></i>` : '') + label;
      if (title) b.title = title;
      b.addEventListener('click', () => click(b));
      b3.appendChild(b);
      return b;
    };
    view3.setBoard(state.board3d);
    view3.setCourtyard(state.crt3d);
    chip('Board', state.board3d, 'board', 'The board under the part: mask, copper and silk', (b) => {
      state.board3d = !state.board3d; b.setAttribute('aria-pressed', String(state.board3d)); view3.setBoard(state.board3d); persist();
    });
    chip('Courtyard', state.crt3d, 'crt', 'The courtyard outline on the board', (b) => {
      state.crt3d = !state.crt3d; b.setAttribute('aria-pressed', String(state.crt3d)); view3.setCourtyard(state.crt3d); persist();
    });
    const sep = document.createElement('span');
    sep.className = 'bar-sep';
    sep.setAttribute('aria-hidden', 'true');
    b3.appendChild(sep);
    for (const [k, label, title] of [['iso', 'Iso', 'From above, at an angle'], ['top', 'Top', 'Straight down, as the 2D drawing'], ['front', 'Front', 'From the front (−y), level with the board'],
      ['side', 'Side', 'From the right (+x), level with the board'], ['bottom', 'Bottom', 'From below: the board turns see-through']]) {
      chip(label, null, null, title, () => view3.view(k));
    }
    const sp = document.createElement('span');
    sp.className = 'bar-fill';
    b3.appendChild(sp);
    const name = () => (state.active || 'model').replace(/[^\w.+-]+/g, '_');
    const current = () => { const r = state.shown; return r ? modelFor(r).model : null; };
    if (files.plain) {
      chip('VRML', null, null, 'Download the model as VRML 2.0 for KiCad (.wrl, 0.1-inch units)', () => {
        const m = current(); if (m && m.meshes.length) files.save(`${name()}.wrl`, S.model3d.toVRML(m, state.active));
      }).classList.add('export');
      chip('STL', null, null, 'Download the model as binary STL (millimetres)', () => {
        const m = current(); if (m && m.meshes.length) files.save(`${name()}.stl`, S.model3d.toSTL(m, state.active));
      }).classList.add('export');
      return;
    }
    // embedded: the host saves .zip but not .wrl or .stl, so both go out zipped
    const zipChip = chip('Save .zip', null, null, 'Download the model as VRML 2.0 for KiCad (.wrl, 0.1-inch units) and STL (mm), in one .zip', async () => {
      const m = current();
      if (!m || !m.meshes.length) return;
      const nm = name();
      const zip = S.store.toZip([
        { name: `${nm}.wrl`, data: new TextEncoder().encode(S.model3d.toVRML(m, state.active)) },
        { name: `${nm}.stl`, data: S.model3d.toSTL(m, state.active) },
      ]);
      try { await files.save(`${nm}-3d.zip`, zip); } catch (e) { saveFailed(e); }
    });
    zipChip.classList.add('export');
    const copyChip = chip('Copy VRML', null, null, 'Copy the model as VRML 2.0 (KiCad units) to paste into a .wrl file', async () => {
      const m = current();
      if (!m || !m.meshes.length) return;
      try { await navigator.clipboard.writeText(S.model3d.toVRML(m, state.active)); toast('Copied the VRML model to the clipboard'); } catch (e) { toast('Copying to the clipboard failed', true); }
    });
    copyChip.classList.add('export');
    const sync = () => { zipChip.hidden = !files.host; copyChip.hidden = !!files.host; };
    sync();
    files.onChange(sync);
  })();


  // Your files
  /** The open file's name, for files saved from it: `soic8`, `My parts`. */
  function fileStem() {
    const kind = kindOf(state.file);
    const ex = sourceOf(state.file);
    if (kind === 'my') return ex.title;
    if (kind === 'doc') return ex.page.key;
    return (kind === 'lib' ? ex.name : state.file || 'stomp').replace(/\.stomp$/, '');
  }
  /** Where the open file came from, for comments in exported files. */
  function sourceLabel() {
    const kind = kindOf(state.file);
    if (kind === 'my') return `${sourceOf(state.file).title}.stomp`;
    if (kind === 'doc') return `the ${sourceOf(state.file).page.nav.toLowerCase()}`;
    return kind === 'lib' ? state.file : `examples/${state.file}`;
  }

  // Autosave: your file is written a moment after you stop typing, and before
  // another file opens or the page goes away.
  let autosave = 0, edits = 0, warnedSave = false;
  function scheduleSave() {
    edits++;
    state.saving = 'pending';
    clearTimeout(autosave);
    autosave = setTimeout(flushSave, 400);
  }
  async function flushSave() {
    clearTimeout(autosave);
    const id = myId(state.file);
    if (!id || state.saving !== 'pending') return { ok: true };
    const at = edits;
    const r = await fstore.save(id, editor.getValue());
    if (myId(state.file) === id && edits === at) { state.saving = r.ok ? 'saved' : 'failed'; markEdited(); }
    if (!r.ok && !warnedSave) {
      warnedSave = true;
      toast('This browser isn\'t saving your file. Use File, then Save to disk, to keep it.', true);
    }
    return r;
  }
  window.addEventListener('pagehide', () => { flushSave(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

  // Ask the browser to keep the site's storage for good, after you first save a file
  let askedToKeep = false;
  function keepFiles() {
    if (askedToKeep) return;
    askedToKeep = true;
    fstore.persist().then((v) => { if (v != null) state.persisted = v; });
  }
  fstore.persisted().then((v) => { state.persisted = v; });

  const STARTER = `# A new file. The Tutorial, at the top right, goes through the language.

footprint "R0805"
  description: "Chip resistor, 0805"
  refdes: "R"
  body 2.0 x 1.25 x 0.5
  pins 2 horizontal
  lead endcap 0.4
end
`;

  /** A name for a file of yours: the problem with it, or null. */
  const nameProblem = (except) => (v) => {
    const c = S.store.cleanName(v);
    if (!c) return 'Give it a name';
    const other = fstore.byName(c);
    if (other && other.id !== except) return `You already have a file named "${c}"`;
    return null;
  };

  // A name or a yes, asked in the page: a host that sandboxes it ignores prompt() and confirm()
  function ask(o) {
    return new Promise((resolve) => {
      const d = $('ask'), form = $('ask-form'), input = $('ask-input'), err = $('ask-error'), ok = $('ask-ok'), cancel = $('ask-cancel');
      const named = o.value != null;
      $('ask-title').textContent = o.title;
      $('ask-text').textContent = o.text || '';
      $('ask-label').hidden = input.hidden = !named;
      err.textContent = '';
      ok.textContent = o.ok || 'OK';
      ok.className = `btn ${o.danger ? 'danger' : 'primary'}`;
      if (named) input.value = o.value;
      const finish = (v) => {
        form.removeEventListener('submit', onSubmit);
        cancel.removeEventListener('click', onCancel);
        d.removeEventListener('cancel', onCancel);
        if (d.open) d.close();
        resolve(v);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        if (!named) { finish(true); return; }
        const problem = o.validate ? o.validate(input.value) : null;
        if (problem) { err.textContent = problem; input.focus(); return; }
        finish(input.value);
      };
      const onCancel = (e) => { if (e) e.preventDefault(); finish(named ? null : false); };
      form.addEventListener('submit', onSubmit);
      cancel.addEventListener('click', onCancel);
      d.addEventListener('cancel', onCancel);
      if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
      if (named) { input.focus(); input.select(); } else ok.focus();
    });
  }

  /** Save text to disk as NAME.stomp: where you choose, as a download, or zipped through the host. */
  async function saveToDisk(stem, text) {
    const fname = S.store.diskName(stem);
    if (files.plain) {
      if (files.pick && await files.pick(fname, text)) return;
      files.plain(fname, text);
      toast(`Downloaded ${fname}`);
      return;
    }
    if (files.host) {
      // the host saves .zip files but not .stomp ones
      const zname = S.store.diskName(stem, 'zip');
      try {
        await files.save(zname, S.store.toZip([{ name: fname, data: new TextEncoder().encode(text) }]));
        toast(`Saved ${zname}, with ${fname} inside`);
      } catch (e) { saveFailed(e); }
      return;
    }
    copyText(text, 'This page can\'t save files here, so the text is copied instead');
  }

  async function saveAllToDisk() {
    const list = fstore.list();
    if (!list.length) return;
    const used = new Set();
    const entries = list.map((f) => {
      let name = S.store.diskName(f.name);
      for (let k = 2; used.has(name.toLowerCase()); k++) name = S.store.diskName(`${f.name} ${k}`);
      used.add(name.toLowerCase());
      return { name, data: new TextEncoder().encode(f.source) };
    });
    try {
      await files.save('stomp-files.zip', S.store.toZip(entries));
      toast(`Saved stomp-files.zip: ${list.length} file${list.length === 1 ? '' : 's'}`);
    } catch (e) { saveFailed(e); }
  }

  async function copyText(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done || 'Copied the text'); } catch (e) { toast('Copying to the clipboard failed', true); }
  }

  // Opening files from disk: .stomp or .txt files, or a .zip of them
  async function addFile(fileName, text) {
    if (/\u0000/.test(text)) throw new Error('it isn\'t a text file');
    const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const base = S.store.cleanName(fileName.split(/[\\/]/).pop()) || 'Untitled';
    const same = fstore.byName(base);
    if (same && same.source === src) return { file: same, renamed: false, ok: true };
    const r = await fstore.create(base, src);
    return { file: r.file, renamed: r.file.name !== base, ok: r.ok };
  }
  async function importFiles(list) {
    const added = [], notes = [];
    for (const f of list) {
      try {
        if (/\.zip$/i.test(f.name)) {
          const inside = (await S.store.readZip(new Uint8Array(await f.arrayBuffer()))).filter((x) => /\.stomp$/i.test(x.name));
          if (!inside.length) { notes.push(`${f.name} has no .stomp files`); continue; }
          for (const x of inside) added.push(await addFile(x.name, new TextDecoder().decode(x.data)));
        } else if (f.size > 4 * 1024 * 1024) {
          notes.push(`${f.name} is too big for a stomp file`);
        } else {
          added.push(await addFile(f.name, await f.text()));
        }
      } catch (e) { notes.push(`${f.name}: ${e.message}`); }
    }
    if (added.length) {
      closeDocs(true);
      openFile(MY + added[0].file.id);
      keepFiles();
    }
    const first = added[0];
    let msg = !added.length ? '' : added.length === 1
      ? `Opened ${first.file.name}, saved in this browser${first.renamed ? ` (renamed: you had a file of that name)` : ''}`
      : `Opened ${added.length} files, saved in this browser`;
    if (added.some((a) => !a.ok)) msg += '. This browser isn\'t saving files: save them to disk to keep them';
    if (notes.length) msg = [msg, `Not opened: ${notes.join('; ')}`].filter(Boolean).join('. ');
    if (msg) toast(msg, !added.length || added.some((a) => !a.ok));
  }
  $('open-file').addEventListener('change', (e) => {
    const list = [...e.target.files];
    e.target.value = '';
    if (list.length) importFiles(list);
  });

  // Drop files anywhere on the page to open them
  (function dropFiles() {
    const zone = $('drop');
    let depth = 0;
    const hasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.hidden = false; });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; zone.hidden = true; } });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      zone.hidden = true;
      importFiles([...e.dataTransfer.files]);
    });
  })();

  // The File menu
  const menuBtn = $('file-btn'), menu = $('file-menu');
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  menu.querySelectorAll('kbd[data-mod]').forEach((k) => { k.textContent = (isMac ? '⌘' : 'Ctrl+') + k.textContent; });
  function syncMenu() {
    const kind = kindOf(state.file);
    const mine = fstore.list().length;
    const item = (act) => menu.querySelector(`[data-act="${act}"]`);
    item('rename').disabled = kind !== 'my';
    item('delete').disabled = kind !== 'my';
    item('download').textContent = files.host && !files.plain ? 'Save to disk (.zip)' : 'Save to disk';
    item('download').disabled = !files.canSave() && !(navigator.clipboard && navigator.clipboard.writeText);
    item('download-all').disabled = !mine || !files.canSave();
    const st = fstore.status();
    const note = $('store-note');
    note.classList.toggle('bad', !st.idb && !st.mirror);
    note.textContent = !st.idb && !st.mirror ? 'This browser isn\'t letting the page save files, so save your work to disk.'
      : state.persisted === true ? `Your files${mine ? ` (${mine})` : ''} are kept in this browser until you clear its data for this site.`
        : `Your files${mine ? ` (${mine})` : ''} are kept in this browser${state.persisted === false ? ', which may clear them if it runs short of space' : ''}. Save to disk to keep a copy.`;
  }
  function openMenu() {
    syncMenu();
    menu.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('[role="menuitem"]:not(:disabled)');
    if (first) first.focus();
  }
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    if (refocus) menuBtn.focus();
  }
  menuBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) closeMenu(); });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') closeMenu();
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    closeMenu();
    act(b.dataset.act);
  });

  async function act(what) {
    const kind = kindOf(state.file);
    const cur = sourceOf(state.file);
    switch (what) {
      case 'new': {
        const v = await ask({ title: 'New file', text: 'It\'s saved in this browser as you type.', value: S.store.uniqueName('Untitled', fstore.names()), ok: 'Create', validate: nameProblem() });
        if (v == null) return;
        const r = await fstore.create(S.store.cleanName(v), STARTER);
        closeDocs(true);
        openFile(MY + r.file.id);
        keepFiles();
        editor.focus();
        if (!r.ok) toast('This browser isn\'t saving files. Use File, then Save to disk, to keep your work.', true);
        return;
      }
      case 'open-disk': $('open-file').click(); return;
      case 'save':
        if (kind !== 'my') { act('save-as'); return; }
        if (state.saving !== 'pending') state.saving = 'pending';
        keepFiles();
        {
          const r = await flushSave();
          toast(r.ok ? `Saved ${cur.title} in this browser` : 'This browser isn\'t saving files. Use File, then Save to disk, to keep your work.', !r.ok);
        }
        return;
      case 'save-as': {
        const base = kind === 'my' ? cur.title : kind === 'doc' ? (state.active || 'Untitled') : fileStem();
        const v = await ask({
          title: 'Save as', text: kind === 'my' ? 'Saves a copy under a new name.' : 'Saves a copy in your files, in this browser.',
          value: S.store.uniqueName(S.store.cleanName(base) || 'Untitled', fstore.names()), ok: 'Save', validate: nameProblem(),
        });
        if (v == null) return;
        const r = await fstore.create(S.store.cleanName(v), editor.getValue());
        openFile(MY + r.file.id);
        keepFiles();
        toast(r.ok ? `Saved ${r.file.name} in this browser` : 'This browser isn\'t saving files. Use File, then Save to disk, to keep your work.', !r.ok);
        return;
      }
      case 'rename': {
        if (kind !== 'my') return;
        const v = await ask({ title: 'Rename', value: cur.title, ok: 'Rename', validate: nameProblem(myId(state.file)) });
        if (v == null) return;
        await fstore.rename(myId(state.file), S.store.cleanName(v));
        renderPicker();
        markEdited();
        persist();
        return;
      }
      case 'delete': {
        if (kind !== 'my') return;
        const yes = await ask({ title: `Delete ${cur.title}?`, text: 'It\'s removed from this browser for good. Save it to disk first if you want to keep a copy.', ok: 'Delete', danger: true });
        if (!yes) return;
        clearTimeout(autosave);
        state.saving = null;
        await fstore.remove(myId(state.file));
        const next = fstore.list()[0];
        openFile(next ? MY + next.id : defaultFile());
        toast(`Deleted ${cur.title}`);
        return;
      }
      case 'download': await saveToDisk(fileStem(), editor.getValue()); return;
      case 'download-all': await saveAllToDisk(); return;
      case 'copy': await copyText(editor.getValue()); return;
      default:
    }
  }
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); act(e.shiftKey ? 'save-as' : 'save'); }
    else if (k === 'o' && !e.shiftKey) { e.preventDefault(); act('open-disk'); }
  });

  // Changes from another tab
  window.addEventListener('storage', (e) => fstore.handleStorageEvent(e));
  fstore.onChange((ids) => {
    renderPicker();
    const id = myId(state.file);
    if (id && ids.includes(id) && !fstore.get(id)) {
      toast('This file was deleted in another tab. File, then Save as, keeps what\'s here.', true);
    } else if (id && ids.includes(id) && state.saving !== 'pending' && fstore.get(id).source !== editor.getValue()) {
      const pos = editor.cursor();
      editor.setValue(fstore.get(id).source);
      editor.reveal(Math.min(pos, editor.getValue().length), null, false);
      compileNow();
    }
    markEdited();
  });

  // Docs: the tutorial, the reference and the rest, in place of the editor. Each page
  // and heading has a #link, so the browser's back button and shared links work.
  const docs = S.createDocs($('docs'), {
    onBack: () => closeDocs(true),
    onOpen: (file) => { closeDocs(true); openFile(file, true); },
    // Try it: an example edited in place, with edits kept as the example's draft
    playground: {
      compile: (text) => { const lib = stdlibNow(); return S.compile(text, lib ? { stdlib: lib } : undefined); },
      model: (r) => modelFor(r),
      units: () => state.units,
      dark: isDark,
      draft: (file) => (state.buffers[file] != null ? state.buffers[file] : null),
      save: (file, text) => { if (text == null) delete state.buffers[file]; else state.buffers[file] = text; persist(); },
      open: (page, k) => { closeDocs(true); openFile(`doc:${page.key}:${k}`); },
    },
  });
  let lastDocsPage = 'reference';
  function showDocs(page, anchor) {
    flushSave();
    closeMenu();
    $('panes').hidden = true;
    docs.show(page, anchor, !anchor);
    const tut = page === 'tutorial';
    if (!tut) lastDocsPage = page;
    $('tutorial-btn')[tut ? 'setAttribute' : 'removeAttribute']('aria-current', 'page');
    $('docs-btn')[tut ? 'removeAttribute' : 'setAttribute']('aria-current', 'page');
    $('docs-btn').href = `#${lastDocsPage}`;
  }
  function closeDocs(clearHash) {
    if (clearHash && docs.parse(location.hash)) {
      try { history.pushState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
    }
    if (!docs.shown()) return;
    docs.hide();
    $('panes').hidden = false;
    $('tutorial-btn').removeAttribute('aria-current');
    $('docs-btn').removeAttribute('aria-current');
    editor.remeasure();
    // the code from the docs that's open here may have been changed in a playground since
    if (kindOf(state.file) === 'doc') {
      const want = state.buffers[state.file] != null ? state.buffers[state.file] : sourceOf(state.file).source;
      if (want !== editor.getValue()) { openFile(state.file); return; }
    }
    showActive();
  }
  /** Show a docs page (and a code block on it) and give it its #link. */
  function goDocs(page, anchor, snippet) {
    const h = `#${anchor ? `${page}-${anchor}` : page}`;
    if (location.hash !== h) {
      try { history.pushState(null, '', h); } catch (e) { location.hash = h; return; }
    }
    showDocs(page, anchor);
    if (snippet != null) docs.showSnippet(page, snippet);
  }
  function route() {
    const r = docs.parse(location.hash);
    if (r) showDocs(r.page, r.anchor); else closeDocs(false);
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  // the header's links: open a page, or close it when it's the one shown
  $('tutorial-btn').addEventListener('click', (e) => {
    e.preventDefault();
    if (docs.shown() && docs.current() === 'tutorial') closeDocs(true); else goDocs('tutorial');
  });
  $('docs-btn').addEventListener('click', (e) => {
    e.preventDefault();
    if (docs.shown() && docs.current() !== 'tutorial') closeDocs(true); else goDocs(lastDocsPage);
  });
  $('back-docs').addEventListener('click', () => {
    const d = docSource(state.file);
    if (d) goDocs(d.page.key, null, d.k);
  });

  // splitter
  (function splitter() {
    const sp = $('splitter');
    const panes = document.querySelector('.panes');
    if (saved.split) panes.style.setProperty('--src-w', saved.split);
    const setPct = (pct) => {
      const v = Math.max(24, Math.min(68, pct));
      panes.style.setProperty('--src-w', v.toFixed(1) + '%');
      persist();
    };
    let dragging = false;
    sp.addEventListener('pointerdown', (e) => { dragging = true; sp.setPointerCapture(e.pointerId); });
    sp.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = panes.getBoundingClientRect();
      setPct(((e.clientX - r.left) / r.width) * 100);
    });
    sp.addEventListener('pointerup', () => { dragging = false; });
    sp.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const cur = parseFloat(panes.style.getPropertyValue('--src-w')) || 42;
      setPct(cur + (e.key === 'ArrowLeft' ? -2 : 2));
      e.preventDefault();
    });
  })();

  // Start: the file you had open (or the first example), then the docs if the link asks
  const start = saved.file && sourceOf(saved.file) ? saved.file : defaultFile();
  if (start) openFile(start);
  else { editor.setValue(STARTER); compileNow(); }
  route();
  // IndexedDB answers later: it may have files, or newer copies, that the quick copy missed
  fstore.load().then((changed) => {
    const id = myId(state.file);
    if (id && changed.includes(id) && state.saving !== 'pending') openFile(state.file);
    else if (!id && myId(saved.file) && fstore.get(myId(saved.file)) && state.file === start && state.buffers[start] == null) openFile(saved.file);
    renderPicker();
    markEdited();
  });
}, (err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', '<p class="fatal">stomp couldn\'t start: this browser didn\'t load its engine (WebAssembly).</p>');
});
