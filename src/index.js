/**
 * 恩株管理ツール - Cloudflare Worker
 * REST API + Yahoo Finance Japan / Google Finance スクレイピングプロキシ
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
    headers: { 'Content-Type': 'application/json', ...CORS },
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

async function scrapeStock(code) {
  // ── Step1: Yahoo Finance グローバル JSON API（最も信頼性が高い）─────────────
  // 終値・会社名・配当利回りを JSON で取得
  let companyName = null;
  let closingPrice = null;
  let yieldValue = null;
  let dividendPerShare = null;

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
      if (meta) {
        closingPrice      = meta.regularMarketPrice       ?? meta.previousClose ?? null;
        // 会社名は英語になるため、Yahoo Finance Japan から別途取得する
        dividendPerShare  = meta.trailingAnnualDividendRate  || null;
        yieldValue        = meta.trailingAnnualDividendYield != null
                            ? meta.trailingAnnualDividendYield * 100
                            : null;
      }
    }
  } catch {
    // JSON API 失敗 → 次のフォールバックへ
  }

  // ── Step2: Yahoo Finance Japan 配当ページ（配当予想・利回りの精度向上）────
  try {
    const divUrl = `https://finance.yahoo.co.jp/quote/${code}.T/dividend`;
    const divRes = await fetch(divUrl, { headers: BROWSER_HEADERS });
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
  } catch {
    // フォールバック失敗は無視
  }

  // ── Step3: Yahoo Finance Japan ベースページから日本語会社名を取得 ───────────
  {
    try {
      const baseRes = await fetch(
        `https://finance.yahoo.co.jp/quote/${code}.T`,
        { headers: BROWSER_HEADERS }
      );
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
    } catch {
      // フォールバック失敗は無視
    }
  }

  // ── Step4: 終値がまだ null なら Google Finance を試みる ────────────────────
  if (closingPrice === null) {
    try {
      const gRes = await fetch(
        `https://www.google.com/finance/quote/${code}:TYO`,
        { headers: BROWSER_HEADERS }
      );
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
    } catch {
      // フォールバック失敗は無視
    }
  }

  return {
    companyName: companyName || code,
    closingPrice,
    yieldValue,
    dividendPerShare,
    fetchedAt: new Date().toISOString(),
  };
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

    // ページ本文テキストを抽出
    let text = '';
    await new HTMLRewriter()
      .on('body', { text(chunk) { if (chunk.text) text += chunk.text; } })
      .transform(new Response(html))
      .arrayBuffer();

    // 行分割・フィルタリング
    const lines = text
      .split(/[\n。]/)
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length >= 6 && s.length <= 200);

    // 優待関連行を抽出
    const relevant = lines.filter(s =>
      /(優待|割引券|食事券|商品券|ギフト|カタログ|クーポン|ポイント|円分|無料|サービス|お食事|お買い物)/.test(s) &&
      /\d/.test(s)
    );
    if (!relevant.length) return null;

    // 保有株数に対応したティアを選択
    if (shares > 0) {
      const tiers = relevant
        .map(line => {
          const m = line.match(/(\d[\d,]*)\s*(株|単元)/);
          const threshold = m
            ? parseInt(m[1].replace(/,/g, '')) * (m[2] === '単元' ? 100 : 1)
            : 0;
          return { line, threshold };
        })
        .filter(t => t.threshold > 0 && t.threshold <= shares)
        .sort((a, b) => b.threshold - a.threshold);
      if (tiers.length) return tiers[0].line;
    }

    return relevant.slice(0, 3).join('\n');
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

  return err('Not Found', 404);
}

// ─── エントリポイント ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
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
};
