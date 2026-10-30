// Seletor de elemento (como "inspecionar" do DevTools): o usuário aponta o 3D que quer capturar.
// Roda no mundo MAIN para poder usar o elemento diretamente (canvas -> renderer/cena/contexto GL).
(() => {
  const api = window.__m3dApi;
  if (!api || !api.pick) return;

  const MODEL_URL = /\.(glb|gltf|obj|fbx|stl|ply|dae|3ds|usdz|usd[acz]?|drc|blend|vox|3mf)(?:$|[?#])/i;
  const URL_ATTRS = ['src', 'href', 'data', 'gltf-model', 'ios-src', 'data-src', 'data-model', 'data-url'];
  const URL_TAGS = /^(MODEL-VIEWER|A-ASSET-ITEM|A-ENTITY|A-SCENE|OBJECT|EMBED)$/;

  let active = false, host = null, box = null, label = null, toast = null, toastTimer = 0, busy = false;

  function deepAt(x, y) {
    const out = [], seen = new Set();
    const walk = (root) => {
      for (const el of root.elementsFromPoint(x, y)) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  }

  function modelUrl(el) {
    for (const a of URL_ATTRS) {
      let v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      const m = /^url\((.*)\)$/.exec(v.trim()); // a-entity gltf-model="url(x.glb)"
      if (m) v = m[1].replace(/^['"]|['"]$/g, '');
      if (MODEL_URL.test(v) || (URL_TAGS.test(el.tagName) && a === 'src')) {
        try { return new URL(v, document.baseURI).href; } catch (e) {}
      }
    }
    return null;
  }

  // melhor alvo na pilha de elementos sob o ponto
  function target(x, y) {
    const stack = deepAt(x, y).filter((el) => !(host && el === host));
    for (const el of stack) {
      if (el.tagName === 'CANVAS') {
        const kind = api.pick(el, true);
        if (kind) return { el, kind, text: kind === 'three' ? 'three.js' : 'WebGL (só malha)' };
      }
    }
    for (const el of stack) {
      const url = modelUrl(el);
      if (url) return { el, kind: 'url', url, text: 'modelo: ' + (url.split('?')[0].split('/').pop() || url) };
    }
    const canvas = stack.find((el) => el.tagName === 'CANVAS');
    if (canvas) return { el: canvas, kind: 'none', text: 'canvas sem 3D capturado (ainda)' };
    return stack[0] ? { el: stack[0], kind: 'none', text: '<' + stack[0].tagName.toLowerCase() + '>' } : null;
  }

  const COLORS = { three: '#2ecc71', webgl: '#2ecc71', url: '#3498db', none: '#888' };

  function ui() {
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' +
      '.box{position:fixed;border:2px solid #888;background:rgba(120,160,255,.12);box-sizing:border-box;display:none;pointer-events:none}' +
      '.label{position:absolute;left:-2px;top:-24px;background:#1b1d21;color:#fff;font:12px system-ui,sans-serif;padding:3px 8px;border-radius:4px;white-space:nowrap}' +
      '.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1b1d21;color:#fff;font:13px system-ui,sans-serif;padding:8px 14px;border-radius:6px;display:none;max-width:80vw}' +
      '</style><div class="box"><div class="label"></div></div><div class="toast"></div>';
    box = root.querySelector('.box');
    label = root.querySelector('.label');
    toast = root.querySelector('.toast');
    (document.documentElement).appendChild(host);
  }

  function say(text, ms) {
    if (!toast) return;
    toast.textContent = text;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { if (toast) toast.style.display = 'none'; }, ms);
  }

  function onMove(e) {
    if (busy) return;
    const t = target(e.clientX, e.clientY);
    if (!t) { box.style.display = 'none'; return; }
    const r = t.el.getBoundingClientRect();
    const c = COLORS[t.kind] || COLORS.none;
    box.style.cssText = `display:block;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-color:${c}`;
    label.textContent = t.text;
    label.style.top = r.top < 28 ? '4px' : '-24px';
    label.style.background = c;
  }

  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };

  async function onClick(e) {
    swallow(e);
    if (busy) return;
    const t = target(e.clientX, e.clientY);
    if (!t || t.kind === 'none') { say('Nada 3D capturado aí. Tente outro elemento (Esc cancela).', 2500); return; }
    busy = true;
    try {
      let id = null;
      if (t.kind === 'url') {
        say('Baixando o modelo…');
        const r = await fetch(t.url, { credentials: 'include' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        id = await api.sniffBlob(await r.blob(), t.url, 'pick');
        if (id == null) throw new Error('o arquivo não foi reconhecido como modelo 3D');
      } else {
        id = api.pick(t.el, false);
        id = id && id.id;
        if (id == null) throw new Error('nada capturado neste canvas');
      }
      say('Capturado! Abrindo o viewer…', 2000);
      window.postMessage({ __m3d: 'picked', id }, '*');
      stop(false);
    } catch (err) {
      say('Falhou: ' + (err && err.message || err), 3500);
    }
    busy = false;
  }

  function onKey(e) {
    if (e.key === 'Escape') { swallow(e); stop(true); }
  }

  const EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'touchstart', 'contextmenu'];

  function start() {
    if (active) return;
    active = true;
    ui();
    say('Passe o mouse e clique no 3D que você quer capturar. Esc cancela.', 0);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    EVENTS.forEach((n) => window.addEventListener(n, swallow, true));
  }

  function stop(notify) {
    if (!active) return;
    active = false;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    EVENTS.forEach((n) => window.removeEventListener(n, swallow, true));
    const h = host;
    setTimeout(() => h && h.remove(), notify ? 0 : 1800);
    host = box = label = toast = null;
    if (notify) window.postMessage({ __m3d: 'pickEnded' }, '*');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__m3d === 'pickStart') start();
    else if (e.data.__m3d === 'pickStop') stop(false);
  });
})();
