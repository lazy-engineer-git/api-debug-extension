window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || !event.data.__apiDebug) return;
  chrome.runtime.sendMessage({ type: 'API_REQUEST', data: event.data.data }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'REPLAY_REQUEST') {
    window.postMessage({ __apiDebugReplay: true, log: msg.log }, '*');
    sendResponse({ ok: true });
  }
});

// Push JWT tokens to MAIN world so content-main.js can inject them directly
async function syncJwt() {
  const { jwtTokens = [] } = await chrome.storage.local.get('jwtTokens');
  window.postMessage({ __apiDebugConfig: true, jwtTokens }, '*');
}
syncJwt();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.jwtTokens) syncJwt();
});
