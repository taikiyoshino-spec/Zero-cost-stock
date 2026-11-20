/**
 * 恩株化ライン到達の LINE 通知
 *
 * 恩株待ちの銘柄について、現在の株価で恩株差がプラス（= 売却で元本を回収できる）に
 * なったら LINE に通知する。Cron Trigger（取引時間中 30 分ごと）から呼ばれる。
 *
 * 恩株差の計算は public/app.js の calculateWaiting と同じ式にしている。
 * 片方を変えたらもう片方も合わせること。
 */

export const TAX_RATE = 0.20315;

// 同じ銘柄を再通知しない期間（株価が恩株売値の前後を行き来しても通知が連発しないように）
const RENOTIFY_INTERVAL_MS = 20 * 60 * 60 * 1000;

// app.js の getLots と同じ：複数口座（lots）が無ければ単一口座として扱う
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

/**
 * 恩株待ち銘柄の恩株差（app.js の calculateWaiting の onKabuDiff と同じ）
 * @returns {{ onKabuDiff: number|null, sellPrice: number|null, sellCount: number, totalShares: number }}
 */
export function waitingOnkabu(stock, price) {
  const lots = getLots(stock);
  const o = stock.on_kabu_shares | 0;
  const p = price ?? null;

  const totalShares = lots.reduce((s, l) => s + (l.current_shares | 0), 0);
  const totalCost   = lots.reduce((s, l) => s + (l.current_shares | 0) * (+(l.avg_acquisition_price) || 0), 0);

  const nonNisaLots   = lots.filter(l => (l.is_nisa ?? 1) === 0);
  const nonNisaShares = nonNisaLots.reduce((s, l) => s + (l.current_shares | 0), 0);
  const nonNisaCost   = nonNisaLots.reduce((s, l) => s + (l.current_shares | 0) * (+(l.avg_acquisition_price) || 0), 0);
  const nonNisaAvg    = nonNisaShares > 0 ? nonNisaCost / nonNisaShares : 0;
  const nonNisaFrac   = totalShares > 0 ? nonNisaShares / totalShares : 0;

  const sellCount = totalShares - o;
  const sellPrice = sellCount > 0 ? totalCost / sellCount : null;

  let onKabuDiff = (p != null && sellPrice != null) ? p - sellPrice : null;
  if (nonNisaFrac > 0 && p != null && sellCount > 0 && nonNisaAvg > 0) {
    const mixedBE = (sellPrice - nonNisaFrac * nonNisaAvg * TAX_RATE) / (1 - nonNisaFrac * TAX_RATE);
    onKabuDiff = p - mixedBE;
  }
  return { onKabuDiff, sellPrice, sellCount, totalShares };
}

// ─── LINE 送信 ─────────────────────────────────────────────────────────────────

export async function sendLine(env, text) {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const to    = env.LINE_USER_ID;
  if (!token || !to) {
    throw new Error('LINE の設定（LINE_CHANNEL_ACCESS_TOKEN と LINE_USER_ID）がありません');
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 5000) }] }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`LINE 送信エラー: HTTP ${res.status} ${body}`);
  }
}

// ─── 通知メッセージ ────────────────────────────────────────────────────────────

const yen = n => `${Math.round(n).toLocaleString('ja-JP')}円`;

export function buildMessage(items, appUrl) {
  const lines = ['【恩株売値に到達】'];
  for (const it of items) {
    lines.push(
      '',
      `${it.code} ${it.name || ''}`.trim(),
      `株価 ${yen(it.price)} ／ 恩株売値 ${yen(it.sellPrice)}（恩株差 +${yen(it.diff)}）`,
      `売却 ${it.sellCount.toLocaleString('ja-JP')}株で元本回収 → 恩株 ${it.onKabuShares.toLocaleString('ja-JP')}株`,
    );
  }
  lines.push('', '※ 株価は自動取得した値です。売却前にご自身で確認してください。');
  if (appUrl) lines.push(appUrl);
  return lines.join('\n');
}

// ─── 定期チェック本体 ──────────────────────────────────────────────────────────

/**
 * @param env  Worker の env（DB, LINE_*, APP_URL）
 * @param deps { fetchPrice(code) => number|null, fetchName(code) => string|null }
 * @param now  現在時刻（テスト用）
 */
export async function runOnkabuCheck(env, deps, now = new Date()) {
  const { results: stocks } = await env.DB.prepare('SELECT * FROM waiting_stocks').all();
  const { results: states } = await env.DB.prepare('SELECT * FROM onkabu_notify_state').all();
  const stateOf = Object.fromEntries(states.map(s => [s.code, s]));

  const summary = { checked: 0, ready: [], notified: [], priceUnavailable: [], lineError: null };
  const toNotify = [];
  const writes = [];
  const nowIso = now.toISOString();

  for (const stock of stocks) {
    // 1 回の実行で外部取得の回数に上限があるため、株価だけを取得する
    const price = await deps.fetchPrice(stock.code).catch(() => null);
    if (price == null) { summary.priceUnavailable.push(stock.code); continue; }
    summary.checked++;

    const { onKabuDiff, sellPrice, sellCount } = waitingOnkabu(stock, price);
    const ready = onKabuDiff != null && onKabuDiff >= 0;
    if (ready) summary.ready.push(stock.code);

    const prev = stateOf[stock.code];
    const lastNotified = prev?.notified_at ? Date.parse(prev.notified_at) : 0;
    const shouldNotify = ready && !prev?.ready && (now.getTime() - lastNotified >= RENOTIFY_INTERVAL_MS);
    if (shouldNotify) {
      toNotify.push({ code: stock.code, price, sellPrice, diff: onKabuDiff, sellCount,
                      onKabuShares: stock.on_kabu_shares | 0 });
    }
    writes.push({ code: stock.code, ready: ready ? 1 : 0, price, diff: onKabuDiff,
                  notifiedAt: prev?.notified_at ?? null, notify: shouldNotify });
  }

  // 通知（まとめて 1 通）。送れなかったら「通知済み」にしない → 次回また試す
  let sent = false;
  if (toNotify.length) {
    for (const it of toNotify) it.name = await deps.fetchName(it.code).catch(() => null);
    try {
      await sendLine(env, buildMessage(toNotify, env.APP_URL));
      sent = true;
      summary.notified = toNotify.map(it => it.code);
    } catch (e) {
      summary.lineError = e.message;
    }
  }

  const stmts = writes.map(w => {
    // 送信に失敗した銘柄は ready=0 のままにして、次回のチェックで再通知させる
    const ready = (w.notify && !sent) ? 0 : w.ready;
    const notifiedAt = (w.notify && sent) ? nowIso : w.notifiedAt;
    return env.DB.prepare(`
      INSERT INTO onkabu_notify_state (code, ready, last_price, last_diff, notified_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        ready = excluded.ready, last_price = excluded.last_price, last_diff = excluded.last_diff,
        notified_at = excluded.notified_at, updated_at = excluded.updated_at
    `).bind(w.code, ready, w.price, w.diff, notifiedAt, nowIso);
  });
  // 恩株待ちから外れた銘柄の状態は消す
  const codes = stocks.map(s => s.code);
  stmts.push(codes.length
    ? env.DB.prepare(`DELETE FROM onkabu_notify_state WHERE code NOT IN (${codes.map(() => '?').join(',')})`).bind(...codes)
    : env.DB.prepare('DELETE FROM onkabu_notify_state'));
  await env.DB.batch(stmts);

  return summary;
}
