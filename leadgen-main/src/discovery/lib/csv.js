import fs from "node:fs";
import path from "node:path";

/** RFC 4180 field escape. */
export function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function stringifyCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function parseCsv(text) {
  if (!text || !text.trim()) return { headers: [], rows: [] };
  const rows = [];
  let i = 0;
  const len = text.length;

  const nextRow = () => {
    const fields = [];
    let field = "";
    let inQuotes = false;
    while (i < len) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (c === ",") {
        fields.push(field);
        field = "";
        i += 1;
        continue;
      }
      if (c === "\r") {
        i += 1;
        continue;
      }
      if (c === "\n") {
        fields.push(field);
        i += 1;
        return fields;
      }
      field += c;
      i += 1;
    }
    if (field.length || fields.length) fields.push(field);
    return fields.length ? fields : null;
  };

  const headerFields = nextRow();
  if (!headerFields) return { headers: [], rows: [] };
  const headers = headerFields.map((h) => h.trim());
  while (i < len) {
    const fields = nextRow();
    if (!fields) break;
    if (fields.length === 1 && fields[0] === "" && i >= len) break;
    if (fields.every((f) => f === "")) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) obj[headers[c]] = fields[c] ?? "";
    rows.push(obj);
  }
  return { headers, rows };
}

export function readCsvFile(filePath) {
  if (!fs.existsSync(filePath)) return { headers: [], rows: [] };
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

export function writeCsvFile(filePath, headers, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyCsv(headers, rows), "utf8");
}

/**
 * Idempotent upsert: merge on composite key, rewrite whole file.
 * `keyFn(row) => string`
 */
export function upsertCsv(filePath, headers, incoming, keyFn) {
  const existing = readCsvFile(filePath);
  const map = new Map();
  for (const row of existing.rows) {
    const k = keyFn(row);
    if (k) map.set(k, { ...row });
  }
  let inserted = 0;
  let updated = 0;
  for (const row of incoming) {
    const k = keyFn(row);
    if (!k) continue;
    if (map.has(k)) {
      map.set(k, { ...map.get(k), ...row });
      updated += 1;
    } else {
      map.set(k, { ...row });
      inserted += 1;
    }
  }
  const rows = [...map.values()];
  writeCsvFile(filePath, headers, rows);
  return { inserted, updated, total: rows.length };
}

export function pipeJoin(values) {
  const parts = [...new Set((values || []).filter((v) => v !== null && v !== undefined && String(v).trim() !== ""))];
  return parts.map((v) => String(v).replace(/\|/g, "/")).join("|");
}

export function pipeSplit(value) {
  if (!value) return [];
  return String(value)
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}
