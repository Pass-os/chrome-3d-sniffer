const listEl = document.getElementById('list');
let tabId = null;
let lastKey = '';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(n) {
  if (!n) return '? bytes';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function render(items) {
  const key = JSON.stringify(items.map((i) => [i.source, i.frameId, i.id, i.url]));
  if (key === lastKey) return;
  lastKey = key;
  if (!items.length) {
    listEl.innerHTML = '<div id="empty">Nenhum modelo 3D detectado ainda.<br>Recarregue a página ou interaja com o viewer para disparar o carregamento.</div>';
    return;
  }
  listEl.innerHTML = items.map((it, i) => `
    <div class="item">
      <div class="info">
        <div class="name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="meta">${esc(it.type)} · ${it.live ? 'exporta ao baixar' : fmt(it.size)} · ${it.source === 'page' ? (it.live ? esc(it.via) : 'bytes verificados (' + esc(it.via) + ')') : 'por URL'}</div>
        <div class="url" title="${esc(it.url)}">${esc(it.url)}</div>
      </div>
      <button data-view="${i}" title="Abre num visualizador 3D na própria extensão">Ver</button>
      <button class="ghost" data-i="${i}">Baixar</button>
      <button class="ghost" data-blender="${i}" title="Baixa e abre no Blender">Blender</button>
    </div>`).join('');
  listEl.querySelectorAll('button[data-i]').forEach((b) => {
    b.onclick = () => download(items[+b.dataset.i]);
  });
  listEl.querySelectorAll('button[data-view]').forEach((b) => {
    b.onclick = () => {
      const it = items[+b.dataset.view];
      const qs = new URLSearchParams({
        tab: tabId, frame: it.frameId || 0, id: it.id || 0, source: it.source,
        url: it.url, name: it.name, ext: it.ext
      });
      chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?' + qs });
    };
  });
  listEl.querySelectorAll('button[data-blender]').forEach((b) => {
    b.onclick = () => {
      chrome.runtime.sendMessage({ kind: 'openBlender', tabId, item: items[+b.dataset.blender] });
      b.textContent = 'Abrindo...';
    };
  });
}

function download(it) {
  if (it.source === 'page') {
    chrome.tabs.sendMessage(tabId, { kind: 'download', id: it.id }, { frameId: it.frameId });
  } else {
    chrome.downloads.download({ url: it.url, filename: it.name.replace(/[\\/:*?"<>|]+/g, '_') });
  }
}

async function refresh() {
  const items = await chrome.runtime.sendMessage({ kind: 'list', tabId });
  render(items || []);
}

document.getElementById('clear').onclick = async () => {
  await chrome.runtime.sendMessage({ kind: 'clear', tabId });
  lastKey = '';
  refresh();
};

chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
  tabId = t.id;
  refresh();
  setInterval(refresh, 1000);
});
