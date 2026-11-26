/* WebGL viewer for the 3D model. All meshes share one buffer and their colors sit
 * in a second one, so a highlight only rewrites colors. The lights follow the camera,
 * so every view is lit from the upper left. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Stomp = root.Stomp || {}).createViewer3D = factory().createViewer3D;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec4 aCol;
uniform mat4 uMVP;
varying vec3 vPos; varying vec3 vNrm; varying vec4 vCol;
void main() { vPos = aPos; vNrm = aNrm; vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); }`;
  const FS = `
precision highp float;
varying vec3 vPos; varying vec3 vNrm; varying vec4 vCol;
uniform vec3 uEye; uniform vec3 uKey; uniform vec3 uFill; uniform vec3 uSky; uniform vec3 uGround; uniform float uAlpha;
void main() {
  vec3 N = normalize(vNrm);
  vec3 V = normalize(uEye - vPos);
  if (dot(N, V) < 0.0) N = -N;
  float metal = vCol.a;
  vec3 base = vCol.rgb;
  float k = max(dot(N, uKey), 0.0);
  float f = max(dot(N, uFill), 0.0);
  vec3 amb = mix(uGround, uSky, 0.5 + 0.5 * N.z);
  vec3 H = normalize(uKey + V);
  float sp = pow(max(dot(N, H), 0.0), mix(24.0, 64.0, metal));
  vec3 R = reflect(-V, N);
  vec3 env = mix(vec3(0.46, 0.47, 0.49), vec3(1.08), smoothstep(-0.45, 0.65, R.z));
  vec3 plastic = base * (0.34 * amb + 0.66 * k + 0.20 * f) + vec3(0.09 * sp);
  vec3 shiny = base * (0.16 * amb + 0.30 * k) + base * env * 0.62 + vec3(0.65 * sp);
  gl_FragColor = vec4(mix(plastic, shiny, metal), uAlpha);
}`;
  const LVS = `attribute vec3 aPos; uniform mat4 uMVP; void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;
  const LFS = `precision mediump float; uniform vec4 uColor; void main() { gl_FragColor = uColor; }`;

  // Math
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const L = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(eye, target, up) {
    const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }

  const PRESETS = {
    iso: { az: 24, el: 44 }, top: { az: 0, el: 90 }, bottom: { az: 0, el: -90 },
    front: { az: 0, el: 8 }, side: { az: 90, el: 8 },
  };

  function createViewer3D(host, opts) {
    opts = opts || {};
    const canvas = document.createElement('canvas');
    canvas.className = 'v3d-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '3D model. Drag to orbit, shift-drag to pan, scroll to zoom, double-click to reset. Arrow keys also orbit.');
    host.appendChild(canvas);
    const note = document.createElement('div');
    note.className = 'v3d-note';
    host.appendChild(note);
    const hint = document.createElement('div');
    hint.className = 'v3d-hint';
    hint.textContent = 'drag to orbit · shift-drag to pan · scroll to zoom · double-click to reset';
    host.appendChild(hint);

    const st = {
      model: null, board: null, key: null, focus: [], showBoard: true, showCrt: true,
      az: PRESETS.iso.az, el: PRESETS.iso.el, dist: 20, target: [0, 0, 0], radius: 5,
      W: 1, H: 1, dpr: 1, dirty: false, lost: false,
    };
    let gl = null, prog = null, lprog = null, ext32 = null;
    let scene = null;            // { vbo, cbo, ibo, count, type, colors, ranges, lines, nLines, boardStart }

    function initGL() {
      gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false })
        || canvas.getContext('experimental-webgl', { antialias: true, alpha: true });
      if (!gl) return false;
      ext32 = gl.getExtension('OES_element_index_uint');
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const link = (vs, fs, attrs) => {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const u = {};
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
        return { p, u };
      };
      prog = link(VS, FS, ['aPos', 'aNrm', 'aCol']);
      lprog = link(LVS, LFS, ['aPos']);
      gl.enable(gl.DEPTH_TEST);
      return true;
    }
    let ok = false;
    try { ok = initGL(); } catch (e) { ok = false; console.error(e); }
    if (!ok) host.classList.add('v3d-nogl');

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); st.lost = true; scene = null; });
    canvas.addEventListener('webglcontextrestored', () => {
      st.lost = false;
      try { initGL(); upload(); draw(); } catch (e) { console.error(e); }
    });

    // Scene
    function upload() {
      if (!gl || st.lost) return;
      if (scene) { gl.deleteBuffer(scene.vbo); gl.deleteBuffer(scene.cbo); gl.deleteBuffer(scene.ibo); if (scene.lbo) gl.deleteBuffer(scene.lbo); }
      scene = null;
      const meshes = [];
      if (st.model) for (const m of st.model.meshes) meshes.push({ m, board: false });
      if (st.board) for (const m of st.board.meshes) meshes.push({ m, board: true });
      // part first, then board, so hiding the board just draws fewer triangles
      meshes.sort((a, b) => (a.board ? 1 : 0) - (b.board ? 1 : 0));
      let nv = 0, ni = 0;
      for (const { m } of meshes) { nv += m.pos.length / 3; ni += m.idx.length; }
      const big = nv > 65535;
      if (big && !ext32) return;      // a scene this large needs 32-bit indices
      const V = new Float32Array(nv * 6), C = new Float32Array(nv * 4), I = big ? new Uint32Array(ni) : new Uint16Array(ni);
      let v = 0, i = 0, boardStart = ni;
      const ranges = [];
      for (const { m, board } of meshes) {
        if (board && boardStart === ni) boardStart = i;
        const base = v;
        for (let k = 0; k < m.pos.length; k += 3) {
          V[v * 6] = m.pos[k]; V[v * 6 + 1] = m.pos[k + 1]; V[v * 6 + 2] = m.pos[k + 2];
          V[v * 6 + 3] = m.nrm[k]; V[v * 6 + 4] = m.nrm[k + 1]; V[v * 6 + 5] = m.nrm[k + 2];
          v++;
        }
        for (let k = 0; k < m.idx.length; k++) I[i++] = base + m.idx[k];
        ranges.push({ m, v0: base, v1: v, board });
      }
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, V, gl.STATIC_DRAW);
      const cbo = gl.createBuffer();
      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I, gl.STATIC_DRAW);
      scene = { vbo, cbo, ibo, count: ni, type: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, colors: C, ranges, boardStart };
      // courtyard lines
      const lines = (st.board && st.board.lines) || [];
      if (lines.length) {
        const L = new Float32Array(lines.length * 6);
        lines.forEach((s, k) => L.set(s, k * 6));
        scene.lbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, scene.lbo);
        gl.bufferData(gl.ARRAY_BUFFER, L, gl.STATIC_DRAW);
        scene.nLines = lines.length * 2;
      }
      writeColors();
    }

    const overlaps = (src, focus) => {
      for (const r of src || []) for (const f of focus) if (r.s < f.e && f.s < r.e) return true;
      return false;
    };
    function writeColors() {
      if (!scene || !gl) return;
      const C = scene.colors;
      const hl = opts.highlight || [0.04, 0.42, 0.75];
      for (const rg of scene.ranges) {
        const on = !rg.board && st.focus.length && overlaps(rg.m.src, st.focus);
        let [r, g, b] = rg.m.color;
        if (on) { r = r * 0.45 + hl[0] * 0.55; g = g * 0.45 + hl[1] * 0.55; b = b * 0.45 + hl[2] * 0.55; }
        const metal = on ? rg.m.metal * 0.4 : rg.m.metal;
        for (let k = rg.v0; k < rg.v1; k++) { C[k * 4] = r; C[k * 4 + 1] = g; C[k * 4 + 2] = b; C[k * 4 + 3] = metal; }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, scene.cbo);
      gl.bufferData(gl.ARRAY_BUFFER, C, gl.DYNAMIC_DRAW);
      request();
    }

    // Camera
    function bounds() {
      const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
      const add = (q) => { if (!q) return; b.x0 = Math.min(b.x0, q.x0); b.y0 = Math.min(b.y0, q.y0); b.z0 = Math.min(b.z0, q.z0); b.x1 = Math.max(b.x1, q.x1); b.y1 = Math.max(b.y1, q.y1); b.z1 = Math.max(b.z1, q.z1); };
      if (st.model && st.model.bbox) add(st.model.bbox);
      if (st.board && st.board.core) add(st.board.core);
      if (!Number.isFinite(b.x0)) return { x0: -2, y0: -2, z0: -1, x1: 2, y1: 2, z1: 1 };
      return b;
    }
    function fit(preset) {
      const b = bounds();
      st.target = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2];
      st.radius = Math.max(0.5, Math.hypot(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0) / 2);
      if (preset) { const P = PRESETS[preset] || PRESETS.iso; st.az = P.az; st.el = P.el; }
      const fov = 30 * Math.PI / 180;
      const aspect = st.W / Math.max(1, st.H);
      const fit1 = st.radius / Math.sin(fov / 2);
      st.dist = fit1 * (aspect < 1 ? 1 / Math.max(aspect, 0.45) : 1) * 1.02;
      st.autoFit = true;
      request();
    }
    function camera() {
      const az = st.az * Math.PI / 180, el = st.el * Math.PI / 180;
      const T = st.target;
      const eye = [T[0] + st.dist * Math.cos(el) * Math.sin(az), T[1] - st.dist * Math.cos(el) * Math.cos(az), T[2] + st.dist * Math.sin(el)];
      const up = [-Math.sin(el) * Math.sin(az), Math.sin(el) * Math.cos(az), Math.cos(el)];
      return { eye, up };
    }

    // Drawing
    let raf = 0;
    function request() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
    function draw() {
      if (!gl || st.lost) return;
      const W = canvas.width, H = canvas.height;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!scene) return;
      const { eye, up } = camera();
      // a close near plane stops z-fighting on the thin marks with 16-bit depth buffers
      const near = Math.max(st.dist - st.radius * 2.5, st.dist * 0.08, 0.01), far = st.dist + st.radius * 4 + 5;
      const proj = perspective(30 * Math.PI / 180, W / Math.max(1, H), near, far);
      const view = lookAt(eye, st.target, up);
      const mvp = mul(proj, view);
      const back = norm(sub(eye, st.target)), right = norm(cross(up, back));
      const toWorld = (v) => norm([right[0] * v[0] + up[0] * v[1] + back[0] * v[2], right[1] * v[0] + up[1] * v[1] + back[1] * v[2], right[2] * v[0] + up[2] * v[1] + back[2] * v[2]]);
      const dark = !!opts.dark && opts.dark();
      gl.useProgram(prog.p);
      gl.uniformMatrix4fv(prog.u.uMVP, false, new Float32Array(mvp));
      gl.uniform3fv(prog.u.uEye, eye);
      gl.uniform3fv(prog.u.uKey, toWorld(norm([-0.45, 0.62, 0.65])));
      gl.uniform3fv(prog.u.uFill, toWorld(norm([0.65, -0.15, 0.45])));
      gl.uniform3fv(prog.u.uSky, dark ? [0.82, 0.86, 0.92] : [0.95, 0.97, 1.0]);
      gl.uniform3fv(prog.u.uGround, dark ? [0.32, 0.31, 0.30] : [0.46, 0.44, 0.42]);
      gl.bindBuffer(gl.ARRAY_BUFFER, scene.vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindBuffer(gl.ARRAY_BUFFER, scene.cbo);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, scene.ibo);
      const bytes = scene.type === gl.UNSIGNED_INT ? 4 : 2;
      gl.uniform1f(prog.u.uAlpha, 1);
      if (scene.boardStart > 0) gl.drawElements(gl.TRIANGLES, scene.boardStart, scene.type, 0);
      if (st.showBoard && scene.count > scene.boardStart) {
        // from below, the board turns see-through so the part's underside shows
        const below = eye[2] < 0;
        if (below) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          gl.uniform1f(prog.u.uAlpha, 0.28);
        }
        gl.drawElements(gl.TRIANGLES, scene.count - scene.boardStart, scene.type, scene.boardStart * bytes);
        if (below) { gl.disable(gl.BLEND); gl.depthMask(true); gl.uniform1f(prog.u.uAlpha, 1); }
      }
      gl.disableVertexAttribArray(1); gl.disableVertexAttribArray(2);
      if (st.showCrt && scene.lbo) {
        gl.useProgram(lprog.p);
        gl.uniformMatrix4fv(lprog.u.uMVP, false, new Float32Array(mvp));
        gl.uniform4fv(lprog.u.uColor, opts.courtyard || [0.82, 0.11, 0.49, 1]);
        gl.bindBuffer(gl.ARRAY_BUFFER, scene.lbo);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, scene.nLines);
      }
      if (opts.onCamera) opts.onCamera({ az: st.az, el: st.el, dist: st.dist });
    }

    function resize() {
      const r = host.getBoundingClientRect();
      st.dpr = Math.min(window.devicePixelRatio || 1, 2);
      st.W = Math.max(1, Math.round(r.width)); st.H = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(st.W * st.dpr); canvas.height = Math.round(st.H * st.dpr);
      canvas.style.width = st.W + 'px'; canvas.style.height = st.H + 'px';
      if (st.autoFit && (st.model || st.board)) fit(null);   // keep the part framed on resize until the user moves the camera
      request();
    }
    const sizer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (!host.hidden) resize(); }) : null;
    if (sizer) sizer.observe(host);

    // Input
    const ptrs = new Map();
    let drag = null;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pan = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey;
      drag = { mode: ptrs.size > 1 ? 'pinch' : pan ? 'pan' : 'orbit', x: e.clientX, y: e.clientY, pinch: pinchState() };
      st.autoFit = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId) || !drag) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size > 1) {
        const now = pinchState();
        if (drag.mode !== 'pinch' || !drag.pinch) { drag = { mode: 'pinch', pinch: now }; return; }
        if (now.d > 0 && drag.pinch.d > 0) st.dist = clampDist(st.dist * drag.pinch.d / now.d);
        panBy(now.x - drag.pinch.x, now.y - drag.pinch.y);
        drag.pinch = now;
        request();
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.mode === 'pan') panBy(dx, dy);
      else if (drag.mode === 'orbit') { st.az -= dx * 0.45; st.el = Math.max(-90, Math.min(90, st.el + dy * 0.45)); }
      request();
    });
    const up = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) drag = null; else drag = { mode: 'pinch', pinch: pinchState() }; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 0.5 : 0.0015;
      st.dist = clampDist(st.dist * Math.exp(e.deltaY * k));
      st.autoFit = false;
      request();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => fit('iso'));
    canvas.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 15 : 5;
      if (e.key === 'ArrowLeft') st.az += step; else if (e.key === 'ArrowRight') st.az -= step;
      else if (e.key === 'ArrowUp') st.el = Math.min(90, st.el + step); else if (e.key === 'ArrowDown') st.el = Math.max(-90, st.el - step);
      else if (e.key === '+' || e.key === '=') st.dist = clampDist(st.dist / 1.15);
      else if (e.key === '-' || e.key === '_') st.dist = clampDist(st.dist * 1.15);
      else if (e.key === '0') { fit('iso'); return; }
      else return;
      st.autoFit = false;
      e.preventDefault();
      request();
    });
    function pinchState() {
      const p = [...ptrs.values()];
      if (p.length < 2) return { x: 0, y: 0, d: 0 };
      return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
    }
    const clampDist = (d) => Math.max(st.radius * 0.15, Math.min(st.radius * 40, d));
    function panBy(dx, dy) {
      const { eye, up: u } = camera();
      const back = norm(sub(eye, st.target)), right = norm(cross(u, back));
      const k = (2 * st.dist * Math.tan(15 * Math.PI / 180)) / Math.max(1, st.H);
      st.target = [st.target[0] - (right[0] * dx - u[0] * dy) * k, st.target[1] - (right[1] * dx - u[1] * dy) * k, st.target[2] - (right[2] * dx - u[2] * dy) * k];
    }

    // API
    return {
      ok,
      show(model, board, key) {
        st.model = model; st.board = board;
        note.innerHTML = '';
        const notes = [];
        if (model && model.none) notes.push('No 3D model: this footprint says <code>no model</code>.');
        for (const n of (model && model.notes) || []) notes.push(n.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/`([^`]+)`/g, '<code>$1</code>'));
        if (!ok) notes.unshift('This browser has no WebGL, so the 3D view can\'t be drawn.');
        note.innerHTML = notes.map((t) => `<p>${t}</p>`).join('');
        note.hidden = !notes.length;
        resize();
        upload();
        // frame a new footprint again but keep the viewing angle
        if (key !== st.key) { fit(st.key == null ? 'iso' : null); st.key = key; }
        request();
      },
      setFocus(ranges) { st.focus = ranges || []; if (scene) writeColors(); },
      setBoard(on) { st.showBoard = !!on; request(); },
      setCourtyard(on) { st.showCrt = !!on; request(); },
      view(p) { fit(p); },
      fit() { fit('iso'); },
      resize,
      redraw: request,
      snapshot() { draw(); return canvas.toDataURL('image/png'); },
      get camera() { return { az: st.az, el: st.el, dist: st.dist, target: st.target.slice() }; },
      /** Let go of the WebGL context (browsers allow only a few) and empty the host. */
      destroy() {
        if (sizer) sizer.disconnect();
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        const lose = gl && gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        gl = null;
        host.innerHTML = '';
      },
    };
  }

  return { createViewer3D };
});
