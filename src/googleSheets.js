/**
 * googleSheets.js
 * ------------------------------------------------------------------
 * Đọc dữ liệu từ các tab Google Sheet công khai (Anyone with link —
 * Viewer) thông qua endpoint xuất CSV "gviz" của Google — không cần
 * API key, không cần service account.
 *
 * Giới hạn: chỉ đọc được sheet đã bật chia sẻ công khai dạng xem.
 * Nếu sau này chuyển sang sheet riêng tư, thay fetchCsv() bằng gọi
 * Google Sheets API v4 kèm API key hoặc service account.
 * ------------------------------------------------------------------
 */

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 phút — đủ mới cho dashboard, tránh gọi Google liên tục
const cache = new Map(); // key: `${spreadsheetId}:${gid}` -> { rows, expiresAt }

/** Parse 1 dòng CSV theo chuẩn RFC 4180 (xử lý dấu phẩy/ngoặc kép trong ô). */
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** Parse toàn bộ CSV (đa dòng, hỗ trợ xuống dòng trong ô có ngoặc kép). */
function parseCsv(text) {
  const rows = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === '\n' && !inQuotes) {
      rows.push(cur);
      cur = '';
    } else if (ch !== '\r' || inQuotes) {
      cur += ch;
    }
  }
  if (cur.trim()) rows.push(cur);
  return rows.map(parseCsvLine);
}

async function fetchCsv(spreadsheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Không đọc được Google Sheet (spreadsheetId=${spreadsheetId}, gid=${gid}): HTTP ${res.status}`);
  }
  const text = await res.text();
  if (text.trim().startsWith('<')) {
    throw new Error(`Google Sheet (spreadsheetId=${spreadsheetId}, gid=${gid}) không công khai hoặc không tồn tại`);
  }
  return text;
}

/**
 * Đọc 1 tab của Google Sheet, trả về mảng object theo dòng tiêu đề (row 1).
 * Bỏ qua các cột tiêu đề rỗng (Google Sheet thường có nhiều cột trống thừa).
 */
async function fetchSheetObjects(spreadsheetId, gid) {
  const cacheKey = `${spreadsheetId}:${gid}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const csvText = await fetchCsv(spreadsheetId, gid);
  const table = parseCsv(csvText);
  if (!table.length) {
    cache.set(cacheKey, { rows: [], expiresAt: Date.now() + CACHE_TTL_MS });
    return [];
  }

  const headers = table[0].map((h) => h.trim());
  const rows = table.slice(1)
    .filter((cols) => cols.some((c) => c.trim() !== ''))
    .map((cols) => {
      const obj = {};
      headers.forEach((header, i) => {
        if (!header) return; // bỏ cột tiêu đề rỗng
        obj[header] = (cols[i] ?? '').trim();
      });
      return obj;
    });

  cache.set(cacheKey, { rows, expiresAt: Date.now() + CACHE_TTL_MS });
  return rows;
}

/* ======================== Helpers parse số/ngày ======================== */

/** "5,824" | "96.08%" | "99,810,889" -> number (bỏ dấu phẩy nghìn + ký hiệu %) */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value).replace(/,/g, '').replace('%', '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "2026/06/29" -> Date */
function parseYmdSlash(value) {
  const m = String(value).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** "7/1/2026" (M/D/YYYY) -> Date */
function parseMdySlash(value) {
  const m = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

/** "20/07/2026" (D/M/YYYY) -> Date */
function parseDmySlash(value) {
  const m = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

const MONTH_ABBR = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "01-May-26" -> Date */
function parseDdMonYy(value) {
  const m = String(value).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (!m || !(m[2] in MONTH_ABBR)) return null;
  return new Date(2000 + Number(m[3]), MONTH_ABBR[m[2]], Number(m[1]));
}

function fmtDateVN(date) {
  if (!date) return null;
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function isSameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

module.exports = {
  fetchSheetObjects,
  toNumber,
  parseYmdSlash,
  parseMdySlash,
  parseDmySlash,
  parseDdMonYy,
  fmtDateVN,
  isSameDay,
};
