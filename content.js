// Ponte entre a página (inject.js, world MAIN) e a extensão.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__m3d !== 'found') return;
  try {
    chrome.runtime.sendMessage({ kind: 'found', item: e.data.item }).catch(() => {});
  } catch (err) {}
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.kind === 'download') window.postMessage({ __m3d: 'download', id: msg.id }, '*');
});

// Viewer da extensão pede os bytes por uma porta; devolvemos em pedaços base64 (mensagens são JSON).
const CHUNK = 3 * 1024 * 1024;
function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'm3d-get') return;
  port.onMessage.addListener((msg) => {
    const reqId = Math.random().toString(36).slice(2);
    const onMsg = (e) => {
      if (e.source !== window || !e.data || e.data.__m3d !== 'data' || e.data.reqId !== reqId) return;
      window.removeEventListener('message', onMsg);
      if (e.data.error) { port.postMessage({ error: e.data.error }); return; }
      const bytes = new Uint8Array(e.data.buf);
      for (let o = 0; o < bytes.length || o === 0; o += CHUNK) {
        const end = Math.min(o + CHUNK, bytes.length);
        port.postMessage({ chunk: toB64(bytes.subarray(o, end)), last: end >= bytes.length });
        if (end >= bytes.length) break;
      }
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ __m3d: 'get', id: msg.id, reqId }, '*');
  });
});
