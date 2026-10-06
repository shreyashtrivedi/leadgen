import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/env.js";
import { extractHospitals } from "./lib/extract.js";
import { collapseWs, extractPincode, normalizePhone, nullIfEmpty } from "./lib/text.js";
import { nowIso } from "./lib/text.js";

const TABLE_HEADER = /\|\s*#\s*\|\s*ProviderName/i;

export function parseLocalHospitalMarkdown(filePath, sourceKey, sourceUrl) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  if (!fs.existsSync(abs)) return [];
  const text = fs.readFileSync(abs, "utf8");
  const scraped_at = nowIso();
  const rows = [];
  const lines = text.split(/\r?\n/);
  let inTable = false;
  for (const line of lines) {
    if (TABLE_HEADER.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // leading empty from leading pipe
    const parts = cells[0] === "" ? cells.slice(1) : cells;
    if (parts.length < 4) continue;
    if (/^[-:\s|]+$/.test(line)) continue;
    const num = parts[0];
    if (!/^\d+$/.test(num)) continue;
    const hospital_name = collapseWs(parts[1]);
    if (!hospital_name) continue;
    const city = nullIfEmpty(parts[2]);
    const address = nullIfEmpty(parts[3]);
    const phone = normalizePhone(parts[5] || "");
    rows.push({
      source_key: sourceKey,
      source_url: sourceUrl,
      hospital_name,
      hospital_type: null,
      bed_count: null,
      address,
      locality: null,
      city,
      district: address && /dist\s+([^,]+)/i.test(address) ? collapseWs(RegExp.$1) : null,
      pincode: extractPincode(address),
      switchboard_phone: phone,
      generic_email: null,
      website: null,
      nabh_accredited: null,
      scraped_at,
      contact_person: nullIfEmpty(parts[4]),
    });
  }
  return rows;
}

export function canaryScore({ markdown, rows, loginWall }) {
  const reasons = [];
  if (loginWall) reasons.push("login_or_captcha");
  if ((markdown || "").length < 500) reasons.push(`markdown_lt_500 (${(markdown || "").length})`);
  if (rows.length < 10) reasons.push(`karnataka_rows_lt_10 (${rows.length})`);
  return {
    pass: reasons.length === 0,
    reasons,
    markdown_len: (markdown || "").length,
    row_count: rows.length,
  };
}

export function rowsFromScrape(scrapeResult, sourceMeta) {
  return extractHospitals({
    json: scrapeResult.json,
    markdown: scrapeResult.markdown,
    source: sourceMeta,
  });
}
