/* stomp: Try it, in the docs. A code block becomes an editor with its footprint drawn
 * beside it, in 2D or 3D, redrawn as you type. The statement under the cursor shows
 * what it places, as in the editor proper.
 */
(function (root) {
  'use strict';
  const S = root.Stomp = root.Stomp || {};
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let count = 0;

  /**
   * opts: code (to start with), original (what Reset restores), compile(text),
   * model(result) -> { model, board }, units(), dark(), onChange(text), onOpen(text),
   * onClose().
   */
  function createPlayground(host, opts) {
    const o = opts;
    const n = ++count;
    host.classList.add('playground');
    host.innerHTML = `
      <div class="pg-bar">
        <span class="pg-title">Try it</span>
        <span class="pg-status" aria-live="polite"></span>
        <span class="pg-fill"></span>
        <select class="pg-fp" aria-label="Footprint" hidden></select>
        <div class="seg" role="group" aria-label="Drawing or 3D model">
          <button type="button" data-dim="2d" aria-pressed="true">2D</button>
          <button type="button" data-dim="3d" aria-pressed="false">3D</button>
        </div>
        <button type="button" class="chip" data-act="reset" title="Put the example back as it was">Reset</button>
        <button type="button" class="chip" data-act="open" title="Keep working on it in the editor">Open in the editor</button>
        <button type="button" class="chip" data-act="close" title="Close, keeping your changes for next time">Close</button>
      </div>
      <div class="pg-body">
        <div class="pg-code editor-host"></div>
        <div class="pg-view">
          <div class="pg-2d viewer-host"></div>
          <div class="pg-3d viewer-host v3d-host" hidden></div>
        </div>
      </div>
      <ul class="pg-problems" hidden></ul>
      <p class="pg-hint">Change the code and the drawing follows. Put the cursor on a line to see what it places; hover over a pad for its size.</p>`;
    const q = (sel) => host.querySelector(sel);
    const lines = (o.code.match(/\n/g) || []).length + 1;
    host.style.setProperty('--pg-lines', String(Math.max(8, Math.min(lines + 1, 24))));

    let out = null, active = null, dim = '2d', view3 = null, timer = 0, cursor = 0, cursorEnd = 0;
    const lastGood = new Map();
    const editor = S.createEditor(q('.pg-code'), {
      id: `pg-src-${n}`,
      label: 'Example code',
      onChange(text) {
        if (o.onChange) o.onChange(text);
        clearTimeout(timer);
        timer = setTimeout(run, 120);
      },
      onCursor(pos, end) {
        cursor = pos; cursorEnd = end;
        follow();
        focus();
      },
    });
    const text = () => editor.getValue();
    const linesOf = (ranges) => {
      const t = text(), set = new Set();
      for (const r of ranges || []) {
        let line = 0;
        for (let i = 0; i < r.s && i < t.length; i++) if (t.charCodeAt(i) === 10) line++;
        let end = line;
        for (let i = r.s; i < r.e && i < t.length; i++) if (t.charCodeAt(i) === 10) end++;
        for (let l = line; l <= end; l++) set.add(l);
      }
      return [...set];
    };
    const viewer = S.createViewer(q('.pg-2d'), {
      onHover(ob) { editor.markLines(ob && ob.src ? linesOf(ob.src) : []); },
      onPick(ob) { const r = ob && (ob.def || (ob.src && ob.src[0])); if (r) editor.reveal(r.s, r.s, true); },
    });
    viewer.setUnits(o.units ? o.units() : 'mm');
    viewer.setLayer('dims', true);       // every placement's dimension, not only the one under the cursor

    /** The footprint the cursor is in, else the one shown, else the first. */
    function fpAt(pos) {
      if (!out) return null;
      const f = out.footprints.find((x) => pos >= x.s && pos <= x.e);
      if (f) return f.name;
      const group = (out.tables || []).concat(out.templates || []).find((x) => pos >= x.s && pos <= x.e);
      if (group && group.users.length) return group.users.includes(active) ? active : group.users[0];
      return null;
    }
    function follow() {
      const name = fpAt(cursor);
      if (name && name !== active) { active = name; show(); }
    }
    function focus() {
      const t = text();
      const a = Math.min(cursor, cursorEnd), b = Math.max(cursor, cursorEnd);
      const s = t.lastIndexOf('\n', a - 1) + 1;
      let e = t.indexOf('\n', b);
      if (e < 0) e = t.length;
      viewer.setFocus([{ s, e }]);
      if (view3) view3.setFocus([{ s, e }]);
    }

    function run() {
      clearTimeout(timer);
      try { out = o.compile(text()); } catch (err) {
        out = { diagnostics: [{ severity: 'error', message: 'internal error: ' + err.message, s: 0, e: 0, line: 1, col: 1 }], footprints: [] };
      }
      if (!out.footprints.some((f) => f.name === active)) active = fpAt(cursor) || (out.footprints[0] && out.footprints[0].name) || null;
      const pick = q('.pg-fp');
      pick.hidden = out.footprints.length < 2;
      pick.innerHTML = out.footprints.map((f) => `<option${f.name === active ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
      editor.setDiagnostics(out.diagnostics);
      problems();
      show();
    }
    function show() {
      const fp = out && out.footprints.find((f) => f.name === active);
      // a half-typed line: keep drawing the last version that parsed
      const syntaxHit = fp && out.diagnostics.some((d) => d.syntax && fp.deps.some((r) => d.s >= r.s && d.s <= r.e));
      let r = null, stale = false;
      if (fp && fp.result && !syntaxHit) { r = fp.result; lastGood.set(fp.name, r); }
      else if (fp && lastGood.has(fp.name)) { r = lastGood.get(fp.name); stale = true; }
      q('.pg-2d').classList.toggle('stale', stale);
      q('.pg-3d').classList.toggle('stale', stale);
      viewer.render(r);
      if (dim === '3d' && view3) {
        const m = r ? o.model(r) : null;
        view3.show(m ? m.model : null, m ? m.board : null, fp ? fp.name : null);
      }
      focus();
    }
    function problems() {
      const list = q('.pg-problems');
      const diags = out.diagnostics;
      const nErr = diags.filter((d) => d.severity === 'error').length, nWarn = diags.length - nErr;
      const st = q('.pg-status');
      st.textContent = !diags.length ? 'No problems' : [nErr && `${nErr} error${nErr === 1 ? '' : 's'}`, nWarn && `${nWarn} warning${nWarn === 1 ? '' : 's'}`].filter(Boolean).join(', ');
      st.classList.toggle('bad', nErr > 0);
      list.hidden = !diags.length;
      list.innerHTML = diags.slice(0, 6).map((d, i) => `<li class="${d.severity}"><button type="button" data-d="${i}"><span class="where">${d.line != null ? `${d.line}:${d.col}` : ''}</span> ${esc(d.message).replace(/`([^`]+)`/g, '<code>$1</code>')}</button></li>`).join('')
        + (diags.length > 6 ? `<li class="more">and ${diags.length - 6} more</li>` : '');
    }

    function setDim(d) {
      dim = d;
      host.querySelectorAll('[data-dim]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dim === d)));
      q('.pg-2d').hidden = d !== '2d';
      q('.pg-3d').hidden = d !== '3d';
      if (d === '3d' && !view3) view3 = S.createViewer3D(q('.pg-3d'), { dark: o.dark || (() => false) });
      show();
    }

    host.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !host.contains(b)) return;
      if (b.dataset.dim) setDim(b.dataset.dim);
      else if (b.dataset.d != null) { const d = out.diagnostics[+b.dataset.d]; if (d) editor.reveal(d.s, d.e, true); }
      else if (b.dataset.act === 'reset') { editor.setValue(o.original); if (o.onChange) o.onChange(o.original); run(); editor.focus(); }
      else if (b.dataset.act === 'open') { if (o.onOpen) o.onOpen(text()); }
      else if (b.dataset.act === 'close') { if (o.onClose) o.onClose(); }
    });
    q('.pg-fp').addEventListener('change', (e) => { active = e.target.value; show(); });

    editor.setValue(o.code);
    run();
    return {
      focus: () => editor.focus(),
      text,
      destroy() {
        clearTimeout(timer);
        editor.destroy();
        viewer.destroy();
        if (view3) view3.destroy();
        host.innerHTML = '';
        host.classList.remove('playground');
      },
    };
  }

  S.createPlayground = createPlayground;
})(typeof self !== 'undefined' ? self : this);
