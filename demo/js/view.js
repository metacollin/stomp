/* SVG footprint viewer. The viewBox is in mm with y flipped, so lines keep their
 * real widths. The grid, dimensions and labels are sized in screen pixels. */
(function (root) {
  'use strict';
  const S = root.Stomp = root.Stomp || {};
  const NS = 'http://www.w3.org/2000/svg';

  const LAYERS = ['courtyard', 'fab', 'copper', 'drills', 'paste', 'mask', 'silk', 'labels', 'dims', 'grid'];

  function f(v) { const s = (Math.abs(v) < 1e-9 ? 0 : v).toFixed(4); return s.replace(/\.?0+$/, '') || '0'; }

  /** Edges to an SVG path, with y flipped (so CCW arcs get sweep 0). */
  function pathOf(edges) {
    if (!edges || !edges.length) return '';
    let d = `M${f(edges[0].a[0])} ${f(-edges[0].a[1])}`;
    for (const e of edges) {
      if (e.t === 'L') { d += `L${f(e.b[0])} ${f(-e.b[1])}`; continue; }
      const sweep = e.a1 - e.a0;
      if (sweep >= Math.PI * 2 - 1e-9) {
        const m = [e.c[0] + e.r * Math.cos(e.a0 + Math.PI), e.c[1] + e.r * Math.sin(e.a0 + Math.PI)];
        d += `A${f(e.r)} ${f(e.r)} 0 0 0 ${f(m[0])} ${f(-m[1])}A${f(e.r)} ${f(e.r)} 0 0 0 ${f(e.b[0])} ${f(-e.b[1])}`;
      } else {
        d += `A${f(e.r)} ${f(e.r)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${f(e.b[0])} ${f(-e.b[1])}`;
      }
    }
    return d + 'Z';
  }
  function polyPath(pts, closed) {
    if (!pts || !pts.length) return '';
    let d = `M${f(pts[0][0])} ${f(-pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) d += `L${f(pts[i][0])} ${f(-pts[i][1])}`;
    return closed ? d + 'Z' : d;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  let viewers = 0;
  function createViewer(host, opts) {
    const o = Object.assign({ onHover() {}, onPick() {}, onCursor() {}, onCamera() {} }, opts);
    const hatchId = `vw-hatch-${++viewers}`;     // one per viewer: a page can show several
    host.classList.add('vw');
    host.innerHTML = '';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'vw-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Footprint preview');
    svg.innerHTML = `
      <defs>
        <pattern id="${hatchId}" patternUnits="userSpaceOnUse" width="0.16" height="0.16" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="0.16" class="vw-paste-line"></line>
        </pattern>
      </defs>
      <g class="vw-grid"></g>
      <g class="vw-world">
        <g class="vw-l vw-courtyard"></g>
        <g class="vw-l vw-fab"></g>
        <g class="vw-l vw-copper"></g>
        <g class="vw-l vw-drills"></g>
        <g class="vw-l vw-paste"></g>
        <g class="vw-l vw-mask"></g>
        <g class="vw-l vw-silk"></g>
        <g class="vw-l vw-hl"></g>
      </g>
      <g class="vw-labels"></g>
      <g class="vw-origin"></g>
      <g class="vw-dims"></g>`;
    svg.style.setProperty('--vw-hatch', `url(#${hatchId})`);
    host.appendChild(svg);
    const tip = document.createElement('div');
    tip.className = 'vw-tip';
    tip.hidden = true;
    host.appendChild(tip);
    const empty = document.createElement('div');
    empty.className = 'vw-empty';
    empty.hidden = true;
    host.appendChild(empty);

    const hatch = svg.querySelector('pattern');
    const hatchLine = hatch.querySelector('line');
    const g = {};
    for (const k of ['grid', 'courtyard', 'fab', 'copper', 'drills', 'paste', 'mask', 'silk', 'hl', 'labels', 'origin', 'dims']) g[k] = svg.querySelector('.vw-' + k);

    const state = {
      res: null, cam: null, autoFit: true, lastKey: null,
      layers: Object.fromEntries(LAYERS.map((k) => [k, k !== 'mask' && k !== 'dims'])),
      units: 'mm', focus: { ranges: [], objects: new Set() }, hover: null, W: 0, H: 0,
    };

    // Camera
    function size() {
      const r = svg.getBoundingClientRect();
      state.W = Math.max(1, r.width); state.H = Math.max(1, r.height);
    }
    function applyCam() {
      const { cx, cy, s } = state.cam;
      const w = state.W / s, h = state.H / s;
      svg.setAttribute('viewBox', `${f(cx - w / 2)} ${f(-cy - h / 2)} ${f(w)} ${f(h)}`);
      // keep the paste hatch the same size on screen
      const k = 5 / s;
      hatch.setAttribute('width', f(k)); hatch.setAttribute('height', f(k));
      hatchLine.setAttribute('y2', f(k)); hatchLine.setAttribute('stroke-width', f(1.1 / s));
      drawGrid();
      drawLabels();
      drawDims();
      drawOrigin();
      o.onCamera(state.cam);
    }
    function fitBox(bb) {
      size();
      const pad = Math.max(24, Math.min(state.W, state.H) * 0.08);
      const bw = Math.max(bb.x1 - bb.x0, 0.5), bh = Math.max(bb.y1 - bb.y0, 0.5);
      const s = Math.min((state.W - 2 * pad) / bw, (state.H - 2 * pad) / bh);
      state.cam = { cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2, s: Math.max(2, Math.min(s, 4000)) };
      applyCam();
    }
    function fit() {
      state.autoFit = true;
      if (state.res) fitBox(state.res.bbox); else { state.cam = { cx: 0, cy: 0, s: 40 }; applyCam(); }
    }
    function toWorld(clientX, clientY) {
      const r = svg.getBoundingClientRect();
      const { cx, cy, s } = state.cam;
      return [cx + (clientX - r.left - state.W / 2) / s, cy - (clientY - r.top - state.H / 2) / s];
    }
    function zoomAt(clientX, clientY, k) {
      const before = toWorld(clientX, clientY);
      state.cam.s = Math.max(2, Math.min(state.cam.s * k, 8000));
      const after = toWorld(clientX, clientY);
      state.cam.cx += before[0] - after[0];
      state.cam.cy += before[1] - after[1];
      state.autoFit = false;
      applyCam();
    }

    svg.addEventListener('wheel', (e) => {
      if (!state.cam) return;
      e.preventDefault();
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      zoomAt(e.clientX, e.clientY, k);
    }, { passive: false });

    const pointers = new Map();
    let drag = null, pinch = null, moved = false;
    svg.addEventListener('pointerdown', (e) => {
      if (!state.cam) return;
      svg.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      moved = false;
      if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, cx: state.cam.cx, cy: state.cam.cy };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: state.cam.s, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        drag = null;
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (state.cam) o.onCursor(toWorld(e.clientX, e.clientY));
      if (!pointers.has(e.pointerId)) { hoverAt(e); return; }
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const k = (pinch.s * d) / pinch.d / state.cam.s;
        zoomAt(pinch.mid[0], pinch.mid[1], k);
        moved = true;
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        if (moved) {
          state.cam.cx = drag.cx - dx / state.cam.s;
          state.cam.cy = drag.cy + dy / state.cam.s;
          state.autoFit = false;
          svg.classList.add('vw-panning');
          applyCam();
        }
      }
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) {
        svg.classList.remove('vw-panning');
        if (drag && !moved && e.type === 'pointerup') {
          const hit = hitTest(e.clientX, e.clientY);
          o.onPick(hit);
        }
        drag = null;
      }
    };
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('pointerleave', () => { if (!pointers.size) { setHover(null); o.onCursor(null); } });
    svg.addEventListener('dblclick', (e) => { e.preventDefault(); fit(); });

    const sizer = new ResizeObserver(() => {
      if (!state.cam) return;
      size();
      if (state.autoFit && state.res) fitBox(state.res.bbox); else applyCam();
    });
    sizer.observe(host);

    // Hit testing
    function hitTest(clientX, clientY) {
      if (!state.res || !state.cam) return null;
      const p = toWorld(clientX, clientY);
      const tol = 3 / state.cam.s;
      const objs = state.res.pads.concat(state.res.holes);
      let best = null, bestArea = Infinity;
      for (const ob of objs) {
        const b = ob.bbox;
        if (p[0] < b.x0 - tol || p[0] > b.x1 + tol || p[1] < b.y0 - tol || p[1] > b.y1 + tol) continue;
        const poly = S.geom.contourToPoly(ob.land, 0.2);
        if (!S.geom.pointInPoly(p, poly) && !nearPoly(p, poly, tol)) continue;
        const area = (b.x1 - b.x0) * (b.y1 - b.y0);
        if (area < bestArea) { best = ob; bestArea = area; }
      }
      if (!best && state.res.body) {
        const b = state.res.body;
        const inside = b.kind === 'cyl' ? Math.hypot(p[0] - b.x, p[1] - b.y) <= b.w / 2
          : Math.abs(p[0] - b.x) <= b.w / 2 && Math.abs(p[1] - b.y) <= b.l / 2;
        if (inside) best = Object.assign({ kind: 'body' }, b);
      }
      return best;
    }
    function nearPoly(p, poly, tol) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
        if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < tol) return true;
      }
      return false;
    }
    let hoverRaf = 0, lastMove = null;
    function hoverAt(e) {
      lastMove = e;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const hit = hitTest(lastMove.clientX, lastMove.clientY);
        setHover(hit, lastMove);
      });
    }
    function setHover(hit, e) {
      const key = hit ? hit.kind + ':' + (hit.name || '') : null;
      if (key !== state.hover) {
        state.hover = key;
        drawHighlight();
        o.onHover(hit);
      }
      svg.classList.toggle('vw-pointer', !!hit && hit.kind !== 'body');
      if (!hit || !e) { tip.hidden = true; return; }
      tip.innerHTML = describe(hit);
      tip.hidden = false;
      const r = host.getBoundingClientRect();
      let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      if (x + tw > r.width - 8) x = e.clientX - r.left - tw - 14;
      if (y + th > r.height - 8) y = e.clientY - r.top - th - 14;
      tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
    }

    // Hover text
    function len(v) { return S.fmtLen(v, state.units); }
    function U() { return state.units; }
    function sizeOf(sh) {
      switch (sh.kind) {
        case 'circle': return `⌀${len(sh.d)}`;
        case 'polygon': return 'polygon';
        default: return `${len(sh.w)} × ${len(sh.l)}`;
      }
    }
    function describe(ob) {
      if (ob.kind === 'body') {
        return `<b>body</b><span>${ob.kind === 'cyl' ? 'cylinder ⌀' + len(ob.w) : len(ob.w) + ' × ' + len(ob.l)}${ob.h ? ' × ' + len(ob.h) : ''} ${U()}</span><span>center (${len(ob.x)}, ${len(ob.y)}) ${U()}</span>`;
      }
      if (ob.kind === 'hole') {
        return `<b>hole ${esc(ob.name)}</b><span>NPTH ${sizeOf(ob.shape)} ${U()}${ob.shape.kind === 'oval' ? ' slot' : ''}</span><span>at (${len(ob.x)}, ${len(ob.y)}) ${U()}</span>`;
      }
      const sp = ob.spec;
      const rows = [];
      rows.push(`${sp.tht ? 'THT ' : ''}${ob.shape.kind} ${sizeOf(ob.shape)}${ob.shape.kind === 'roundrect' ? ' r ' + len(ob.shape.r) : ''}${ob.shape.kind !== 'polygon' ? ' ' + U() : ''}`);
      if (Math.abs(ob.rot % 360) > 1e-9) rows.push(`rotated ${+(((ob.rot % 360) + 360) % 360).toFixed(3)}°`);
      rows.push(`at (${len(ob.x)}, ${len(ob.y)}) ${U()}`);
      if (sp.drill) rows.push(`drill ${sp.drill.d != null ? '⌀' + len(sp.drill.d) : 'slot ' + len(sp.drill.slot.w) + ' × ' + len(sp.drill.slot.l)}`);
      const mk = sp.mask;
      rows.push(`mask ${!mk ? '+' + len(S.compiler.D.mask) + ' ' + U() + ' (default)' : mk.mode === 'expand' ? (mk.v >= 0 ? '+' : '') + len(mk.v) + ' ' + U() : mk.mode}`);
      const pm = sp.paste;
      rows.push(`paste ${!pm ? (sp.tht ? 'none (THT)' : '1:1') : pm.mode === 'divide' ? `${pm.nx} × ${pm.ny} windows${pm.coverage != null ? ', ' + Math.round(pm.coverage * 100) + '%' : ''}` : pm.mode === 'expand' ? (pm.v >= 0 ? '+' : '') + len(pm.v) : pm.mode}`);
      if (sp.vias) rows.push(`${sp.vias.nx} × ${sp.vias.ny} vias ⌀${len(sp.vias.drill)}`);
      const tags = [];
      if (ob.thermal) tags.push('thermal');
      if (ob.ipc) tags.push('IPC-derived');
      else if (ob.generated) tags.push('generated');
      if (ob.row) tags.push('row ' + esc(ob.row));
      if (ob.unplaced) tags.push('<em>unplaced</em>');
      if (ob.overlap) tags.push('<em>overlaps</em>');
      return `<b>pad ${esc(ob.name)}</b>${tags.length ? `<i>${tags.join(' · ')}</i>` : ''}${rows.map((r) => `<span>${r}</span>`).join('')}`;
    }

    // Drawing
    function render(res) {
      const key = res ? res.name : null;
      const first = !state.cam || key !== state.lastKey;
      state.lastKey = key;
      state.res = res;
      empty.hidden = !!res;
      if (!res) {
        for (const k of ['courtyard', 'fab', 'copper', 'drills', 'paste', 'mask', 'silk', 'hl', 'labels', 'origin', 'dims']) g[k].innerHTML = '';
        empty.textContent = 'Nothing to draw yet. Write a `footprint "NAME"` block, closed with `end`.';
        if (!state.cam) { size(); state.cam = { cx: 0, cy: 0, s: 40 }; applyCam(); }
        return;
      }
      drawWorld();
      size();
      if (first) { state.autoFit = true; fitBox(res.bbox); }
      else if (state.autoFit) fitBox(res.bbox);
      else applyCam();
      drawHighlight();
    }

    function drawWorld() {
      const res = state.res;
      // courtyard, fab and silk
      const lineItems = (items, cls) => items.map((it) => {
        if (it.type === 'line') return `<path class="${cls}" d="${polyPath(it.pts, false)}" stroke-width="${f(it.w)}"></path>`;
        if (it.type === 'poly') return `<path class="${cls} fill" d="${polyPath(it.pts, true)}"></path>`;
        if (it.type === 'circle') {
          return it.fill ? `<circle class="${cls} fill" cx="${f(it.c[0])}" cy="${f(-it.c[1])}" r="${f(it.r)}"></circle>`
            : `<circle class="${cls}" cx="${f(it.c[0])}" cy="${f(-it.c[1])}" r="${f(it.r)}" stroke-width="${f(it.w)}"></circle>`;
        }
        if (it.type === 'text') {
          const fs = it.size / 0.72;
          return `<text class="${cls} txt" x="${f(it.at[0])}" y="${f(-it.at[1])}" font-size="${f(fs)}">${esc(it.str)}</text>`;
        }
        return '';
      }).join('');
      g.courtyard.innerHTML = lineItems(res.courtyard, 'crt');
      g.fab.innerHTML = lineItems(res.assembly, 'fab');
      g.silk.innerHTML = lineItems(res.silk, 'silk');
      // copper
      let cu = '', dr = '', pa = '', mk = '';
      res.pads.forEach((p, i) => {
        const cls = ['pad'];
        if (p.unplaced) cls.push('unplaced');
        if (p.missing) cls.push('missing');
        cu += `<path class="${cls.join(' ')}" data-i="${i}" d="${pathOf(p.copper)}"></path>`;
        if (p.drillShape) dr += `<path class="drill" d="${pathOf(p.drillShape)}"></path>`;
        for (const v of p.vias || []) dr += `<circle class="via" cx="${f(v.x)}" cy="${f(-v.y)}" r="${f(v.d / 2)}"></circle>`;
        if (p.paste) for (const w of p.paste) pa += `<path class="paste" d="${pathOf(w)}"></path>`;
        if (p.mask) mk += `<path class="mask" d="${pathOf(p.mask)}"></path>`;
      });
      for (const h of res.holes) {
        dr += `<path class="npth${h.unplaced ? ' unplaced' : ''}" d="${pathOf(h.land)}"></path>`;
        if (h.mask) mk += `<path class="mask" d="${pathOf(h.mask)}"></path>`;
      }
      g.copper.innerHTML = cu;
      g.drills.innerHTML = dr;
      g.paste.innerHTML = pa;
      g.mask.innerHTML = mk;
      applyLayerVisibility();
    }

    function drawGrid() {
      if (!state.layers.grid || !state.cam) { g.grid.innerHTML = ''; return; }
      const { cx, cy, s } = state.cam;
      const w = state.W / s, h = state.H / s;
      const unit = state.units === 'mil' ? 0.0254 : 1;
      const steps = [1, 2, 5];
      let minor = null;
      for (let e = -3; e <= 4 && !minor; e++) {
        for (const k of steps) {
          const v = k * Math.pow(10, e) * unit;
          if (v * s >= 14) { minor = v; break; }
        }
      }
      minor = minor || 10;
      const major = minor * 5;
      const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
      let d1 = '', d2 = '';
      const lines = (step, push) => {
        for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) push(`M${f(x)} ${f(-y1)}V${f(-y0)}`, x);
        for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) push(`M${f(x0)} ${f(-y)}H${f(x1)}`, y);
      };
      lines(minor, (d, v) => { if (Math.abs(Math.round(v / major) * major - v) > minor * 0.01) d1 += d; });
      lines(major, (d, v) => { if (Math.abs(v) > minor * 0.01) d2 += d; });
      const axes = `M${f(x0)} 0H${f(x1)}M0 ${f(-y1)}V${f(-y0)}`;
      g.grid.innerHTML = `<path class="g-minor" d="${d1}"></path><path class="g-major" d="${d2}"></path><path class="g-axis" d="${axes}"></path>`;
      state.gridStep = minor;
    }

    function drawOrigin() {
      if (!state.res || !state.cam) { g.origin.innerHTML = ''; return; }
      const r = 7 / state.cam.s;
      g.origin.innerHTML = `<circle class="org" cx="0" cy="0" r="${f(r)}"></circle><path class="org" d="M${f(-r * 1.8)} 0H${f(r * 1.8)}M0 ${f(-r * 1.8)}V${f(r * 1.8)}"></path>`;
    }

    function drawLabels() {
      if (!state.res || !state.cam || !state.layers.labels) { g.labels.innerHTML = ''; return; }
      const s = state.cam.s;
      let out = '';
      for (const p of state.res.pads) {
        const b = p.bbox;
        const w = b.x1 - b.x0, h = b.y1 - b.y0;
        const name = String(p.name);
        const byH = Math.min(w, h) * 0.62;
        const byW = (Math.max(w, h) * 0.86) / (0.62 * Math.max(1, name.length));
        let fs = Math.min(byH, byW, 0.9);
        if (p.drillShape) fs = Math.min(fs, Math.min(w, h) * 0.32);
        if (fs * s < 7) continue;
        let x = p.x, y = p.y, onDrill = false;
        if (p.drillShape) {
          const db = S.geom.contourBBox(p.drillShape);
          const room = (b.y1 - db.y1);
          if (room > fs * 0.9) y = (db.y1 + b.y1) / 2;
          else onDrill = true;
        }
        out += `<text class="plabel${onDrill ? ' on-drill' : ''}${p.unplaced ? ' unplaced' : ''}" x="${f(x)}" y="${f(-y)}" font-size="${f(fs)}">${esc(name)}</text>`;
      }
      for (const h of state.res.holes) {
        const b = h.bbox;
        const fs = Math.min((b.x1 - b.x0) * 0.3, 1.2);
        if (fs * s < 8) continue;
        out += `<text class="hlabel" x="${f(h.x)}" y="${f(-(b.y0 - fs * 0.9))}" font-size="${f(fs)}">${esc(h.name)}</text>`;
      }
      g.labels.innerHTML = out;
    }

    // Dimensions
    function drawDims() {
      if (!state.res || !state.cam) { g.dims.innerHTML = ''; return; }
      const s = state.cam.s;
      const px = (n) => n / s;
      const focus = state.focus.ranges;
      const inFocus = (d) => focus.some((r) => r.s <= d.s && d.e <= r.e + 0 || (r.s >= d.stmtS && r.s <= d.stmtE));
      const list = state.res.dims.filter((d) => state.layers.dims || inFocus(d));
      let out = '';
      const used = { x: [], y: [] };
      placed = [];
      // focused dimensions go first, so their labels win
      list.sort((a, b) => (inFocus(b) ? 1 : 0) - (inFocus(a) ? 1 : 0));
      for (const d of list) {
        const cls = inFocus(d) ? 'dim on' : 'dim';
        if (d.kind === 'dim') out += dimLinear(d, cls, px, used);
        else if (d.kind === 'between') {
          out += `<path class="${cls} dash" d="M${f(d.a[0])} ${f(-d.a[1])}L${f(d.b[0])} ${f(-d.b[1])}"></path>`;
          const m = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
          out += mark(m, cls, px) + dot(d.a, cls, px) + dot(d.b, cls, px);
          out += pill(m[0], m[1], `centered ${d.axis === 'x' ? '↔' : '↕'}`, cls, px, 0, -16);
        } else if (d.kind === 'on') {
          out += `<path class="${cls} dash" d="${d.axis === 'x' ? `M${f(d.o[0])} ${f(-Math.max(d.obox.y1, d.tbox.y1) - px(12))}V${f(-Math.min(d.obox.y0, d.tbox.y0) + px(12))}` : `M${f(Math.min(d.obox.x0, d.tbox.x0) - px(12))} ${f(-d.o[1])}H${f(Math.max(d.obox.x1, d.tbox.x1) + px(12))}`}"></path>`;
          out += pill(d.o[0], d.o[1], `centered on ${d.axis}`, cls, px, 0, -16);
        } else if (d.kind === 'align') {
          const horiz = d.axis === 'y';
          const xa = Math.min(d.tbox.x0, d.bbox.x0) - px(10), xb = Math.max(d.tbox.x1, d.bbox.x1) + px(10);
          const ya = Math.min(d.tbox.y0, d.bbox.y0) - px(10), yb = Math.max(d.tbox.y1, d.bbox.y1) + px(10);
          out += horiz ? `<path class="${cls} dash" d="M${f(xa)} ${f(-d.b[1])}H${f(xb)}"></path>` : `<path class="${cls} dash" d="M${f(d.b[0])} ${f(-yb)}V${f(-ya)}"></path>`;
          out += dot(d.a, cls, px) + dot(d.b, cls, px);
        } else if (d.kind === 'mirror') {
          const bb = state.res.bbox;
          const ext = px(16);
          out += d.axis === 'x'
            ? `<path class="${cls} axis" d="M${f(d.line)} ${f(-(bb.y1 + ext))}V${f(-(bb.y0 - ext))}"></path>`
            : `<path class="${cls} axis" d="M${f(bb.x0 - ext)} ${f(-d.line)}H${f(bb.x1 + ext)}"></path>`;
          out += `<path class="${cls} dot-line" d="M${f(d.p[0])} ${f(-d.p[1])}L${f(d.t[0])} ${f(-d.t[1])}"></path>`;
          out += dot(d.p, cls, px) + dot(d.t, cls, px);
          out += pill(d.axis === 'x' ? d.line : bb.x1 + ext, d.axis === 'x' ? bb.y1 + ext : d.line, 'mirror', cls, px, 0, -10);
        } else if (d.kind === 'at') {
          const p = d.point;
          out += mark(p, cls, px);
          out += pill(p[0], p[1], `(${len(p[0])}, ${len(p[1])}) ${U()}`, cls, px, 0, -18);
        }
      }
      g.dims.innerHTML = out;
    }
    function dot(p, cls, px) { return `<circle class="${cls} pt" cx="${f(p[0])}" cy="${f(-p[1])}" r="${f(px(2.6))}"></circle>`; }
    function mark(p, cls, px) {
      const r = px(6);
      return `<path class="${cls}" d="M${f(p[0] - r)} ${f(-p[1])}H${f(p[0] + r)}M${f(p[0])} ${f(-p[1] - r)}V${f(-p[1] + r)}"></path>`;
    }
    let placed = [];
    function pill(x, y, text, cls, px, dxp, dyp) {
      const fs = px(11);
      const w = px(7 + text.length * 6.6), h = px(16);
      const X = x + px(dxp || 0), Y = -y + px(dyp || 0);
      const box = { x0: X - w / 2, x1: X + w / 2, y0: Y - h / 2, y1: Y + h / 2 };
      const hit = placed.some((q) => box.x0 < q.x1 && q.x0 < box.x1 && box.y0 < q.y1 && q.y0 < box.y1);
      if (hit && !/\bon\b/.test(cls)) return '';     // unfocused labels make room
      placed.push(box);
      return `<g class="${cls} pill"><rect x="${f(X - w / 2)}" y="${f(Y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(px(4))}"></rect><text x="${f(X)}" y="${f(Y)}" font-size="${f(fs)}">${esc(text)}</text></g>`;
    }
    function dimLinear(d, cls, px, used) {
      const ax = d.axis;
      const a = d.a, b = d.b;
      const label = d.plain ? d.text : `${d.text} = ${len(d.value)} ${U()}`;
      // the dimension line goes outside both objects, past any earlier ones
      let out = '';
      if (ax === 'x') {
        let yl = Math.max(d.rbox.y1, d.tbox.y1) + px(18);
        while (used.x.some((u) => Math.abs(u - yl) < px(18))) yl += px(18);
        used.x.push(yl);
        const ext = px(5);
        out += `<path class="${cls} wit" d="M${f(a)} ${f(-(d.rbox.y1 + px(3)))}V${f(-(yl + ext))}M${f(b)} ${f(-(d.tbox.y1 + px(3)))}V${f(-(yl + ext))}"></path>`;
        out += arrowLine([a, yl], [b, yl], cls, px);
        out += pill((a + b) / 2, yl, label, cls, px, 0, -11);
      } else {
        let xl = Math.max(d.rbox.x1, d.tbox.x1) + px(18);
        while (used.y.some((u) => Math.abs(u - xl) < px(18))) xl += px(18);
        used.y.push(xl);
        const ext = px(5);
        out += `<path class="${cls} wit" d="M${f(d.rbox.x1 + px(3))} ${f(-a)}H${f(xl + ext)}M${f(d.tbox.x1 + px(3))} ${f(-b)}H${f(xl + ext)}"></path>`;
        out += arrowLine([xl, a], [xl, b], cls, px);
        out += pill(xl, (a + b) / 2, label, cls, px, 8 + label.length * 3.3, 0);
      }
      return out;
    }
    function arrowLine(p, q, cls, px) {
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const ah = px(6), aw = px(3);
      if (L < 1e-9) return `<circle class="${cls} pt" cx="${f(p[0])}" cy="${f(-p[1])}" r="${f(px(2.5))}"></circle>`;
      const u = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
      const n = [-u[1], u[0]];
      const head = (tip, dir) => {
        const b0 = [tip[0] - dir[0] * ah + n[0] * aw, tip[1] - dir[1] * ah + n[1] * aw];
        const b1 = [tip[0] - dir[0] * ah - n[0] * aw, tip[1] - dir[1] * ah - n[1] * aw];
        return `<path class="${cls} head" d="M${f(tip[0])} ${f(-tip[1])}L${f(b0[0])} ${f(-b0[1])}L${f(b1[0])} ${f(-b1[1])}Z"></path>`;
      };
      const inside = L * state.cam.s > 22;
      let out = `<path class="${cls}" d="M${f(p[0])} ${f(-p[1])}L${f(q[0])} ${f(-q[1])}"></path>`;
      if (inside) out += head(q, u) + head(p, [-u[0], -u[1]]);
      else {
        const e = px(12);
        out += `<path class="${cls}" d="M${f(p[0] - u[0] * e)} ${f(-(p[1] - u[1] * e))}L${f(p[0])} ${f(-p[1])}M${f(q[0])} ${f(-q[1])}L${f(q[0] + u[0] * e)} ${f(-(q[1] + u[1] * e))}"></path>`;
        out += head(p, u) + head(q, [-u[0], -u[1]]);
      }
      return out;
    }

    // Highlight
    function drawHighlight() {
      if (!state.res) { g.hl.innerHTML = ''; return; }
      let out = '';
      const focus = state.focus.objects;
      const draw = (ob, cls) => {
        if (ob.kind === 'body') out += `<path class="${cls}" d="${polyPath(state.res.body.outline, true)}"></path>`;
        else out += `<path class="${cls}" d="${pathOf(ob.land)}"></path>`;
      };
      for (const ob of state.res.pads.concat(state.res.holes)) if (focus.has(ob)) draw(ob, 'hl-focus');
      if (state.res.body && focus.has('body')) draw({ kind: 'body' }, 'hl-focus');
      if (state.hover) {
        const [kind, name] = state.hover.split(':');
        if (kind === 'body') draw({ kind: 'body' }, 'hl-hover');
        else {
          const ob = (kind === 'pad' ? state.res.pads : state.res.holes).find((x) => String(x.name) === name);
          if (ob) draw(ob, 'hl-hover');
        }
      }
      g.hl.innerHTML = out;
    }

    function applyLayerVisibility() {
      const L = state.layers;
      g.courtyard.style.display = L.courtyard ? '' : 'none';
      g.fab.style.display = L.fab ? '' : 'none';
      g.copper.style.display = L.copper ? '' : 'none';
      g.drills.style.display = L.drills ? '' : 'none';
      g.paste.style.display = L.paste ? '' : 'none';
      g.mask.style.display = L.mask ? '' : 'none';
      g.silk.style.display = L.silk ? '' : 'none';
    }

    // API
    return {
      render,
      fit,
      setLayer(k, on) {
        state.layers[k] = on;
        applyLayerVisibility();
        if (k === 'grid') drawGrid();
        if (k === 'labels') drawLabels();
        if (k === 'dims') drawDims();
      },
      layers: () => Object.assign({}, state.layers),
      setUnits(u) { state.units = u; if (state.cam) applyCam(); },
      /** Statement ranges under the editor cursor: highlight their objects and dimensions. */
      setFocus(ranges) {
        state.focus.ranges = ranges || [];
        const objs = new Set();
        if (state.res && ranges && ranges.length) {
          const hit = (src) => src && src.some((r) => ranges.some((q) => q.s >= r.s && q.s <= r.e));
          for (const ob of state.res.pads.concat(state.res.holes)) if (hit(ob.src)) objs.add(ob);
          if (state.res.body && hit(state.res.body.src)) objs.add('body');
        }
        state.focus.objects = objs;
        drawHighlight();
        drawDims();
      },
      gridStep: () => state.gridStep,
      destroy() { sizer.disconnect(); host.innerHTML = ''; host.classList.remove('vw'); },
    };
  }

  /** Formats a length. Used by the viewer and the app. */
  S.fmtLen = function (v, units) {
    const n = units === 'mil' ? +(v / 0.0254).toFixed(2) : +v.toFixed(4);
    return (Object.is(n, -0) ? 0 : n).toString().replace('-', '−');
  };

  S.createViewer = createViewer;
  S.svgPaths = { contour: pathOf, poly: polyPath };
})(typeof self !== 'undefined' ? self : this);
