// ---- Freemium ----
const FREE_LOG_LIMIT = 20;
const GUMROAD_BUY_URL = 'https://YOUR_GUMROAD_URL'; // Gumroad商品作成後に差し替え
let isPro = false;

function showUpgradeModal(featureName) {
  const el = document.getElementById('upgrade-feature-name');
  if (el) el.textContent = featureName ? `「${featureName}」はProプランの機能です` : 'Proプランの機能です';
  document.getElementById('upgrade-buy-link').href = GUMROAD_BUY_URL;
  document.getElementById('upgrade-modal').classList.remove('hidden');
  document.getElementById('license-msg').classList.add('hidden');
  document.getElementById('license-key-input').value = '';
}

async function activateLicense(key) {
  const btn = document.getElementById('license-activate-btn');
  const msgEl = document.getElementById('license-msg');
  btn.disabled = true;
  btn.textContent = '認証中…';
  msgEl.className = 'license-msg hidden';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'VERIFY_LICENSE', key: key.trim() });
    if (result.success) {
      isPro = true;
      await chrome.storage.local.set({ licenseKey: key.trim(), isPro: true, licenseValidatedAt: Date.now() });
      document.getElementById('upgrade-modal').classList.add('hidden');
      showToast('Pro機能が有効になりました！');
      applyProGates();
      renderLicenseStatus();
      renderLogs();
    } else {
      msgEl.textContent = result.error || '無効なライセンスキーです';
      msgEl.className = 'license-msg license-err';
    }
  } catch {
    msgEl.textContent = 'ネットワークエラー。接続を確認してください。';
    msgEl.className = 'license-msg license-err';
  } finally {
    btn.disabled = false;
    btn.textContent = '認証';
  }
}

function applyProGates() {
  document.querySelector('.filter-chips .chip[data-filter="all"]')?.classList.toggle('pro-locked', !isPro);
  ['jwt', 'env'].forEach(tab => {
    document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.toggle('pro-locked', !isPro);
  });
  ['export-md', 'select-mode-btn', 'body-search-btn', 'snapshot-btn'].forEach(id => {
    document.getElementById(id)?.classList.toggle('pro-locked', !isPro);
  });
}

function renderLicenseStatus() {
  const el = document.getElementById('license-status-text');
  if (!el) return;
  if (isPro) {
    el.textContent = 'Pro — 有効';
    el.className = 'license-status-pro';
    document.getElementById('license-deactivate-btn')?.classList.remove('hidden');
    document.getElementById('upgrade-open-btn')?.classList.add('hidden');
  } else {
    el.textContent = 'Free プラン';
    el.className = 'license-status-free';
    document.getElementById('license-deactivate-btn')?.classList.add('hidden');
    document.getElementById('upgrade-open-btn')?.classList.remove('hidden');
  }
}

// ---- Tab switching ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!isPro && (btn.dataset.tab === 'jwt' || btn.dataset.tab === 'env')) {
      showUpgradeModal(btn.dataset.tab === 'jwt' ? 'JWT自動注入' : '環境切り替え');
      return;
    }
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---- Helpers ----
function statusClass(status) {
  if (status === 0) return 'status-net';
  if (status < 300) return 'status-ok';
  if (status < 400) return 'status-warn';
  return 'status-error';
}

function itemClass(status) {
  if (status === 0) return 'is-net';
  if (status < 300) return 'is-ok';
  if (status < 400) return 'is-warn';
  return 'is-error';
}

function methodClass(method) {
  return `method-${method.toLowerCase()}`;
}

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function tryPrettyJson(str) {
  if (!str) return '';
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, 2000);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('クリップボードにコピーしました');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
    }
  } catch (_) {}
}

// ---- Log tab ----
let allLogs = [];
let logFilterMode = 'err';
let statusFilter = null; // null | number — click status badge to set
let selectMode = false;
const selectedIds = new Set();
const seenLogIds = new Set(); // for flash animation
let pinnedLogIds = new Set();
let logTags = {};
let tagFilter = null;
let bodySearchEnabled = false;
let snapshots = [];
let snapshotViewActive = false;
let snapshotViewLogs = [];
const collapsedSections = new Set();
const logList = document.getElementById('log-list');
const logDetail = document.getElementById('log-detail');
const logFilter = document.getElementById('log-filter');

// ---- Context menu ----
const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctx-menu hidden';
ctxMenu.innerHTML = `
  <button class="ctx-item" id="ctx-url">URLをコピー</button>
  <button class="ctx-item" id="ctx-curl">curlをコピー</button>
  <button class="ctx-item" id="ctx-tab">新しいタブで開く (GET)</button>
  <div class="ctx-divider"></div>
  <button class="ctx-item" id="ctx-pin">◈ ピン / 解除</button>
  <button class="ctx-item" id="ctx-ai">AIプロンプトをコピー</button>
`;
document.body.appendChild(ctxMenu);
let ctxLog = null;

function showCtxMenu(e, log) {
  ctxLog = log;
  const x = Math.min(e.clientX, window.innerWidth - 170);
  const y = Math.min(e.clientY, window.innerHeight - 140);
  ctxMenu.style.left = `${x}px`;
  ctxMenu.style.top = `${y}px`;
  ctxMenu.classList.remove('hidden');
}
function hideCtxMenu() { ctxMenu.classList.add('hidden'); }

document.addEventListener('click', hideCtxMenu);
document.addEventListener('contextmenu', e => { if (!e.target.closest('.log-item')) hideCtxMenu(); });
document.getElementById('ctx-url').addEventListener('click', () => { if (ctxLog) navigator.clipboard.writeText(ctxLog.url); });
document.getElementById('ctx-curl').addEventListener('click', () => { if (ctxLog) navigator.clipboard.writeText(logToCurl(ctxLog)); });
document.getElementById('ctx-tab').addEventListener('click', () => { if (ctxLog) chrome.tabs.create({ url: ctxLog.url }); });
document.getElementById('ctx-ai').addEventListener('click', () => { if (ctxLog) navigator.clipboard.writeText(generateAIPrompt(ctxLog)); });
document.getElementById('ctx-pin').addEventListener('click', () => {
  if (!isPro) { showUpgradeModal('ピン留め'); return; }
  if (ctxLog) togglePin(ctxLog.id);
});

// ---- Diff view ----
function lineDiff(textA, textB) {
  const A = (textA || '').split('\n');
  const B = (textB || '').split('\n');
  const m = A.length, n = B.length;
  if (m * n > 40000) {
    return A.map(t => ({ type: 'removed', text: t })).concat(B.map(t => ({ type: 'added', text: t })));
  }
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = A[i-1] === B[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const ops = [];
  let ai = m, bi = n;
  while (ai > 0 || bi > 0) {
    if (ai > 0 && bi > 0 && A[ai-1] === B[bi-1]) { ops.unshift({ type: 'same', text: A[ai-1] }); ai--; bi--; }
    else if (bi > 0 && (ai === 0 || dp[ai][bi-1] >= dp[ai-1][bi])) { ops.unshift({ type: 'added', text: B[bi-1] }); bi--; }
    else { ops.unshift({ type: 'removed', text: A[ai-1] }); ai--; }
  }
  return ops;
}

function renderDiffSection(title, textA, textB) {
  const a = (textA || '').trim(), b = (textB || '').trim();
  if (a === b) return `<div class="diff-section"><div class="diff-section-title">${title} <span class="diff-badge-same">同一</span></div></div>`;
  if (!a && !b) return '';
  const ops = lineDiff(a, b);
  const lines = ops.map(op => {
    const cls = op.type === 'added' ? 'diff-add' : op.type === 'removed' ? 'diff-del' : 'diff-eq';
    const pfx = op.type === 'added' ? '+' : op.type === 'removed' ? '-' : ' ';
    return `<div class="diff-line ${cls}"><span class="diff-prefix">${pfx}</span>${escHtml(op.text)}</div>`;
  }).join('');
  return `<div class="diff-section"><div class="diff-section-title">${title}</div><div class="diff-code">${lines}</div></div>`;
}

function openDiffView() {
  const [idA, idB] = [...selectedIds];
  const logA = getActiveLogs().find(l => l.id === idA);
  const logB = getActiveLogs().find(l => l.id === idB);
  if (!logA || !logB) return;
  const hdrText = l => Object.entries(l.requestHeaders || {}).map(([k,v]) => `${k}: ${v}`).join('\n');
  const resHdrText = l => Object.entries(l.responseHeaders || {}).map(([k,v]) => `${k}: ${v}`).join('\n');
  const stStr = l => l.status === 0 ? 'Network Error' : `${l.status} ${l.statusText || ''}`.trim();
  const pathOf = l => { try { return new URL(l.url).pathname; } catch { return l.url; } };
  const stCls = l => l.status < 300 ? 'diff-status-ok' : 'diff-status-err';

  document.getElementById('diff-body').innerHTML = `
    <div class="diff-overview">
      <div class="diff-col">
        <div class="diff-col-label">A</div>
        <div class="diff-col-url">${escHtml(logA.method)} <span class="${stCls(logA)}">${escHtml(stStr(logA))}</span></div>
        <div class="diff-col-path">${escHtml(pathOf(logA))}</div>
        <div class="diff-col-meta">${formatDuration(logA.duration)} · ${new Date(logA.timestamp).toLocaleTimeString('ja-JP')}</div>
      </div>
      <div class="diff-vs">VS</div>
      <div class="diff-col">
        <div class="diff-col-label">B</div>
        <div class="diff-col-url">${escHtml(logB.method)} <span class="${stCls(logB)}">${escHtml(stStr(logB))}</span></div>
        <div class="diff-col-path">${escHtml(pathOf(logB))}</div>
        <div class="diff-col-meta">${formatDuration(logB.duration)} · ${new Date(logB.timestamp).toLocaleTimeString('ja-JP')}</div>
      </div>
    </div>
    ${renderDiffSection('リクエストヘッダー', hdrText(logA), hdrText(logB))}
    ${renderDiffSection('リクエストボディ', tryPrettyJson(logA.requestBody || ''), tryPrettyJson(logB.requestBody || ''))}
    ${renderDiffSection('レスポンスヘッダー', resHdrText(logA), resHdrText(logB))}
    ${renderDiffSection('レスポンスボディ', tryPrettyJson(logA.responseBody || ''), tryPrettyJson(logB.responseBody || ''))}
  `;
  document.getElementById('diff-panel').classList.remove('hidden');
}

document.getElementById('close-diff').addEventListener('click', () => {
  document.getElementById('diff-panel').classList.add('hidden');
});

document.getElementById('bulk-diff-btn').addEventListener('click', openDiffView);

// ---- Keyboard shortcuts ----
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hideCtxMenu();
    if (!logDetail.classList.contains('hidden')) { logDetail.classList.add('hidden'); hideTooltip(); return; }
    if (!document.getElementById('diff-panel').classList.contains('hidden')) {
      document.getElementById('diff-panel').classList.add('hidden'); return;
    }
  }
  if (e.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    document.querySelector('[data-tab="logs"]')?.click();
    logFilter.focus();
  }
});

// ---- Stats bar: click to clear status filter ----
document.getElementById('log-stats').addEventListener('click', () => {
  if (statusFilter !== null) { statusFilter = null; renderLogs(); }
});

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const count = selectedIds.size;
  if (count === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('bulk-count').textContent = `${count}件選択中`;
  document.getElementById('bulk-diff-btn').classList.toggle('hidden', count !== 2);
}

document.getElementById('select-mode-btn').addEventListener('click', () => {
  if (!isPro) { showUpgradeModal('複数選択・差分ビュー'); return; }
  selectMode = !selectMode;
  document.getElementById('select-mode-btn').classList.toggle('active', selectMode);
  logList.classList.toggle('select-mode', selectMode);
  if (!selectMode) { selectedIds.clear(); updateBulkBar(); renderLogs(); }
});

document.getElementById('bulk-deselect').addEventListener('click', () => {
  selectedIds.clear();
  updateBulkBar();
  renderLogs();
});

document.getElementById('bulk-ai-btn').addEventListener('click', () => {
  const logs = getActiveLogs().filter(l => selectedIds.has(l.id));
  if (!logs.length) return;
  const prompt = generateBulkAIPrompt(logs);
  navigator.clipboard.writeText(prompt).then(() => {
    const btn = document.getElementById('bulk-ai-btn');
    btn.textContent = '✓ コピー済';
    setTimeout(() => { btn.textContent = 'AIプロンプトをコピー'; }, 2000);
  });
});

document.getElementById('export-md').addEventListener('click', () => {
  if (!isPro) { showUpgradeModal('Markdownエクスポート'); return; }
  const md = generateMarkdownExport();
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `api-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// Filter chips
document.querySelectorAll('.filter-chips .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if (!isPro && chip.dataset.filter === 'all') {
      showUpgradeModal('全ステータスのログ表示');
      return;
    }
    document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    logFilterMode = chip.dataset.filter;
    renderLogs();
  });
});

function getActiveLogs() {
  return snapshotViewActive ? snapshotViewLogs : allLogs;
}

function renderLogs() {
  const source = getActiveLogs();
  const urlFilter = logFilter.value.trim().toLowerCase();
  let logs = source.filter(l => {
    if (statusFilter !== null && l.status !== statusFilter) return false;
    if (statusFilter === null && logFilterMode === 'err' && l.status < 400 && l.status !== 0) return false;
    if (tagFilter !== null) {
      if (!(logTags[l.id] || []).includes(tagFilter)) return false;
    }
    if (urlFilter) {
      const inUrl = l.url.toLowerCase().includes(urlFilter);
      const inBody = bodySearchEnabled && (
        (l.responseBody || '').toLowerCase().includes(urlFilter) ||
        (l.requestBody || '').toLowerCase().includes(urlFilter)
      );
      if (!inUrl && !inBody) return false;
    }
    return true;
  });

  // Pinned items float to top
  logs = [...logs].sort((a, b) => {
    const ap = pinnedLogIds.has(a.id) ? 0 : 1;
    const bp = pinnedLogIds.has(b.id) ? 0 : 1;
    return ap - bp;
  });

  let showUpgradeBanner = false;
  if (!isPro && !snapshotViewActive && logs.length > FREE_LOG_LIMIT) {
    logs = logs.slice(0, FREE_LOG_LIMIT);
    showUpgradeBanner = true;
  }

  updateStats(logs);

  const newIds = new Set(logs.map(l => l.id).filter(id => !seenLogIds.has(id)));
  logs.forEach(l => seenLogIds.add(l.id));

  if (logs.length === 0) {
    const msg = logFilterMode === 'err'
      ? 'エラーログはありません<br><small>「全て」に切り替えると全リクエストを表示します</small>'
      : 'ログがありません<br><small>APIリクエストを送信すると表示されます</small>';
    logList.innerHTML = `<div class="log-empty"><div class="log-empty-icon">◎</div>${msg}</div>`;
    return;
  }

  logList.innerHTML = logs.map(l => {
    const sc = statusClass(l.status);
    const ic = itemClass(l.status);
    const mc = methodClass(l.method);
    const statusLabel = l.status === 0 ? 'ERR' : l.status;
    const urlObj = (() => { try { return new URL(l.url); } catch { return null; } })();
    const shortUrl = urlObj ? urlObj.pathname + urlObj.search : l.url;
    const size = formatSize(l.responseBody);
    const gqlInfo = getGraphQLInfo(l);
    const durationLabel = size ? `${formatDuration(l.duration)} · ${size}` : formatDuration(l.duration);
    const gqlBadge = gqlInfo?.operationName
      ? `<span class="log-gql-op">${escHtml(gqlInfo.operationName)}</span>` : '';
    const isPinned = pinnedLogIds.has(l.id);
    const pinBadge = isPinned ? '<span class="pin-badge" title="ピン留め中">◈</span>' : '';
    const tags = logTags[l.id] || [];
    const tagBadges = tags.map(t =>
      `<span class="log-tag-badge" data-tag="${escHtml(t)}">#${escHtml(t)}</span>`
    ).join('');
    return `<div class="log-item ${ic}${isPinned ? ' is-pinned' : ''}${newIds.has(l.id) ? ' is-new' : ''}" data-id="${l.id}">
      <input type="checkbox" class="log-select-cb" data-id="${l.id}" ${selectedIds.has(l.id) ? 'checked' : ''}>
      ${pinBadge}
      <span class="log-status ${sc}" title="クリックして絞り込み">${statusLabel}</span>
      <span class="log-method ${mc}">${l.method}</span>
      <span class="log-url" title="${escHtml(l.url)}">${escHtml(shortUrl)}${gqlBadge}${tagBadges}</span>
      <span class="log-duration">${durationLabel}</span>
    </div>`;
  }).join('');

  if (showUpgradeBanner) {
    logList.insertAdjacentHTML('beforeend', `<div class="upgrade-log-banner"><span>最新${FREE_LOG_LIMIT}件を表示中 — Proで全件表示</span><button class="upgrade-log-btn" id="upgrade-log-banner-btn">Proにアップグレード</button></div>`);
    document.getElementById('upgrade-log-banner-btn')?.addEventListener('click', () => showUpgradeModal('全件ログ表示'));
  }

  logList.querySelectorAll('.log-item').forEach(el => {
    el.addEventListener('click', () => { hideTooltip(); openDetail(el.dataset.id); });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const log = getActiveLogs().find(l => l.id === el.dataset.id);
      if (log) showCtxMenu(e, log);
    });
    el.addEventListener('mouseenter', () => {
      const log = getActiveLogs().find(l => l.id === el.dataset.id);
      if (log) showTooltip(el, log);
    });
    el.addEventListener('mouseleave', hideTooltip);
  });

  logList.querySelectorAll('.log-status').forEach(badge => {
    badge.addEventListener('click', e => {
      e.stopPropagation();
      const id = badge.closest('.log-item').dataset.id;
      const log = getActiveLogs().find(l => l.id === id);
      if (!log) return;
      statusFilter = statusFilter === log.status ? null : log.status;
      renderLogs();
    });
  });

  logList.querySelectorAll('.log-select-cb').forEach(cb => {
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(cb.dataset.id);
      else selectedIds.delete(cb.dataset.id);
      updateBulkBar();
    });
  });

  logList.querySelectorAll('.log-tag-badge').forEach(badge => {
    badge.addEventListener('click', e => {
      e.stopPropagation();
      const tag = badge.dataset.tag;
      tagFilter = tagFilter === tag ? null : tag;
      updateTagFilterBar();
      renderLogs();
    });
  });
}

// ---- Error explanation ----
const ERROR_INFO = {
  0: {
    type: 'net',
    title: 'ネットワークエラー（レスポンスなし）',
    desc: 'サーバーとの接続が完全に失敗しました。ブラウザがレスポンスを一切受信できていません。',
    infraHints: [
      'DNS解決失敗 — ホスト名が名前解決できているか確認',
      'ファイアウォール・セキュリティグループでポートがブロックされている',
      'TLS証明書エラー（自己署名・期限切れ）',
      'CDN・リバースプロキシの設定ミス',
    ],
    appHints: [
      'CORSポリシーによるブロック — F12コンソールの「CORS」エラーを確認',
      'HTTP / HTTPS の混在（Mixed Content）でブロックされている',
      'URLのホスト名・ポート番号の間違い',
    ],
  },
  400: {
    type: '4xx',
    title: '400 Bad Request — 不正なリクエスト',
    desc: 'サーバーがリクエストの形式を理解できませんでした。',
    infraHints: [
      'APIゲートウェイのリクエスト変換・スキーマ検証設定（Apigee、API Gateway等）',
      'ロードバランサーがリクエストを意図せず変形させている可能性',
    ],
    appHints: [
      'リクエストボディのJSON構文エラー（末尾カンマ、型ミスマッチなど）',
      '必須パラメータの欠落',
      'Content-Type ヘッダーが実際のボディ形式と一致していない',
    ],
  },
  401: {
    type: '4xx',
    title: '401 Unauthorized — 認証エラー',
    desc: '有効な認証情報がありません。トークンが未付与・期限切れ・形式不正の可能性があります。',
    infraHints: [
      'APIゲートウェイ（Cognito / Auth0 等）の認証設定を確認',
      'ロードバランサー・プロキシがAuthorizationヘッダーを除去していないか確認',
    ],
    appHints: [
      'JWTタブのトークンが有効期限切れ、または無効化されていないか確認',
      'Authorizationヘッダーが実際のリクエストに付与されているか（このリクエストヘッダーを確認）',
      'プレフィックス（Bearer / Token など）がAPIの仕様と一致しているか確認',
    ],
  },
  403: {
    type: '4xx',
    title: '403 Forbidden — 権限なし',
    desc: '認証は通っていますが、このリソースへのアクセス権限がありません。',
    infraHints: [
      'WAF（Web Application Firewall）によるIPブロック・ルール一致',
      'IPアドレス制限・VPN接続が必要な環境',
      'CDNのアクセス制御（地域制限・リファラ制限）',
    ],
    appHints: [
      'アカウント・APIキーに必要なスコープ・ロールが付与されているか確認',
      '開発用トークンで本番リソースにアクセスしていないか確認',
      'マルチテナントの場合、テナントIDとリソースの所有者が一致しているか確認',
    ],
  },
  404: {
    type: '4xx',
    title: '404 Not Found — リソースが存在しない',
    desc: '指定されたURLにリソースが見つかりません。',
    infraHints: [
      'Nginx / ALB などのルーティング設定ミス（パスが正しくマッピングされていない）',
      'ブルーグリーンデプロイ・カナリアリリース中の一時的なリソース不在',
    ],
    appHints: [
      'URLパスのタイポ・APIバージョン番号のずれ（v1 vs v2 など）',
      'リソースが削除済みまたはIDが間違っている',
      '環境タブのURL変換が意図しない向きになっていないか確認',
    ],
  },
  405: {
    type: '4xx',
    title: '405 Method Not Allowed — HTTPメソッド不可',
    desc: 'このエンドポイントは指定されたHTTPメソッドに対応していません。',
    infraHints: [
      'APIゲートウェイ・プロキシのメソッド制限設定',
      'CORSプリフライト（OPTIONS）が正しく処理されているか確認',
    ],
    appHints: [
      'GET / POST / PUT / PATCH / DELETE のどれが正しいかAPIドキュメントを確認',
      'エンドポイントが読み取り専用（GETのみ）の可能性',
    ],
  },
  408: {
    type: '4xx',
    title: '408 Request Timeout — リクエストタイムアウト',
    desc: 'クライアントがリクエストを時間内に送信できませんでした。',
    infraHints: [
      'ネットワーク遅延・パケットロスによる送信遅延',
      'クライアントのコネクションタイムアウト設定が短すぎる',
    ],
    appHints: [
      'リクエストボディが大きすぎてアップロードが完了しない',
      'サーバー側の接続維持設定（keep-alive）の不整合',
    ],
  },
  409: {
    type: '4xx',
    title: '409 Conflict — 競合',
    desc: 'リクエストがサーバーの現在の状態と競合しました。',
    infraHints: [
      '複数インスタンスへのリクエスト分散（ロードバランサー）による楽観的ロック競合',
    ],
    appHints: [
      '重複したデータの作成（メールアドレス・ユニークキー違反）',
      '楽観的ロックの競合 — GETで最新状態を取得してから再試行',
      '並行更新によるリソースの状態不整合',
    ],
  },
  410: {
    type: '4xx',
    title: '410 Gone — 削除済み',
    desc: 'このリソースは永続的に削除されました。404と異なり、意図的な廃止を意味します。',
    infraHints: [
      '旧バージョンのAPIサーバーが残存している可能性（デプロイが不完全）',
    ],
    appHints: [
      'APIバージョンの廃止（v1 → v2 移行）',
      'APIドキュメントで移行先エンドポイントを確認',
    ],
  },
  422: {
    type: '4xx',
    title: '422 Unprocessable Entity — バリデーションエラー',
    desc: 'リクエスト形式は正しいですが、内容がサーバーのバリデーションを通過しませんでした。',
    infraHints: [
      'APIゲートウェイのJSONスキーマ検証（OpenAPI定義との不一致）',
    ],
    appHints: [
      'レスポンスボディにバリデーションエラーの詳細が含まれている（下を確認）',
      '必須フィールドの型・形式・文字数制限などを確認',
      '参照先リソース（外部キー等）が存在しない',
    ],
  },
  429: {
    type: '4xx',
    title: '429 Too Many Requests — レート制限超過',
    desc: '短時間に送信できるリクエスト数の上限を超えました。',
    infraHints: [
      'APIゲートウェイ・WAF・CDNのレート制限（DDoS保護含む）',
      'クラスタ全体のリクエスト集中によるサービスレベルの制限',
    ],
    appHints: [
      'APIキー・プランのレート制限（`Retry-After` レスポンスヘッダーを確認）',
      'ユーザー単位・IPアドレス単位のアプリケーション内レート制限',
    ],
  },
  500: {
    type: '5xx',
    title: '500 Internal Server Error — サーバー内部エラー',
    desc: 'サーバー側で予期しないエラーが発生しました。クライアントの問題ではありません。',
    infraHints: [
      'サーバーのOOM（メモリ不足）・ディスクフル',
      'DBやキャッシュ（Redis等）への接続失敗',
      'コンテナ・ポッドの異常終了（OOMKilled等）',
    ],
    appHints: [
      'サーバーログでスタックトレースを確認するのが最短の原因特定手段',
      '特定のリクエストパラメータでのみ発生する場合はエッジケース',
      'レスポンスボディにエラー詳細が含まれていることもある（下を確認）',
    ],
  },
  502: {
    type: '5xx',
    title: '502 Bad Gateway — ゲートウェイエラー',
    desc: 'リバースプロキシ・ロードバランサーがバックエンドから無効なレスポンスを受け取りました。',
    infraHints: [
      'バックエンドサーバーの停止・クラッシュ（ヘルスチェック失敗）',
      'デプロイ中（ローリングアップデート）のインスタンスへのルーティング',
      'コンテナ・ポッドの起動失敗またはポートバインド失敗',
    ],
    appHints: [
      'アプリが返すレスポンスの形式が不正（プロキシが解釈できない）',
      'アプリが接続を途中で切断している',
    ],
  },
  503: {
    type: '5xx',
    title: '503 Service Unavailable — サービス停止中',
    desc: 'サーバーが一時的にリクエストを処理できない状態です。',
    infraHints: [
      'サーバーの過負荷によるリクエスト拒否',
      'オートスケールのインスタンス追加が追いつかない',
      'インフラメンテナンス中（ステータスページを確認）',
    ],
    appHints: [
      'サーキットブレーカーの発動（依存サービスの障害検知）',
      'アプリ側のメンテナンスモードレスポンス',
    ],
  },
  504: {
    type: '5xx',
    title: '504 Gateway Timeout — ゲートウェイタイムアウト',
    desc: 'プロキシがバックエンドサービスからの応答を待ってタイムアウトしました。',
    infraHints: [
      'Nginx / ALB などのタイムアウト設定が短い（デフォルト60秒等）',
      'バックエンドサービスが無応答（ハング・無限ループ）',
      'マイクロサービス間のネットワーク遅延の蓄積',
    ],
    appHints: [
      'N+1クエリ・インデックスなしの全件スキャンなど重いDBクエリ',
      '外部APIへの同期的な長時間待機',
      '無限ループやデッドロックの可能性',
    ],
  },
};

function getErrorExplanationHtml(log) {
  if (log.status >= 200 && log.status < 400) return '';

  const info = ERROR_INFO[log.status] || (() => {
    if (log.status === 0) return ERROR_INFO[0];
    if (log.status >= 500) return {
      type: '5xx',
      title: `${log.status} Server Error`,
      desc: 'サーバー側でエラーが発生しました。',
      infraHints: ['サーバーログ・コンテナの状態を確認してください'],
      appHints: ['レスポンスボディにエラー詳細が含まれている場合があります'],
    };
    return {
      type: '4xx',
      title: `${log.status} Client Error`,
      desc: 'クライアント側のリクエストに問題がある可能性があります。',
      infraHints: [],
      appHints: ['APIドキュメントで正しいリクエスト形式を確認してください'],
    };
  })();

  const typeClass = info.type === 'net' ? 'type-net' : info.type === '5xx' ? 'type-5xx' : '';
  const infraHtml = (info.infraHints || []).map(h =>
    `<div class="persp-hint">${escHtml(h)}</div>`).join('');
  const appHtml = (info.appHints || []).map(h =>
    `<div class="persp-hint">${escHtml(h)}</div>`).join('');

  return `
    <div class="error-explain ${typeClass}">
      <div class="error-explain-header">
        <div class="error-explain-dot"></div>
        <div class="error-explain-title">${escHtml(info.title)}</div>
      </div>
      <div class="error-explain-desc">${escHtml(info.desc)}</div>
      <div class="error-perspectives">
        <div class="error-persp infra-persp">
          <div class="persp-label persp-label-infra">⚙ インフラ</div>
          ${infraHtml || '<div class="persp-hint persp-none">—</div>'}
        </div>
        <div class="error-persp app-persp">
          <div class="persp-label persp-label-app">✦ アプリ</div>
          ${appHtml || '<div class="persp-hint persp-none">—</div>'}
        </div>
      </div>
    </div>`;
}

// ---- Settings ----
chrome.storage.local.get('colorBlindMode').then(({ colorBlindMode }) => {
  if (colorBlindMode) document.documentElement.dataset.theme = 'colorblind';
  const toggle = document.getElementById('colorblind-toggle');
  if (toggle) toggle.checked = !!colorBlindMode;
});

document.getElementById('colorblind-toggle').addEventListener('change', async (e) => {
  if (e.target.checked) {
    document.documentElement.dataset.theme = 'colorblind';
  } else {
    delete document.documentElement.dataset.theme;
  }
  await chrome.storage.local.set({ colorBlindMode: e.target.checked });
});

// ---- AI prompt generation ----
function maskSensitiveHeaders(headers) {
  const sensitive = /^(authorization|x-api-key|api-key|token|x-auth-token|cookie|set-cookie)/i;
  const result = {};
  for (const [k, v] of Object.entries(headers || {})) {
    result[k] = sensitive.test(k) ? `${v.slice(0, 10)}…[masked]` : v;
  }
  return result;
}

function generateAIPrompt(log) {
  const gqlInfo = getGraphQLInfo(log);
  const isError = log.status >= 400 || log.status === 0;
  const isSlow = log.duration >= 1500;

  const safeReqHeaders = maskSensitiveHeaders(log.requestHeaders);
  const reqHdrText = Object.entries(safeReqHeaders).map(([k, v]) => `${k}: ${v}`).join('\n') || '(なし)';
  const resHdrText = Object.entries(log.responseHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\n') || '(なし)';

  const statusStr = log.status === 0
    ? 'Network Error（接続失敗）'
    : `${log.status} ${log.statusText || ''}`.trim();

  let lines = [];
  lines.push('以下のAPIリクエストを調査してください。\n');
  lines.push('## リクエスト概要');
  lines.push(`- メソッド: ${log.method}`);
  lines.push(`- URL: ${log.url}`);
  lines.push(`- ステータス: ${statusStr}`);
  lines.push(`- 所要時間: ${formatDuration(log.duration)}`);
  if (gqlInfo?.operationName) lines.push(`- GraphQL操作: ${gqlInfo.operationName}`);

  lines.push('\n## リクエストヘッダー（認証情報は一部マスク済み）');
  lines.push('```');
  lines.push(reqHdrText);
  lines.push('```');

  if (log.requestBody && !gqlInfo) {
    lines.push('\n## リクエストボディ');
    lines.push('```json');
    lines.push(tryPrettyJson(log.requestBody));
    lines.push('```');
  }

  if (gqlInfo?.query) {
    lines.push('\n## GraphQLクエリ');
    lines.push('```graphql');
    lines.push(gqlInfo.query);
    lines.push('```');
    if (gqlInfo.variables) {
      lines.push('\n## GraphQL変数');
      lines.push('```json');
      lines.push(JSON.stringify(gqlInfo.variables, null, 2));
      lines.push('```');
    }
  }

  lines.push('\n## レスポンスヘッダー');
  lines.push('```');
  lines.push(resHdrText);
  lines.push('```');

  if (log.responseBody) {
    const body = log.responseBody.length > 3000
      ? log.responseBody.slice(0, 3000) + '\n... (以下省略)'
      : log.responseBody;
    lines.push('\n## レスポンスボディ');
    lines.push('```');
    lines.push(tryPrettyJson(body));
    lines.push('```');
  }

  const info = ERROR_INFO[log.status];
  if (isError && info) {
    lines.push('\n## 自動検出エラー情報');
    lines.push(`**${info.title}**`);
    lines.push(info.desc);
    if (info.infraHints?.length) {
      lines.push('\n**⚙ インフラ観点の確認項目:**');
      info.infraHints.forEach(h => lines.push(`- ${h}`));
    }
    if (info.appHints?.length) {
      lines.push('\n**✦ アプリ観点の確認項目:**');
      info.appHints.forEach(h => lines.push(`- ${h}`));
    }
  }

  lines.push('\n---');
  if (log.status === 0) {
    lines.push('このネットワークエラーの原因を特定してください。CORS・Mixed Content・サーバー未起動の観点も含めて分析し、具体的な修正手順を教えてください。');
  } else if (log.status === 401 || log.status === 403) {
    lines.push('この認証/認可エラーの原因を特定してください。リクエストヘッダーとレスポンスボディの内容から、何が問題でどう修正すれば良いか教えてください。');
  } else if (isError) {
    lines.push('このエラーの原因を特定し、修正方法を具体的に教えてください。リクエストボディとレスポンスボディの内容も踏まえて分析してください。');
  } else if (isSlow) {
    lines.push(`このリクエストが${formatDuration(log.duration)}かかっています。レスポンスヘッダー（Cache-Control、Content-Length等）とURLの構造から、パフォーマンス問題の原因と改善策を教えてください。`);
  } else {
    lines.push('このAPIリクエストについて気になる点や改善できる点があれば教えてください。');
  }

  return lines.join('\n');
}

// ---- OpenAPI snippet generation ----
function inferSchema(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'boolean', example: value };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number', example: value };
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return { type: 'string', format: 'date-time' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { type: 'string', format: 'date' };
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(value)) return { type: 'string', format: 'uuid' };
    return { type: 'string', ...(value.length <= 80 ? { example: value } : {}) };
  }
  if (Array.isArray(value)) return { type: 'array', items: value.length > 0 ? inferSchema(value[0]) : {} };
  if (typeof value === 'object') {
    const properties = {};
    for (const [k, v] of Object.entries(value)) properties[k] = inferSchema(v);
    return { type: 'object', properties };
  }
  return {};
}

function generateOpenAPISnippet(log) {
  const urlObj = (() => { try { return new URL(log.url); } catch { return null; } })();
  if (!urlObj) return null;

  const rawPath = urlObj.pathname;
  // Replace numeric segments with {resourceId} pattern
  const path = rawPath.replace(/\/(\d+)(?=\/|$)/g, (_, n, offset) => {
    const before = rawPath.slice(0, offset).split('/').filter(Boolean);
    const res = before.length > 0 ? before[before.length - 1] : 'resource';
    const singular = res.endsWith('s') ? res.slice(0, -1) : res;
    return `/{${singular}Id}`;
  });

  const method = log.method.toLowerCase();
  const parameters = [];
  urlObj.searchParams.forEach((value, name) => {
    parameters.push({ name, in: 'query', required: false, schema: { type: 'string' }, example: value });
  });

  let requestBody;
  if (log.requestBody && !['GET', 'HEAD', 'DELETE'].includes(log.method)) {
    try {
      requestBody = { required: true, content: { 'application/json': { schema: inferSchema(JSON.parse(log.requestBody)) } } };
    } catch {
      requestBody = { required: true, content: { 'application/json': { schema: { type: 'object' } } } };
    }
  }

  let responseContent;
  if (log.responseBody) {
    try { responseContent = { 'application/json': { schema: inferSchema(JSON.parse(log.responseBody)) } }; } catch {}
  }

  const operation = {
    summary: '',
    tags: [rawPath.split('/').filter(Boolean)[0] || 'api'],
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: {
      [String(log.status || 200)]: {
        description: log.statusText || (log.status < 300 ? 'Success' : 'Error'),
        ...(responseContent ? { content: responseContent } : {})
      }
    }
  };

  return JSON.stringify({ paths: { [path]: { [method]: operation } } }, null, 2);
}

// ---- Bulk AI prompt ----
function generateBulkAIPrompt(logs) {
  const errors = logs.filter(l => l.status >= 400 || l.status === 0).length;
  const avg = Math.round(logs.reduce((s, l) => s + l.duration, 0) / logs.length);
  const lines = [];
  lines.push(`以下の${logs.length}件のAPIリクエストをまとめて分析してください。\n`);
  lines.push(`- 合計: ${logs.length}件 · エラー: ${errors}件 · 平均応答: ${formatDuration(avg)}\n`);

  logs.forEach((log, i) => {
    const gqlInfo = getGraphQLInfo(log);
    const statusStr = log.status === 0 ? 'Network Error' : `${log.status} ${log.statusText || ''}`.trim();
    lines.push(`---\n### リクエスト ${i + 1}: ${log.method} ${log.url}`);
    lines.push(`ステータス: ${statusStr} · ${formatDuration(log.duration)}`);
    const safeHdr = maskSensitiveHeaders(log.requestHeaders);
    if (Object.keys(safeHdr).length) {
      lines.push(`\nリクエストヘッダー:\n\`\`\`\n${Object.entries(safeHdr).map(([k,v]) => `${k}: ${v}`).join('\n')}\n\`\`\``);
    }
    if (log.requestBody && !gqlInfo) {
      lines.push(`\nリクエストボディ:\n\`\`\`json\n${tryPrettyJson(log.requestBody)}\n\`\`\``);
    }
    if (gqlInfo?.query) {
      lines.push(`\nGraphQL操作: ${gqlInfo.operationName || '(無名)'}\n\`\`\`graphql\n${gqlInfo.query}\n\`\`\``);
    }
    if (log.responseBody) {
      const b = log.responseBody.length > 800 ? log.responseBody.slice(0, 800) + '\n...(省略)' : log.responseBody;
      lines.push(`\nレスポンスボディ:\n\`\`\`\n${tryPrettyJson(b)}\n\`\`\``);
    }
  });

  lines.push(`\n---\n## 質問`);
  if (errors > 0) {
    lines.push(`1. エラーに共通するパターンや根本原因があれば特定してください`);
    lines.push(`2. 各エラーの修正方法を具体的に教えてください`);
    lines.push(`3. リクエスト設計で気になる点があれば指摘してください`);
  } else {
    lines.push(`上記リクエスト群を分析して、問題点や改善できる点があれば教えてください。`);
  }
  return lines.join('\n');
}

// ---- Markdown session export ----
function generateMarkdownExport() {
  const urlFilter = logFilter.value.trim().toLowerCase();
  const logs = getActiveLogs().filter(l => {
    if (statusFilter !== null && l.status !== statusFilter) return false;
    if (statusFilter === null && logFilterMode === 'err' && l.status < 400 && l.status !== 0) return false;
    if (urlFilter && !l.url.toLowerCase().includes(urlFilter)) return false;
    return true;
  });

  const now = new Date().toLocaleString('ja-JP');
  const errors = logs.filter(l => l.status >= 400 || l.status === 0).length;
  const avg = logs.length ? Math.round(logs.reduce((s, l) => s + l.duration, 0) / logs.length) : 0;
  const lines = [];
  lines.push(`# APIデバッグセッションレポート`);
  lines.push(`> 生成日時: ${now}  `);
  lines.push(`> ${logs.length}件 · エラー${errors}件 · 平均${formatDuration(avg)}\n`);
  lines.push('---\n');

  logs.forEach((log, i) => {
    const gqlInfo = getGraphQLInfo(log);
    const statusStr = log.status === 0 ? 'Network Error' : `${log.status} ${log.statusText || ''}`.trim();
    const title = gqlInfo?.operationName
      ? `${log.method} ${gqlInfo.operationName} — ${log.url}`
      : `${log.method} ${log.url}`;
    lines.push(`## ${i + 1}. ${title}`);
    lines.push(`**ステータス:** ${statusStr} · **所要時間:** ${formatDuration(log.duration)} · **時刻:** ${new Date(log.timestamp).toLocaleTimeString('ja-JP')}\n`);

    const safeHdr = maskSensitiveHeaders(log.requestHeaders);
    if (Object.keys(safeHdr).length) {
      lines.push('**リクエストヘッダー** *(認証情報はマスク済み)*');
      lines.push('```\n' + Object.entries(safeHdr).map(([k,v]) => `${k}: ${v}`).join('\n') + '\n```\n');
    }
    if (log.requestBody) {
      lines.push('**リクエストボディ**');
      lines.push('```json\n' + tryPrettyJson(log.requestBody) + '\n```\n');
    }
    if (gqlInfo?.query) {
      lines.push(`**GraphQL操作:** ${gqlInfo.operationName || '(無名)'}`);
      lines.push('```graphql\n' + gqlInfo.query + '\n```\n');
      if (gqlInfo.variables) lines.push('```json\n' + JSON.stringify(gqlInfo.variables, null, 2) + '\n```\n');
    }
    if (log.responseBody) {
      const b = log.responseBody.length > 1500 ? log.responseBody.slice(0, 1500) + '\n...(省略)' : log.responseBody;
      lines.push('**レスポンスボディ**');
      lines.push('```\n' + tryPrettyJson(b) + '\n```\n');
    }
    const info = ERROR_INFO[log.status];
    if (info) lines.push(`> **自動診断:** ${info.title}  \n> ${info.desc}\n`);
    lines.push('---\n');
  });

  lines.push(`## AI分析依頼`);
  lines.push(`上記${logs.length}件のAPIリクエストを分析してください。`);
  if (errors > 0) lines.push(`特に${errors}件のエラーについて、共通の原因パターンと具体的な修正方法を教えてください。`);
  return lines.join('\n');
}

// ---- curl generation ----
function logToCurl(log) {
  const parts = ['curl'];
  if (log.method && log.method !== 'GET') parts.push(`-X ${log.method}`);
  for (const [k, v] of Object.entries(log.requestHeaders || {})) {
    parts.push(`-H '${k.replace(/'/g, "'\\''")}: ${v.replace(/'/g, "'\\''")}'`);
  }
  if (log.requestBody && log.method !== 'GET' && log.method !== 'HEAD') {
    parts.push(`-d '${log.requestBody.replace(/'/g, "'\\''")}'`);
  }
  parts.push(`'${log.url.replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n  ');
}

// ---- Response size ----
function formatSize(body) {
  if (!body) return null;
  const bytes = new Blob([body]).size;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---- GraphQL detection ----
function getGraphQLInfo(log) {
  if (!log.requestBody) return null;
  try {
    const body = JSON.parse(log.requestBody);
    if (!body.query && !body.operationName) return null;
    const opName = body.operationName ||
      (body.query || '').match(/(?:query|mutation|subscription)\s+(\w+)/)?.[1] || null;
    return { operationName: opName, query: body.query || null, variables: body.variables || null };
  } catch { return null; }
}

// ---- Stats bar ----
function updateStats(logs) {
  const el = document.getElementById('log-stats');
  if (logs.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const total = logs.length;
  const ok2xx = logs.filter(l => l.status >= 200 && l.status < 300).length;
  const redir  = logs.filter(l => l.status >= 300 && l.status < 400).length;
  const err4xx = logs.filter(l => l.status >= 400 && l.status < 500).length;
  const err5xx = logs.filter(l => l.status >= 500).length;
  const errNet = logs.filter(l => l.status === 0).length;
  const errors = err4xx + err5xx + errNet;
  const avg = Math.round(logs.reduce((s, l) => s + l.duration, 0) / total);
  const filterLabel = statusFilter !== null ? ` · [${statusFilter === 0 ? 'ERR' : statusFilter}]` : '';
  const tagLabel = tagFilter ? ` · #${tagFilter}` : '';
  const seg = (n, cls) => n > 0
    ? `<div class="stats-seg ${cls}" style="flex:${n}" title="${n}件"></div>` : '';
  el.innerHTML = `
    <div class="stats-bar">
      ${seg(ok2xx,'seg-ok')}${seg(redir,'seg-warn')}${seg(err4xx,'seg-error')}${seg(err5xx,'seg-5xx')}${seg(errNet,'seg-net')}
    </div>
    <div class="stats-text">${total}件 · エラー${errors}件 · 平均${formatDuration(avg)}${filterLabel}${tagLabel}</div>`;
  el.className = `log-stats${errors > 0 ? ' has-errors' : ''}${statusFilter !== null ? ' has-filter' : ''}`;
}

// ---- Log hover tooltip ----
const _tooltip = document.createElement('div');
_tooltip.className = 'log-tooltip';
document.body.appendChild(_tooltip);

function buildTooltipHtml(log) {
  const ts = new Date(log.timestamp).toLocaleTimeString('ja-JP');
  const statusTxt = log.status === 0
    ? 'Network Error'
    : `${log.status} ${log.statusText || ''}`.trim();
  const sc = statusClass(log.status);
  const mc = methodClass(log.method);

  const info = ERROR_INFO[log.status] || (log.status >= 500
    ? { title: `${log.status} Server Error`, type: '5xx' }
    : log.status >= 400
    ? { title: `${log.status} Client Error`, type: '4xx' }
    : null);

  let extra = '';
  if (info && (log.status >= 400 || log.status === 0)) {
    const typeClass = info.type === 'net' ? 'type-net' : info.type === '5xx' ? 'type-5xx' : '';
    extra += `<hr class="tt-divider"><div class="tt-error ${typeClass}">${escHtml(info.title)}</div>`;
    if (log.responseBody) {
      const preview = tryPrettyJson(log.responseBody);
      extra += `<div class="tt-body">${escHtml(preview.slice(0, 200))}</div>`;
    }
  }

  return `<div class="tt-row">
    <span class="log-method ${mc}">${escHtml(log.method)}</span>
    <span class="log-status ${sc}">${escHtml(statusTxt)}</span>
    <span class="tt-meta">${formatDuration(log.duration)} · ${ts}</span>
  </div>
  <div class="tt-url">${escHtml(log.url)}</div>
  ${extra}`;
}

function showTooltip(el, log) {
  _tooltip.innerHTML = buildTooltipHtml(log);
  _tooltip.classList.add('visible');
  const rect = el.getBoundingClientRect();
  const margin = 6;
  // measure after content set
  const th = _tooltip.offsetHeight || 70;
  const tw = _tooltip.offsetWidth || 280;
  let top = rect.bottom + margin;
  let left = rect.left;
  if (top + th > window.innerHeight - margin) top = rect.top - th - margin;
  if (left + tw > window.innerWidth - margin) left = window.innerWidth - tw - margin;
  _tooltip.style.top = `${Math.max(margin, top)}px`;
  _tooltip.style.left = `${Math.max(margin, left)}px`;
}

function hideTooltip() {
  _tooltip.classList.remove('visible');
}

// Clipboard texts indexed by position (reset per detail open)
let _copyTexts = [];
function _copyIdx(text) {
  const idx = _copyTexts.length;
  _copyTexts.push(text);
  return idx;
}

function openDetail(id) {
  const log = getActiveLogs().find(l => l.id === id);
  if (!log) return;
  hideTooltip();
  _copyTexts = [];

  // Update replay button target
  const replayBtn = document.getElementById('replay-btn');
  replayBtn.dataset.logId = id;
  replayBtn.textContent = '↺ 再送';
  replayBtn.disabled = false;

  const gqlInfo = getGraphQLInfo(log);
  const aiPrompt = generateAIPrompt(log);
  const openApiSnippet = generateOpenAPISnippet(log);
  const curlCmd = logToCurl(log);
  const urlObj = (() => { try { return new URL(log.url); } catch { return null; } })();
  document.getElementById('detail-title').textContent =
    gqlInfo?.operationName
      ? `${log.method} ${gqlInfo.operationName}`
      : `${log.method} ${urlObj ? urlObj.pathname : log.url}`;

  const reqHeadersText = Object.entries(log.requestHeaders || {})
    .map(([k, v]) => `${k}: ${v}`).join('\n');
  const resHeadersText = Object.entries(log.responseHeaders || {})
    .map(([k, v]) => `${k}: ${v}`).join('\n');

  const reqHeadersHtml = Object.entries(log.requestHeaders || {})
    .map(([k, v]) => `<div class="detail-kv"><span class="key">${escHtml(k)}: </span><span class="val">${escHtml(v)}</span></div>`)
    .join('') || `<span style="color:var(--text-dim)">なし</span>`;

  const resHeadersHtml = Object.entries(log.responseHeaders || {})
    .map(([k, v]) => `<div class="detail-kv"><span class="key">${escHtml(k)}: </span><span class="val">${escHtml(v)}</span></div>`)
    .join('') || `<span style="color:var(--text-dim)">なし</span>`;

  const ts = new Date(log.timestamp).toLocaleTimeString('ja-JP');

  const urlCopyIdx = _copyIdx(log.url);
  const reqHdrCopyIdx = reqHeadersText ? _copyIdx(reqHeadersText) : -1;
  const resHdrCopyIdx = resHeadersText ? _copyIdx(resHeadersText) : -1;
  const reqBodyCopyIdx = log.requestBody ? _copyIdx(tryPrettyJson(log.requestBody)) : -1;
  const resBodyCopyIdx = log.responseBody ? _copyIdx(tryPrettyJson(log.responseBody)) : -1;

  document.getElementById('detail-body').innerHTML = `
    ${getErrorExplanationHtml(log)}
    <div class="detail-section">
      <div class="detail-section-header">
        <div class="detail-section-title">概要</div>
        <button class="copy-btn" data-idx="${urlCopyIdx}">コピー</button>
      </div>
      <div class="detail-kv" style="margin-bottom:4px">
        <div class="detail-url-val">${escHtml(log.url)}</div>
      </div>
      <div class="detail-kv">
        <div><span class="key">ステータス: </span><span class="val">${log.status} ${escHtml(log.statusText || '')}</span></div>
        <div><span class="key">所要時間: </span><span class="val">${formatDuration(log.duration)}</span></div>
        <div><span class="key">時刻: </span><span class="val">${ts}</span></div>
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-section-header">
        <div class="detail-section-title">リクエストヘッダー</div>
        ${reqHdrCopyIdx >= 0 ? `<button class="copy-btn" data-idx="${reqHdrCopyIdx}">コピー</button>` : ''}
      </div>
      ${reqHeadersHtml}
    </div>
    ${log.requestBody ? `
    <div class="detail-section">
      <div class="detail-section-header">
        <div class="detail-section-title">リクエストボディ</div>
        ${reqBodyCopyIdx >= 0 ? `<button class="copy-btn" data-idx="${reqBodyCopyIdx}">コピー</button>` : ''}
      </div>
      <pre class="detail-pre">${escHtml(tryPrettyJson(log.requestBody))}</pre>
    </div>` : ''}
    ${gqlInfo ? `
    <div class="detail-section">
      <div class="detail-section-header">
        <div class="detail-section-title">GraphQL${gqlInfo.operationName ? ` <span style="color:var(--purple);font-weight:700">· ${escHtml(gqlInfo.operationName)}</span>` : ''}</div>
        ${gqlInfo.query ? `<button class="copy-btn" data-idx="${_copyIdx(gqlInfo.query)}">コピー</button>` : ''}
      </div>
      ${gqlInfo.query ? `<pre class="detail-pre">${escHtml(gqlInfo.query)}</pre>` : ''}
      ${gqlInfo.variables ? `
      <div style="font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em;margin:8px 0 4px">variables</div>
      <pre class="detail-pre">${escHtml(JSON.stringify(gqlInfo.variables, null, 2))}</pre>` : ''}
    </div>` : ''}
    <div class="detail-section">
      <div class="detail-section-header">
        <div class="detail-section-title">レスポンスヘッダー</div>
        ${resHdrCopyIdx >= 0 ? `<button class="copy-btn" data-idx="${resHdrCopyIdx}">コピー</button>` : ''}
      </div>
      ${resHeadersHtml}
    </div>
    ${log.responseBody != null ? `
    <div class="detail-section">
      <div class="detail-section-header">
        <div class="detail-section-title">レスポンスボディ</div>
        ${resBodyCopyIdx >= 0 ? `<button class="copy-btn" data-idx="${resBodyCopyIdx}">コピー</button>` : ''}
      </div>
      <pre class="detail-pre">${escHtml(tryPrettyJson(log.responseBody))}</pre>
    </div>` : ''}
    <div class="detail-section">
      <div class="detail-section-header">
        <div class="detail-section-title">curlコマンド</div>
        <button class="copy-btn" data-idx="${_copyIdx(curlCmd)}">コピー</button>
      </div>
      <pre class="detail-pre">${escHtml(curlCmd)}</pre>
    </div>
    ${openApiSnippet ? `
    <div class="detail-section">
      <div class="detail-section-header">
        <div class="detail-section-title">OpenAPI 3.0 スニペット</div>
        <button class="copy-btn" data-idx="${_copyIdx(openApiSnippet)}">コピー</button>
      </div>
      <pre class="detail-pre">${escHtml(openApiSnippet)}</pre>
    </div>` : ''}
    <div class="ai-prompt-section">
      <div class="ai-prompt-header">
        <div class="ai-prompt-title">AI 分析プロンプト</div>
        <button class="copy-btn" data-idx="${_copyIdx(aiPrompt)}">コピー</button>
      </div>
      <div class="ai-prompt-note">Claude / ChatGPT などに貼り付けると原因分析・修正案が得られます。認証ヘッダーは自動マスク済み。</div>
      <pre class="ai-prompt-pre">${escHtml(aiPrompt)}</pre>
    </div>
  `;

  document.querySelectorAll('#detail-body .copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = _copyTexts[+btn.dataset.idx];
      if (text != null) copyText(text, btn);
    });
  });

  // Tag section (inserted at top of detail body) — Pro only
  if (!isPro) {
    document.getElementById('detail-body').insertAdjacentHTML('afterbegin', `
      <div class="detail-section detail-tag-section">
        <div class="detail-section-header">
          <div class="detail-section-title">タグ <span class="pro-badge-inline">Pro</span></div>
        </div>
        <div class="pro-locked-hint" id="pro-tag-hint">Proプランで利用可能</div>
      </div>`);
    document.getElementById('pro-tag-hint')?.addEventListener('click', () => showUpgradeModal('タグ付け'));
  } else {
  const tagsForLog = logTags[id] || [];
  const tagChipsHtml = tagsForLog.map(t =>
    `<span class="detail-tag-chip">#${escHtml(t)}<button class="tag-remove-btn" data-tag="${escHtml(t)}" data-logid="${escHtml(id)}">✕</button></span>`
  ).join('');
  document.getElementById('detail-body').insertAdjacentHTML('afterbegin', `
    <div class="detail-section detail-tag-section">
      <div class="detail-section-header">
        <div class="detail-section-title">タグ</div>
      </div>
      <div class="tag-input-row" id="tag-input-row">
        ${tagChipsHtml}
        <input type="text" class="tag-add-input" id="tag-add-input" placeholder="Enterで追加..." />
      </div>
    </div>`);
  function refreshDetailTagChips(logId) {
    const row = document.getElementById('tag-input-row');
    if (!row) return;
    row.querySelectorAll('.detail-tag-chip').forEach(c => c.remove());
    (logTags[logId] || []).forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'detail-tag-chip';
      chip.innerHTML = `#${escHtml(t)}<button class="tag-remove-btn" data-tag="${escHtml(t)}" data-logid="${escHtml(logId)}">✕</button>`;
      chip.querySelector('.tag-remove-btn').addEventListener('click', e => {
        e.stopPropagation();
        removeLogTag(logId, t);
        chip.remove();
        updateTagFilterBar();
      });
      row.insertBefore(chip, document.getElementById('tag-add-input'));
    });
  }
  document.querySelectorAll('.tag-remove-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeLogTag(btn.dataset.logid, btn.dataset.tag);
      btn.closest('.detail-tag-chip').remove();
      updateTagFilterBar();
    });
  });
  const tagAddInput = document.getElementById('tag-add-input');
  tagAddInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const tag = tagAddInput.value.trim();
    if (!tag) return;
    addLogTag(id, tag);
    tagAddInput.value = '';
    refreshDetailTagChips(id);
    updateTagFilterBar();
  });
  } // end isPro tag section

  // Collapsible section headers
  document.querySelectorAll('#detail-body .detail-section-header').forEach(header => {
    const titleEl = header.querySelector('.detail-section-title');
    if (!titleEl) return;
    const key = titleEl.textContent.trim().replace(/\s+/g, ' ');
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'section-collapse-btn';
    toggleBtn.title = '折りたたむ';
    const section = header.closest('.detail-section');
    if (collapsedSections.has(key)) {
      section.classList.add('collapsed');
      toggleBtn.textContent = '▶';
    } else {
      toggleBtn.textContent = '▼';
    }
    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (collapsedSections.has(key)) {
        collapsedSections.delete(key);
        section.classList.remove('collapsed');
        toggleBtn.textContent = '▼';
      } else {
        collapsedSections.add(key);
        section.classList.add('collapsed');
        toggleBtn.textContent = '▶';
      }
    });
    header.insertBefore(toggleBtn, header.firstChild);
  });

  logDetail.classList.remove('hidden');
}

document.getElementById('close-detail').addEventListener('click', () => {
  logDetail.classList.add('hidden');
});

document.getElementById('replay-btn').addEventListener('click', () => {
  const btn = document.getElementById('replay-btn');
  const log = getActiveLogs().find(l => l.id === btn.dataset.logId);
  if (!log) return;
  btn.textContent = '送信中…';
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'REPLAY_REQUEST', log }, () => {
    setTimeout(() => { btn.textContent = '↺ 再送'; btn.disabled = false; }, 1500);
  });
});

document.getElementById('export-logs').addEventListener('click', () => {
  const urlFilter = logFilter.value.trim().toLowerCase();
  const logs = getActiveLogs().filter(l => {
    if (statusFilter !== null && l.status !== statusFilter) return false;
    if (statusFilter === null && logFilterMode === 'err' && l.status < 400 && l.status !== 0) return false;
    if (urlFilter && !l.url.toLowerCase().includes(urlFilter)) return false;
    return true;
  });
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `api-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('clear-logs').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, () => {
    allLogs = [];
    pinnedLogIds.clear();
    logTags = {};
    tagFilter = null;
    savePins();
    saveTags();
    updateTagFilterBar();
    renderLogs();
    logDetail.classList.add('hidden');
  });
});

logFilter.addEventListener('input', renderLogs);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG_UPDATED') loadLogs();
});

function loadLogs() {
  chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (res) => {
    const isInitial = allLogs.length === 0;
    allLogs = res?.logs || [];
    if (isInitial) allLogs.forEach(l => seenLogIds.add(l.id));
    if (!snapshotViewActive) renderLogs();
  });
}
loadLogs();

// ---- Exclude filter ----
let excludePatterns = [];

async function loadExcludePatterns() {
  const { excludePatterns: stored = [] } = await chrome.storage.local.get('excludePatterns');
  excludePatterns = stored;
  renderExcludePatterns();
}

async function saveExcludePatterns() {
  await chrome.storage.local.set({ excludePatterns });
}

function renderExcludePatterns() {
  const list = document.getElementById('exclude-list');
  if (excludePatterns.length === 0) {
    list.innerHTML = '<div class="exclude-tags"><span class="exclude-tags-empty">除外パターンなし</span></div>';
    return;
  }
  list.innerHTML = `<div class="exclude-tags">${excludePatterns.map((p, i) => `
    <span class="exclude-tag">${escHtml(p)}<button class="exclude-tag-remove" data-idx="${i}">✕</button></span>
  `).join('')}</div>`;
  list.querySelectorAll('.exclude-tag-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      excludePatterns.splice(+btn.dataset.idx, 1);
      await saveExcludePatterns();
      renderExcludePatterns();
    });
  });
}

document.getElementById('exclude-settings-btn').addEventListener('click', () => {
  document.getElementById('exclude-panel').classList.toggle('hidden');
});

document.getElementById('exclude-add-btn').addEventListener('click', async () => {
  const val = document.getElementById('exclude-input').value.trim();
  if (!val || excludePatterns.includes(val)) return;
  excludePatterns.push(val);
  await saveExcludePatterns();
  renderExcludePatterns();
  document.getElementById('exclude-input').value = '';
});

document.getElementById('exclude-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('exclude-add-btn').click();
});

loadExcludePatterns();

// ---- JWT tab ----
let jwtTokens = [];
let editingJwtId = null;

function parseJwtExpiry(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    if (!payload.exp) return null;
    return new Date(payload.exp * 1000);
  } catch { return null; }
}

function formatExpiry(exp) {
  const diff = exp - Date.now();
  const abs = Math.abs(diff);
  const fmt = abs < 60000 ? '数秒'
    : abs < 3600000 ? `${Math.floor(abs / 60000)}分`
    : abs < 86400000 ? `${Math.floor(abs / 3600000)}時間`
    : `${Math.floor(abs / 86400000)}日`;
  return diff < 0 ? `期限切れ（${fmt}前）` : `あと${fmt}`;
}

function expiryTagClass(exp) {
  if (!exp) return '';
  const diff = exp - Date.now();
  if (diff < 0) return 'expiry-expired';
  if (diff < 3600000) return 'expiry-warn';
  return 'expiry-ok';
}

async function loadJwt() {
  const { jwtTokens: stored = [] } = await chrome.storage.local.get('jwtTokens');
  jwtTokens = stored;
  renderJwt();
}

function renderJwt() {
  const list = document.getElementById('jwt-list');
  if (jwtTokens.length === 0) {
    list.innerHTML = '<div class="log-empty"><div class="log-empty-icon">🔑</div>JWTトークンが登録されていません</div>';
    return;
  }
  list.innerHTML = jwtTokens.map(t => {
    const preview = t.token ? t.token.slice(0, 24) + '...' : '未設定';
    const exp = t.token ? parseJwtExpiry(t.token) : null;
    const expTag = exp
      ? `<span class="expiry-tag ${expiryTagClass(exp)}">${formatExpiry(exp)}</span>`
      : '';
    return `<div class="jwt-item" data-id="${t.id}">
      <div class="jwt-item-info">
        <div class="jwt-item-name">
          ${escHtml(t.name)}
          ${t.enabled ? '<span class="badge-active">有効</span>' : ''}
          ${expTag}
        </div>
        <div class="jwt-item-sub">${escHtml(t.urlPattern)} · ${escHtml(preview)}</div>
      </div>
      <div class="jwt-item-actions">
        <button class="jwt-toggle secondary">${t.enabled ? '無効化' : '有効化'}</button>
        <button class="jwt-edit secondary">編集</button>
        <button class="jwt-delete danger">削除</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.jwt-toggle').forEach((btn, i) => {
    btn.addEventListener('click', () => toggleJwt(jwtTokens[i].id));
  });
  list.querySelectorAll('.jwt-edit').forEach((btn, i) => {
    btn.addEventListener('click', () => openJwtForm(jwtTokens[i].id));
  });
  list.querySelectorAll('.jwt-delete').forEach((btn, i) => {
    btn.addEventListener('click', () => deleteJwt(jwtTokens[i].id));
  });
}

async function saveJwt() {
  await chrome.storage.local.set({ jwtTokens });
  chrome.runtime.sendMessage({ type: 'UPDATE_JWT', tokens: jwtTokens });
}

async function toggleJwt(id) {
  const t = jwtTokens.find(t => t.id === id);
  if (t) t.enabled = !t.enabled;
  await saveJwt();
  renderJwt();
}

async function deleteJwt(id) {
  jwtTokens = jwtTokens.filter(t => t.id !== id);
  await saveJwt();
  renderJwt();
}

function openJwtForm(id = null) {
  editingJwtId = id;
  const form = document.getElementById('jwt-form');
  const t = id ? jwtTokens.find(t => t.id === id) : null;
  document.getElementById('jwt-form-title').textContent = id ? 'JWTトークン編集' : 'JWTトークン追加';
  document.getElementById('jwt-name').value = t?.name || '';
  document.getElementById('jwt-pattern').value = t?.urlPattern || '';
  document.getElementById('jwt-header').value = t?.headerName || 'Authorization';
  document.getElementById('jwt-prefix').value = t?.prefix || 'Bearer ';
  document.getElementById('jwt-token').value = t?.token || '';
  document.getElementById('jwt-list').classList.add('hidden');
  form.classList.remove('hidden');
}

document.getElementById('add-jwt').addEventListener('click', () => openJwtForm());

document.getElementById('jwt-cancel').addEventListener('click', () => {
  document.getElementById('jwt-form').classList.add('hidden');
  document.getElementById('jwt-list').classList.remove('hidden');
});

document.getElementById('jwt-save').addEventListener('click', async () => {
  const token = {
    id: editingJwtId || crypto.randomUUID(),
    name: document.getElementById('jwt-name').value.trim() || '無名',
    urlPattern: document.getElementById('jwt-pattern').value.trim(),
    headerName: document.getElementById('jwt-header').value.trim() || 'Authorization',
    prefix: document.getElementById('jwt-prefix').value,
    token: document.getElementById('jwt-token').value.trim(),
    enabled: true
  };
  if (editingJwtId) {
    const idx = jwtTokens.findIndex(t => t.id === editingJwtId);
    jwtTokens[idx] = token;
  } else {
    jwtTokens.push(token);
  }
  await saveJwt();
  renderJwt();
  document.getElementById('jwt-form').classList.add('hidden');
  document.getElementById('jwt-list').classList.remove('hidden');
});

loadJwt();

// ---- Environment tab ----
let environments = [];
let activeEnvId = null;
let editingEnvId = null;

async function loadEnv() {
  const data = await chrome.storage.local.get(['environments', 'activeEnvironmentId']);
  environments = data.environments || [];
  activeEnvId = data.activeEnvironmentId || null;
  renderEnv();
}

function renderEnv() {
  const statusEl = document.getElementById('env-status');
  const activeEnv = environments.find(e => e.id === activeEnvId);
  if (activeEnv) {
    statusEl.textContent = `現在の環境: ${activeEnv.name}（有効）`;
    statusEl.classList.add('active');
  } else {
    statusEl.textContent = '現在の環境: なし（OFF）';
    statusEl.classList.remove('active');
  }

  const list = document.getElementById('env-list');
  if (environments.length === 0) {
    list.innerHTML = '<div class="log-empty"><div class="log-empty-icon">⇄</div>環境が登録されていません</div>';
    return;
  }
  list.innerHTML = environments.map(e => {
    const isActive = e.id === activeEnvId;
    const ruleCount = (e.rules || []).filter(r => r.from && r.to).length;
    return `<div class="env-item" data-id="${e.id}">
      <div class="env-item-info">
        <div class="env-item-name">
          ${escHtml(e.name)}
          ${isActive ? '<span class="badge-active">有効</span>' : ''}
        </div>
        <div class="env-item-sub">${ruleCount}件のURLルール</div>
      </div>
      <div class="env-item-actions">
        <button class="env-activate secondary">${isActive ? '無効化' : '適用'}</button>
        <button class="env-edit secondary">編集</button>
        <button class="env-delete danger">削除</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.env-activate').forEach((btn, i) => {
    btn.addEventListener('click', () => activateEnv(environments[i].id));
  });
  list.querySelectorAll('.env-edit').forEach((btn, i) => {
    btn.addEventListener('click', () => openEnvForm(environments[i].id));
  });
  list.querySelectorAll('.env-delete').forEach((btn, i) => {
    btn.addEventListener('click', () => deleteEnv(environments[i].id));
  });
}

async function activateEnv(id) {
  activeEnvId = activeEnvId === id ? null : id;
  await chrome.storage.local.set({ activeEnvironmentId: activeEnvId });
  chrome.runtime.sendMessage({ type: 'UPDATE_ENVIRONMENT', environmentId: activeEnvId });
  renderEnv();
}

async function deleteEnv(id) {
  environments = environments.filter(e => e.id !== id);
  if (activeEnvId === id) {
    activeEnvId = null;
    await chrome.storage.local.set({ activeEnvironmentId: null });
    chrome.runtime.sendMessage({ type: 'UPDATE_ENVIRONMENT', environmentId: null });
  }
  await chrome.storage.local.set({ environments });
  renderEnv();
}

document.getElementById('env-off').addEventListener('click', async () => {
  activeEnvId = null;
  await chrome.storage.local.set({ activeEnvironmentId: null });
  chrome.runtime.sendMessage({ type: 'UPDATE_ENVIRONMENT', environmentId: null });
  renderEnv();
});

function openEnvForm(id = null) {
  editingEnvId = id;
  const env = id ? environments.find(e => e.id === id) : null;
  document.getElementById('env-form-title').textContent = id ? '環境編集' : '環境追加';
  document.getElementById('env-name').value = env?.name || '';

  const rulesContainer = document.getElementById('env-rules');
  rulesContainer.innerHTML = '';
  const rules = env?.rules?.length ? env.rules : [{ from: '', to: '' }];
  rules.forEach(r => addRuleRow(r.from, r.to));

  document.getElementById('env-list').classList.add('hidden');
  document.getElementById('env-form').classList.remove('hidden');
}

function addRuleRow(from = '', to = '') {
  const container = document.getElementById('env-rules');
  const row = document.createElement('div');
  row.className = 'rule-row';
  row.innerHTML = `
    <input type="text" class="rule-from" value="${escHtml(from)}" placeholder="api.example.com（変換元ホスト）" />
    <span style="color:var(--text-dim)">→</span>
    <input type="text" class="rule-to" value="${escHtml(to)}" placeholder="api-dev.example.com（変換先ホスト）" />
    <button class="remove-rule">✕</button>
  `;
  row.querySelector('.remove-rule').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

document.getElementById('add-rule').addEventListener('click', () => addRuleRow());
document.getElementById('add-env').addEventListener('click', () => openEnvForm());

document.getElementById('env-cancel').addEventListener('click', () => {
  document.getElementById('env-form').classList.add('hidden');
  document.getElementById('env-list').classList.remove('hidden');
});

document.getElementById('env-save').addEventListener('click', async () => {
  const name = document.getElementById('env-name').value.trim() || '無名';
  const rows = document.querySelectorAll('#env-rules .rule-row');
  const rules = [...rows].map(row => ({
    from: row.querySelector('.rule-from').value.trim(),
    to: row.querySelector('.rule-to').value.trim()
  })).filter(r => r.from && r.to);

  const env = { id: editingEnvId || crypto.randomUUID(), name, rules };
  if (editingEnvId) {
    const idx = environments.findIndex(e => e.id === editingEnvId);
    environments[idx] = env;
  } else {
    environments.push(env);
  }
  await chrome.storage.local.set({ environments });
  renderEnv();
  document.getElementById('env-form').classList.add('hidden');
  document.getElementById('env-list').classList.remove('hidden');
});

loadEnv();

// ---- Pin ----
async function loadPins() {
  const { pinnedLogIds: stored = [] } = await chrome.storage.local.get('pinnedLogIds');
  pinnedLogIds = new Set(stored);
}
async function savePins() {
  await chrome.storage.local.set({ pinnedLogIds: [...pinnedLogIds] });
}
function togglePin(id) {
  if (pinnedLogIds.has(id)) pinnedLogIds.delete(id);
  else pinnedLogIds.add(id);
  savePins();
  renderLogs();
  showToast(pinnedLogIds.has(id) ? 'ピン留めしました' : 'ピンを解除しました');
}

// ---- Tags ----
async function loadTags() {
  const { logTags: stored = {} } = await chrome.storage.local.get('logTags');
  logTags = stored;
}
async function saveTags() {
  await chrome.storage.local.set({ logTags });
}
function addLogTag(logId, tag) {
  if (!logTags[logId]) logTags[logId] = [];
  if (!logTags[logId].includes(tag)) { logTags[logId].push(tag); saveTags(); renderLogs(); }
}
function removeLogTag(logId, tag) {
  if (!logTags[logId]) return;
  logTags[logId] = logTags[logId].filter(t => t !== tag);
  if (logTags[logId].length === 0) delete logTags[logId];
  saveTags(); renderLogs();
}
function updateTagFilterBar() {
  const allTagSet = new Set();
  getActiveLogs().forEach(l => (logTags[l.id] || []).forEach(t => allTagSet.add(t)));
  const bar = document.getElementById('tag-filter-bar');
  const chipsContainer = document.getElementById('active-tag-chips');
  if (allTagSet.size === 0) { bar.classList.add('hidden'); tagFilter = null; return; }
  bar.classList.remove('hidden');
  if (!allTagSet.has(tagFilter)) tagFilter = null;
  chipsContainer.innerHTML = [...allTagSet].map(t =>
    `<button class="tag-filter-chip${tagFilter === t ? ' active' : ''}" data-tag="${escHtml(t)}">#${escHtml(t)}</button>`
  ).join('');
  chipsContainer.querySelectorAll('.tag-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      tagFilter = tagFilter === chip.dataset.tag ? null : chip.dataset.tag;
      updateTagFilterBar(); renderLogs();
    });
  });
}

// ---- Snapshots ----
async function loadSnapshots() {
  const { snapshots: stored = [] } = await chrome.storage.local.get('snapshots');
  snapshots = stored;
}
async function saveCurrentAsSnapshot(name) {
  const logsToSave = snapshotViewActive ? snapshotViewLogs : allLogs;
  const snapshot = {
    id: crypto.randomUUID(),
    name,
    date: Date.now(),
    logs: logsToSave.slice(),
    savedLogTags: { ...logTags }
  };
  snapshots.unshift(snapshot);
  if (snapshots.length > 30) snapshots.splice(30);
  await chrome.storage.local.set({ snapshots });
  renderSnapshotList();
  showToast(`"${name}" を保存しました`);
}
async function deleteSnapshot(id) {
  snapshots = snapshots.filter(s => s.id !== id);
  await chrome.storage.local.set({ snapshots });
  renderSnapshotList();
  showToast('削除しました');
}
function loadSnapshot(snapshot) {
  snapshotViewActive = true;
  snapshotViewLogs = snapshot.logs;
  if (snapshot.savedLogTags) Object.assign(logTags, snapshot.savedLogTags);
  document.getElementById('snapshot-banner').classList.remove('hidden');
  document.getElementById('snapshot-banner-name').textContent = snapshot.name;
  closeSnapshotModal();
  renderLogs();
  updateTagFilterBar();
}
function exitSnapshotView() {
  snapshotViewActive = false;
  snapshotViewLogs = [];
  document.getElementById('snapshot-banner').classList.add('hidden');
  loadLogs();
  updateTagFilterBar();
}
function renderSnapshotList() {
  const list = document.getElementById('snapshot-list');
  if (!list) return;
  if (snapshots.length === 0) {
    list.innerHTML = '<div class="snapshot-empty">保存済みスナップショットなし</div>';
    return;
  }
  list.innerHTML = snapshots.map(s => {
    const d = new Date(s.date).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<div class="snapshot-item" data-id="${s.id}">
      <div class="snapshot-info">
        <div class="snapshot-name">${escHtml(s.name)}</div>
        <div class="snapshot-meta">${d} · ${s.logs.length}件</div>
      </div>
      <div class="snapshot-actions">
        <button class="snapshot-load-btn secondary">読込</button>
        <button class="snapshot-delete-btn danger">削除</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.snapshot-item').forEach(item => {
    const snap = snapshots.find(s => s.id === item.dataset.id);
    item.querySelector('.snapshot-load-btn').addEventListener('click', () => loadSnapshot(snap));
    item.querySelector('.snapshot-delete-btn').addEventListener('click', () => deleteSnapshot(snap.id));
  });
}
function openSnapshotModal() {
  loadSnapshots().then(() => {
    renderSnapshotList();
    document.getElementById('snapshot-modal').classList.remove('hidden');
  });
}
function closeSnapshotModal() {
  document.getElementById('snapshot-modal').classList.add('hidden');
}

// ---- Snapshot events ----
document.getElementById('snapshot-btn').addEventListener('click', () => {
  if (!isPro) { showUpgradeModal('スナップショット'); return; }
  openSnapshotModal();
});
document.getElementById('snapshot-modal-close').addEventListener('click', closeSnapshotModal);
document.getElementById('snapshot-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('snapshot-modal')) closeSnapshotModal();
});
document.getElementById('snapshot-save-btn').addEventListener('click', () => {
  const name = document.getElementById('snapshot-name-input').value.trim();
  if (!name) { showToast('スナップショット名を入力してください', 'warn'); return; }
  saveCurrentAsSnapshot(name);
  document.getElementById('snapshot-name-input').value = '';
});
document.getElementById('snapshot-exit-btn').addEventListener('click', exitSnapshotView);

// ---- Body search toggle ----
document.getElementById('body-search-btn').addEventListener('click', () => {
  if (!isPro) { showUpgradeModal('ボディ内テキスト検索'); return; }
  bodySearchEnabled = !bodySearchEnabled;
  const btn = document.getElementById('body-search-btn');
  btn.classList.toggle('active', bodySearchEnabled);
  logFilter.placeholder = bodySearchEnabled ? 'URL・ボディで絞り込み' : 'URLで絞り込み';
  renderLogs();
});

// ---- Onboarding ----
chrome.storage.local.get('onboardingDone').then(({ onboardingDone }) => {
  if (!onboardingDone) document.getElementById('onboarding-overlay').classList.remove('hidden');
});
document.getElementById('onboarding-start').addEventListener('click', () => {
  chrome.storage.local.set({ onboardingDone: true });
  document.getElementById('onboarding-overlay').classList.add('hidden');
});

// ---- Init ----
loadPins();
loadTags().then(() => updateTagFilterBar());

// ---- License init ----
chrome.storage.local.get(['isPro', 'licenseKey', 'licenseValidatedAt']).then(({ isPro: stored, licenseKey, licenseValidatedAt }) => {
  isPro = !!stored;
  applyProGates();
  renderLicenseStatus();

  // 24時間経過後にバックグラウンドで再検証
  if (licenseKey && licenseValidatedAt && Date.now() - licenseValidatedAt > 86400000) {
    chrome.runtime.sendMessage({ type: 'VERIFY_LICENSE', key: licenseKey }).then(result => {
      if (!result?.success) {
        isPro = false;
        chrome.storage.local.remove(['licenseKey', 'isPro', 'licenseValidatedAt']);
        applyProGates();
        renderLicenseStatus();
        renderLogs();
      } else {
        chrome.storage.local.set({ licenseValidatedAt: Date.now() });
      }
    }).catch(() => {}); // オフライン時は現状維持
  }
});

// Upgrade modal events
document.getElementById('upgrade-modal-close').addEventListener('click', () => {
  document.getElementById('upgrade-modal').classList.add('hidden');
});
document.getElementById('upgrade-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('upgrade-modal'))
    document.getElementById('upgrade-modal').classList.add('hidden');
});
document.getElementById('license-activate-btn').addEventListener('click', () => {
  const key = document.getElementById('license-key-input').value.trim();
  if (key) activateLicense(key);
});
document.getElementById('license-key-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('license-activate-btn').click();
});
document.getElementById('license-deactivate-btn')?.addEventListener('click', async () => {
  await chrome.storage.local.remove(['licenseKey', 'isPro', 'licenseValidatedAt']);
  isPro = false;
  applyProGates();
  renderLicenseStatus();
  renderLogs();
  showToast('ライセンスを解除しました');
});
document.getElementById('upgrade-open-btn')?.addEventListener('click', () => showUpgradeModal());

// ---- curl Parser tab ----
function parseCurl(raw) {
  const src = raw.replace(/\\\s*\n/g, ' ').replace(/\\\s*\r\n/g, ' ').trim();
  let method = 'GET', url = '';
  const headers = {};
  let body = null;
  const tokens = tokenizeCurl(src);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'curl') continue;
    if ((t === '-X' || t === '--request') && tokens[i + 1]) {
      method = tokens[++i].toUpperCase();
    } else if ((t === '-H' || t === '--header') && tokens[i + 1]) {
      const header = tokens[++i];
      const sep = header.indexOf(':');
      if (sep > -1) {
        headers[header.slice(0, sep).trim()] = header.slice(sep + 1).trim();
      }
    } else if ((t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') && tokens[i + 1]) {
      body = tokens[++i];
      if (method === 'GET') method = 'POST';
    } else if (!t.startsWith('-') && !url && t !== 'curl') {
      url = t;
    }
  }
  return { method, url, headers, body };
}

function tokenizeCurl(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === ' ' || src[i] === '\t') { i++; continue; }
    if (src[i] === "'" || src[i] === '"') {
      const q = src[i++];
      let val = '';
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\' && src[i + 1]) { i++; val += src[i++]; }
        else val += src[i++];
      }
      i++;
      tokens.push(val);
    } else {
      let val = '';
      while (i < src.length && src[i] !== ' ' && src[i] !== '\t') val += src[i++];
      tokens.push(val);
    }
  }
  return tokens;
}

document.getElementById('curl-parse').addEventListener('click', () => {
  const raw = document.getElementById('curl-input').value.trim();
  if (!raw) return;

  const result = parseCurl(raw);
  document.getElementById('curl-method').textContent = result.method;
  document.getElementById('curl-url').textContent = result.url || '(URLが検出できませんでした)';

  const headersText = Object.entries(result.headers)
    .map(([k, v]) => `${k}: ${v}`).join('\n') || '(なし)';
  document.getElementById('curl-headers').textContent = headersText;

  const bodySection = document.getElementById('curl-body-section');
  if (result.body) {
    document.getElementById('curl-body').textContent = tryPrettyJson(result.body);
    bodySection.classList.remove('hidden');
  } else {
    bodySection.classList.add('hidden');
  }

  document.getElementById('curl-result').classList.remove('hidden');
});
