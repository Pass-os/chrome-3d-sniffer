// Captura de cenas three.js (via __THREE_DEVTOOLS__) e, como reserva, de geometria WebGL pura.
(() => {
  const api = window.__m3dApi;
  if (!api || !api.registerLive) return;

  // ---------- three.js ----------
  // three (r13x+) avisa cada Scene/WebGLRenderer criado se existir window.__THREE_DEVTOOLS__
  const pending = new Map(); // scene -> instante em que foi vista
  const rendered = new WeakSet(); // cenas desenhadas na tela (sem render target)
  let rendererSeen = false;
  let registeredCount = 0;
  const canvasScenes = new WeakMap(); // canvas -> cenas recentes desenhadas por ele (inclui render targets/pós-processamento)
  const sceneIds = new WeakMap();
  const glByCanvas = new WeakMap();
  let timer = 0;

  // quad/triângulo de tela cheia com shader próprio (pós-processamento, fundo): não é modelo
  function isTrivialShader(o) {
    const g = o.geometry, p = g && g.attributes && g.attributes.position;
    if (!p) return false;
    const tris = g.index ? g.index.count / 3 : p.count / 3;
    const m = [].concat(o.material)[0];
    return tris <= 2 && !!(m && m.isShaderMaterial);
  }

  function countMeshes(scene) {
    let n = 0;
    scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && !isTrivialShader(o)) n++; });
    return n;
  }

  function registerScene(s, n) {
    if (sceneIds.has(s)) return sceneIds.get(s);
    registeredCount++;
    const id = api.registerLive({
      type: 'three.js (' + n + ' malhas, exportado ao vivo)',
      name: (s.name || 'scene') + '_' + registeredCount + '.glb',
      via: 'three.js',
      build: () => api.exportThree(s)
    });
    sceneIds.set(s, id);
    return id;
  }

  function trackScene(canvas, scene) {
    if (!canvas || !scene) return;
    let a = canvasScenes.get(canvas);
    if (!a) { a = []; canvasScenes.set(canvas, a); }
    if (!a.includes(scene)) { a.push(scene); if (a.length > 8) a.shift(); }
  }

  function poll() {
    const now = Date.now();
    for (const [s, t0] of pending) {
      // com renderer observado, só cenas realmente desenhadas viram item (ignora RoomEnvironment etc.)
      if (rendererSeen && !rendered.has(s) && now - t0 < 60000) continue;
      let n = 0;
      try { n = countMeshes(s); } catch (e) { pending.delete(s); continue; }
      if (!n) continue;
      pending.delete(s);
      registerScene(s, n);
    }
    if (!pending.size) { clearInterval(timer); timer = 0; }
  }

  function hookRenderer(r) {
    if (r.__m3dHooked || typeof r.render !== 'function') return;
    Object.defineProperty(r, '__m3dHooked', { value: true });
    rendererSeen = true;
    const orig = r.render;
    r.render = function (scene) {
      try {
        trackScene(r.domElement, scene);
        if (!(r.getRenderTarget && r.getRenderTarget())) rendered.add(scene);
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  }

  let hook = window.__THREE_DEVTOOLS__;
  if (!hook) {
    hook = new EventTarget();
    try { window.__THREE_DEVTOOLS__ = hook; } catch (e) {}
  }
  hook.addEventListener('observe', (e) => {
    const o = e.detail;
    if (!o) return;
    if (o.isWebGLRenderer || o.isWebGPURenderer) hookRenderer(o);
    else if (o.isScene && pending.size < 50) {
      pending.set(o, Date.now());
      if (!timer) timer = setInterval(poll, 1500);
    }
  });

  // ---------- WebGL puro ----------
  const ARRAY = 34962, ELEMENT = 34963, STATIC = 35044;
  const MAX_BYTES = 128 * 1024 * 1024;
  const BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5124: 4, 5125: 4, 5126: 4, 5131: 2, 36193: 2 };
  const RX_POS1 = /^(a_?|in_?|v_?)?pos(ition)?$/i;
  const RX_POS2 = /position|vertex/i;
  const RX_NOT_POS = /normal|uv|tex|col|tangent|weight|joint|skin|bone/i;
  let totalBytes = 0;
  const states = new WeakMap();
  const ids = new WeakMap();
  let idSeq = 0;
  const objId = (o) => {
    if (!o) return 0;
    if (!ids.has(o)) ids.set(o, ++idSeq);
    return ids.get(o);
  };

  function half(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  function readComp(dv, o, type, norm) {
    switch (type) {
      case 5126: return dv.getFloat32(o, true);
      case 5120: { const v = dv.getInt8(o); return norm ? Math.max(v / 127, -1) : v; }
      case 5121: { const v = dv.getUint8(o); return norm ? v / 255 : v; }
      case 5122: { const v = dv.getInt16(o, true); return norm ? Math.max(v / 32767, -1) : v; }
      case 5123: { const v = dv.getUint16(o, true); return norm ? v / 65535 : v; }
      case 5124: { const v = dv.getInt32(o, true); return norm ? Math.max(v / 2147483647, -1) : v; }
      case 5125: { const v = dv.getUint32(o, true); return norm ? v / 4294967295 : v; }
      default: return half(dv.getUint16(o, true));
    }
  }

  function mul4(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }
  function invert4(m) {
    const inv = new Float32Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (!det) return null;
    for (let i = 0; i < 16; i++) inv[i] /= det;
    return inv;
  }

  function state(gl) {
    let s = states.get(gl);
    if (!s) {
      s = {
        bufs: new Map(), tgt: new Map(), vaos: new Map(), cur: null, prog: null,
        draws: new Map(), timer: 0, registered: false, canvas: gl.canvas,
        uni: new Map(), locNames: new WeakMap(), progAttr: new WeakMap()
      };
      states.set(gl, s);
      try { if (gl.canvas) glByCanvas.set(gl.canvas, s); } catch (e) {}
    }
    return s;
  }
  function vao(s) {
    let v = s.vaos.get(s.cur);
    if (!v) { v = { attribs: new Map(), elem: null }; s.vaos.set(s.cur, v); }
    return v;
  }
  const bound = (s, target) => (target === ELEMENT ? vao(s).elem : s.tgt.get(target));

  function toBytes(data, srcOffset, length) {
    if (ArrayBuffer.isView(data)) {
      const bps = data.BYTES_PER_ELEMENT || 1;
      const start = data.byteOffset + (srcOffset || 0) * bps;
      const len = length ? length * bps : data.byteLength - (srcOffset || 0) * bps;
      if (len < 0 || start + len > data.buffer.byteLength) return null;
      return new Uint8Array(data.buffer, start, len);
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return null;
  }

  function attrNames(gl, s) {
    let m = s.progAttr.get(s.prog);
    if (m && m.size) return m;
    m = m || new Map();
    try {
      const n = gl.getProgramParameter(s.prog, 35721);
      for (let i = 0; i < n; i++) {
        const a = gl.getActiveAttrib(s.prog, i);
        if (a) m.set(gl.getAttribLocation(s.prog, a.name), a.name);
      }
    } catch (e) {}
    if (s.prog) s.progAttr.set(s.prog, m);
    return m;
  }

  function modelMatrix(s) {
    const mats = s.uni.get(s.prog);
    if (!mats) return null;
    let model = null, mv = null, view = null;
    for (const [name, mat] of mats) {
      if (/inv|normal|proj|mvp|viewproj|light|shadow|texture|uv/i.test(name)) continue;
      if (/model.?view|^u?_?mv(?![a-z])/i.test(name)) mv = mat;
      else if (/^u?_?(model|world|object)/i.test(name)) model = mat;
      else if (/^u?_?view(matrix|mat)?$/i.test(name)) view = mat;
    }
    if (model) return model;
    if (mv && view) { const iv = invert4(view); if (iv) return mul4(iv, mv); }
    return null;
  }

  function record(gl, mode, count, type, offset, indexed) {
    if (mode < 4 || mode > 6 || count < 9) return;
    const s = state(gl);
    if (s.draws.size >= 3000) return;
    const v = vao(s);
    const names = attrNames(gl, s);
    let pos = null, best = Infinity;
    for (const [i, a] of v.attribs) {
      if (!a.buf || a.size < 3 || !BYTES[a.type] || !s.bufs.has(a.buf)) continue;
      const nm = (names && names.get(i)) || '';
      const score = RX_POS1.test(nm) ? 0 : RX_POS2.test(nm) ? 1 : RX_NOT_POS.test(nm) ? 100 + i : 10 + i;
      if (score < best) { best = score; pos = a; }
    }
    if (!pos) return;
    if (indexed && !(v.elem && s.bufs.has(v.elem))) return;
    const model = modelMatrix(s);
    let h = 0;
    if (model) for (let i = 0; i < 16; i++) h = (h * 31 + Math.round(model[i] * 1000)) | 0;
    const geoKey = [objId(pos.buf), pos.offset, pos.stride, pos.type, indexed ? objId(v.elem) : 0, count, type, offset, mode].join(':');
    const key = geoKey + ':' + h;
    if (s.draws.has(key)) return;
    s.draws.set(key, { geoKey, pos, elem: indexed ? v.elem : null, mode, count, type, offset, model: model ? model.slice() : null });
    if (!s.timer && !s.registered) {
      s.timer = setTimeout(() => {
        if (registeredCount > 0 || pending.size > 0 || s.registered) return; // cenas three.js já saem com materiais
        registerGL(s);
      }, 2500);
    }
  }

  function registerGL(s) {
    if (s.id != null) return s.id;
    s.registered = true;
    const c = s.canvas;
    s.id = api.registerLive({
      type: 'WebGL (geometria capturada, sem textura)',
      name: 'webgl_' + (c ? (c.width || 0) + 'x' + (c.height || 0) : 'canvas') + '.glb',
      via: 'webgl',
      build: async () => exportGL(s)
    });
    return s.id;
  }

  function toTriangles(d, tri) {
    if (d.mode === 4) return tri.subarray(0, tri.length - (tri.length % 3));
    const restart = d.elem ? (d.type === 5125 ? 0xffffffff : d.type === 5123 ? 0xffff : 0xff) : -1;
    const out = [];
    let run = [];
    const flush = () => {
      for (let k = 0; k + 2 < run.length; k++) {
        if (d.mode === 6) out.push(run[0], run[k + 1], run[k + 2]);
        else if (k % 2) out.push(run[k + 1], run[k], run[k + 2]);
        else out.push(run[k], run[k + 1], run[k + 2]);
      }
      run = [];
    };
    for (let k = 0; k < tri.length; k++) {
      if (tri[k] === restart) flush();
      else run.push(tri[k]);
    }
    flush();
    return Uint32Array.from(out);
  }

  function exportGL(s) {
    const meshes = [], nodes = [], geoMesh = new Map();
    for (const d of s.draws.values()) {
      let mi = geoMesh.get(d.geoKey);
      if (mi === undefined) {
        mi = buildDrawMesh(s, d, meshes.length);
        if (mi) meshes.push(mi);
        geoMesh.set(d.geoKey, mi ? meshes.length - 1 : -1);
        mi = mi ? meshes.length - 1 : -1;
      }
      if (mi >= 0) nodes.push({ name: meshes[mi].name, mesh: mi, matrix: d.model });
    }
    if (!meshes.length) throw new Error('nenhuma geometria WebGL utilizável capturada');
    return api.buildGLB({
      meshes,
      nodes,
      materials: [{ name: 'default', color: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.8, doubleSided: true }],
      images: []
    });
  }

  function buildDrawMesh(s, d, n) {
    const pe = s.bufs.get(d.pos.buf);
    if (!pe) return null;
    const pb = pe.data, a = d.pos;
    const bps = BYTES[a.type];
    const stride = a.stride || a.size * bps;
    const dv = new DataView(pb.buffer, pb.byteOffset, pb.byteLength);
    let raw;
    if (d.elem) {
      const ee = s.bufs.get(d.elem);
      if (!ee) return null;
      const bytes = d.type === 5125 ? 4 : d.type === 5123 ? 2 : 1;
      if (d.offset + d.count * bytes > ee.data.byteLength) return null;
      const edv = new DataView(ee.data.buffer, ee.data.byteOffset, ee.data.byteLength);
      raw = new Uint32Array(d.count);
      for (let k = 0; k < d.count; k++) {
        const o = d.offset + k * bytes;
        raw[k] = bytes === 4 ? edv.getUint32(o, true) : bytes === 2 ? edv.getUint16(o, true) : edv.getUint8(o);
      }
    } else {
      raw = new Uint32Array(d.count);
      for (let k = 0; k < d.count; k++) raw[k] = d.offset + k; // offset = "first" nos drawArrays
    }
    const tri = toTriangles(d, raw);
    if (!tri.length) return null;

    // compacta: só os vértices realmente usados
    const remap = new Map(), used = [], idx = new Uint32Array(tri.length);
    for (let k = 0; k < tri.length; k++) {
      let r = remap.get(tri[k]);
      if (r === undefined) { r = used.length; remap.set(tri[k], r); used.push(tri[k]); }
      idx[k] = r;
    }
    const pos = new Float32Array(used.length * 3);
    for (let k = 0; k < used.length; k++) {
      const base = a.offset + used[k] * stride;
      if (base + 2 * bps + bps > pb.byteLength) return null;
      for (let c = 0; c < 3; c++) {
        const val = readComp(dv, base + c * bps, a.type, a.norm);
        if (!Number.isFinite(val)) return null;
        pos[k * 3 + c] = val;
      }
    }
    return { name: 'draw_' + n, pos, prims: [{ idx, mat: 0 }] };
  }

  // Usado pelo seletor de elemento. probeOnly: só diz o que há no canvas, sem registrar item.
  api.pick = function (canvas, probeOnly) {
    const a = canvasScenes.get(canvas);
    if (a && a.length) {
      let best = null, bn = 0;
      for (const sc of a) {
        let n = 0;
        try { n = countMeshes(sc); } catch (e) {}
        if (n > bn) { bn = n; best = sc; }
      }
      if (best) return probeOnly ? 'three' : { kind: 'three', id: registerScene(best, bn) };
    }
    const g = glByCanvas.get(canvas);
    if (g && g.draws.size) return probeOnly ? 'webgl' : { kind: 'webgl', id: registerGL(g) };
    return null;
  };

  function patch(proto) {
    if (!proto || proto.__m3dPatched) return;
    Object.defineProperty(proto, '__m3dPatched', { value: true });
    const wrap = (name, fn) => {
      const orig = proto[name];
      if (typeof orig !== 'function') return;
      proto[name] = function (a, b, c, d, e, f) {
        const r = orig.apply(this, arguments);
        try { fn(this, arguments, r); } catch (err) {}
        return r;
      };
    };

    wrap('bindBuffer', (gl, [target, buf]) => {
      const s = state(gl);
      if (target === ELEMENT) vao(s).elem = buf;
      else s.tgt.set(target, buf);
    });
    wrap('bindVertexArray', (gl, [v]) => { state(gl).cur = v || null; });
    wrap('deleteBuffer', (gl, [buf]) => {
      const s = state(gl), old = s.bufs.get(buf);
      if (old) totalBytes -= old.data.byteLength;
      s.bufs.delete(buf);
      for (const [k, d] of s.draws) if (d.pos.buf === buf || d.elem === buf) s.draws.delete(k);
    });
    wrap('bufferData', (gl, [target, data, usage, srcOffset, length]) => {
      const s = state(gl), buf = bound(s, target);
      if (!buf) return;
      const old = s.bufs.get(buf);
      const prev = old ? old.updates : 0;
      if (old) { totalBytes -= old.data.byteLength; s.bufs.delete(buf); }
      // buffers dinâmicos só são copiados nas primeiras atualizações (evita custo por frame)
      if (usage !== STATIC && prev >= 3) { s.bufs.set(buf, { data: new Uint8Array(0), updates: prev + 1, usage }); return; }
      let bytes;
      if (typeof data === 'number') bytes = data > 0 && data <= 64 * 1024 * 1024 ? new Uint8Array(data) : null;
      else { const src = toBytes(data, srcOffset, length); bytes = src && src.slice(); }
      if (!bytes || totalBytes + bytes.byteLength > MAX_BYTES) return;
      s.bufs.set(buf, { data: bytes, updates: prev + 1, usage });
      totalBytes += bytes.byteLength;
    });
    wrap('bufferSubData', (gl, [target, dstOff, src, srcOffset, length]) => {
      const s = state(gl), buf = bound(s, target), e = buf && s.bufs.get(buf);
      if (!e || (e.usage !== STATIC && e.updates > 20)) return;
      const bytes = toBytes(src, srcOffset, length);
      if (!bytes || dstOff + bytes.length > e.data.length) return;
      e.data.set(bytes, dstOff);
      e.updates++;
    });
    wrap('copyBufferSubData', (gl, [rt, wt, ro, wo, size]) => {
      const s = state(gl), a = s.bufs.get(bound(s, rt)), b = s.bufs.get(bound(s, wt));
      if (!a || !b || ro + size > a.data.length || wo + size > b.data.length) return;
      b.data.set(a.data.subarray(ro, ro + size), wo);
    });
    wrap('vertexAttribPointer', (gl, [index, size, type, norm, stride, offset]) => {
      const s = state(gl);
      vao(s).attribs.set(index, { buf: s.tgt.get(ARRAY), size, type, norm, stride, offset });
    });
    wrap('useProgram', (gl, [p]) => { state(gl).prog = p; });
    wrap('linkProgram', (gl, [p]) => {
      const s = state(gl), prev = s.prog;
      s.prog = p;
      s.progAttr.delete(p);
      attrNames(gl, s);
      s.prog = prev;
    });
    wrap('getAttribLocation', (gl, [p, name], loc) => {
      const s = state(gl);
      let m = s.progAttr.get(p);
      if (!m) { m = new Map(); s.progAttr.set(p, m); }
      if (loc >= 0) m.set(loc, name);
    });
    wrap('getUniformLocation', (gl, [p, name], loc) => { if (loc) state(gl).locNames.set(loc, name); });
    wrap('uniformMatrix4fv', (gl, [loc, transpose, value]) => {
      const s = state(gl), name = s.locNames.get(loc);
      if (!name || !s.prog || !value || value.length < 16) return;
      let m = Float32Array.from(value.length === 16 ? value : Array.prototype.slice.call(value, 0, 16));
      if (transpose) { const t = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) t[i * 4 + j] = m[j * 4 + i]; m = t; }
      let mats = s.uni.get(s.prog);
      if (!mats) { mats = new Map(); s.uni.set(s.prog, mats); }
      mats.set(name, m);
    });
    wrap('drawElements', (gl, [mode, count, type, offset]) => record(gl, mode, count, type, offset, true));
    wrap('drawElementsInstanced', (gl, [mode, count, type, offset]) => record(gl, mode, count, type, offset, true));
    wrap('drawRangeElements', (gl, [mode, start, end, count, type, offset]) => record(gl, mode, count, type, offset, true));
    wrap('drawArrays', (gl, [mode, first, count]) => record(gl, mode, count, 0, first, false));
    wrap('drawArraysInstanced', (gl, [mode, first, count]) => record(gl, mode, count, 0, first, false));

    // extensões do WebGL1: o objeto da extensão tem os próprios métodos
    wrap('getExtension', (gl, [name], ext) => {
      if (!ext || ext.__m3dExt) return;
      Object.defineProperty(ext, '__m3dExt', { value: true });
      const over = (method, fn) => {
        const orig = ext[method];
        if (typeof orig !== 'function') return;
        ext[method] = function () {
          const r = orig.apply(this, arguments);
          try { fn(arguments); } catch (err) {}
          return r;
        };
      };
      if (name === 'OES_vertex_array_object') over('bindVertexArrayOES', ([v]) => { state(gl).cur = v || null; });
      if (name === 'ANGLE_instanced_arrays') {
        over('drawElementsInstancedANGLE', ([mode, count, type, offset]) => record(gl, mode, count, type, offset, true));
        over('drawArraysInstancedANGLE', ([mode, first, count]) => record(gl, mode, count, 0, first, false));
      }
    });
  }

  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();
