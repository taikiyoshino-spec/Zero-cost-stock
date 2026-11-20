/**
 * 恩株管理ツール - Cloudflare Worker
 * REST API + Yahoo Finance Japan / Google Finance スクレイピングプロキシ
 * + 恩株化ライン到達の LINE 通知（Cron Trigger）
 */

import { runOnkabuCheck, sendLine } from './onkabu-notify.js';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
};

// ─── レスポンスヘルパー ───────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ─── HTML テキスト抽出（HTMLRewriter 使用）────────────────────────────────────

async function extractText(html, selectorMap) {
  const result = {};
  for (const k of Object.keys(selectorMap)) result[k] = '';

  let rw = new HTMLRewriter();
  for (const [key, selector] of Object.entries(selectorMap)) {
    const k = key;
    rw = rw.on(selector, {
      text(chunk) {
        if (chunk.text) result[k] += chunk.text;
      },
    });
  }
  await rw.transform(new Response(html)).arrayBuffer();

  return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.trim()]));
}

// ─── スクレイピング ────────────────────────────────────────────────────────────

// 会社名クリーニング
function cleanCompanyName(raw) {
  return raw
    .replace(/[のー]?株価[\s\S]*/, '')  // "の株価・株式情報"以降を除去
    .replace(/[：:][\s\S]*/, '')        // 全角・半角コロン以降を除去
    .replace(/\(株\)/g, '')
    .replace(/（株）/g, '')
    .replace(/【[^】]*】/, '')           // 【証券コード】を除去
    .replace(/[-－|｜].*$/, '')         // "- Yahoo!ファイナンス"などを除去
    .replace(/\s+/g, ' ')
    .trim();
}

// 取得できなかった項目と、その理由を利用者向けの文にする。
// src の各値は 'ok'（取得成功）、失敗理由の文字列、null（試していない）のいずれか。
// 無配当の銘柄もあるため、配当は「配当ページ自体を取得できなかった」ときだけ問題とする。
function collectIssues({ companyName, closingPrice }, src) {
  const reason = (label, v) => `${label}: ${v === 'ok' ? '値が見つからない' : v}`;
  const issues = [];
  if (closingPrice === null) {
    const parts = [reason('Yahoo API', src.yahooApi)];
    if (src.google !== null) parts.push(reason('Google', src.google));
    issues.push(`終値を取得できませんでした（${parts.join('、')}）`);
  }
  if (!companyName) {
    issues.push(`会社名を取得できませんでした（${reason('Yahoo!ファイナンス', src.yahooBase)}）`);
  }
  if (src.yahooDividend !== 'ok') {
    issues.push(`配当情報を取得できませんでした（配当ページ: ${src.yahooDividend}）`);
  }
  return issues;
}

const fetchFailReason = e => (e && e.name === 'AbortError') ? 'タイムアウト' : '通信エラー';

async function scrapeStock(code) {
  // ── Step1: Yahoo Finance グローバル JSON API（最も信頼性が高い）─────────────
  // 終値・会社名・配当利回りを JSON で取得
  let companyName = null;
  let closingPrice = null;
  let yieldValue = null;
  let dividendPerShare = null;
  // 取得元ごとの結果（失敗時に理由を表示するため）
  const src = { yahooApi: null, yahooDividend: null, yahooBase: null, google: null };

  try {
    const apiUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?interval=1d&range=1d`;
    const apiRes = await fetch(apiUrl, {
      headers: {
        ...BROWSER_HEADERS,
        'Accept': 'application/json',
        'Origin': 'https://finance.yahoo.com',
        'Referer': 'https://finance.yahoo.com/',
      },
    });
    if (apiRes.ok) {
      const data = await apiRes.json();
      const meta = data?.chart?.result?.[0]?.meta;
      src.yahooApi = meta ? 'ok' : 'データなし';
      if (meta) {
        closingPrice      = meta.regularMarketPrice       ?? meta.previousClose ?? null;
        // 会社名は英語になるため、Yahoo Finance Japan から別途取得する
        dividendPerShare  = meta.trailingAnnualDividendRate  || null;
        yieldValue        = meta.trailingAnnualDividendYield != null
                            ? meta.trailingAnnualDividendYield * 100
                            : null;
      }
    } else {
      src.yahooApi = `HTTP ${apiRes.status}`;
    }
  } catch (e) {
    // JSON API 失敗 → 次のフォールバックへ
    src.yahooApi = fetchFailReason(e);
  }

  // ── Step2: Yahoo Finance Japan 配当ページ（配当予想・利回りの精度向上）────
  try {
    const divUrl = `https://finance.yahoo.co.jp/quote/${code}.T/dividend`;
    const divRes = await fetch(divUrl, { headers: BROWSER_HEADERS });
    src.yahooDividend = divRes.ok ? 'ok' : `HTTP ${divRes.status}`;
    if (divRes.ok) {
      const html = await divRes.text();

      const extracted = await extractText(html, {
        div1:    '#dvdinfo ul li:first-child dl dd span span span',
        div2:    '#dvdinfo ul li:nth-child(2) dl dd span span span',
        divAlt1: '#dvdinfo ul li:first-child dd',
        divAlt2: '#dvdinfo ul li:nth-child(2) dd',
      });

      const divText   = extracted.div1 || extracted.divAlt1 || '';
      const yieldText = extracted.div2 || extracted.divAlt2 || '';

      const divM = divText.match(/([\d,]+\.?\d*)/);
      if (divM) dividendPerShare = parseFloat(divM[1].replace(/,/g, ''));

      const yieldM = yieldText.match(/([\d,]+\.?\d*)/);
      if (yieldM) {
        const v = parseFloat(yieldM[1].replace(/,/g, ''));
        // 20%超は誤パースとみなしてスキップ（無配当株で別数値を拾うケースを排除）
        if (v >= 0 && v <= 20) yieldValue = v;
      }

      // 正規表現フォールバック
      if (!dividendPerShare) {
        const m = html.match(/配当予想.*?([\d,]+\.?\d*)\s*円/s);
        if (m) dividendPerShare = parseFloat(m[1].replace(/,/g, ''));
      }
      if (yieldValue === null) {
        const m = html.match(/配当利回り.*?([\d.]+)\s*%/s);
        if (m) {
          const v = parseFloat(m[1]);
          if (v >= 0 && v <= 20) yieldValue = v;
        }
      }
    }
  } catch (e) {
    src.yahooDividend = fetchFailReason(e);
  }

  // ── Step3: Yahoo Finance Japan ベースページから日本語会社名を取得 ───────────
  {
    try {
      const baseRes = await fetch(
        `https://finance.yahoo.co.jp/quote/${code}.T`,
        { headers: BROWSER_HEADERS }
      );
      src.yahooBase = baseRes.ok ? 'ok' : `HTTP ${baseRes.status}`;
      if (baseRes.ok) {
        const html = await baseRes.text();
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch) {
          const candidate = cleanCompanyName(titleMatch[1]);
          if (candidate) companyName = candidate;
        }
        if (!companyName) {
          const extracted = await extractText(html, {
            h2: '#root main section h2',
            h1: 'h1',
          });
          const candidate = cleanCompanyName(extracted.h2 || extracted.h1 || '');
          if (candidate) companyName = candidate;
        }
      }
    } catch (e) {
      src.yahooBase = fetchFailReason(e);
    }
  }

  // ── Step4: 終値がまだ null なら Google Finance を試みる ────────────────────
  if (closingPrice === null) {
    try {
      const gRes = await fetch(
        `https://www.google.com/finance/quote/${code}:TYO`,
        { headers: BROWSER_HEADERS }
      );
      src.google = gRes.ok ? 'ok' : `HTTP ${gRes.status}`;
      if (gRes.ok) {
        const html = await gRes.text();
        const m = html.match(/<div class="YMlKec fxKbKc">(.*?)<\/div>/);
        if (m) {
          const parsed = parseFloat(m[1].replace(/[¥,\s]/g, ''));
          if (!isNaN(parsed)) closingPrice = parsed;
        }
        // フォールバック: data-last-price 属性
        if (closingPrice === null) {
          const m2 = html.match(/data-last-price="([\d.]+)"/);
          if (m2) closingPrice = parseFloat(m2[1]);
        }
      }
    } catch (e) {
      src.google = fetchFailReason(e);
    }
  }

  return {
    companyName: companyName || code,
    closingPrice,
    yieldValue,
    dividendPerShare,
    issues: collectIssues({ companyName, closingPrice }, src),
    fetchedAt: new Date().toISOString(),
  };
}

function normalize(str) {
  return str.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30));
}

function extractBenefitMonths(html) {
  // 優待ページ: "株主優待の内容" セクションの "X月末" を抽出
  const months = new Set();
  const start = html.indexOf('株主優待の内容');
  if (start < 0) return [];
  const section = normalize(html.substring(start, start + 6000));
  const regex = /(\d{1,2})月末/g;
  let m;
  while ((m = regex.exec(section)) !== null) {
    const n = parseInt(m[1]);
    if (n >= 1 && n <= 12) months.add(n);
  }
  return [...months].sort((a, b) => a - b);
}

async function extractDividendMonths(html) {
  // 配当ページ全体からテーブル行を収集し、
  // "yyyy年m月期" 行の近く(15行以内)で 第1〜4四半期が2個以上ある列ヘッダー行を見つけ、
  // その直後の予想・実績行から 0 より大きい値がある四半期を配当月として登録
  const rows = [];
  let currentRow = [];
  let cellBuf = '';
  await new HTMLRewriter()
    .on('tr', {
      element(el) {
        currentRow = [];
        el.onEndTag(() => {
          if (currentRow.length > 0) rows.push([...currentRow]);
          currentRow = [];
        });
      },
    })
    .on('td, th', {
      element(el) {
        cellBuf = '';
        el.onEndTag(() => {
          currentRow.push(normalize(cellBuf.trim()));
          cellBuf = '';
        });
      },
      text(chunk) { cellBuf += chunk.text; },
    })
    .transform(new Response(html)).arrayBuffer();

  // "yyyy年m月期" を含む行から決算月と行インデックスを取得
  let fiscalEndMonth = null;
  let fiscalRowIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    for (const cell of rows[i]) {
      const fm = cell.match(/\d{4}年(\d{1,2})月期/);
      if (fm) { fiscalEndMonth = parseInt(fm[1]); fiscalRowIdx = i; break; }
    }
    if (fiscalEndMonth) break;
  }
  if (!fiscalEndMonth) return [];

  // 決算月行から15行以内で 第X四半期が2個以上ある行を列ヘッダーとして認識
  // 列位置は「末尾（合計列）からの距離」で記録する。データ行には年度ラベルや
  // 予想/実績ラベル、調整後合計など先頭に余分な列が付くことがあり、絶対列番号は
  // ヘッダー行とデータ行でずれるため、末尾基準のオフセットで対応付ける。
  let headerRowIdx = -1;
  const qOffsetMap = {};
  for (let i = fiscalRowIdx; i < Math.min(rows.length, fiscalRowIdx + 15); i++) {
    const qCells = rows[i].filter(c => /第[1-4]四半期/.test(c));
    if (qCells.length >= 2) {
      headerRowIdx = i;
      const len = rows[i].length;
      rows[i].forEach((cell, idx) => {
        const qm = cell.match(/第([1-4])四半期/);
        if (qm) qOffsetMap[parseInt(qm[1])] = len - idx;
      });
      break;
    }
  }
  if (headerRowIdx < 0 || Object.keys(qOffsetMap).length === 0) return [];

  // 列ヘッダー行の直後6行(予想・実績)を確認
  const months = new Set();
  for (let i = headerRowIdx + 1; i < Math.min(rows.length, headerRowIdx + 6); i++) {
    const row = rows[i];
    for (const [q, offsetFromEnd] of Object.entries(qOffsetMap)) {
      const colIdx = row.length - offsetFromEnd;
      if (colIdx < 0 || colIdx >= row.length) continue;
      const v = parseFloat(row[colIdx]);
      if (!isNaN(v) && v > 0) {
        const offset = (4 - parseInt(q)) * 3;
        const month = ((fiscalEndMonth - 1 - offset) % 12 + 12) % 12 + 1;
        months.add(month);
      }
    }
  }

  return [...months].sort((a, b) => a - b);
}

async function scrapeWatchInfo(code) {
  const stockData = await scrapeStock(code);
  let benefitMonths = [];
  let dividendMonths = [];
  try {
    const [incentiveRes, dividendRes] = await Promise.all([
      fetch(`https://finance.yahoo.co.jp/quote/${code}.T/incentive`, { headers: BROWSER_HEADERS }),
      fetch(`https://finance.yahoo.co.jp/quote/${code}.T/dividend`,  { headers: BROWSER_HEADERS }),
    ]);
    if (incentiveRes.ok) benefitMonths  = extractBenefitMonths(await incentiveRes.text());
    if (dividendRes.ok)  dividendMonths = await extractDividendMonths(await dividendRes.text());
  } catch {}
  return { ...stockData, benefitMonths, dividendMonths };
}

// ─── 株主優待スクレイピング ────────────────────────────────────────────────────

async function scrapeIncentiveInfo(code, shares) {
  try {
    const res = await fetch(
      `https://finance.yahoo.co.jp/quote/${code}.T/incentive`,
      { headers: BROWSER_HEADERS }
    );
    if (!res.ok) return null;
    const html = await res.text();

    // ── 1. テーブル行をセルペアで抽出 ─────────────────────────────────────────
    const rows = [];
    let currentRow = [];
    let cellBuf = '';

    await new HTMLRewriter()
      .on('tr', {
        element(el) {
          currentRow = [];
          el.onEndTag(() => {
            if (currentRow.length >= 2) rows.push([...currentRow]);
            currentRow = [];
          });
        }
      })
      .on('td, th', {
        element(el) {
          cellBuf = '';
          el.onEndTag(() => {
            const t = cellBuf.trim();
            if (t) currentRow.push(t);
            cellBuf = '';
          });
        },
        text(chunk) { if (chunk.text) cellBuf += chunk.text; }
      })
      .transform(new Response(html))
      .arrayBuffer();

    // ── 2. カテゴリ見出し（テーブル直前のテキスト）を正規表現で抽出 ───────────
    // スクリプト・スタイルを除いた HTML から「株以上」より前の部分を対象にする
    const strippedHtml = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
    let categoryLabel = '';
    const firstTierPos = strippedHtml.indexOf('株以上');
    if (firstTierPos > 0) {
      const beforeTiers = strippedHtml.substring(0, firstTierPos);
      // タグ間のテキストのうち、優待種別キーワードを含む最後のものをカテゴリ名とする
      const matches = [
        ...beforeTiers.matchAll(/>([^<>]{4,60}(?:券|ギフト|カタログ|割引|食事|お買|商品|ポイント|QUO|図書|クーポン)[^<>]{0,30})</g)
      ];
      if (matches.length > 0) {
        const candidate = matches[matches.length - 1][1].trim();
        if (!/株主優待の内容|ランキング|TOP\d|おすすめ/.test(candidate)) {
          categoryLabel = candidate;
        }
      }
    }

    // ── 3. ティア選択と結果生成 ───────────────────────────────────────────────
    const tierRows = rows.filter(row => /\d[\d,]*(株|単元)以上/.test(row[0]));

    if (tierRows.length > 0) {
      const buildResult = (tierText) =>
        categoryLabel ? `${categoryLabel}\n${tierText}` : tierText;

      if (shares > 0) {
        const qualifying = tierRows
          .map(row => {
            const m = row[0].match(/(\d[\d,]*)\s*(株|単元)/);
            const threshold = m
              ? parseInt(m[1].replace(/,/g, '')) * (m[2] === '単元' ? 100 : 1)
              : 0;
            return { text: `${row[0]}：${row.slice(1).join(' ')}`, threshold };
          })
          .filter(t => t.threshold > 0 && t.threshold <= shares)
          .sort((a, b) => b.threshold - a.threshold);
        if (qualifying.length) return buildResult(qualifying[0].text);
      }
      // 株数不明・該当なし → 全ティアを列挙
      return buildResult(tierRows.map(row => `${row[0]}：${row.slice(1).join(' ')}`).join('\n'));
    }

    // ── フォールバック：本文テキストからキーワード行を抽出 ────────────────────
    let bodyText = '';
    await new HTMLRewriter()
      .on('body', { text(chunk) { if (chunk.text) bodyText += chunk.text; } })
      .transform(new Response(html))
      .arrayBuffer();
    const lines = bodyText
      .split(/[\n。]/)
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length >= 6 && s.length <= 200);
    const relevant = lines.filter(s =>
      /(優待|割引券|食事券|商品券|ギフト|カタログ|クーポン|ポイント|円分|お食事|お買い物)/.test(s) &&
      /\d/.test(s)
    );
    return relevant.slice(0, 3).join('\n') || null;
  } catch { return null; }
}

// ─── API ルーティング ──────────────────────────────────────────────────────────

async function handleApi(request, env, path) {
  const method = request.method;

  // GET /api/stocks
  if (path === '/api/stocks' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM stocks ORDER BY created_at ASC'
    ).all();
    return json(results);
  }

  // POST /api/stocks
  if (path === '/api/stocks' && method === 'POST') {
    const { code, target_shares, on_kabu_shares, lots = [], purchase_nisa = 1 } = await request.json();

    if (!code || target_shares == null || on_kabu_shares == null) {
      return err('証券コード・目標保有数・恩株数は必須です');
    }
    if (!/^\d{4}$/.test(String(code))) {
      return err('証券コードは4桁の数字で入力してください');
    }
    if (on_kabu_shares >= target_shares) {
      return err('恩株数は目標保有数より小さくしてください');
    }
    const totalShares = lots.reduce((s, l) => s + (l.current_shares | 0), 0);
    const weightedAvg = totalShares > 0
      ? lots.reduce((s, l) => s + (l.current_shares | 0) * (+l.avg_acquisition_price || 0), 0) / totalShares
      : 0;

    await env.DB.prepare(`
      INSERT INTO stocks (code, target_shares, on_kabu_shares, current_shares, avg_acquisition_price, lots, purchase_nisa)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        target_shares         = excluded.target_shares,
        on_kabu_shares        = excluded.on_kabu_shares,
        current_shares        = excluded.current_shares,
        avg_acquisition_price = excluded.avg_acquisition_price,
        lots                  = excluded.lots,
        purchase_nisa         = excluded.purchase_nisa,
        updated_at            = datetime('now')
    `).bind(code, target_shares, on_kabu_shares, totalShares, weightedAvg, lots.length ? JSON.stringify(lots) : null, purchase_nisa).run();

    return json({ success: true });
  }

  // PUT /api/stocks/:id
  const updateMatch = path.match(/^\/api\/stocks\/(\d+)$/);
  if (updateMatch && method === 'PUT') {
    const id = updateMatch[1];
    const { target_shares, on_kabu_shares, lots = [], purchase_nisa = 1 } = await request.json();

    if (on_kabu_shares >= target_shares) {
      return err('恩株数は目標保有数より小さくしてください');
    }
    const totalShares = lots.reduce((s, l) => s + (l.current_shares | 0), 0);
    const weightedAvg = totalShares > 0
      ? lots.reduce((s, l) => s + (l.current_shares | 0) * (+l.avg_acquisition_price || 0), 0) / totalShares
      : 0;

    await env.DB.prepare(`
      UPDATE stocks
      SET target_shares         = ?,
          on_kabu_shares        = ?,
          current_shares        = ?,
          avg_acquisition_price = ?,
          lots                  = ?,
          purchase_nisa         = ?,
          updated_at            = datetime('now')
      WHERE id = ?
    `).bind(target_shares, on_kabu_shares, totalShares, weightedAvg, lots.length ? JSON.stringify(lots) : null, purchase_nisa, id).run();

    return json({ success: true });
  }

  // DELETE /api/stocks/:id
  const deleteMatch = path.match(/^\/api\/stocks\/(\d+)$/);
  if (deleteMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM stocks WHERE id = ?').bind(deleteMatch[1]).run();
    return json({ success: true });
  }

  // ── 恩株待ちテーブル CRUD ─────────────────────────────────────────────────────

  // GET /api/waiting-stocks
  if (path === '/api/waiting-stocks' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM waiting_stocks ORDER BY created_at ASC'
    ).all();
    return json(results);
  }

  // POST /api/waiting-stocks
  if (path === '/api/waiting-stocks' && method === 'POST') {
    const { code, on_kabu_shares, lots } = await request.json();
    if (!code || on_kabu_shares == null || !Array.isArray(lots) || lots.length === 0) {
      return err('証券コード・恩株数・保有口座は必須です');
    }
    if (!/^\d{4}$/.test(String(code))) {
      return err('証券コードは4桁の数字で入力してください');
    }
    const totalShares = lots.reduce((s, l) => s + (l.current_shares | 0), 0);
    if (on_kabu_shares >= totalShares) {
      return err('恩株数は合計保有数より小さくしてください');
    }
    const weightedAvg = lots.reduce((s, l) => s + (l.current_shares | 0) * (+l.avg_acquisition_price || 0), 0) / totalShares;
    await env.DB.prepare(`
      INSERT INTO waiting_stocks (code, on_kabu_shares, current_shares, avg_acquisition_price, is_nisa, lots)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        on_kabu_shares        = excluded.on_kabu_shares,
        current_shares        = excluded.current_shares,
        avg_acquisition_price = excluded.avg_acquisition_price,
        is_nisa               = excluded.is_nisa,
        lots                  = excluded.lots,
        updated_at            = datetime('now')
    `).bind(code, on_kabu_shares, totalShares, weightedAvg, 1, JSON.stringify(lots)).run();
    return json({ success: true });
  }

  // PUT /api/waiting-stocks/:id
  const waitUpdateMatch = path.match(/^\/api\/waiting-stocks\/(\d+)$/);
  if (waitUpdateMatch && method === 'PUT') {
    const { on_kabu_shares, lots } = await request.json();
    if (!Array.isArray(lots) || lots.length === 0) return err('保有口座は必須です');
    const totalShares = lots.reduce((s, l) => s + (l.current_shares | 0), 0);
    if (on_kabu_shares >= totalShares) return err('恩株数は合計保有数より小さくしてください');
    const weightedAvg = lots.reduce((s, l) => s + (l.current_shares | 0) * (+l.avg_acquisition_price || 0), 0) / totalShares;
    await env.DB.prepare(`
      UPDATE waiting_stocks
      SET on_kabu_shares        = ?,
          current_shares        = ?,
          avg_acquisition_price = ?,
          lots                  = ?,
          updated_at            = datetime('now')
      WHERE id = ?
    `).bind(on_kabu_shares, totalShares, weightedAvg, JSON.stringify(lots), waitUpdateMatch[1]).run();
    return json({ success: true });
  }

  // DELETE /api/waiting-stocks/:id
  const waitDeleteMatch = path.match(/^\/api\/waiting-stocks\/(\d+)$/);
  if (waitDeleteMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM waiting_stocks WHERE id = ?').bind(waitDeleteMatch[1]).run();
    return json({ success: true });
  }

  // ── 恩株化テーブル CRUD ───────────────────────────────────────────────────────

  // GET /api/achieved-stocks
  if (path === '/api/achieved-stocks' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM achieved_stocks ORDER BY created_at ASC'
    ).all();
    return json(results);
  }

  // POST /api/achieved-stocks
  if (path === '/api/achieved-stocks' && method === 'POST') {
    const { code, current_shares, is_nisa = 1 } = await request.json();
    if (!code || current_shares == null) return err('証券コード・保有数は必須です');
    if (!/^\d{4}$/.test(String(code))) return err('証券コードは4桁の数字で入力してください');
    await env.DB.prepare(`
      INSERT INTO achieved_stocks (code, current_shares, is_nisa)
      VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        current_shares = excluded.current_shares,
        is_nisa        = excluded.is_nisa,
        updated_at     = datetime('now')
    `).bind(code, current_shares, is_nisa).run();
    return json({ success: true });
  }

  // PUT /api/achieved-stocks/:id
  const achUpdateMatch = path.match(/^\/api\/achieved-stocks\/(\d+)$/);
  if (achUpdateMatch && method === 'PUT') {
    const { current_shares, is_nisa = 1 } = await request.json();
    await env.DB.prepare(
      'UPDATE achieved_stocks SET current_shares = ?, is_nisa = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(current_shares, is_nisa, achUpdateMatch[1]).run();
    return json({ success: true });
  }

  // DELETE /api/achieved-stocks/:id
  const achDeleteMatch = path.match(/^\/api\/achieved-stocks\/(\d+)$/);
  if (achDeleteMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM achieved_stocks WHERE id = ?').bind(achDeleteMatch[1]).run();
    return json({ success: true });
  }

  // GET /api/stock-data/:code（スクレイピング）
  const scrapeMatch = path.match(/^\/api\/stock-data\/(\d{4})$/);
  if (scrapeMatch && method === 'GET') {
    try {
      const data = await scrapeStock(scrapeMatch[1]);
      return json(data);
    } catch (e) {
      return err(`データ取得エラー: ${e.message}`, 500);
    }
  }

  // ── 優待期限 CRUD ─────────────────────────────────────────────────────────────

  // GET /api/benefits
  if (path === '/api/benefits' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM benefit_expirations ORDER BY expires_at ASC'
    ).all();
    return json(results);
  }

  // POST /api/benefits
  if (path === '/api/benefits' && method === 'POST') {
    const { code, company_name = '', memo = '', tag = '', shares = 0, expires_at } = await request.json();
    if (!code || !expires_at) return err('証券コードと有効期限は必須です');
    if (!/^\d{4}$/.test(String(code))) return err('証券コードは4桁の数字で入力してください');
    await env.DB.prepare(
      'INSERT INTO benefit_expirations (code, company_name, memo, tag, shares, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(code, company_name, memo, tag, shares, expires_at).run();
    await env.DB.prepare(`
      INSERT INTO benefit_templates (code, memo, tag)
      VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET memo = excluded.memo, tag = excluded.tag, updated_at = datetime('now')
    `).bind(code, memo, tag).run();
    return json({ success: true });
  }

  // PUT /api/benefits/:id
  const benefitUpdateMatch = path.match(/^\/api\/benefits\/(\d+)$/);
  if (benefitUpdateMatch && method === 'PUT') {
    const id = benefitUpdateMatch[1];
    const { company_name = '', memo = '', tag = '', shares = 0, expires_at } = await request.json();
    if (!expires_at) return err('有効期限は必須です');
    await env.DB.prepare(`
      UPDATE benefit_expirations
      SET company_name = ?, memo = ?, tag = ?, shares = ?, expires_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(company_name, memo, tag, shares, expires_at, id).run();
    const row = await env.DB.prepare('SELECT code FROM benefit_expirations WHERE id = ?').bind(id).first();
    if (row) {
      await env.DB.prepare(`
        INSERT INTO benefit_templates (code, memo, tag)
        VALUES (?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET memo = excluded.memo, tag = excluded.tag, updated_at = datetime('now')
      `).bind(row.code, memo, tag).run();
    }
    return json({ success: true });
  }

  // DELETE /api/benefits/:id
  const benefitDeleteMatch = path.match(/^\/api\/benefits\/(\d+)$/);
  if (benefitDeleteMatch && method === 'DELETE') {
    const id = benefitDeleteMatch[1];
    const row = await env.DB.prepare('SELECT * FROM benefit_expirations WHERE id = ?').bind(id).first();
    if (row) {
      await env.DB.prepare(`
        INSERT INTO benefit_templates (code, memo, tag)
        VALUES (?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET memo = excluded.memo, tag = excluded.tag, updated_at = datetime('now')
      `).bind(row.code, row.memo, row.tag).run();
    }
    await env.DB.prepare('DELETE FROM benefit_expirations WHERE id = ?').bind(id).run();
    return json({ success: true });
  }

  // GET /api/benefit-templates/:code
  const benefitTmplMatch = path.match(/^\/api\/benefit-templates\/(\d{4})$/);
  if (benefitTmplMatch && method === 'GET') {
    const row = await env.DB.prepare('SELECT memo, tag FROM benefit_templates WHERE code = ?').bind(benefitTmplMatch[1]).first();
    return json(row ?? null);
  }

  // GET /api/incentive-info/:code?shares=N
  const incentiveInfoMatch = path.match(/^\/api\/incentive-info\/(\d{4})$/);
  if (incentiveInfoMatch && method === 'GET') {
    const reqUrl = new URL(request.url);
    const shares = parseInt(reqUrl.searchParams.get('shares')) || 0;
    const text = await scrapeIncentiveInfo(incentiveInfoMatch[1], shares);
    return json({ text: text ?? null });
  }

  // ── ウォッチリスト CRUD ───────────────────────────────────────────────────────

  // GET /api/watchlist
  if (path === '/api/watchlist' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM watchlist ORDER BY created_at ASC'
    ).all();
    return json(results);
  }

  // POST /api/watchlist
  if (path === '/api/watchlist' && method === 'POST') {
    const { code, company_name = '', status = 'watching', shares = 0,
            avg_price = null, benefit_months = '[]', dividend_months = '[]', dividend_yield = null, memo = '' } = await request.json();
    if (!code || !/^\d{4}$/.test(String(code))) return err('証券コードは4桁の数字で入力してください');
    await env.DB.prepare(
      'INSERT INTO watchlist (code, company_name, status, shares, avg_price, benefit_months, dividend_months, dividend_yield, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(code, company_name, status, shares, avg_price, benefit_months, dividend_months, dividend_yield, memo).run();
    return json({ success: true });
  }

  // PUT /api/watchlist/:id
  const watchUpdateMatch = path.match(/^\/api\/watchlist\/(\d+)$/);
  if (watchUpdateMatch && method === 'PUT') {
    const { company_name = '', status = 'watching', shares = 0,
            avg_price = null, benefit_months = '[]', dividend_months = '[]', dividend_yield = null, memo = '' } = await request.json();
    await env.DB.prepare(`
      UPDATE watchlist SET company_name=?, status=?, shares=?, avg_price=?,
        benefit_months=?, dividend_months=?, dividend_yield=?, memo=?, updated_at=datetime('now')
      WHERE id=?
    `).bind(company_name, status, shares, avg_price, benefit_months, dividend_months, dividend_yield, memo, watchUpdateMatch[1]).run();
    return json({ success: true });
  }

  // DELETE /api/watchlist/:id
  const watchDeleteMatch = path.match(/^\/api\/watchlist\/(\d+)$/);
  if (watchDeleteMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM watchlist WHERE id=?').bind(watchDeleteMatch[1]).run();
    return json({ success: true });
  }

  // GET /api/watch-info/:code
  const watchInfoMatch = path.match(/^\/api\/watch-info\/(\d{4})$/);
  if (watchInfoMatch && method === 'GET') {
    try {
      const data = await scrapeWatchInfo(watchInfoMatch[1]);
      return json(data);
    } catch (e) {
      return err(`データ取得エラー: ${e.message}`, 500);
    }
  }

  // ── LINE 通知 ─────────────────────────────────────────────────────────────────

  // POST /api/notify/test（LINE にテスト通知を送る）
  if (path === '/api/notify/test' && method === 'POST') {
    try {
      await sendLine(env, '恩株管理ツールからのテスト通知です。\nこのメッセージが届いていれば、恩株売値に到達したときの通知も届きます。');
      return json({ ok: true });
    } catch (e) {
      return err(e.message, 500);
    }
  }

  // POST /api/notify/run（定期チェックを今すぐ実行する。到達した銘柄があれば通知も送る）
  if (path === '/api/notify/run' && method === 'POST') {
    return json(await runOnkabuCheck(env, notifyDeps));
  }

  return err('Not Found', 404);
}

// ─── 通知の定期チェック用：株価・会社名だけを軽く取得 ───────────────────────────
// Workers 無料プランは 1 回の実行で外部取得 50 回までなので、scrapeStock（最大 4 回）は使わない

async function fetchClosingPrice(code) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?interval=1d&range=1d`,
      { headers: { ...BROWSER_HEADERS, Accept: 'application/json',
                   Origin: 'https://finance.yahoo.com', Referer: 'https://finance.yahoo.com/' } },
    );
    if (res.ok) {
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      const p = meta?.regularMarketPrice ?? meta?.previousClose ?? null;
      if (p != null) return p;
    }
  } catch {}
  try {
    const res = await fetch(`https://www.google.com/finance/quote/${code}:TYO`, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/<div class="YMlKec fxKbKc">(.*?)<\/div>/);
      if (m) {
        const v = parseFloat(m[1].replace(/[¥,\s]/g, ''));
        if (!isNaN(v)) return v;
      }
      const m2 = html.match(/data-last-price="([\d.]+)"/);
      if (m2) return parseFloat(m2[1]);
    }
  } catch {}
  return null;
}

async function fetchCompanyName(code) {
  try {
    const res = await fetch(`https://finance.yahoo.co.jp/quote/${code}.T`, { headers: BROWSER_HEADERS });
    if (!res.ok) return null;
    const m = (await res.text()).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? (cleanCompanyName(m[1]) || null) : null;
  } catch { return null; }
}

const notifyDeps = { fetchPrice: fetchClosingPrice, fetchName: fetchCompanyName };

// ─── 認証（APP_PASSWORD による簡易ログイン）──────────────────────────────────

const AUTH_COOKIE = 'onkabu_auth';
const AUTH_MAX_AGE = 30 * 24 * 60 * 60; // 30日

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 長さや内容で処理時間が変わらないよう、両方を HMAC してから比較する
async function safeEqual(a, b) {
  const k = 'onkabu-compare';
  const [ha, hb] = await Promise.all([hmacHex(k, a), hmacHex(k, b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

// トークン = 有効期限.署名。パスワードを変えると既存のログインはすべて無効になる
async function makeToken(env) {
  const exp = Math.floor(Date.now() / 1000) + AUTH_MAX_AGE;
  return `${exp}.${await hmacHex(env.APP_PASSWORD, `v1:${exp}`)}`;
}

async function isAuthenticated(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
  if (!m) return false;
  const [expStr, sig] = m[1].split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now() / 1000) return false;
  return safeEqual(sig, await hmacHex(env.APP_PASSWORD, `v1:${exp}`));
}

function authCookie(token) {
  return `${AUTH_COOKIE}=${token}; Path=/; Max-Age=${AUTH_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function clearAuthCookie() {
  return `${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(location, setCookie) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(null, { status: 303, headers });
}

async function handleLogin(request, env) {
  let password = '';
  try {
    const form = await request.formData();
    password = String(form.get('password') || '');
  } catch { /* 空として扱う */ }

  if (password && (await safeEqual(password, env.APP_PASSWORD))) {
    return redirect('/', authCookie(await makeToken(env)));
  }
  // 総当たり対策として失敗時は1秒待たせる
  await new Promise(r => setTimeout(r, 1000));
  return loginPage('パスワードが違います', 401);
}

function loginPage(message = '', status = 200) {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>ログイン - 恩株管理ツール</title>
  <style>
    :root { --primary:#1d4ed8; --bg:#f1f5f9; --surface:#fff; --border:#cbd5e1; --text:#0f172a; --sub:#475569; --danger:#dc2626; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      padding:16px; background:var(--bg); color:var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif; }
    form { width:100%; max-width:340px; background:var(--surface); border-radius:12px; padding:28px 24px;
      box-shadow:0 4px 16px rgba(0,0,0,.08); }
    h1 { font-size:18px; margin:0 0 4px; }
    p.sub { font-size:13px; color:var(--sub); margin:0 0 20px; }
    label { display:block; font-size:13px; color:var(--sub); margin-bottom:6px; }
    input { width:100%; font-size:16px; padding:10px 12px; border:1px solid var(--border); border-radius:8px; }
    input:focus { outline:2px solid var(--primary); outline-offset:-1px; border-color:transparent; }
    button { width:100%; margin-top:16px; padding:11px; font-size:15px; font-weight:600; color:#fff;
      background:var(--primary); border:0; border-radius:8px; cursor:pointer; }
    .error { color:var(--danger); font-size:13px; margin:12px 0 0; }
  </style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>恩株管理ツール</h1>
    <p class="sub">パスワードを入力してください</p>
    <label for="password">パスワード</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    ${message ? `<p class="error">${message}</p>` : ''}
    <button type="submit">ログイン</button>
  </form>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ─── エントリポイント ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // パスワード未設定のときは誰も入れないようにする（設定漏れで公開状態にならないように）
    if (!env.APP_PASSWORD) {
      return new Response(
        'APP_PASSWORD が設定されていません。npx wrangler secret put APP_PASSWORD で設定してください。',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }

    if (path === '/login') {
      if (request.method === 'POST') return handleLogin(request, env);
      return loginPage();
    }
    if (path === '/logout' && request.method === 'POST') {
      return redirect('/login', clearAuthCookie());
    }

    if (!(await isAuthenticated(request, env))) {
      if (path.startsWith('/api/')) return err('ログインが必要です', 401);
      return redirect('/login');
    }

    if (path.startsWith('/api/')) {
      try {
        return await handleApi(request, env, path);
      } catch (e) {
        return err(`サーバーエラー: ${e.message}`, 500);
      }
    }

    // 静的ファイル（public/ ディレクトリ）を配信
    return env.ASSETS.fetch(request);
  },

  // Cron Trigger（wrangler.toml の [triggers]）：取引時間中 30 分ごとに恩株売値の到達を確認
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runOnkabuCheck(env, notifyDeps)
        .then(r => console.log('onkabu-check', JSON.stringify(r)))
        .catch(e => console.error('onkabu-check failed', e)),
    );
  },
};
