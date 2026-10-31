// Roda no contexto da página (world MAIN): intercepta fetch/XHR/createObjectURL,
// confere os bytes iniciais e guarda uma cópia (Blob) de tudo que parece modelo 3D.
(() => {
  if (window.__m3dHooked) return;
  window.__m3dHooked = true;

  const SNIFF = 16384;
  const MAX = 512 * 1024 * 1024;
  const SKIP_CT = /^(image|video|audio|font)\/|text\/(css|html|javascript|event-stream)|javascript|wasm|x-ndjson|^multipart\/|grpc/i;
  const MODEL_URL_CT = /^model\//i;

  const store = new Map(); // id -> { blob, name }
  const seen = new Map(); // chave url|tamanho -> id
  let seq = 0;

  const _createObjectURL = URL.createObjectURL;

  function ascii(b, o, n) {
    let s = '';
    for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  function sniffText(s) {
    if (/^\s*solid[\s\S]*facet\s+normal/.test(s)) return { type: 'STL (ASCII)', ext: 'stl' };
    if (/<COLLADA[\s>]/.test(s)) return { type: 'COLLADA', ext: 'dae' };
    if (/^; FBX/.test(s)) return { type: 'FBX (ASCII)', ext: 'fbx' };
    if (/^\s*\{/.test(s) && (/"asset"\s*:\s*\{/.test(s) || (/"accessors"/.test(s) && /"bufferViews"/.test(s)))) {
      return { type: 'glTF (JSON)', ext: 'gltf' };
    }
    const verts = s.match(/^v\s+-?[\d.eE+-]+\s+-?[\d.eE+-]+\s+-?[\d.eE+-]+/gm);
    if (verts && verts.length >= 3) return { type: 'OBJ', ext: 'obj' };
    return null;
  }

  // b: Uint8Array com o começo do arquivo; total: tamanho completo (0 se desconhecido)
  function sniff(b, total) {
    if (b.length < 4) return null;
    const m4 = ascii(b, 0, 4);
    if (m4 === 'glTF') return { type: 'glTF binário (GLB)', ext: 'glb' };
    if (ascii(b, 0, 18) === 'Kaydara FBX Binary') return { type: 'FBX (binário)', ext: 'fbx' };
    if (ascii(b, 0, 5) === 'DRACO') return { type: 'Draco', ext: 'drc' };
    if (ascii(b, 0, 3) === 'ply' && (b[3] === 10 || b[3] === 13)) return { type: 'PLY', ext: 'ply' };
    if (ascii(b, 0, 8) === 'PXR-USDC') return { type: 'USD (crate)', ext: 'usdc' };
    if (ascii(b, 0, 7) === 'BLENDER') return { type: 'Blender', ext: 'blend' };
    if (m4 === 'VOX ') return { type: 'MagicaVoxel', ext: 'vox' };
    if (b[0] === 0x4d && b[1] === 0x4d && total >= 6) {
      const len = b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24);
      if ((len >>> 0) === total) return { type: '3DS', ext: '3ds' };
    }
    if (m4 === 'PK\x03\x04') {
      const m = ascii(b, 0, Math.min(b.length, SNIFF)).match(/[\w\-./ ]*\.(glb|gltf|obj|fbx|usd[acz]?|stl|ply|dae|3ds|blend)\b/i);
      if (m) {
        const ext = m[1].toLowerCase();
        return { type: ext.startsWith('usd') ? 'USDZ/ZIP com USD' : 'ZIP com modelo (' + m[0].trim() + ')', ext: ext === 'usdz' ? 'usdz' : 'zip' };
      }
      return null;
    }
    if (total >= 84) {
      const n = (b[80] | (b[81] << 8) | (b[82] << 16) | (b[83] << 24)) >>> 0;
      if (n > 0 && 84 + 50 * n === total && ascii(b, 0, 5) !== 'solid') return { type: 'STL (binário)', ext: 'stl' };
    }
    return sniffText(ascii(b, 0, Math.min(b.length, SNIFF)));
  }

  // site de onde veio: host da página (do topo, se estiver num iframe) sem "www." e sem o TLD
  function siteTag() {
    let h = location.hostname;
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) h = new URL(ao[ao.length - 1]).hostname || h;
    } catch (e) {}
    const parts = h.replace(/^www\./, '').split('.').filter(Boolean);
    if (parts.length > 1) parts.pop();
    return (parts.join('_') || 'local').replace(/[^\w-]+/g, '_');
  }

  // "<site>_<modelo>.<ext>"; sem nome de modelo, "<site>_<id>.<ext>"
  function withSite(model, ext, id) {
    const site = siteTag();
    const base = String(model || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/:*?"<>|]+/g, '_');
    if (!base) return site + '_' + id + '.' + ext;
    if (base.toLowerCase().startsWith(site.toLowerCase() + '_')) return base + '.' + ext;
    return site + '_' + base + '.' + ext;
  }

  function fileName(url, info, id) {
    let name = '';
    try { name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || ''); } catch (e) {}
    return withSite(name, info.ext, id);
  }

  function register(blob, info, url, via) {
    const key = url + '|' + blob.size;
    if (seen.has(key)) return seen.get(key);
    const id = ++seq;
    seen.set(key, id);
    const name = fileName(url, info, id);
    store.set(id, { blob, name });
    window.postMessage({
      __m3d: 'found',
      item: { id, type: info.type, ext: info.ext, size: blob.size, url, name, via, page: location.href }
    }, '*');
    return id;
  }

  async function inspectBlob(blob, url, via) {
    if (blob.size < 16 || blob.size > MAX) return null;
    if (blob.type && SKIP_CT.test(blob.type)) return null;
    const head = new Uint8Array(await blob.slice(0, SNIFF).arrayBuffer());
    const info = sniff(head, blob.size);
    return info ? register(blob, info, url, via) : null;
  }

  async function inspectResponse(resp, url) {
    const ct = resp.headers.get('content-type') || '';
    if (SKIP_CT.test(ct) || (!resp.ok && resp.status !== 206)) return;
    const cl = +resp.headers.get('content-length') || 0;
    if (cl > MAX) return;
    if (resp.status === 206 && !/^bytes 0-/.test(resp.headers.get('content-range') || '')) return; // trecho do meio, não o arquivo
    const clone = resp.clone();
    if (!clone.body) return;
    const reader = clone.body.getReader();
    const chunks = [];
    let got = 0, info = null, decided = false;
    const headOf = () => {
      const out = new Uint8Array(Math.min(got, SNIFF));
      let o = 0;
      for (const c of chunks) {
        if (o >= out.length) break;
        const part = c.subarray(0, out.length - o);
        out.set(part, o);
        o += part.length;
      }
      return out;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (!decided && got >= Math.min(SNIFF, cl || SNIFF)) {
          decided = true;
          info = sniff(headOf(), cl);
          if (!info && !MODEL_URL_CT.test(ct)) { reader.cancel(); return; }
        }
        if (got > MAX) { reader.cancel(); return; }
      }
    } catch (e) { return; }
    const blob = new Blob(chunks);
    if (!decided) info = sniff(headOf(), blob.size);
    else if (!info) info = sniff(headOf(), blob.size);
    if (info) register(blob, info, url, 'fetch');
  }

  // ---- fetch
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const p = _fetch.apply(this, arguments);
    p.then((r) => {
      try { inspectResponse(r, r.url || (input && input.url) || String(input)); } catch (e) {}
    }, () => {});
    return p;
  };

  // ---- XMLHttpRequest
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__m3dUrl = url;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const ct = this.getResponseHeader('content-type') || '';
        if (SKIP_CT.test(ct) || this.status >= 400) return;
        const url = this.responseURL || String(this.__m3dUrl);
        const r = this.response;
        if (this.responseType === 'arraybuffer' && r) {
          const head = new Uint8Array(r, 0, Math.min(SNIFF, r.byteLength));
          const info = sniff(head, r.byteLength);
          if (info && r.byteLength <= MAX) register(new Blob([r]), info, url, 'xhr');
        } else if (this.responseType === 'blob' && r) inspectBlob(r, url, 'xhr');
        else if (this.responseType === 'json' && r && typeof r === 'object' && (r.asset || (r.accessors && r.bufferViews))) {
          inspectBlob(new Blob([JSON.stringify(r)]), url, 'xhr');
        } else if (this.responseType === '' || this.responseType === 'text') {
          const t = this.responseText;
          const info = sniffText(t.slice(0, SNIFF));
          if (info) register(new Blob([t]), info, url, 'xhr');
        }
      } catch (e) {}
    });
    return _send.apply(this, arguments);
  };

  // ---- blobs criados pela própria página (ex.: modelo descompactado em worker)
  URL.createObjectURL = function (obj) {
    const u = _createObjectURL.apply(this, arguments);
    try { if (obj instanceof Blob) inspectBlob(obj, u, 'blob'); } catch (e) {}
    return u;
  };

  // ---- itens "ao vivo" (cena three.js / WebGL): o arquivo só é gerado ao baixar
  function registerLive({ type, name, via, build }) {
    const id = ++seq;
    name = withSite(name, 'glb', id);
    store.set(id, { build, name });
    window.postMessage({
      __m3d: 'found',
      item: { id, type, ext: 'glb', size: 0, live: true, url: location.href + '#' + name, name, via, page: location.href }
    }, '*');
    return id;
  }
  function unregisterLive(id) {
    store.delete(id);
    window.postMessage({ __m3d: 'gone', id }, '*');
  }
  Object.defineProperty(window, '__m3dApi', { value: { registerLive, unregisterLive, sniffBlob: inspectBlob }, enumerable: false });

  // ---- bytes pedidos pelo viewer da extensão (via content.js)
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__m3d !== 'get') return;
    const reqId = e.data.reqId;
    try {
      const it = store.get(e.data.id);
      if (!it) throw new Error('item não está mais na memória da página (recarregou?)');
      const blob = it.blob || (await it.build());
      const buf = await blob.arrayBuffer();
      window.postMessage({ __m3d: 'data', reqId, buf }, '*', [buf]);
    } catch (err) {
      window.postMessage({ __m3d: 'data', reqId, error: String(err && err.message || err) }, '*');
    }
  });

  // ---- download pedido pelo popup
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__m3d !== 'download') return;
    const it = store.get(e.data.id);
    if (!it) return;
    let blob = it.blob;
    if (!blob) {
      try { blob = await it.build(); } catch (err) { console.warn('[3D Model Sniffer] exportação falhou:', err); return; }
    }
    const u = _createObjectURL.call(URL, blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = it.name;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 30000);
  });
})();
