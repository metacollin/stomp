/* stomp live demo — code editor.
 *
 * A plain <textarea> laid exactly over a highlighted <pre>. The textarea owns
 * input, selection, IME and native undo; the <pre> paints tokens from the real
 * stomp lexer plus diagnostic squiggles. Both share font metrics, so the caret
 * lines up with the painted text.
 */
(function (root) {
  'use strict';
  const S = root.Stomp = root.Stomp || {};

  // highlight classes for keyword families
  const DECL = new Set(['footprint', 'template', 'extends', 'from', 'let', 'units', 'description', 'datasheet', 'manufacturer', 'mpn', 'refdes', 'tags']);
  const RELATION = new Set(['is', 'at', 'of', 'left', 'right', 'above', 'below', 'and', 'centered', 'between', 'on', 'mirrors', 'across', 'align', 'with',
    'horizontally', 'vertically', 'inner', 'outer', 'center', 'top', 'bottom', 'span', 'gap', 'pitch', 'to', 'going', 'up', 'down', 'origin']);
  const OBJECT = new Set(['pad', 'pads', 'hole', 'row', 'group', 'side', 'ball', 'body', 'pins', 'balls', 'lead', 'thermal', 'default', 'delete', 'omit', 'only']);

  function esc(s) { return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')); }

  function tokenClass(t) {
    switch (t.t) {
      case 'comment': return 'tk-com';
      case 'str': return 'tk-str';
      case 'num': return 'tk-num';
      case 'bad': return 'tk-bad';
      case 'p': return t.v === '{' || t.v === '}' ? 'tk-brace' : 'tk-op';
      case 'word':
        if (!t.kw) return 'tk-id';
        if (DECL.has(t.v)) return 'tk-decl';
        if (RELATION.has(t.v)) return 'tk-rel';
        if (OBJECT.has(t.v)) return 'tk-obj';
        return 'tk-kw';
      default: return '';
    }
  }

  function createEditor(host, opts) {
    const o = Object.assign({ onChange() {}, onCursor() {}, label: 'stomp source' }, opts);
    host.classList.add('ed');
    host.innerHTML = `
      <div class="ed-scroll">
        <div class="ed-inner">
          <div class="ed-gutter" aria-hidden="true"></div>
          <div class="ed-code">
            <div class="ed-bands" aria-hidden="true"></div>
            <pre class="ed-hl" aria-hidden="true"><code></code></pre>
            <textarea class="ed-ta" id="${o.id || 'stomp-src'}" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="${o.label}"></textarea>
          </div>
        </div>
      </div>
      <div class="ed-tip" role="tooltip" hidden></div>`;
    const scroll = host.querySelector('.ed-scroll');
    const gutter = host.querySelector('.ed-gutter');
    const code = host.querySelector('.ed-code');
    const bands = host.querySelector('.ed-bands');
    const hl = host.querySelector('.ed-hl code');
    const ta = host.querySelector('.ed-ta');
    const tip = host.querySelector('.ed-tip');

    let diags = [];
    let showDiags = true;
    let lineCount = 0;
    let marks = [];          // [{line, cls}] extra line bands (e.g. hovered object's source)
    let escapeTab = false;

    const metrics = { lh: 20, cw: 8, padT: 10, padL: 14 };
    function measure() {
      const cs = getComputedStyle(ta);
      metrics.lh = parseFloat(cs.lineHeight) || 20;
      metrics.padT = parseFloat(cs.paddingTop) || 0;
      metrics.padL = parseFloat(cs.paddingLeft) || 0;
      const probe = document.createElement('span');
      probe.textContent = 'M'.repeat(100);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
      hl.appendChild(probe);
      metrics.cw = probe.getBoundingClientRect().width / 100 || 8;
      probe.remove();
    }

    // ----------------------------------------------------------- painting
    /** Lexer tokens → non-overlapping classed spans (strings split around `{…}`). */
    function spansOf(toks) {
      const out = [];
      for (const t of toks) {
        if (t.t === 'str' && t.parts) {
          let pos = t.s;
          for (const p of t.parts) {
            if (p.lit != null) continue;
            if (p.open > pos) out.push({ s: pos, e: p.open, cls: 'tk-str' });
            out.push({ s: p.open, e: p.open + 1, cls: 'tk-interp' });
            let q = p.open + 1;
            for (const c of p.all) {
              if (c.s < q) continue;
              if (c.s > q) out.push({ s: q, e: c.s, cls: '' });
              out.push({ s: c.s, e: c.e, cls: tokenClass(c) });
              q = c.e;
            }
            if (p.close > q) out.push({ s: q, e: p.close, cls: p.fmtS != null ? 'tk-interp' : '' });
            out.push({ s: p.close, e: p.close + 1, cls: 'tk-interp' });
            pos = p.close + 1;
          }
          if (t.e > pos) out.push({ s: pos, e: t.e, cls: 'tk-str' });
          continue;
        }
        if (t.t === 'num' && t.suffix && t.num) {          // colour `mil` apart from `50`
          const m = t.s + t.num.length;
          out.push({ s: t.s, e: m, cls: 'tk-num' }, { s: m, e: t.e, cls: 'tk-num tk-unit' });
          continue;
        }
        out.push({ s: t.s, e: t.e, cls: tokenClass(t) });
      }
      return out;
    }

    function paint() {
      const text = ta.value;
      const lx = S.lexer.lex(text, null);
      const spans = spansOf(lx.all.filter((t) => t.t !== 'nl'));
      // boundaries from spans and diagnostics
      const ranges = showDiags ? diags.map((d) => {
        let s = d.s, e = Math.max(d.e, d.s + 1);
        if (s >= text.length) { s = Math.max(0, text.length - 1); e = text.length; }
        if (text[s] === '\n' && s > 0) { s--; e = s + 1; }
        return { s, e: Math.min(e, text.length), cls: d.severity === 'error' ? 'sq-err' : 'sq-warn' };
      }) : [];
      const cuts = new Set([0, text.length]);
      for (const t of spans) { cuts.add(t.s); cuts.add(t.e); }
      for (const r of ranges) { cuts.add(r.s); cuts.add(r.e); }
      const pts = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
      let html = '';
      let ti = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        if (a === b) continue;
        while (ti < spans.length && spans[ti].e <= a) ti++;
        const sp = ti < spans.length && spans[ti].s <= a && spans[ti].e >= b ? spans[ti] : null;
        let cls = sp ? sp.cls : '';
        for (const r of ranges) if (r.s < b && r.e > a) cls += ' ' + r.cls;
        const chunk = esc(text.slice(a, b));
        html += cls.trim() ? `<span class="${cls.trim()}">${chunk}</span>` : chunk;
      }
      // keep the <pre> as tall as the textarea when the text ends in a newline
      hl.innerHTML = html + (text.endsWith('\n') || !text ? ' ' : '') + '\n';
      const lines = text.split('\n').length;
      if (lines !== lineCount) {
        lineCount = lines;
        let g = '';
        for (let i = 1; i <= lines; i++) g += `<div class="ln" data-l="${i}">${i}</div>`;
        gutter.innerHTML = g;
      }
      paintGutterMarks();
      paintBands();
    }

    function paintGutterMarks() {
      gutter.querySelectorAll('.ln.e, .ln.w').forEach((n) => n.classList.remove('e', 'w'));
      if (!showDiags) return;
      for (const d of diags) {
        const n = gutter.children[d.line - 1];
        if (!n) continue;
        n.classList.add(d.severity === 'error' ? 'e' : 'w');
      }
    }

    function caretLine() {
      const p = ta.selectionStart;
      let line = 0;
      for (let i = 0; i < p; i++) if (ta.value.charCodeAt(i) === 10) line++;
      return line;
    }

    function paintBands() {
      let out = '';
      const cur = caretLine();
      out += `<div class="band cur${document.activeElement === ta ? '' : ' idle'}" style="top:${metrics.padT + cur * metrics.lh}px;height:${metrics.lh}px"></div>`;
      for (const m of marks) out += `<div class="band ${m.cls}" style="top:${metrics.padT + m.line * metrics.lh}px;height:${metrics.lh}px"></div>`;
      bands.innerHTML = out;
    }

    // ----------------------------------------------------------- editing
    function insert(text, selStart, selEnd) {
      ta.focus();
      if (selStart != null) ta.setSelectionRange(selStart, selEnd);
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok) {
        const s = ta.selectionStart, e = ta.selectionEnd;
        ta.setRangeText(text, s, e, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    function lineStartOf(pos) { return ta.value.lastIndexOf('\n', pos - 1) + 1; }

    function selectedLines() {
      const v = ta.value;
      const s = lineStartOf(ta.selectionStart);
      let e = ta.selectionEnd;
      if (e > ta.selectionStart && v[e - 1] === '\n') e--;
      const nl = v.indexOf('\n', e);
      return { s, e: nl < 0 ? v.length : nl };
    }

    function mapLines(fn) {
      const { s, e } = selectedLines();
      const block = ta.value.slice(s, e);
      const out = block.split('\n').map(fn).join('\n');
      if (out === block) return;
      const keepSel = ta.selectionStart !== ta.selectionEnd;
      insert(out, s, e);
      if (keepSel) ta.setSelectionRange(s, s + out.length);
    }

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { escapeTab = true; return; }
      if (e.key === 'Tab') {
        if (escapeTab) { escapeTab = false; return; }   // let focus move on
        e.preventDefault();
        const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
        if (e.shiftKey) mapLines((l) => l.replace(/^ {1,2}/, ''));
        else if (multi) mapLines((l) => (l.length ? '  ' + l : l));
        else insert('  ');
        return;
      }
      escapeTab = false;
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const v = ta.value;
        const pos = ta.selectionStart;
        const ls = lineStartOf(pos);
        const indent = /^[ \t]*/.exec(v.slice(ls, pos))[0];
        const before = v.slice(ls, pos).replace(/#.*$/, '').trimEnd();
        const after = v.slice(ta.selectionEnd);
        if (before.endsWith('{')) {
          if (/^\s*}/.test(after.split('\n')[0])) {
            insert('\n' + indent + '  \n' + indent);
            const p = ta.selectionStart - (indent.length + 1);
            ta.setSelectionRange(p, p);
          } else insert('\n' + indent + '  ');
        } else insert('\n' + indent);
        return;
      }
      if (e.key === '}' && !e.ctrlKey && !e.metaKey) {
        const v = ta.value, pos = ta.selectionStart;
        const ls = lineStartOf(pos);
        const head = v.slice(ls, pos);
        if (/^ +$/.test(head) && ta.selectionStart === ta.selectionEnd) {
          e.preventDefault();
          insert(head.slice(0, Math.max(0, head.length - 2)) + '}', ls, pos);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        const { s, e: end } = selectedLines();
        const lines = ta.value.slice(s, end).split('\n');
        const allCommented = lines.filter((l) => l.trim()).every((l) => /^\s*#/.test(l));
        mapLines((l) => {
          if (!l.trim()) return l;
          if (allCommented) return l.replace(/^(\s*)# ?/, '$1');
          const ind = /^\s*/.exec(l)[0];
          return ind + '# ' + l.slice(ind.length);
        });
      }
    });

    ta.addEventListener('input', () => {
      showDiags = false;          // stale until the next compile
      paint();
      keepCaretVisible();
      o.onChange(ta.value);
      cursorChanged();
    });

    let lastCursor = -1;
    function cursorChanged() {
      paintBands();
      const p = ta.selectionStart;
      if (p === lastCursor) return;
      lastCursor = p;
      o.onCursor(p, ta.selectionEnd);
    }
    for (const ev of ['keyup', 'mouseup', 'focus', 'select']) ta.addEventListener(ev, cursorChanged);
    ta.addEventListener('blur', paintBands);
    document.addEventListener('selectionchange', () => { if (document.activeElement === ta) cursorChanged(); });

    function keepCaretVisible() {
      const line = caretLine();
      const top = metrics.padT + line * metrics.lh;
      const vh = scroll.clientHeight;
      if (top < scroll.scrollTop) scroll.scrollTop = top - metrics.lh;
      else if (top + metrics.lh * 2 > scroll.scrollTop + vh) scroll.scrollTop = top + metrics.lh * 2 - vh;
      const ls = lineStartOf(ta.selectionStart);
      const col = ta.selectionStart - ls;
      const x = metrics.padL + col * metrics.cw + gutter.offsetWidth;
      const vw = scroll.clientWidth;
      if (x < scroll.scrollLeft + gutter.offsetWidth + 20) scroll.scrollLeft = Math.max(0, x - gutter.offsetWidth - 40);
      else if (x > scroll.scrollLeft + vw - 20) scroll.scrollLeft = x - vw + 40;
      ta.scrollTop = 0; ta.scrollLeft = 0;
    }

    // ----------------------------------------------------------- hover tips
    ta.addEventListener('mousemove', (e) => {
      if (!showDiags || !diags.length) { tip.hidden = true; return; }
      const r = code.getBoundingClientRect();
      const line = Math.floor((e.clientY - r.top - metrics.padT) / metrics.lh);
      const col = Math.floor((e.clientX - r.left - metrics.padL) / metrics.cw);
      const hits = diags.filter((d) => {
        const l0 = d.line - 1, l1 = d.endLine - 1;
        if (line < l0 || line > l1) return false;
        const c0 = line === l0 ? d.col - 1 : 0;
        const c1 = line === l1 ? Math.max(d.endCol - 1, c0 + 1) : Infinity;
        return col >= c0 && col < c1;
      });
      if (!hits.length) { tip.hidden = true; return; }
      tip.innerHTML = hits.map((d) => `<div class="${d.severity}"><b>${d.severity}</b> ${esc(d.message)}</div>`).join('');
      tip.hidden = false;
      const hr = host.getBoundingClientRect();
      let x = e.clientX - hr.left + 12, y = e.clientY - hr.top + 18;
      if (x + tip.offsetWidth > hr.width - 8) x = Math.max(8, hr.width - tip.offsetWidth - 8);
      tip.style.transform = `translate(${x}px, ${y}px)`;
    });
    ta.addEventListener('mouseleave', () => { tip.hidden = true; });
    gutter.addEventListener('click', () => ta.focus());

    // ----------------------------------------------------------- API
    measure();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); paint(); });

    return {
      el: ta,
      getValue: () => ta.value,
      setValue(text) {
        ta.value = text;
        diags = [];
        lastCursor = -1;
        paint();
        scroll.scrollTop = 0; scroll.scrollLeft = 0;
      },
      setDiagnostics(list) {
        diags = list || [];
        showDiags = true;
        paint();
      },
      /** Select a source range and scroll it into view. */
      reveal(s, e, focus) {
        if (focus !== false) ta.focus({ preventScroll: true });
        ta.setSelectionRange(s, e == null ? s : e);
        const line = ta.value.slice(0, s).split('\n').length - 1;
        const top = metrics.padT + line * metrics.lh;
        const vh = scroll.clientHeight;
        if (top < scroll.scrollTop + metrics.lh || top > scroll.scrollTop + vh - metrics.lh * 2) {
          scroll.scrollTop = Math.max(0, top - vh / 3);
        }
        cursorChanged();
      },
      /** Tint source lines (0-based) — e.g. the statements behind a hovered pad. */
      markLines(lines, cls) {
        marks = (lines || []).map((line) => ({ line, cls: cls || 'mark' }));
        paintBands();
      },
      cursor: () => ta.selectionStart,
      focus: () => ta.focus(),
      remeasure() { measure(); paint(); },
    };
  }

  S.createEditor = createEditor;
})(typeof self !== 'undefined' ? self : this);
