/**
 * 恩株管理ツール（NISA用）- フロントエンド
 */
'use strict';

// ─── API クライアント ──────────────────────────────────────────────────────────

const API = {
  async request(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'APIエラーが発生しました');
    return data;
  },
  get:    path        => API.request('GET',    path),
  post:   (path, b)   => API.request('POST',   path, b),
  put:    (path, b)   => API.request('PUT',    path, b),
  delete: path        => API.request('DELETE', path),
};

// ─── スクレイピングキャッシュ（localStorage・30分 TTL）───────────────────────

const Cache = {
  TTL: 30 * 60 * 1000,
  key: code => `onkabu:stock:${code}`,
  get(code) {
    try {
      const raw = localStorage.getItem(this.key(code));
      if (!raw) return null;
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts > this.TTL) { localStorage.removeItem(this.key(code)); return null; }
      return data;
    } catch { return null; }
  },
  set(code, data) {
    try { localStorage.setItem(this.key(code), JSON.stringify({ data, ts: Date.now() })); } catch {}
  },
  clear(code) { localStorage.removeItem(this.key(code)); },
};

const TAX_RATE = 0.20315;

// ─── フォーマットヘルパー ─────────────────────────────────────────────────────

const fmt     = (n, d = 0) => (n == null || isNaN(n)) ? '—'
                : n.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtYen  = n => (n == null || isNaN(n)) ? '—' : `¥${fmt(n)}`;
const fmtPct  = n => (n == null || isNaN(n)) ? '—' : `${(+n).toFixed(2)}%`;
const signCls = n => (n == null || isNaN(n)) ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '';

function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  return Math.floor((d - today) / 86400000);
}
function fmtDaysLeft(days) {
  if (days < 0) return '期限切れ';
  if (days === 0) return '今日まで';
  return `残り${days}日`;
}
function expiryRowCls(days) {
  if (days < 0) return 'expiry-expired';
  if (days <= 7) return 'expiry-danger';
  if (days <= 30) return 'expiry-warn';
  return '';
}
function daysCls(days) {
  if (days < 0) return 'days-left-expired';
  if (days <= 7) return 'days-left-danger';
  if (days <= 30) return 'days-left-warn';
  return '';
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
const loadingSpan = () => '<span class="cell-loading">読込中</span>';
const errSpan     = () => '<span class="cell-error">取得失敗</span>';

function nameHtml(code, s, isLoad, hasErr) {
  if (isLoad) return loadingSpan();
  if (hasErr) return errSpan();
  const yahooUrl     = `https://finance.yahoo.co.jp/quote/${code}.T`;
  const incentiveUrl = `${yahooUrl}/incentive`;
  return `<a class="company-link" href="${yahooUrl}" target="_blank" rel="noopener">${escHtml(s?.companyName || code)}</a>` +
         `<a class="incentive-link" href="${incentiveUrl}" target="_blank" rel="noopener" title="株主優待">優待</a>`;
}

// ─── 計算：購入検討 ───────────────────────────────────────────────────────────

function calculate(stock, scraped) {
  const t = stock.target_shares  | 0;
  const o = stock.on_kabu_shares | 0;
  const p = scraped?.closingPrice    ?? null;
  const d = scraped?.dividendPerShare ?? null;

  // 現在保有：複数口座対応
  const lots = getLots(stock);
  const c = lots.reduce((s, l) => s + (l.current_shares | 0), 0);
  const currentCost = lots.reduce((s, l) => s + (l.current_shares | 0) * (+(l.avg_acquisition_price) || 0), 0);
  const a = c > 0 ? currentCost / c : 0;

  const purchaseCount    = t - c;
  const currentAcq       = c * a;
  const totalAcq         = currentAcq + purchaseCount * (p ?? 0);
  const sellCount        = t - o;
  const onKabuPrice      = sellCount > 0 ? totalAcq / sellCount : null;
  const purchaseAmt      = purchaseCount * (p ?? 0);
  const purchaseAfterAvg = t > 0 ? totalAcq / t : null;
  // 非NISA比率の計算：現在保有ロット + 新規購入口座設定
  const nonNisaLots   = lots.filter(l => (l.is_nisa ?? 1) === 0);
  const nonNisaShares = nonNisaLots.reduce((s, l) => s + (l.current_shares | 0), 0);
  const nonNisaCost   = nonNisaLots.reduce((s, l) => s + (l.current_shares | 0) * (+(l.avg_acquisition_price) || 0), 0);

  const purchaseIsNisa   = (stock.purchase_nisa ?? 1) !== 0;
  const newPurchaseNonNisa = purchaseIsNisa ? 0 : purchaseCount;
  const combinedNonNisaShares = nonNisaShares + newPurchaseNonNisa;
  const combinedNonNisaCost   = nonNisaCost   + newPurchaseNonNisa * (p ?? 0);
  const combinedNonNisaAvg    = combinedNonNisaShares > 0 ? combinedNonNisaCost / combinedNonNisaShares : 0;
  const combinedNonNisaFrac   = t > 0 ? combinedNonNisaShares / t : 0;

  let onKabuDiff;
  if (combinedNonNisaFrac > 0 && onKabuPrice != null && sellCount > 0) {
    const mixedBE = (onKabuPrice - combinedNonNisaFrac * combinedNonNisaAvg * TAX_RATE) / (1 - combinedNonNisaFrac * TAX_RATE);
    onKabuDiff = p != null ? p - mixedBE : null;
  } else {
    onKabuDiff = (p != null && onKabuPrice != null) ? p - onKabuPrice : null;
  }
  const dividendAmt      = d != null ? t * d : null;
  const currentAmt       = p != null ? p * c : null;
  const profitLoss       = currentAmt != null ? currentAmt - currentAcq : null;
  const currentSellAmt   = purchaseAfterAvg != null ? sellCount * purchaseAfterAvg : null;

  return { purchaseCount, purchaseAmt, onKabuPrice, onKabuDiff, dividendAmt,
           currentAmt, profitLoss, sellCount, totalAcq, currentAcq,
           purchaseAfterAvg, currentSellAmt };
}

// ─── 計算：恩株待ち ───────────────────────────────────────────────────────────

function getLots(stock) {
  if (stock?.lots) {
    try {
      const parsed = typeof stock.lots === 'string' ? JSON.parse(stock.lots) : stock.lots;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  if ((stock?.current_shares | 0) > 0) {
    return [{ current_shares: stock.current_shares | 0,
              avg_acquisition_price: +(stock.avg_acquisition_price) || 0,
              is_nisa: stock.is_nisa ?? 1 }];
  }
  return [];
}

function createLotRow(lot = {}) {
  const isNisa = (lot.is_nisa ?? 1) !== 0;
  const div = document.createElement('div');
  div.className = 'lot-row';
  div.innerHTML = `
    <button type="button" class="lot-nisa-chip" data-nisa="${isNisa ? 1 : 0}">${isNisa ? 'NISA' : '非NISA'}</button>
    <input type="number" class="lot-shares-input" placeholder="保有数" min="0" step="100" value="${lot.current_shares || ''}">
    <span class="lot-unit">株</span>
    <input type="number" class="lot-avg-input" placeholder="均価" min="0" step="0.01" value="${lot.avg_acquisition_price || ''}">
    <span class="lot-unit">円</span>
    <button type="button" class="btn-icon danger lot-remove-btn" title="削除">−</button>`;
  div.querySelector('.lot-nisa-chip').addEventListener('click', function() {
    const next = parseInt(this.dataset.nisa) === 1 ? 0 : 1;
    this.dataset.nisa = next;
    this.textContent = next === 1 ? 'NISA' : '非NISA';
  });
  div.querySelector('.lot-remove-btn').addEventListener('click', () => {
    if (div.parentElement.querySelectorAll('.lot-row').length > 1) div.remove();
    else { div.querySelector('.lot-shares-input').value = ''; div.querySelector('.lot-avg-input').value = ''; }
  });
  return div;
}

function collectLots(containerId) {
  return Array.from($(containerId).querySelectorAll('.lot-row')).map(row => ({
    current_shares:        parseInt(row.querySelector('.lot-shares-input').value) || 0,
    avg_acquisition_price: parseFloat(row.querySelector('.lot-avg-input').value) || 0,
    is_nisa:               parseInt(row.querySelector('.lot-nisa-chip').dataset.nisa),
  })).filter(l => l.current_shares > 0);
}

function calculateWaiting(stock, scraped) {
  const lots = getLots(stock);
  const o = stock.on_kabu_shares | 0;
  const p = scraped?.closingPrice    ?? null;
  const d = scraped?.dividendPerShare ?? null;

  // 全口座を集計
  const totalShares = lots.reduce((s, l) => s + (l.current_shares | 0), 0);
  const totalCost   = lots.reduce((s, l) => s + (l.current_shares | 0) * (+(l.avg_acquisition_price) || 0), 0);
  const weightedAvg = totalShares > 0 ? totalCost / totalShares : 0;

  // 非NISA口座を集計
  const nonNisaLots   = lots.filter(l => (l.is_nisa ?? 1) === 0);
  const nonNisaShares = nonNisaLots.reduce((s, l) => s + (l.current_shares | 0), 0);
  const nonNisaCost   = nonNisaLots.reduce((s, l) => s + (l.current_shares | 0) * (+(l.avg_acquisition_price) || 0), 0);
  const nonNisaAvg    = nonNisaShares > 0 ? nonNisaCost / nonNisaShares : 0;
  const nonNisaFrac   = totalShares > 0 ? nonNisaShares / totalShares : 0;

  const sellCount = totalShares - o;
  const sellPrice = sellCount > 0 ? totalCost / sellCount : null;
  const sellAmt   = totalCost;

  const currentAmt = p != null ? p * totalShares : null;
  const profitLoss = currentAmt != null ? currentAmt - totalCost : null;
  const currentDiv = d != null ? totalShares * d : null;
  const afterDiv   = d != null ? o * d : null;

  const currentSellRaw = p != null ? sellCount * p : null;
  const onKabuDiffRaw  = (p != null && sellPrice != null) ? p - sellPrice : null;

  // 非NISA比率に応じて税を按分（比例売却を仮定）
  // 混合損益分岐点: p_b = (nisaBE − nonNisaFrac × nonNisaAvg × TAX) / (1 − nonNisaFrac × TAX)
  let currentSell = currentSellRaw;
  let onKabuDiff  = onKabuDiffRaw;
  if (nonNisaFrac > 0 && p != null && sellCount > 0 && nonNisaAvg > 0) {
    const nonNisaSellProceeds = (currentSellRaw || 0) * nonNisaFrac;
    const nonNisaSellCost     = sellCount * nonNisaFrac * nonNisaAvg;
    const profit = Math.max(0, nonNisaSellProceeds - nonNisaSellCost);
    currentSell = (currentSellRaw || 0) - profit * TAX_RATE;
    const mixedBE = (sellPrice - nonNisaFrac * nonNisaAvg * TAX_RATE) / (1 - nonNisaFrac * TAX_RATE);
    onKabuDiff = p - mixedBE;
  }

  return { totalShares, weightedAvg, nonNisaFrac, lots,
           currentAcq: totalCost, sellCount, sellPrice, sellAmt, onKabuDiff,
           currentAmt, profitLoss, currentSell, currentDiv, afterDiv };
}

// ─── アプリ状態 ───────────────────────────────────────────────────────────────

let currentSection  = 'onkabu';   // 'onkabu' | 'yuutai'
let currentTab      = 'purchase';
let currentOnkabuTab = 'purchase';
let stocks          = [];
let waitingStocks   = [];
let achievedStocks  = [];
let benefits        = [];
let scraped         = {};
const loading       = new Set();
let drawerContext   = null;

// ─── DOM 参照 ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ─── タブ切り替え ──────────────────────────────────────────────────────────────

function switchSection(section) {
  currentSection = section;

  // ボトムナビ active 更新
  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });

  const tabNav = $('tabNav');
  const subBar = document.querySelector('.sub-bar');
  const addBtn = $('addBtn');

  if (section === 'onkabu') {
    tabNav.classList.remove('hidden');
    subBar.classList.remove('hidden');
    addBtn.querySelector('.label').textContent = '銘柄追加';
    // セクション内のタブだけ表示
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('hidden', b.dataset.section !== 'onkabu');
    });
    // 最後に使っていたタブに戻す
    switchTab(currentOnkabuTab);
  } else {
    tabNav.classList.add('hidden');
    subBar.classList.add('hidden');
    addBtn.querySelector('.label').textContent = '優待追加';
    currentTab = 'benefit';
    $('tab-purchase').classList.add('hidden');
    $('tab-waiting').classList.add('hidden');
    $('tab-achieved').classList.add('hidden');
    $('tab-benefit').classList.remove('hidden');
  }
}

function switchTab(tab) {
  currentTab = tab;
  if (document.querySelector(`.tab-btn[data-section="onkabu"]`)) {
    currentOnkabuTab = tab;
  }
  document.querySelectorAll('.tab-btn[data-section="onkabu"]').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  $('tab-purchase').classList.toggle('hidden', tab !== 'purchase');
  $('tab-waiting').classList.toggle('hidden',  tab !== 'waiting');
  $('tab-achieved').classList.toggle('hidden', tab !== 'achieved');
  $('tab-benefit').classList.add('hidden');
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.section === 'onkabu') switchTab(btn.dataset.tab);
  });
});

document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchSection(btn.dataset.section));
});

// ─── スクレイピングデータ取得 ─────────────────────────────────────────────────

async function fetchScraped(code, force = false) {
  if (!force) {
    const cached = Cache.get(code);
    if (cached) { scraped[code] = cached; renderBoth(); return; }
  }
  loading.add(code);
  renderBoth();
  try {
    const data = await API.get(`/stock-data/${code}`);
    scraped[code] = data;
    Cache.set(code, data);
    $('lastUpdated').textContent = `最終更新: ${new Date().toLocaleTimeString('ja-JP')}`;
  } catch (e) {
    scraped[code] = { error: e.message };
  } finally {
    loading.delete(code);
    renderBoth();
  }
}

function renderBoth() { renderPurchase(); renderWaiting(); renderAchieved(); renderBenefits(); }

// ─── ドロワーアクションボタン生成 ─────────────────────────────────────────────

function buildDrawerActions(type) {
  const edit    = `<button class="btn-drawer-action da-edit">✏️ 編集</button>`;
  const ref     = `<button class="btn-drawer-action da-ref">↻ 更新</button>`;
  const del     = `<button class="btn-drawer-action danger da-del">🗑️ 削除</button>`;
  const toWait  = `<button class="btn-drawer-action move da-move">↗ 恩株待ちへ移行</button>`;
  const toAchieve = `<button class="btn-drawer-action move da-achieve">🎯 恩株化へ移行</button>`;
  if (type === 'purchase') {
    return `<div class="drawer-action-grid">${edit}${toWait}${ref}${del}</div>`;
  }
  if (type === 'waiting') {
    return `<div class="drawer-action-grid">${edit}${toAchieve}${ref}${del}</div>`;
  }
  if (type === 'benefit') {
    return `<div class="drawer-action-grid">${edit}<div class="drawer-action-span2">${del}</div></div>`;
  }
  return `<div class="drawer-action-grid">${edit}${ref}<div class="drawer-action-span2">${del}</div></div>`;
}

// ─── 購入検討 描画 ────────────────────────────────────────────────────────────

function renderPurchase() {
  const tbody = $('tableBody');
  tbody.innerHTML = '';
  if (stocks.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="14"><span class="empty-icon">📋</span>銘柄が登録されていません。</td></tr>`;
    return;
  }
  for (const stock of stocks) {
    const s  = scraped[stock.code];
    const cv = calculate(stock, s);
    const isLoad = loading.has(stock.code);
    const hasErr = !!s?.error;
    const tr = document.createElement('tr');
    tr.dataset.id = stock.id; tr.dataset.code = stock.code;
    tr.innerHTML = `
      <td class="code-cell"><span class="code-badge">${stock.code}</span></td>
      <td class="name-cell"><span class="company-name">${nameHtml(stock.code, s, isLoad, hasErr)}</span></td>
      <td class="num-cell ${signCls(cv.onKabuDiff)}">${fmtYen(cv.onKabuDiff)}</td>
      <td class="num-cell">${fmtYen(cv.purchaseAmt)}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtYen(s?.closingPrice))}</td>
      <td class="num-cell">${fmt(cv.purchaseCount)}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtYen(cv.dividendAmt))}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtPct(s?.yieldValue))}</td>
      <td class="num-cell desktop-only input-col">${fmt(stock.target_shares)}</td>
      <td class="num-cell desktop-only input-col">${fmt(stock.on_kabu_shares)}</td>
      <td class="num-cell desktop-only input-col">${fmt(stock.current_shares)}</td>
      <td class="num-cell desktop-only input-col">${stock.current_shares > 0 ? fmtYen(stock.avg_acquisition_price) : '—'}</td>
      <td class="num-cell ${signCls(cv.profitLoss)}">${fmtYen(cv.profitLoss)}</td>
      <td class="action-cell"><button class="btn-icon action-open-btn" data-id="${stock.id}" data-code="${stock.code}" title="操作">⋮</button></td>`;
    tbody.appendChild(tr);
  }
}

// ─── 恩株待ち 描画 ────────────────────────────────────────────────────────────

function renderWaiting() {
  const tbody = $('waitingTableBody');
  tbody.innerHTML = '';
  if (waitingStocks.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="15"><span class="empty-icon">📋</span>銘柄が登録されていません。</td></tr>`;
    return;
  }
  for (const stock of waitingStocks) {
    const s  = scraped[stock.code];
    const cv = calculateWaiting(stock, s);
    const isLoad = loading.has(stock.code);
    const hasErr = !!s?.error;
    const tr = document.createElement('tr');
    tr.dataset.wid = stock.id; tr.dataset.code = stock.code;
    tr.innerHTML = `
      <td class="code-cell"><span class="code-badge">${stock.code}</span></td>
      <td class="name-cell"><span class="company-name">${nameHtml(stock.code, s, isLoad, hasErr)}</span></td>
      <td class="num-cell ${signCls(cv.onKabuDiff)}">${fmtYen(cv.onKabuDiff)}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtYen(s?.closingPrice))}</td>
      <td class="num-cell">${fmtYen(cv.sellPrice)}</td>
      <td class="num-cell">${fmtYen(cv.currentSell)}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtYen(cv.currentDiv))}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtYen(cv.afterDiv))}</td>
      <td class="num-cell ${signCls(cv.profitLoss)}">${fmtYen(cv.profitLoss)}</td>
      <td class="num-cell desktop-only">${fmtYen(cv.sellAmt)}</td>
      <td class="num-cell desktop-only">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtPct(s?.yieldValue))}</td>
      <td class="num-cell desktop-only input-col">${fmt(cv.totalShares)}</td>
      <td class="num-cell desktop-only input-col">${fmt(stock.on_kabu_shares)}</td>
      <td class="num-cell desktop-only input-col">${fmtYen(cv.weightedAvg)}</td>
      <td class="action-cell"><button class="btn-icon action-open-btn" data-wid="${stock.id}" data-code="${stock.code}" title="操作">⋮</button></td>`;
    tbody.appendChild(tr);
  }
}

// ─── 恩株化 描画 ──────────────────────────────────────────────────────────────

function renderAchieved() {
  const tbody = $('achievedTableBody');
  tbody.innerHTML = '';

  const anyLoading = achievedStocks.some(s => loading.has(s.code));
  const totalAssets = achievedStocks.reduce((sum, s) => {
    const p = scraped[s.code]?.closingPrice;
    if (p == null) return sum;
    const taxMult = (s.is_nisa ?? 1) === 0 ? (1 - TAX_RATE) : 1;
    return sum + p * s.current_shares * taxMult;
  }, 0);
  const totalDiv = achievedStocks.reduce((sum, s) => {
    const d = scraped[s.code]?.dividendPerShare;
    if (d == null) return sum;
    const taxMult = (s.is_nisa ?? 1) === 0 ? (1 - TAX_RATE) : 1;
    return sum + d * s.current_shares * taxMult;
  }, 0);
  const placeholder = achievedStocks.length === 0 ? '—' : anyLoading ? '読込中…' : null;
  $('achievedTotalAssets').textContent = placeholder ?? fmtYen(totalAssets);
  $('achievedTotalDiv').textContent    = placeholder ?? fmtYen(totalDiv);

  if (achievedStocks.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8"><span class="empty-icon">📋</span>銘柄が登録されていません。</td></tr>`;
    return;
  }
  for (const stock of achievedStocks) {
    const s      = scraped[stock.code];
    const isLoad = loading.has(stock.code);
    const hasErr = !!s?.error;
    const p = s?.closingPrice ?? null;
    const d = s?.dividendPerShare ?? null;
    const taxMult = (stock.is_nisa ?? 1) === 0 ? (1 - TAX_RATE) : 1;
    const currentValue = p != null ? p * stock.current_shares * taxMult : null;
    const currentDiv   = d != null ? d * stock.current_shares * taxMult : null;
    const tr = document.createElement('tr');
    tr.dataset.aid  = stock.id;
    tr.dataset.code = stock.code;
    tr.innerHTML = `
      <td class="code-cell"><span class="code-badge">${stock.code}</span></td>
      <td class="name-cell"><span class="company-name">${nameHtml(stock.code, s, isLoad, hasErr)}</span></td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtYen(currentValue))}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtYen(currentDiv))}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtYen(p))}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : fmtPct(s?.yieldValue))}</td>
      <td class="num-cell">${isLoad ? loadingSpan() : (hasErr ? errSpan() : (d != null ? fmtYen(d) : '—'))}</td>
      <td class="action-cell"><button class="btn-icon action-open-btn" data-aid="${stock.id}" data-code="${stock.code}" title="操作">⋮</button></td>`;
    tbody.appendChild(tr);
  }
}

// ─── データ読み込み ───────────────────────────────────────────────────────────

async function loadAll() {
  [stocks, waitingStocks, achievedStocks, benefits] = await Promise.all([
    API.get('/stocks'),
    API.get('/waiting-stocks'),
    API.get('/achieved-stocks'),
    API.get('/benefits'),
  ]);
  renderBoth();
  const allCodes = [...new Set([
    ...stocks.map(s => s.code),
    ...waitingStocks.map(s => s.code),
    ...achievedStocks.map(s => s.code),
  ])];
  for (const code of allCodes) fetchScraped(code);
}

// ─── 購入検討 モーダル ────────────────────────────────────────────────────────

let editingId = null;
const modal        = $('modal');
const stockForm    = $('stockForm');
const calcPreview  = $('calcPreview');
const calcGrid     = $('calcPreviewGrid');

function openModal(stock = null) {
  editingId = stock?.id ?? null;
  $('modalTitle').textContent = stock ? '銘柄編集' : '銘柄追加';
  $('fieldId').value          = stock?.id ?? '';
  $('fieldCode').value        = stock?.code ?? '';
  $('fieldCode').disabled     = !!stock;
  $('fieldTarget').value      = stock?.target_shares ?? '';
  $('fieldOnKabu').value      = stock?.on_kabu_shares ?? '';
  const lots = getLots(stock);
  const pc = $('pLotsContainer');
  pc.innerHTML = '';
  (lots.length > 0 ? lots : []).forEach(l => pc.appendChild(createLotRow(l)));
  const pnBtn = $('pPurchaseNisaBtn');
  const pIsNisa = (stock?.purchase_nisa ?? 1) !== 0;
  pnBtn.dataset.nisa = pIsNisa ? 1 : 0;
  pnBtn.textContent  = pIsNisa ? 'NISA' : '非NISA';
  modal.classList.add('open');
  setTimeout(() => $('fieldCode').focus(), 50);
}
function closeModal() {
  modal.classList.remove('open');
  $('fieldId').value = ''; $('fieldCode').value = '';
  $('fieldTarget').value = ''; $('fieldOnKabu').value = '';
  $('pLotsContainer').innerHTML = '';
  editingId = null;
  calcPreview.classList.add('preview-hidden');
}
function updateCalcPreview() {
  const code = $('fieldCode').value.trim();
  const t = parseInt($('fieldTarget').value) || 0;
  const o = parseInt($('fieldOnKabu').value) || 0;
  const lots = collectLots('pLotsContainer');
  const purchase_nisa = parseInt($('pPurchaseNisaBtn').dataset.nisa);
  const cv = calculate({ target_shares: t, on_kabu_shares: o, lots, purchase_nisa }, scraped[code] ?? null);
  calcGrid.innerHTML = [
    { label: '購入数',   value: fmt(cv.purchaseCount) + '株' },
    { label: '売却数',   value: fmt(cv.sellCount) + '株' },
    { label: '恩株売値', value: fmtYen(cv.onKabuPrice) },
    { label: '恩株差',   value: fmtYen(cv.onKabuDiff), cls: signCls(cv.onKabuDiff) },
    { label: '購入額',   value: fmtYen(cv.purchaseAmt) },
    { label: '配当額',   value: fmtYen(cv.dividendAmt) },
  ].map(i => `<div class="preview-item"><span class="preview-label">${i.label}</span><span class="preview-value ${i.cls||''}">${i.value}</span></div>`).join('');
  calcPreview.classList.toggle('preview-hidden', !t || !code);
}

// ─── 恩株待ち モーダル ────────────────────────────────────────────────────────

let editingWId = null;
let movingFromStockId = null;
const waitingModal = $('waitingModal');
const waitingForm  = $('waitingForm');

function openWaitingModal(stock = null, forMove = false) {
  editingWId = stock?.id ?? null;
  movingFromStockId = null;
  $('waitingModalTitle').textContent = forMove ? '恩株待ちに移行'
    : (stock?.id ? '恩株待ち 編集' : '恩株待ち 銘柄追加');
  $('wFieldId').value      = stock?.id ?? '';
  $('wFieldCode').value    = stock?.code ?? '';
  $('wFieldCode').disabled = !!(stock?.id || forMove);
  $('wFieldOnKabu').value  = stock?.on_kabu_shares ?? '';
  const lots = getLots(stock);
  const container = $('wLotsContainer');
  container.innerHTML = '';
  (lots.length > 0 ? lots : [{}]).forEach(l => container.appendChild(createLotRow(l)));
  waitingModal.classList.add('open');
  setTimeout(() => $('wFieldCode').focus(), 50);
}

async function moveToAchieved(stock) {
  const lots = getLots(stock);
  const hasNonNisa = lots.some(l => (l.is_nisa ?? 1) === 0);
  const is_nisa = hasNonNisa ? 0 : 1;
  try {
    await API.post('/achieved-stocks', { code: stock.code, current_shares: stock.on_kabu_shares, is_nisa });
    await API.delete(`/waiting-stocks/${stock.id}`);
    [waitingStocks, achievedStocks] = await Promise.all([
      API.get('/waiting-stocks'),
      API.get('/achieved-stocks'),
    ]);
    renderWaiting();
    renderAchieved();
  } catch (err) { alert(err.message); }
}

function moveToWaiting(stock) {
  const s = scraped[stock.code];
  const p = s?.closingPrice ?? null;
  const t = stock.target_shares | 0;
  const existingLots = getLots(stock);
  const c = existingLots.reduce((sum, l) => sum + (l.current_shares | 0), 0);
  const currentCost = existingLots.reduce((sum, l) => sum + (l.current_shares | 0) * (+(l.avg_acquisition_price) || 0), 0);
  const a = c > 0 ? currentCost / c : 0;
  const purchaseIsNisa = (stock.purchase_nisa ?? 1) !== 0;
  const newAvg = t > 0
    ? Math.round(((c * a + (t - c) * (p ?? a)) / t) * 10) / 10
    : a;
  const newPurchase = t - c;
  let moveLots;
  if (existingLots.length > 0 && newPurchase > 0) {
    moveLots = existingLots.map(l => ({ ...l }));
    const targetLot = moveLots.find(l => ((l.is_nisa ?? 1) !== 0) === purchaseIsNisa);
    if (targetLot) {
      targetLot.current_shares = (targetLot.current_shares | 0) + newPurchase;
    } else {
      moveLots.push({ current_shares: newPurchase, avg_acquisition_price: p ?? 0, is_nisa: purchaseIsNisa ? 1 : 0 });
    }
  } else {
    moveLots = [{ current_shares: t, avg_acquisition_price: newAvg, is_nisa: purchaseIsNisa ? 1 : 0 }];
  }
  openWaitingModal({
    code:           stock.code,
    on_kabu_shares: stock.on_kabu_shares,
    lots:           moveLots,
  }, true);
  movingFromStockId = stock.id;
}
function closeWaitingModal() {
  waitingModal.classList.remove('open');
  $('wFieldId').value = '';
  $('wFieldCode').value = '';
  $('wFieldOnKabu').value = '';
  $('wLotsContainer').innerHTML = '';
  editingWId = null;
  movingFromStockId = null;
}

// ─── 詳細ドロワー ──────────────────────────────────────────────────────────────

const detailDrawer  = $('detailDrawer');
const drawerOverlay = $('drawerOverlay');

function buildDrawer(sections) {
  return sections.map(sec => `
    <div class="drawer-section">
      <div class="drawer-section-title">${sec.title}</div>
      <div class="drawer-grid">
        ${sec.rows.map(r => `<div class="drawer-item">
          <span class="drawer-label">${r.label}</span>
          <span class="drawer-value ${r.cls||''}">${r.value}</span>
        </div>`).join('')}
      </div>
    </div>`).join('');
}

function openDrawer(code) {
  const stock = stocks.find(s => s.code === code);
  if (!stock) return;
  const s = scraped[code];
  const cv = calculate(stock, s);
  $('drawerTitle').textContent = `${code} ${s?.companyName || ''}`;
  $('drawerBody').innerHTML = buildDrawer([
    { title: '市場データ', rows: [
      { label: '終値',     value: fmtYen(s?.closingPrice) },
      { label: '利回り',   value: fmtPct(s?.yieldValue) },
      { label: '配当予想', value: s?.dividendPerShare != null ? `¥${fmt(s.dividendPerShare)}` : '—' },
    ]},
    { title: 'インプット', rows: (() => {
        const currentLots = getLots(stock);
        const totalC = currentLots.reduce((s,l) => s + (l.current_shares|0), 0);
        const rows = [
          { label: '目標保有数', value: fmt(stock.target_shares) + '株' },
          { label: '恩株数',     value: fmt(stock.on_kabu_shares) + '株' },
          { label: '現在保有数', value: fmt(totalC) + '株' },
        ];
        if (totalC > 0) rows.push({ label: '加重平均', value: fmtYen(cv.currentAcq / totalC) });
        return rows;
      })()
    },
    { title: '購入計画', rows: [
      { label: '購入数',         value: fmt(cv.purchaseCount) + '株' },
      { label: '購入額',         value: fmtYen(cv.purchaseAmt) },
      { label: '取得金額',       value: fmtYen(cv.totalAcq) },
      { label: '購入後取得平均', value: fmtYen(cv.purchaseAfterAvg) },
      { label: '配当額',         value: fmtYen(cv.dividendAmt) },
    ]},
    { title: '恩株化', rows: [
      { label: '売却数',     value: fmt(cv.sellCount) + '株' },
      { label: '恩株売値',   value: fmtYen(cv.onKabuPrice) },
      { label: '現在売却額', value: fmtYen(cv.currentSellAmt) },
      { label: '恩株差',     value: fmtYen(cv.onKabuDiff), cls: signCls(cv.onKabuDiff) },
    ]},
    { title: '現在保有', rows: [
      { label: '現在金額',     value: fmtYen(cv.currentAmt) },
      { label: '現在取得金額', value: fmtYen(cv.currentAcq) },
      { label: '現在損益',     value: fmtYen(cv.profitLoss), cls: signCls(cv.profitLoss) },
    ]},
  ]);
  drawerContext = { type: 'purchase', id: stock.id, code };
  $('drawerActions').innerHTML = buildDrawerActions('purchase');
  drawerOverlay.classList.add('open');
  detailDrawer.classList.add('open');
}

function openWaitingDrawer(code) {
  const stock = waitingStocks.find(s => s.code === code);
  if (!stock) return;
  const s = scraped[code];
  const cv = calculateWaiting(stock, s);
  $('drawerTitle').textContent = `${code} ${s?.companyName || ''}（恩株待ち）`;
  $('drawerBody').innerHTML = buildDrawer([
    { title: '市場データ', rows: [
      { label: '終値',     value: fmtYen(s?.closingPrice) },
      { label: '利回り',   value: fmtPct(s?.yieldValue) },
      { label: '配当予想', value: s?.dividendPerShare != null ? `¥${fmt(s.dividendPerShare)}` : '—' },
    ]},
    { title: '保有口座', rows: [
      { label: '合計保有数', value: fmt(cv.totalShares) + '株' },
      { label: '恩株数',     value: fmt(stock.on_kabu_shares) + '株' },
      { label: '加重平均',   value: fmtYen(cv.weightedAvg) },
      { label: '非NISA比率', value: cv.nonNisaFrac > 0 ? fmtPct(cv.nonNisaFrac * 100) : '全NISA' },
    ]},
    { title: '恩株化', rows: [
      { label: '売数',   value: fmt(cv.sellCount) + '株' },
      { label: '売値',   value: fmtYen(cv.sellPrice) },
      { label: '売値額', value: fmtYen(cv.sellAmt) },
      { label: '恩株差', value: fmtYen(cv.onKabuDiff), cls: signCls(cv.onKabuDiff) },
      { label: '現売値', value: fmtYen(cv.currentSell) },
    ]},
    { title: '配当', rows: [
      { label: '現配当（全株）',   value: fmtYen(cv.currentDiv) },
      { label: '後配当（恩株後）', value: fmtYen(cv.afterDiv) },
    ]},
    { title: '現在保有', rows: [
      { label: '現在金額',     value: fmtYen(cv.currentAmt) },
      { label: '現在取得金額', value: fmtYen(cv.currentAcq) },
      { label: '現在損益',     value: fmtYen(cv.profitLoss), cls: signCls(cv.profitLoss) },
    ]},
  ]);
  drawerContext = { type: 'waiting', id: stock.id, code };
  $('drawerActions').innerHTML = buildDrawerActions('waiting');
  drawerOverlay.classList.add('open');
  detailDrawer.classList.add('open');
}

function openAchievedDrawer(code) {
  const stock = achievedStocks.find(s => s.code === code);
  if (!stock) return;
  const s = scraped[code];
  const isLoad = loading.has(code);
  const hasErr = !!s?.error;
  const p = s?.closingPrice ?? null;
  const d = s?.dividendPerShare ?? null;
  const isNisaStock = (stock.is_nisa ?? 1) !== 0;
  const taxMult = isNisaStock ? 1 : (1 - TAX_RATE);
  const currentValue    = p != null ? p * stock.current_shares * taxMult : null;
  const currentValueRaw = p != null ? p * stock.current_shares : null;
  const currentDiv      = d != null ? d * stock.current_shares * taxMult : null;
  $('drawerTitle').textContent = `${code} ${s?.companyName || ''}（恩株化）`;
  $('drawerBody').innerHTML = buildDrawer([
    { title: '市場データ', rows: [
      { label: '終値',     value: isLoad ? '読込中' : (hasErr ? '—' : fmtYen(p)) },
      { label: '利回り',   value: isLoad ? '読込中' : (hasErr ? '—' : fmtPct(s?.yieldValue)) },
      { label: '配当予想', value: isLoad ? '読込中' : (hasErr ? '—' : (d != null ? fmtYen(d) : '—')) },
    ]},
    { title: '保有情報', rows: [
      { label: '口座種別',   value: isNisaStock ? 'NISA' : '非NISA' },
      { label: '保有数',     value: fmt(stock.current_shares) + '株' },
      { label: isNisaStock ? '現在評価額' : '現在評価額(税引後)', value: isLoad ? '読込中' : fmtYen(currentValue) },
      ...(!isNisaStock ? [{ label: '現在評価額(税引前)', value: isLoad ? '読込中' : fmtYen(currentValueRaw) }] : []),
      { label: isNisaStock ? '年間配当' : '年間配当(税引後)', value: isLoad ? '読込中' : fmtYen(currentDiv) },
    ]},
  ]);
  drawerContext = { type: 'achieved', id: stock.id, code };
  $('drawerActions').innerHTML = buildDrawerActions('achieved');
  drawerOverlay.classList.add('open');
  detailDrawer.classList.add('open');
}

function closeDrawer() {
  drawerOverlay.classList.remove('open');
  detailDrawer.classList.remove('open');
  drawerContext = null;
}

// ─── イベントリスナー ──────────────────────────────────────────────────────────

$('addBtn').addEventListener('click', () => {
  if (currentSection === 'yuutai') { openBenefitModal(); return; }
  if (currentTab === 'purchase') openModal();
  else if (currentTab === 'waiting') openWaitingModal();
  else openAchievedModal();
});
$('refreshAllBtn').addEventListener('click', () => {
  if (currentSection === 'yuutai') return;
  const targets = currentTab === 'purchase' ? stocks
    : currentTab === 'waiting' ? waitingStocks
    : achievedStocks;
  for (const s of targets) { Cache.clear(s.code); fetchScraped(s.code, true); }
});

// 購入検討 モーダル
$('cancelBtn').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
['fieldTarget','fieldOnKabu','fieldCode'].forEach(id => $(id).addEventListener('input', updateCalcPreview));
$('pLotsContainer').addEventListener('input', updateCalcPreview);
$('pPurchaseNisaBtn').addEventListener('click', function() {
  const next = parseInt(this.dataset.nisa) === 1 ? 0 : 1;
  this.dataset.nisa = next;
  this.textContent  = next === 1 ? 'NISA' : '非NISA';
  updateCalcPreview();
});
$('pAddLotBtn').addEventListener('click', () => {
  $('pLotsContainer').appendChild(createLotRow());
  updateCalcPreview();
});

stockForm.addEventListener('submit', async e => {
  e.preventDefault();
  const code   = $('fieldCode').value.trim();
  const target = parseInt($('fieldTarget').value);
  const onKabu = parseInt($('fieldOnKabu').value);
  const lots         = collectLots('pLotsContainer');
  const purchase_nisa = parseInt($('pPurchaseNisaBtn').dataset.nisa);
  if (!editingId && !/^\d{4}$/.test(code)) { alert('証券コードは4桁の数字で入力してください'); return; }
  if (onKabu >= target) { alert('恩株数は目標保有数より小さくしてください'); return; }
  const btn = $('saveBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    if (editingId) await API.put(`/stocks/${editingId}`, { target_shares: target, on_kabu_shares: onKabu, lots, purchase_nisa });
    else           await API.post('/stocks', { code, target_shares: target, on_kabu_shares: onKabu, lots, purchase_nisa });
    closeModal();
    stocks = await API.get('/stocks');
    renderPurchase();
    fetchScraped(code);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = '保存'; }
});

// 購入検討 テーブルボタン
$('tableBody').addEventListener('click', e => {
  const btn = e.target.closest('.action-open-btn');
  if (btn) openDrawer(btn.dataset.code);
});

// 恩株待ち 口座追加ボタン
$('wAddLotBtn').addEventListener('click', () => {
  $('wLotsContainer').appendChild(createLotRow());
});

// 恩株待ち モーダル
$('wCancelBtn').addEventListener('click', closeWaitingModal);
waitingModal.addEventListener('click', e => { if (e.target === waitingModal) closeWaitingModal(); });

waitingForm.addEventListener('submit', async e => {
  e.preventDefault();
  const code   = $('wFieldCode').value.trim();
  const onKabu = parseInt($('wFieldOnKabu').value);
  const lots   = collectLots('wLotsContainer');
  if (!editingWId && !/^\d{4}$/.test(code)) { alert('証券コードは4桁の数字で入力してください'); return; }
  if (lots.length === 0) { alert('保有口座を1つ以上入力してください'); return; }
  const totalShares = lots.reduce((s, l) => s + l.current_shares, 0);
  if (onKabu >= totalShares) { alert('恩株数は合計保有数より小さくしてください'); return; }
  const btn = $('wSaveBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    if (editingWId) await API.put(`/waiting-stocks/${editingWId}`, { on_kabu_shares: onKabu, lots });
    else            await API.post('/waiting-stocks', { code, on_kabu_shares: onKabu, lots });
    const fromId = movingFromStockId;
    closeWaitingModal();
    if (fromId) {
      await API.delete(`/stocks/${fromId}`);
      stocks = await API.get('/stocks');
      renderPurchase();
    }
    waitingStocks = await API.get('/waiting-stocks');
    renderWaiting();
    fetchScraped(code);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = '保存'; }
});

// 恩株待ち テーブルボタン
$('waitingTableBody').addEventListener('click', e => {
  const btn = e.target.closest('.action-open-btn');
  if (btn) openWaitingDrawer(btn.dataset.code);
});

// ─── 恩株化 モーダル ──────────────────────────────────────────────────────────

let editingAId = null;
const achievedModal = $('achievedModal');
const achievedForm  = $('achievedForm');

function openAchievedModal(stock = null) {
  editingAId = stock?.id ?? null;
  $('achievedModalTitle').textContent = stock ? '恩株化 編集' : '恩株化 銘柄追加';
  $('aFieldId').value      = stock?.id ?? '';
  $('aFieldCode').value    = stock?.code ?? '';
  $('aFieldCode').disabled = !!stock;
  $('aFieldShares').value  = stock?.current_shares ?? '';
  const isNisa = (stock?.is_nisa ?? 1) !== 0;
  const btn = $('aIsNisaBtn');
  btn.dataset.nisa = isNisa ? 1 : 0;
  btn.textContent  = isNisa ? 'NISA' : '非NISA';
  achievedModal.classList.add('open');
  setTimeout(() => $('aFieldCode').focus(), 50);
}
function closeAchievedModal() {
  achievedModal.classList.remove('open');
  achievedForm.reset();
  editingAId = null;
}

$('aIsNisaBtn').addEventListener('click', function() {
  const next = parseInt(this.dataset.nisa) === 1 ? 0 : 1;
  this.dataset.nisa = next;
  this.textContent  = next === 1 ? 'NISA' : '非NISA';
});
$('aCancelBtn').addEventListener('click', closeAchievedModal);
achievedModal.addEventListener('click', e => { if (e.target === achievedModal) closeAchievedModal(); });

achievedForm.addEventListener('submit', async e => {
  e.preventDefault();
  const code    = $('aFieldCode').value.trim();
  const shares  = parseInt($('aFieldShares').value);
  const is_nisa = parseInt($('aIsNisaBtn').dataset.nisa);
  if (!editingAId && !/^\d{4}$/.test(code)) { alert('証券コードは4桁の数字で入力してください'); return; }
  if (!shares || shares <= 0) { alert('保有数を入力してください'); return; }
  const btn = $('aSaveBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    if (editingAId) await API.put(`/achieved-stocks/${editingAId}`, { current_shares: shares, is_nisa });
    else            await API.post('/achieved-stocks', { code, current_shares: shares, is_nisa });
    closeAchievedModal();
    achievedStocks = await API.get('/achieved-stocks');
    renderAchieved();
    fetchScraped(code);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = '保存'; }
});

// 恩株化 テーブルボタン
$('achievedTableBody').addEventListener('click', e => {
  const btn = e.target.closest('.action-open-btn');
  if (btn) openAchievedDrawer(btn.dataset.code);
});

// ─── ドロワーアクション ────────────────────────────────────────────────────────

$('drawerActions').addEventListener('click', async e => {
  if (!drawerContext) return;
  const { type, id, code } = drawerContext;

  if (e.target.closest('.da-edit')) {
    closeDrawer();
    if (type === 'purchase')      { const s = stocks.find(x => x.id == id);         if (s) openModal(s); }
    else if (type === 'waiting')  { const s = waitingStocks.find(x => x.id == id);  if (s) openWaitingModal(s); }
    else if (type === 'benefit')  { const s = benefits.find(x => x.id == id);       if (s) openBenefitModal(s); }
    else                          { const s = achievedStocks.find(x => x.id == id); if (s) openAchievedModal(s); }
  } else if (e.target.closest('.da-move')) {
    closeDrawer();
    const s = stocks.find(x => x.id == id);
    if (s) moveToWaiting(s);
  } else if (e.target.closest('.da-achieve')) {
    closeDrawer();
    const s = waitingStocks.find(x => x.id == id);
    if (s) moveToAchieved(s);
  } else if (e.target.closest('.da-ref')) {
    closeDrawer();
    Cache.clear(code);
    fetchScraped(code, true);
  } else if (e.target.closest('.da-del')) {
    if (!confirm('この銘柄を削除しますか？')) return;
    closeDrawer();
    try {
      if (type === 'purchase') {
        await API.delete(`/stocks/${id}`);
        stocks = await API.get('/stocks');
        renderPurchase();
      } else if (type === 'waiting') {
        await API.delete(`/waiting-stocks/${id}`);
        waitingStocks = await API.get('/waiting-stocks');
        renderWaiting();
      } else if (type === 'benefit') {
        await API.delete(`/benefits/${id}`);
        benefits = await API.get('/benefits');
        renderBenefits();
      } else {
        await API.delete(`/achieved-stocks/${id}`);
        achievedStocks = await API.get('/achieved-stocks');
        renderAchieved();
      }
    } catch (err) { alert(err.message); }
  }
});

// ドロワー・キーボード
$('drawerClose').addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeWaitingModal(); closeAchievedModal(); closeBenefitModal(); closeDrawer(); }
});

// ─── 優待期限 描画 ────────────────────────────────────────────────────────────

function renderBenefits() {
  const tbody = $('benefitTableBody');
  tbody.innerHTML = '';
  if (benefits.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><span class="empty-icon">🎁</span>優待が登録されていません。</td></tr>`;
    return;
  }
  for (const b of benefits) {
    const days = daysUntil(b.expires_at);
    const rowCls = expiryRowCls(days);
    const dCls   = daysCls(days);
    const tr = document.createElement('tr');
    if (rowCls) tr.className = rowCls;
    tr.dataset.bid  = b.id;
    tr.dataset.code = b.code;
    tr.innerHTML = `
      <td class="code-cell"><span class="code-badge">${escHtml(b.code)}</span></td>
      <td class="name-cell"><span class="company-name">${escHtml(b.company_name || b.code)}</span></td>
      <td class="code-cell desktop-only">${b.tag ? `<span class="tag-chip">${escHtml(b.tag)}</span>` : '—'}</td>
      <td class="memo-cell desktop-only">${escHtml(b.memo || '—')}</td>
      <td class="num-cell">${escHtml(b.expires_at)}</td>
      <td class="num-cell"><span class="${dCls}">${fmtDaysLeft(days)}</span></td>
      <td class="action-cell"><button class="btn-icon action-open-btn" data-bid="${b.id}" data-code="${b.code}" title="操作">⋮</button></td>`;
    tbody.appendChild(tr);
  }
}

// ─── 優待期限 モーダル ────────────────────────────────────────────────────────

let editingBId = null;
const benefitModal = $('benefitModal');
const benefitForm  = $('benefitForm');
let bFetchTimer    = null;

async function prefillBenefitTemplate(code) {
  try {
    const tmpl = await API.get(`/benefit-templates/${code}`);
    if (!tmpl) return;
    if (!$('bFieldMemo').value) $('bFieldMemo').value = tmpl.memo || '';
    if (!$('bFieldTag').value)  $('bFieldTag').value  = tmpl.tag  || '';
  } catch {}
}

function openBenefitModal(benefit = null) {
  editingBId = benefit?.id ?? null;
  $('benefitModalTitle').textContent = benefit ? '優待期限 編集' : '優待期限 追加';
  $('bFieldId').value      = benefit?.id ?? '';
  $('bFieldCode').value    = benefit?.code ?? '';
  $('bFieldCode').disabled = !!benefit;
  $('bFieldTag').value     = benefit?.tag ?? '';
  $('bFieldMemo').value    = benefit?.memo ?? '';
  $('bFieldExpires').value = benefit?.expires_at ?? '';
  $('bCompanyHint').textContent = benefit?.company_name ?? '';
  benefitModal.classList.add('open');
  setTimeout(() => $('bFieldCode').focus(), 50);
}
function closeBenefitModal() {
  benefitModal.classList.remove('open');
  benefitForm.reset();
  $('bCompanyHint').textContent = '';
  editingBId = null;
}

// コード入力 → 会社名プレビュー＋テンプレート自動入力
$('bFieldCode').addEventListener('input', function() {
  const code = this.value.trim();
  clearTimeout(bFetchTimer);
  if (!/^\d{4}$/.test(code)) { $('bCompanyHint').textContent = ''; return; }
  $('bCompanyHint').textContent = '取得中…';
  bFetchTimer = setTimeout(async () => {
    try {
      let name = scraped[code]?.companyName;
      if (!name) {
        const data = await API.get(`/stock-data/${code}`);
        name = data.companyName;
        scraped[code] = data;
        Cache.set(code, data);
      }
      $('bCompanyHint').textContent = name || '';
    } catch { $('bCompanyHint').textContent = ''; }
    if (!editingBId) await prefillBenefitTemplate(code);
  }, 600);
});

benefitForm.addEventListener('submit', async e => {
  e.preventDefault();
  const code      = $('bFieldCode').value.trim();
  const tag       = $('bFieldTag').value;
  const memo      = $('bFieldMemo').value.trim();
  const expires_at = $('bFieldExpires').value;
  const company_name = $('bCompanyHint').textContent || scraped[code]?.companyName || code;
  if (!editingBId && !/^\d{4}$/.test(code)) { alert('証券コードは4桁の数字で入力してください'); return; }
  if (!expires_at) { alert('有効期限を入力してください'); return; }
  const btn = $('bSaveBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    if (editingBId) {
      await API.put(`/benefits/${editingBId}`, { company_name, memo, tag, expires_at });
    } else {
      await API.post('/benefits', { code, company_name, memo, tag, expires_at });
    }
    closeBenefitModal();
    benefits = await API.get('/benefits');
    renderBenefits();
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = '保存'; }
});

$('bCancelBtn').addEventListener('click', closeBenefitModal);
benefitModal.addEventListener('click', e => { if (e.target === benefitModal) closeBenefitModal(); });

// ─── 優待期限 ドロワー ────────────────────────────────────────────────────────

function openBenefitDrawer(id) {
  const b = benefits.find(x => x.id == id);
  if (!b) return;
  const days = daysUntil(b.expires_at);
  $('drawerTitle').textContent = `${b.code} ${b.company_name || ''}（優待期限）`;
  $('drawerBody').innerHTML = buildDrawer([
    { title: '基本情報', rows: [
      { label: '証券コード', value: escHtml(b.code) },
      { label: '会社名',     value: escHtml(b.company_name || b.code) },
      { label: '種類',       value: b.tag ? `<span class="tag-chip">${escHtml(b.tag)}</span>` : '—' },
    ]},
    { title: '期限', rows: [
      { label: '有効期限', value: escHtml(b.expires_at) },
      { label: '残り日数', value: `<span class="${daysCls(days)}">${fmtDaysLeft(days)}</span>` },
    ]},
    ...(b.memo ? [{ title: '優待内容', rows: [{ label: 'メモ', value: escHtml(b.memo) }] }] : []),
  ]);
  drawerContext = { type: 'benefit', id: b.id, code: b.code };
  $('drawerActions').innerHTML = buildDrawerActions('benefit');
  drawerOverlay.classList.add('open');
  detailDrawer.classList.add('open');
}

$('benefitTableBody').addEventListener('click', e => {
  const btn = e.target.closest('.action-open-btn');
  if (btn) openBenefitDrawer(btn.dataset.bid);
});

// ─── 初期化 ────────────────────────────────────────────────────────────────────

loadAll().catch(err => {
  $('tableBody').innerHTML = `<tr class="empty-row"><td colspan="14"><span class="empty-icon">⚠️</span>読み込み失敗: ${escHtml(err.message)}</td></tr>`;
});
