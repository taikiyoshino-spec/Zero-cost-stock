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

// ─── フォーマットヘルパー ─────────────────────────────────────────────────────

const fmt     = (n, d = 0) => (n == null || isNaN(n)) ? '—'
                : n.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtYen  = n => (n == null || isNaN(n)) ? '—' : `¥${fmt(n)}`;
const fmtPct  = n => (n == null || isNaN(n)) ? '—' : `${(+n).toFixed(2)}%`;
const signCls = n => (n == null || isNaN(n)) ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '';

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
  const c = stock.current_shares | 0;
  const a = +(stock.avg_acquisition_price) || 0;
  const p = scraped?.closingPrice    ?? null;
  const d = scraped?.dividendPerShare ?? null;

  const purchaseCount    = t - c;
  const currentAcq       = c * a;
  const totalAcq         = currentAcq + purchaseCount * (p ?? 0);
  const sellCount        = t - o;
  const onKabuPrice      = sellCount > 0 ? totalAcq / sellCount : null;
  const purchaseAmt      = purchaseCount * (p ?? 0);
  const onKabuDiff       = (p != null && onKabuPrice != null) ? p - onKabuPrice : null;
  const dividendAmt      = d != null ? t * d : null;
  const currentAmt       = p != null ? p * c : null;
  const profitLoss       = currentAmt != null ? currentAmt - currentAcq : null;
  const purchaseAfterAvg = t > 0 ? totalAcq / t : null;
  const currentSellAmt   = purchaseAfterAvg != null ? sellCount * purchaseAfterAvg : null;

  return { purchaseCount, purchaseAmt, onKabuPrice, onKabuDiff, dividendAmt,
           currentAmt, profitLoss, sellCount, totalAcq, currentAcq,
           purchaseAfterAvg, currentSellAmt };
}

// ─── 計算：恩株待ち ───────────────────────────────────────────────────────────

function calculateWaiting(stock, scraped) {
  const o = stock.on_kabu_shares | 0;
  const c = stock.current_shares | 0;
  const a = +(stock.avg_acquisition_price) || 0;
  const p = scraped?.closingPrice    ?? null;
  const d = scraped?.dividendPerShare ?? null;

  const currentAcq  = c * a;                                          // 現在取得金額
  const sellCount   = c - o;                                          // 売数
  const sellPrice   = sellCount > 0 ? currentAcq / sellCount : null; // 売値
  const sellAmt     = sellPrice != null ? sellPrice * sellCount : null; // 売値額（≒現在取得金額）
  const onKabuDiff  = (p != null && sellPrice != null) ? p - sellPrice : null; // 恩株差
  const currentAmt  = p != null ? p * c : null;                       // 現在金額
  const profitLoss  = currentAmt != null ? currentAmt - currentAcq : null; // 現在損益
  const currentSell = p != null ? sellCount * p : null;               // 現売値
  const currentDiv  = d != null ? c * d : null;                       // 現配当
  const afterDiv    = d != null ? o * d : null;                       // 後配当

  return { currentAcq, sellCount, sellPrice, sellAmt, onKabuDiff,
           currentAmt, profitLoss, currentSell, currentDiv, afterDiv };
}

// ─── アプリ状態 ───────────────────────────────────────────────────────────────

let currentTab    = 'purchase';
let stocks        = [];
let waitingStocks = [];
let scraped       = {};
const loading     = new Set();

// ─── DOM 参照 ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ─── タブ切り替え ──────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    $('tab-purchase').classList.toggle('hidden', currentTab !== 'purchase');
    $('tab-waiting').classList.toggle('hidden',  currentTab !== 'waiting');
  });
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

function renderBoth() { renderPurchase(); renderWaiting(); }

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
      <td class="action-cell"><div class="action-buttons">
        <button class="btn-icon detail-btn" data-code="${stock.code}" title="詳細">👁</button>
        <button class="btn-icon edit-btn"   data-id="${stock.id}"    title="編集">✏️</button>
        <button class="btn-icon danger del-btn"  data-id="${stock.id}"    title="削除">🗑️</button>
        <button class="btn-icon ref-btn"    data-code="${stock.code}" title="更新">↻</button>
      </div></td>`;
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
      <td class="num-cell desktop-only input-col">${fmt(stock.current_shares)}</td>
      <td class="num-cell desktop-only input-col">${fmt(stock.on_kabu_shares)}</td>
      <td class="num-cell desktop-only input-col">${fmtYen(stock.avg_acquisition_price)}</td>
      <td class="action-cell"><div class="action-buttons">
        <button class="btn-icon wdetail-btn" data-code="${stock.code}" title="詳細">👁</button>
        <button class="btn-icon wedit-btn"   data-wid="${stock.id}"   title="編集">✏️</button>
        <button class="btn-icon danger wdel-btn"  data-wid="${stock.id}"   title="削除">🗑️</button>
        <button class="btn-icon ref-btn"     data-code="${stock.code}" title="更新">↻</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
}

// ─── データ読み込み ───────────────────────────────────────────────────────────

async function loadAll() {
  [stocks, waitingStocks] = await Promise.all([
    API.get('/stocks'),
    API.get('/waiting-stocks'),
  ]);
  renderBoth();
  const allCodes = [...new Set([...stocks.map(s => s.code), ...waitingStocks.map(s => s.code)])];
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
  $('modalTitle').textContent  = stock ? '銘柄編集' : '銘柄追加';
  $('fieldId').value           = stock?.id ?? '';
  $('fieldCode').value         = stock?.code ?? '';
  $('fieldCode').disabled      = !!stock;
  $('fieldTarget').value       = stock?.target_shares ?? '';
  $('fieldOnKabu').value       = stock?.on_kabu_shares ?? '';
  $('fieldCurrent').value      = stock?.current_shares ?? 0;
  $('fieldAvgPrice').value     = stock?.avg_acquisition_price ?? 0;
  syncAvgPriceState();
  modal.classList.add('open');
  setTimeout(() => $('fieldCode').focus(), 50);
}
function closeModal() {
  modal.classList.remove('open');
  stockForm.reset();
  editingId = null;
  calcPreview.hidden = true;
}
function syncAvgPriceState() {
  const cur = parseInt($('fieldCurrent').value) || 0;
  $('fieldAvgPrice').disabled = cur === 0;
  if (cur === 0) $('fieldAvgPrice').value = 0;
  updateCalcPreview();
}
function updateCalcPreview() {
  const code = $('fieldCode').value.trim();
  const t = parseInt($('fieldTarget').value) || 0;
  const o = parseInt($('fieldOnKabu').value) || 0;
  const c = parseInt($('fieldCurrent').value) || 0;
  const a = parseFloat($('fieldAvgPrice').value) || 0;
  if (!t || !code) { calcPreview.hidden = true; return; }
  const cv = calculate({ target_shares: t, on_kabu_shares: o, current_shares: c, avg_acquisition_price: a }, scraped[code] ?? null);
  calcGrid.innerHTML = [
    { label: '購入数',   value: fmt(cv.purchaseCount) + '株' },
    { label: '売却数',   value: fmt(cv.sellCount) + '株' },
    { label: '恩株売値', value: fmtYen(cv.onKabuPrice) },
    { label: '恩株差',   value: fmtYen(cv.onKabuDiff), cls: signCls(cv.onKabuDiff) },
    { label: '購入額',   value: fmtYen(cv.purchaseAmt) },
    { label: '配当額',   value: fmtYen(cv.dividendAmt) },
  ].map(i => `<div class="preview-item"><span class="preview-label">${i.label}</span><span class="preview-value ${i.cls||''}">${i.value}</span></div>`).join('');
  calcPreview.hidden = false;
}

// ─── 恩株待ち モーダル ────────────────────────────────────────────────────────

let editingWId = null;
const waitingModal = $('waitingModal');
const waitingForm  = $('waitingForm');

function openWaitingModal(stock = null) {
  editingWId = stock?.id ?? null;
  $('waitingModalTitle').textContent = stock ? '恩株待ち 編集' : '恩株待ち 銘柄追加';
  $('wFieldId').value       = stock?.id ?? '';
  $('wFieldCode').value     = stock?.code ?? '';
  $('wFieldCode').disabled  = !!stock;
  $('wFieldCurrent').value  = stock?.current_shares ?? '';
  $('wFieldOnKabu').value   = stock?.on_kabu_shares ?? '';
  $('wFieldAvgPrice').value = stock?.avg_acquisition_price ?? '';
  waitingModal.classList.add('open');
  setTimeout(() => $('wFieldCode').focus(), 50);
}
function closeWaitingModal() {
  waitingModal.classList.remove('open');
  waitingForm.reset();
  editingWId = null;
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
    { title: 'インプット', rows: [
      { label: '目標保有数', value: fmt(stock.target_shares) + '株' },
      { label: '恩株数',     value: fmt(stock.on_kabu_shares) + '株' },
      { label: '現在保有数', value: fmt(stock.current_shares) + '株' },
      { label: '取得平均額', value: fmtYen(stock.avg_acquisition_price) },
    ]},
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
      { label: '恩株差', value: fmtYen(cv.onKabuDiff), cls: signCls(cv.onKabuDiff) },
    ]},
    { title: '現在保有', rows: [
      { label: '現在金額',     value: fmtYen(cv.currentAmt) },
      { label: '現在取得金額', value: fmtYen(cv.currentAcq) },
      { label: '現在損益', value: fmtYen(cv.profitLoss), cls: signCls(cv.profitLoss) },
    ]},
  ]);
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
    { title: 'インプット', rows: [
      { label: '現在保有数', value: fmt(stock.current_shares) + '株' },
      { label: '恩株数',     value: fmt(stock.on_kabu_shares) + '株' },
      { label: '取得平均額', value: fmtYen(stock.avg_acquisition_price) },
    ]},
    { title: '恩株化', rows: [
      { label: '売数',   value: fmt(cv.sellCount) + '株' },
      { label: '売値',   value: fmtYen(cv.sellPrice) },
      { label: '売値額', value: fmtYen(cv.sellAmt) },
      { label: '恩株差', value: fmtYen(cv.onKabuDiff), cls: signCls(cv.onKabuDiff) },
      { label: '現売値', value: fmtYen(cv.currentSell) },
    ]},
    { title: '配当', rows: [
      { label: '現配当（全株）', value: fmtYen(cv.currentDiv) },
      { label: '後配当（恩株後）', value: fmtYen(cv.afterDiv) },
    ]},
    { title: '現在保有', rows: [
      { label: '現在金額',     value: fmtYen(cv.currentAmt) },
      { label: '現在取得金額', value: fmtYen(cv.currentAcq) },
      { label: '現在損益', value: fmtYen(cv.profitLoss), cls: signCls(cv.profitLoss) },
    ]},
  ]);
  drawerOverlay.classList.add('open');
  detailDrawer.classList.add('open');
}

function closeDrawer() {
  drawerOverlay.classList.remove('open');
  detailDrawer.classList.remove('open');
}

// ─── イベントリスナー ──────────────────────────────────────────────────────────

// ヘッダーボタン（タブに応じて動作を切り替え）
$('addBtn').addEventListener('click', () => {
  if (currentTab === 'purchase') openModal();
  else openWaitingModal();
});
$('refreshAllBtn').addEventListener('click', () => {
  const targets = currentTab === 'purchase' ? stocks : waitingStocks;
  for (const s of targets) { Cache.clear(s.code); fetchScraped(s.code, true); }
});

// 購入検討 モーダル
$('cancelBtn').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
$('fieldCurrent').addEventListener('input', syncAvgPriceState);
['fieldTarget','fieldOnKabu','fieldAvgPrice','fieldCode'].forEach(id => $( id).addEventListener('input', updateCalcPreview));

stockForm.addEventListener('submit', async e => {
  e.preventDefault();
  const code   = $('fieldCode').value.trim();
  const target = parseInt($('fieldTarget').value);
  const onKabu = parseInt($('fieldOnKabu').value);
  const current  = parseInt($('fieldCurrent').value) || 0;
  const avgPrice = parseFloat($('fieldAvgPrice').value) || 0;
  if (!editingId && !/^\d{4}$/.test(code)) { alert('証券コードは4桁の数字で入力してください'); return; }
  if (onKabu >= target) { alert('恩株数は目標保有数より小さくしてください'); return; }
  const btn = $('saveBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    if (editingId) await API.put(`/stocks/${editingId}`, { target_shares: target, on_kabu_shares: onKabu, current_shares: current, avg_acquisition_price: avgPrice });
    else           await API.post('/stocks', { code, target_shares: target, on_kabu_shares: onKabu, current_shares: current, avg_acquisition_price: avgPrice });
    closeModal();
    stocks = await API.get('/stocks');
    renderPurchase();
    fetchScraped(code);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = '保存'; }
});

// 購入検討 テーブルボタン
$('tableBody').addEventListener('click', async e => {
  const edit   = e.target.closest('.edit-btn');
  const del    = e.target.closest('.del-btn');
  const ref    = e.target.closest('.ref-btn');
  const detail = e.target.closest('.detail-btn');
  if (edit)   { const s = stocks.find(x => x.id == edit.dataset.id); if (s) openModal(s); }
  if (detail) openDrawer(detail.dataset.code);
  if (ref)    { Cache.clear(ref.dataset.code); fetchScraped(ref.dataset.code, true); }
  if (del) {
    if (!confirm('この銘柄を削除しますか？')) return;
    try { await API.delete(`/stocks/${del.dataset.id}`); stocks = await API.get('/stocks'); renderPurchase(); }
    catch (err) { alert(err.message); }
  }
});

// 恩株待ち モーダル
$('wCancelBtn').addEventListener('click', closeWaitingModal);
waitingModal.addEventListener('click', e => { if (e.target === waitingModal) closeWaitingModal(); });

waitingForm.addEventListener('submit', async e => {
  e.preventDefault();
  const code    = $('wFieldCode').value.trim();
  const current = parseInt($('wFieldCurrent').value);
  const onKabu  = parseInt($('wFieldOnKabu').value);
  const avgPrice = parseFloat($('wFieldAvgPrice').value) || 0;
  if (!editingWId && !/^\d{4}$/.test(code)) { alert('証券コードは4桁の数字で入力してください'); return; }
  if (onKabu >= current) { alert('恩株数は現在保有数より小さくしてください'); return; }
  const btn = $('wSaveBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    if (editingWId) await API.put(`/waiting-stocks/${editingWId}`, { on_kabu_shares: onKabu, current_shares: current, avg_acquisition_price: avgPrice });
    else            await API.post('/waiting-stocks', { code, on_kabu_shares: onKabu, current_shares: current, avg_acquisition_price: avgPrice });
    closeWaitingModal();
    waitingStocks = await API.get('/waiting-stocks');
    renderWaiting();
    fetchScraped(code);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = '保存'; }
});

// 恩株待ち テーブルボタン
$('waitingTableBody').addEventListener('click', async e => {
  const edit   = e.target.closest('.wedit-btn');
  const del    = e.target.closest('.wdel-btn');
  const ref    = e.target.closest('.ref-btn');
  const detail = e.target.closest('.wdetail-btn');
  if (edit)   { const s = waitingStocks.find(x => x.id == edit.dataset.wid); if (s) openWaitingModal(s); }
  if (detail) openWaitingDrawer(detail.dataset.code);
  if (ref)    { Cache.clear(ref.dataset.code); fetchScraped(ref.dataset.code, true); }
  if (del) {
    if (!confirm('この銘柄を削除しますか？')) return;
    try { await API.delete(`/waiting-stocks/${del.dataset.wid}`); waitingStocks = await API.get('/waiting-stocks'); renderWaiting(); }
    catch (err) { alert(err.message); }
  }
});

// ドロワー・キーボード
$('drawerClose').addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeWaitingModal(); closeDrawer(); }
});

// ─── 初期化 ────────────────────────────────────────────────────────────────────

loadAll().catch(err => {
  $('tableBody').innerHTML = `<tr class="empty-row"><td colspan="14"><span class="empty-icon">⚠️</span>読み込み失敗: ${escHtml(err.message)}</td></tr>`;
});
