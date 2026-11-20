/**
 * 東京証券取引所の営業日判定
 *
 * 休業日 = 土日・国民の祝日（振替休日・国民の休日を含む）・12/31・1/1〜1/3
 * 祝日は「国民の祝日に関する法律」のルールから計算する（外部サービスに依存しない）。
 * 春分・秋分の日は 1980〜2099 年で使える近似式による（実際の日付は前年 2 月の官報で確定する）。
 * 法改正や特例（五輪の移動など）があったときはここを直すこと。
 */

const pad = n => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// その月の第 n 月曜日
function nthMonday(y, m, n) {
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const firstMonday = 1 + ((8 - firstDow) % 7);
  return firstMonday + (n - 1) * 7;
}

function springEquinoxDay(y) {
  return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}
function autumnEquinoxDay(y) {
  return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

const cache = new Map();

/** その年の祝日（振替休日・国民の休日を含む）を "YYYY-MM-DD" の Set で返す。2020 年以降が対象 */
export function japaneseHolidays(y) {
  if (cache.has(y)) return cache.get(y);
  const base = [
    [1, 1],                         // 元日
    [1, nthMonday(y, 1, 2)],        // 成人の日
    [2, 11],                        // 建国記念の日
    [2, 23],                        // 天皇誕生日
    [3, springEquinoxDay(y)],       // 春分の日
    [4, 29],                        // 昭和の日
    [5, 3], [5, 4], [5, 5],         // 憲法記念日・みどりの日・こどもの日
    [7, nthMonday(y, 7, 3)],        // 海の日
    [8, 11],                        // 山の日
    [9, nthMonday(y, 9, 3)],        // 敬老の日
    [9, autumnEquinoxDay(y)],       // 秋分の日
    [10, nthMonday(y, 10, 2)],      // スポーツの日
    [11, 3],                        // 文化の日
    [11, 23],                       // 勤労感謝の日
  ];
  const set = new Set(base.map(([m, d]) => key(y, m, d)));

  // 国民の休日：前後を祝日に挟まれた平日（実際には敬老の日と秋分の日の間で起きる）
  for (const [m, d] of base) {
    const t = new Date(Date.UTC(y, m - 1, d + 2));
    const mid = new Date(Date.UTC(y, m - 1, d + 1));
    const midKey = key(mid.getUTCFullYear(), mid.getUTCMonth() + 1, mid.getUTCDate());
    if (set.has(key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()))
        && !set.has(midKey) && mid.getUTCDay() !== 0) {
      set.add(midKey);
    }
  }

  // 振替休日：祝日が日曜なら、その後の最初の「祝日でない日」が休日
  for (const k of [...set].sort()) {
    const [yy, mm, dd] = k.split('-').map(Number);
    if (new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay() !== 0) continue;
    let n = 1;
    let next;
    do {
      const t = new Date(Date.UTC(yy, mm - 1, dd + n++));
      next = key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    } while (set.has(next));
    set.add(next);
  }

  cache.set(y, set);
  return set;
}

/** 日本時間での年月日・曜日 */
export function jstParts(date) {
  const j = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate(), dow: j.getUTCDay() };
}

/** 東証の休業日なら理由（'土日' / '祝日' / '年末年始'）、営業日なら null */
export function tseClosedReason(date) {
  const { y, m, d, dow } = jstParts(date);
  if (dow === 0 || dow === 6) return '土日';
  if ((m === 12 && d === 31) || (m === 1 && d <= 3)) return '年末年始';
  if (japaneseHolidays(y).has(key(y, m, d))) return '祝日';
  return null;
}
