const MAX_LOGS = 500;
// JWT rules: IDs 1-100, Env rules: IDs 101-200

async function getLogs() {
  const result = await chrome.storage.session.get('requestLogs');
  return result.requestLogs || [];
}

async function addLog(log) {
  const logs = await getLogs();
  log.id = crypto.randomUUID();
  logs.unshift(log);
  if (logs.length > MAX_LOGS) logs.splice(MAX_LOGS);
  await chrome.storage.session.set({ requestLogs: logs });
  await updateBadge(logs);
  // Persist to local storage (truncated) so logs survive browser restart
  const persisted = logs.slice(0, 200).map(l => ({
    ...l,
    requestBody:  l.requestBody  ? l.requestBody.slice(0, 1000)  : l.requestBody,
    responseBody: l.responseBody ? l.responseBody.slice(0, 1000) : l.responseBody,
  }));
  chrome.storage.local.set({ persistedLogs: persisted });
  chrome.runtime.sendMessage({ type: 'LOG_UPDATED' }).catch(() => {});
}

// Restore persisted logs when browser restarts and session is empty
chrome.runtime.onStartup.addListener(async () => {
  const session = await getLogs();
  if (session.length === 0) {
    const { persistedLogs = [] } = await chrome.storage.local.get('persistedLogs');
    if (persistedLogs.length > 0) {
      await chrome.storage.session.set({ requestLogs: persistedLogs });
      await updateBadge(persistedLogs);
    }
  }
});

async function updateBadge(logs) {
  const errorCount = logs.filter(l => l.status >= 400 || l.status === 0).length;
  if (errorCount > 0) {
    await chrome.action.setBadgeText({ text: errorCount > 99 ? '99+' : String(errorCount) });
    await chrome.action.setBadgeBackgroundColor({ color: '#E53E3E' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// JWT injection is handled by content-main.js (via content-bridge.js postMessage sync).
// This function only clears any leftover declarativeNetRequest JWT rules from older versions.
async function clearLegacyJwtRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.filter(r => r.id >= 1 && r.id <= 100).map(r => r.id);
  if (removeIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: [] });
  }
}

async function updateEnvironmentRules(environmentId) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.filter(r => r.id >= 101 && r.id <= 200).map(r => r.id);

  if (!environmentId) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: [] });
    return;
  }

  const { environments = [] } = await chrome.storage.local.get('environments');
  const env = environments.find(e => e.id === environmentId);
  if (!env) return;

  const addRules = env.rules
    .filter(r => r.from && r.to)
    .map((r, i) => ({
      id: 101 + i,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { transform: { host: r.to } }
      },
      condition: {
        urlFilter: `||${r.from}`,
        resourceTypes: ['xmlhttprequest', 'fetch', 'main_frame', 'sub_frame']
      }
    }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules });
}

function matchExclude(url, pattern) {
  if (!pattern) return false;
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try { return new RegExp(re).test(url); } catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'API_REQUEST') {
    chrome.storage.local.get('excludePatterns').then(({ excludePatterns = [] }) => {
      const url = message.data.url || '';
      if (!excludePatterns.some(p => matchExclude(url, p))) return addLog(message.data);
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'GET_LOGS') {
    getLogs().then(logs => sendResponse({ logs }));
    return true;
  }
  if (message.type === 'CLEAR_LOGS') {
    Promise.all([
      chrome.storage.session.set({ requestLogs: [] }),
      chrome.storage.local.remove('persistedLogs'),
    ]).then(async () => {
      await chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message.type === 'UPDATE_JWT') {
    clearLegacyJwtRules().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'UPDATE_ENVIRONMENT') {
    updateEnvironmentRules(message.environmentId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'REPLAY_REQUEST') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'REPLAY_REQUEST', log: message.log }).catch(() => {});
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});
