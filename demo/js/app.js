/* stomp live demo: wires the editor, compiler and viewers together. */
(function () {
  'use strict';
  const S = window.Stomp;
  const $ = (id) => document.getElementById(id);
  const KEY = 'stomp-live:v1';

  // Where to put the cursor when an example opens, so its most interesting
  // statement is already highlighted and dimensioned.
  const SHOWCASE = {
    'to252.stomp': 'pad 2 inner is 1.9 above pad 1',
    'usb_microb.stomp': 'span pad "SH3" to pad "SH4" is 8.0',
    'soic8.stomp': 'lead gullwing',
    'qfn32.stomp': 'paste divide',
    'sot23-5.stomp': 'right: 4, nc, 5',
    'tssop20.stomp': 'lead gullwing b x L span E',
    'soic_family.stomp': 'footprint "SOIC-16W"',
    'r0402.stomp': 'gap 0.5',
    'bga64.stomp': 'omit A1, H8',
    'dip8.stomp': 'span 300mil centers',
    'hdr2x5.stomp': 'origin at pad 1',
    'syntax_zoo.stomp': 'gap pad 6 to pad 7 is 70',
    'qfn_library.stomp': '  32   5    3.45',
    'sot223.stomp': 'lead 4 gullwing',
    'do41.stomp': 'body cylinder',
    'crystal3225.stomp': 'box 2.9',
  };
  // Examples that open on the Library view rather than a single footprint
  const OPEN_IN_LIBRARY = new Set(['qfn_library.stomp']);
  // Examples about the 3D model, which open on it
  const OPEN_IN_3D = new Set(['sot223.stomp', 'do41.stomp', 'crystal3225.stomp']);
  const TAB_LIMIT = 5;          // more footprints than this: a dropdown instead of tabs

  const store = {
    load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } },
    save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* storage unavailable: edits live for this visit only */ } },
  };
  const saved = store.load();
  const examples = S.examples || [];
  const byFile = new Map(examples.map((e) => [e.file, e]));

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
      const ex = byFile.get(state.file);
      if (ex && text === ex.source) delete state.buffers[state.file]; else state.buffers[state.file] = text;
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

  const viewer = S.createViewer($('viewer'), {
    onHover(ob) {
      state.hover = ob;
      if (!ob || !ob.src) { editor.markLines([]); highlightRow(null); return; }
      editor.markLines(linesOf(ob.src));
      highlightRow(ob);
    },
    onPick(ob) {
      if (!ob) return;
      const r = ob.def || (ob.src && ob.src[0]);
      if (r) editor.reveal(r.s, r.s, true);
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

  // 3D: the model on a board, built when first shown and cached with its result
  const darkMode = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const view3 = S.createViewer3D($('viewer3d'), {
    dark: () => !!(darkMode && darkMode.matches),
    onCamera(c) {
      if (state.dim !== '3d') return;
      const a = ((Math.round(c.az) % 360) + 360) % 360, e = Math.round(c.el);
      $('tb-scale').textContent = e >= 89 ? 'from above' : e <= -89 ? 'from below' : `${a}° round, ${Math.abs(e)}° ${e >= 0 ? 'above' : 'below'}`;
    },
  });
  if (darkMode && darkMode.addEventListener) darkMode.addEventListener('change', () => view3.redraw());
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

  // Examples
  const sel = $('example');
  for (const ex of examples) {
    const opt = document.createElement('option');
    opt.value = ex.file;
    opt.textContent = ex.title;
    if (ex.blurb) opt.title = ex.blurb;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => openExample(sel.value));
  $('reset').addEventListener('click', () => {
    delete state.buffers[state.file];
    persist();
    openExample(state.file, true);
  });

  function openExample(file, fresh) {
    const ex = byFile.get(file) || examples[0];
    if (!ex) return;
    state.file = ex.file;
    sel.value = ex.file;
    $('file-name').textContent = `examples/${ex.file}`;
    const edited = state.buffers[ex.file];
    editor.setValue(edited != null ? edited : ex.source);
    state.active = null;
    state.view = OPEN_IN_LIBRARY.has(ex.file) && edited == null ? 'lib' : 'fp';
    if (OPEN_IN_3D.has(ex.file) && (edited == null || fresh)) state.dim = '3d';
    markEdited();
    compileNow();
    if (edited == null || fresh) {
      const needle = SHOWCASE[ex.file];
      const at = needle ? ex.source.indexOf(needle) : -1;
      editor.reveal(at >= 0 ? at : 0, at >= 0 ? at : 0, false);
    } else {
      editor.reveal(0, 0, false);
    }
    persist();
  }

  function markEdited() {
    const ex = byFile.get(state.file);
    const edited = ex && state.buffers[state.file] != null;
    $('file-name').textContent = `examples/${state.file}${edited ? ' •' : ''}`;
    $('file-name').title = edited ? 'Edited. Reset restores the original.' : '';
    $('reset').disabled = !edited;
  }

  // Compile
  function compileNow() {
    clearTimeout(compileTimer);
    const text = editor.getValue();
    const t0 = performance.now();
    let out;
    try {
      out = S.compile(text);
    } catch (err) {
      out = { diagnostics: [{ severity: 'error', message: 'internal error: ' + err.message, s: 0, e: 0, line: 1, col: 1, endLine: 1, endCol: 1 }], footprints: [], templates: [] };
      console.error(err);
    }
    const ms = performance.now() - t0;
    state.out = out;
    $('compile-ms').textContent = `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
    editor.setDiagnostics(out.diagnostics);
    renderProblems(out.diagnostics);
    if (!out.footprints.some((f) => f.name === state.active)) state.active = fpAt(state.cursor) || (out.footprints[0] && out.footprints[0].name) || null;
    renderTabs();
    applyView();
    showActive();
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
    const name = fpAt(state.cursor);
    if (name && name !== state.active) {
      state.active = name;
      renderTabs();
      showActive();
      if (state.view === 'lib') markActiveCard(true);
    }
  }

  function updateFocus() {
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
    editor.reveal(f.nameS, f.nameS, false);
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
    if (!fps.length) html += '<p class="lib-head">Nothing yet. Add a <code>footprint</code>, or a <code>footprints from TEMPLATE { ... }</code> table.</p>';
    box.innerHTML = html;
    box.querySelectorAll('.card').forEach((el) => {
      const f = fps[+el.dataset.i];
      const th = el.querySelector('.thumb');
      if (f.result) {
        if (thumbs.has(f.result) || !lazyThumbs) th.innerHTML = thumb(f.result);
        else { th._result = f.result; lazyThumbs.observe(th); }
      }
      el.addEventListener('click', () => openFootprint(f.name));
      el.addEventListener('mouseenter', () => editor.markLines(linesOf([{ s: f.s, e: f.e }])));
      el.addEventListener('mouseleave', () => editor.markLines([]));
    });
    box.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => editor.reveal(+b.dataset.goto, +b.dataset.goto, true)));
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
      btn.innerHTML = `<span class="sev" aria-label="${d.severity}"></span><span class="where">${d.line}:${d.col}</span><span class="msg">${codeify(d.message)}${multi && d.footprint ? ` <span class="fp">· ${escapeHtml(d.footprint)}</span>` : ''}</span>`;
      btn.addEventListener('click', () => editor.reveal(d.s, d.e, true));
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
    if (!fp) { box.innerHTML = '<div><h3>Footprint</h3><p class="desc">Add a <code>footprint "NAME" { ... }</code> block to see it here.</p></div>'; return; }
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
      tr.addEventListener('click', () => { const d = p.def || p.src[0]; if (d) editor.reveal(d.s, d.s, true); });
      tr.addEventListener('mouseenter', () => { editor.markLines(linesOf(p.src)); });
      tr.addEventListener('mouseleave', () => { editor.markLines([]); });
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
    const text = editor.getValue();
    let n = 1;
    for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }

  function linesOf(ranges) {
    const text = editor.getValue();
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
    const lib = (state.file || 'stomp').replace(/\.stomp$/, '');
    const L = S.kicad.library(fps, { lib, source: state.file ? `examples/${state.file}` : null });
    if (!L.count) { toast('Nothing to export: every footprint has errors', true); return; }
    try {
      await files.save(`${L.lib}.pretty.zip`, S.model3d.toZip(L.files));
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
      const zip = S.model3d.toZip([
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
  $('about-btn').addEventListener('click', () => {
    const d = $('about');
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
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

  // Start
  const start = saved.file && byFile.has(saved.file) ? saved.file : (byFile.has('to252.stomp') ? 'to252.stomp' : (examples[0] && examples[0].file));
  if (start) openExample(start);
  else { editor.setValue('footprint "NEW" {\n  \n}\n'); compileNow(); }
})();
