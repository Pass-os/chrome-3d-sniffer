// Guarda a lista de modelos por aba e mostra a contagem no ícone.
// Também pega por URL/Content-Type o que a página não expõe (Workers, iframes cross-origin).
const URL_EXTS = /\.(glb|gltf|obj|fbx|stl|ply|dae|3ds|usdz|usd|usdc|usda|drc|blend|vox|3mf)(?:$|[?#])/i;

let tabs = {}; // tabId -> item[]
const ready = chrome.storage.session.get('tabs').then((r) => { tabs = r.tabs || {}; });
let saving = Promise.resolve();
const save = () => { saving = saving.then(() => chrome.storage.session.set({ tabs })); };

function badge(tabId) {
  const n = (tabs[tabId] || []).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2a7de1' }).catch(() => {});
}

function nameFromUrl(url, ext) {
  let n = '';
  try { n = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (e) {}
  return n || 'model.' + (ext || 'bin');
}

async function add(tabId, item) {
  await ready;
  const list = (tabs[tabId] = tabs[tabId] || []);
  if (item.source === 'url') {
    if (list.some((i) => i.url === item.url)) return;
  } else {
    // a versão verificada pela página substitui a detectada só por URL
    const idx = list.findIndex((i) => i.source === 'url' && i.url === item.url);
    if (idx >= 0) list.splice(idx, 1);
    if (list.some((i) => i.source === 'page' && i.frameId === item.frameId && i.id === item.id)) return;
  }
  list.push(item);
  save();
  badge(tabId);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.kind === 'found' && sender.tab) {
    add(sender.tab.id, { ...msg.item, source: 'page', frameId: sender.frameId });
  } else if (msg.kind === 'list') {
    ready.then(() => sendResponse(tabs[msg.tabId] || []));
    return true;
  } else if (msg.kind === 'clear') {
    ready.then(() => { delete tabs[msg.tabId]; save(); badge(msg.tabId); sendResponse(true); });
    return true;
  }
});

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const h = (n) => ((d.responseHeaders || []).find((x) => x.name.toLowerCase() === n) || {}).value || '';
    const ct = h('content-type');
    const byCt = /^model\//i.test(ct);
    const byExt = URL_EXTS.test(d.url);
    if (!byCt && !byExt) return;
    const ext = (d.url.match(URL_EXTS) || [])[1] || (ct.split('/')[1] || 'bin').split(';')[0];
    add(d.tabId, {
      source: 'url',
      type: byCt ? ct.split(';')[0] : 'Por extensão (.' + ext.toLowerCase() + ', não verificado)',
      ext: ext.toLowerCase(),
      size: +h('content-length') || 0,
      url: d.url,
      name: nameFromUrl(d.url, ext.toLowerCase()),
      via: 'webRequest'
    });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other', 'object', 'sub_frame'] },
  ['responseHeaders']
);

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await ready;
  delete tabs[d.tabId];
  save();
  badge(d.tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  delete tabs[tabId];
  save();
});

// ---- "Abrir no Blender": baixa o item, vigia o download e chama o native host quando termina
const HOST = 'com.alex.m3d_blender';
let waitingCreate = 0; // timestamp limite para capturar o download disparado pela página

const getPending = async () => (await chrome.storage.session.get('blenderIds')).blenderIds || [];
const setPending = (ids) => chrome.storage.session.set({ blenderIds: ids });

chrome.downloads.onCreated.addListener(async (dl) => {
  if (!waitingCreate || Date.now() > waitingCreate) return;
  waitingCreate = 0;
  await setPending([...(await getPending()), dl.id]);
});

chrome.downloads.onChanged.addListener(async (delta) => {
  const ids = await getPending();
  if (!ids.includes(delta.id) || !delta.state) return;
  if (delta.state.current === 'in_progress') return;
  await setPending(ids.filter((i) => i !== delta.id));
  if (delta.state.current !== 'complete') return;
  const [dl] = await chrome.downloads.search({ id: delta.id });
  if (!dl) return;
  chrome.runtime.sendNativeMessage(HOST, { path: dl.filename }, (res) => {
    if (chrome.runtime.lastError) console.warn('native host:', chrome.runtime.lastError.message);
    else if (!res || !res.ok) console.warn('native host:', res && res.error);
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind !== 'openBlender') return;
  const it = msg.item;
  if (it.source === 'page') {
    waitingCreate = Date.now() + 15000;
    chrome.tabs.sendMessage(msg.tabId, { kind: 'download', id: it.id }, { frameId: it.frameId });
  } else {
    chrome.downloads.download({ url: it.url, filename: it.name.replace(/[\\/:*?"<>|]+/g, '_') }).then(async (id) => {
      await setPending([...(await getPending()), id]);
    });
  }
});

// ---- seletor de elemento: ao capturar, abre o viewer e encerra o modo nos outros frames
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab || (msg.kind !== 'picked' && msg.kind !== 'pickEnded')) return;
  const stop = () => chrome.tabs.sendMessage(sender.tab.id, { kind: 'pickStop' }).catch(() => {});
  if (msg.kind === 'pickEnded') { stop(); return; }
  ready.then(() => {
    const it = (tabs[sender.tab.id] || []).find((i) => i.source === 'page' && i.frameId === sender.frameId && i.id === msg.id);
    stop();
    if (!it) return;
    const qs = new URLSearchParams({
      tab: sender.tab.id, frame: sender.frameId || 0, id: it.id, source: 'page', url: it.url, name: it.name, ext: it.ext
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?' + qs });
  });
});

// ---- cena/canvas que saiu da página: tira da lista
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.kind !== 'gone' || !sender.tab) return;
  ready.then(() => {
    const list = tabs[sender.tab.id];
    if (!list) return;
    const idx = list.findIndex((i) => i.source === 'page' && i.frameId === sender.frameId && i.id === msg.id);
    if (idx < 0) return;
    list.splice(idx, 1);
    save();
    badge(sender.tab.id);
  });
});
