/* stomp live demo — app controller: wires the editor, compiler and viewer. */
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
  };

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
  };

  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.save({
      file: state.file, buffers: state.buffers, units: state.units, layers: viewer.layers(),
      split: document.querySelector('.panes').style.getPropertyValue('--src-w') || null,
    }), 250);
  }

  // ------------------------------------------------------------- components
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
      $('tb-cursor').textContent = p ? `${fmt(p[0])}, ${fmt(p[1])} ${state.units}` : '—';
    },
    onCamera(cam) {
      const ratio = cam.s / (96 / 25.4);   // screen pixels per mm vs. a 96-dpi "real size"
      $('tb-scale').textContent = ratio >= 1 ? `≈ ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} : 1` : `≈ 1 : ${(1 / ratio).toFixed(1)}`;
      const g = viewer && viewer.gridStep ? viewer.gridStep() : null;
      $('tb-grid').textContent = g ? `${fmt(g)} ${state.units}` : '—';
    },
  });

  function fmt(v) { return S.fmtLen(v, state.units); }

  // ------------------------------------------------------------- examples
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
    $('file-name').title = edited ? 'Edited — Reset restores the original' : '';
    $('reset').disabled = !edited;
  }

  // ------------------------------------------------------------- compile
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
    showActive();
  }

  function fpAt(offset) {
    const out = state.out;
    if (!out) return null;
    const fp = out.footprints.find((f) => offset >= f.s && offset <= f.e);
    if (fp) return fp.name;
    const t = (out.templates || []).find((x) => offset >= x.s && offset <= x.e);
    if (t && t.users.length) return t.users.includes(state.active) ? state.active : t.users[0];
    return null;
  }

  function followCursor() {
    const name = fpAt(state.cursor);
    if (name && name !== state.active) {
      state.active = name;
      renderTabs();
      showActive();
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
    viewer.render(shown);
    state.shown = shown;
    $('tb-name').textContent = fp ? fp.name : '—';
    renderDetails(fp, shown);
    updateFocus();
  }

  // ------------------------------------------------------------- tabs
  function renderTabs() {
    const tabs = $('tabs');
    const fps = state.out ? state.out.footprints : [];
    const errs = new Set((state.out ? state.out.diagnostics : []).filter((d) => d.severity === 'error' && d.footprint).map((d) => d.footprint));
    tabs.innerHTML = '';
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
      b.addEventListener('click', () => {
        state.active = f.name;
        renderTabs();
        showActive();
        editor.reveal(f.nameS, f.nameS, false);
      });
      tabs.appendChild(b);
    }
    const on = tabs.querySelector('[aria-selected="true"]');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ------------------------------------------------------------- problems
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

  // ------------------------------------------------------------- details
  function renderDetails(fp, shown) {
    const box = $('details');
    const r = shown;
    if (!fp) { box.innerHTML = '<div><h3>Footprint</h3><p class="desc">Add a <code>footprint "NAME" { … }</code> block to see it here.</p></div>'; return; }
    if (!r) { box.innerHTML = `<div><h3>${escapeHtml(fp.name)}</h3><p class="desc">This footprint has errors that stop it from being drawn — see Problems.</p></div>`; return; }
    const U = state.units;
    const L = (v) => fmt(v);
    const m = r.meta;
    const facts = [];
    const fact = (k, v) => facts.push(`<dt>${k}</dt><dd>${v}</dd>`);
    if (r.template) fact('From', `template <b>${escapeHtml(r.template)}</b>`);
    if (r.extends) fact('Extends', `"${escapeHtml(r.extends)}"`);
    const smd = r.pads.filter((p) => !p.tht).length, tht = r.pads.length - smd;
    fact('Pads', `${r.pads.length}${tht && smd ? ` <span class="note">(${smd} SMD, ${tht} THT)</span>` : tht ? ' <span class="note">through-hole</span>' : ''}${r.holes.length ? ` + ${r.holes.length} NPTH` : ''}${r.generator && r.generator.omitted.length ? ` <span class="note">(omitted ${escapeHtml(r.generator.omitted.join(', '))})</span>` : ''}`);
    if (r.body) {
      fact('Body', r.body.kind === 'cyl' ? `⌀${L(r.body.w)}${r.body.h ? ' × ' + L(r.body.h) : ''} ${U} <span class="note">cylinder</span>` : `${L(r.body.w)} × ${L(r.body.l)}${r.body.h ? ' × ' + L(r.body.h) : ''} ${U}`);
    }
    if (r.courtyardBox) {
      const c = r.courtyardBox;
      fact('Courtyard', `${L(c.x1 - c.x0)} × ${L(c.y1 - c.y0)} ${U}${r.courtyardClearance != null ? ` <span class="note">(+${L(r.courtyardClearance)} ${U} clearance)</span>` : ''}`);
    }
    if (r.generator && r.generator.spacing) {
      for (const [ax, sp] of Object.entries(r.generator.spacing)) {
        fact(ax === 'x' ? 'Rows ↔' : 'Rows ↕', `${L(sp.C)} ${U} <span class="note">apart, centre to centre — ${escapeHtml(sp.how)}</span>`);
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
      else if (md.props.step) t = `STEP file <code>${escapeHtml(md.props.step)}</code>`;
      else if (md.generated) {
        const bits = [];
        if (md.props.standoff != null) bits.push(`standoff ${L(md.props.standoff)}`);
        if (md.props.height != null) bits.push(`height ${L(md.props.height)}`);
        if (md.props.bodyColor) bits.push(`body ${escapeHtml(md.props.bodyColor)}`);
        if (md.props.leadsColor) bits.push(`leads ${escapeHtml(md.props.leadsColor)}`);
        if (md.props.pin1) bits.push(`pin 1 ${md.props.pin1}`);
        t = `generated from the body${bits.length ? ` <span class="note">(${bits.join(', ')})</span>` : ''} <span class="note">— not rendered in this demo</span>`;
      } else t = '<span class="note">none — add a <code>body</code> to generate one</span>';
      fact('3D model', t);
    }
    const rows = r.pads.map((p, i) => {
      const sh = p.shape;
      const rot = ((p.rot % 360) + 360) % 360;
      const square = Math.abs(rot / 90 - Math.round(rot / 90)) < 1e-9;
      // sizes in board axes (x × y); odd angles keep the shape's own size plus the angle
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

  // ------------------------------------------------------------- toolbar
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
      persist();
    });
  });
  viewer.setUnits(state.units);
  $('fit').addEventListener('click', () => viewer.fit());
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

  // ------------------------------------------------------------- go
  const start = saved.file && byFile.has(saved.file) ? saved.file : (byFile.has('to252.stomp') ? 'to252.stomp' : (examples[0] && examples[0].file));
  if (start) openExample(start);
  else { editor.setValue('footprint "NEW" {\n  \n}\n'); compileNow(); }
})();
