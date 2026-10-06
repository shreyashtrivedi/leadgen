import {
  collapseWs,
  nullIfEmpty,
  extractPincode,
  looksKarnataka,
  otherStateNotKarnataka,
  pageIsKarnatakaScoped,
  normalizePhone,
  websiteFromRaw,
  isPlausibleHospitalName,
  normalizeDomain,
} from "./text.js";

const NAME_LINE_RE =
  /^\s*(?:[-*•]|\d+[.)])\s+(.{3,120}?(?:hospital|nursing home|medical centre|medical center|clinic|healthcare|health care|institute|nethralaya|netralaya))\b/i;

const DIRECTORY_HOSTS = new Set([
  "nabh.co",
  "qualityhealth.in",
  "hexahealth.com",
  "medasus.com",
  "bengaluruurban.nic.in",
  "starhealth.in",
  "newindia.co.in",
  "naukri.com",
  "scribd.com",
  "phana.org",
  "cmai.org",
  "chai-india.org",
]);

function hospitalWebsite(raw, sourceUrl) {
  const site = websiteFromRaw(raw);
  if (!site) return null;
  const host = normalizeDomain(site);
  if (host && DIRECTORY_HOSTS.has(host)) return null;
  const srcHost = normalizeDomain(sourceUrl);
  if (host && srcHost && host === srcHost && DIRECTORY_HOSTS.has(srcHost)) return null;
  return site;
}

function coerceHospital(obj, source, pageHint) {
  if (!obj || typeof obj !== "object") return null;
  const name =
    obj.hospital_name ||
    obj.name ||
    obj.hospital ||
    obj.provider_name ||
    obj.ProviderName ||
    obj.institution ||
    obj.company ||
    obj.employer;
  if (!name || String(name).length < 3) return null;
  if (!isPlausibleHospitalName(name)) return null;
  if (/^\*/.test(String(name).trim()) || /\*\*/.test(String(name))) return null;
  const address = obj.address || obj.Address || obj.location || null;
  const city = obj.city || obj.City || obj.town || null;
  const pincode = extractPincode(obj.pincode || obj.pin || obj.Address || address || "") || null;
  const bedsRaw = obj.bed_count ?? obj.beds ?? obj.bedCount;
  const beds = bedsRaw === null || bedsRaw === undefined || bedsRaw === "" ? null : Number(bedsRaw);
  const row = {
    source_key: source.source_key,
    source_url: source.source_url,
    hospital_name: collapseWs(name).replace(/^\*+\s*/, ""),
    hospital_type: nullIfEmpty(obj.hospital_type || obj.type),
    bed_count: Number.isFinite(beds) ? beds : null,
    address: nullIfEmpty(address),
    locality: nullIfEmpty(obj.locality),
    city: nullIfEmpty(city),
    district: nullIfEmpty(obj.district),
    pincode,
    switchboard_phone: normalizePhone(obj.switchboard_phone || obj.phone || obj.contact_number || obj.ContactNumber),
    generic_email: nullIfEmpty(obj.generic_email || obj.email),
    website: hospitalWebsite(obj.website || obj.url || obj.web, source.source_url),
    nabh_accredited:
      obj.nabh_accredited === true ||
      obj.nabh_accredited === "true" ||
      source.source_key === "nabh_karnataka" ||
      null,
    scraped_at: source.scraped_at,
  };
  if (otherStateNotKarnataka(row)) return null;
  if (!looksKarnataka(row, "")) {
    const pageKa = /karnataka|bengaluru|bangalore/i.test(`${source.source_url}\n${(pageHint || "").slice(0, 2000)}`);
    if (!pageKa) return null;
    if (row.city || row.address || row.pincode) return null;
  }
  return row;
}

function walkHospitalArrays(json) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === "object") out.push(node);
      for (const x of node) visit(x);
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node)) visit(v);
    }
  };
  visit(json);
  return out;
}

export function hospitalsFromJson(json, source, pageHint) {
  if (!json) return [];
  const rows = [];
  const arrays = walkHospitalArrays(json);
  const preferred = arrays.find((a) =>
    a.some((x) => x && (x.hospital_name || x.provider_name || x.name))
  );
  const use = preferred ? [preferred] : arrays.slice(0, 1);
  for (const arr of use) {
    for (const item of arr) {
      const row = coerceHospital(item, source, pageHint);
      if (row) rows.push(row);
    }
  }
  if (!rows.length && json.hospital_name) {
    const row = coerceHospital(json, source, pageHint);
    if (row) rows.push(row);
  }
  return rows;
}

export function hospitalsFromMarkdown(markdown, source) {
  const rows = [];
  const seen = new Set();
  const hint = markdown || "";
  const lines = String(markdown || "").split(/\r?\n/);

  // pipe tables
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === "") && !(i === a.length - 1 && c === ""));
    if (cells.length < 2) continue;
    if (cells.every((c) => /^[-:]+$/.test(c))) continue;
    if (/^#+$/.test(cells[0]) || /^providername$/i.test(cells[0])) continue;
    const nameCell = cells.find((c, idx) => idx <= 2 && /hospital|clinic|nursing|nethralaya|healthcare|institute|centre|center/i.test(c)) || cells[1] || cells[0];
    if (!nameCell || nameCell.length < 4) continue;
    if (/^[\d.#\s]+$/.test(nameCell)) continue;
    const address = cells.slice(2).join(" ");
    const row = coerceHospital(
      {
        hospital_name: nameCell.replace(/^\d+\s*/, ""),
        address,
        city: cells.find((c) => /bengaluru|bangalore|mysuru|hubli/i.test(c)),
        switchboard_phone: cells.find((c) => /\d{6,}/.test(c)),
      },
      source,
      hint
    );
    if (row && !seen.has(row.hospital_name.toLowerCase())) {
      seen.add(row.hospital_name.toLowerCase());
      rows.push(row);
    }
  }

  for (const line of lines) {
    const m = line.match(NAME_LINE_RE);
    if (!m) continue;
    const row = coerceHospital({ hospital_name: m[1], address: line }, source, hint);
    if (row && !seen.has(row.hospital_name.toLowerCase())) {
      seen.add(row.hospital_name.toLowerCase());
      rows.push(row);
    }
  }

  if (rows.length < 10 && pageIsKarnatakaScoped(markdown, source.source_url)) {
    const re = /\b([A-Z][A-Za-z0-9&.''\-\s]{2,70}\s(?:Hospital|Hospitals|Clinic|Nursing Home|Medical Centre|Medical Center|Nethralaya|Netralaya|Healthcare|Institute))\b/g;
    let m;
    while ((m = re.exec(markdown || ""))) {
      const row = coerceHospital({ hospital_name: collapseWs(m[1]) }, source, hint);
      if (row && !seen.has(row.hospital_name.toLowerCase())) {
        seen.add(row.hospital_name.toLowerCase());
        rows.push(row);
      }
    }
  }
  return rows;
}

export function extractHospitals({ json, markdown, source }) {
  const fromJson = hospitalsFromJson(json, source, markdown || "");
  if (fromJson.length >= 10) return { rows: fromJson, via: "json" };
  const fromMd = hospitalsFromMarkdown(markdown, source);
  if (fromMd.length > fromJson.length) return { rows: fromMd, via: "markdown" };
  return { rows: fromJson.length ? fromJson : fromMd, via: fromJson.length ? "json" : "markdown" };
}

export function peopleFromJson(json) {
  if (!json) return [];
  if (Array.isArray(json.people)) return json.people.filter((p) => p && (p.name || p.person_name));
  if (Array.isArray(json)) return json.filter((p) => p && (p.name || p.person_name));
  for (const v of Object.values(json)) {
    if (Array.isArray(v) && v.some((x) => x && (x.name || x.person_name))) {
      return v;
    }
  }
  return [];
}

export function markdownLinks(markdown) {
  const out = [];
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(markdown || ""))) {
    out.push({ text: m[1], url: m[2] });
  }
  return out;
}

export function detectPaginationStyle(markdown, url) {
  const u = String(url || "");
  if (/\.pdf($|\?)/i.test(u)) return "pdf";
  if (/[?&]page=\d+/i.test(u) || /page=\d+/i.test(markdown || "")) return "query_page";
  const links = markdownLinks(markdown);
  if (links.some((l) => /next|›|»/i.test(l.text) || /[?&]page=/i.test(l.url))) return "link_next";
  return "none";
}

export function nextPageUrl(url, markdown, pageNum) {
  try {
    const u = new URL(url);
    if (/[?&]page=/i.test(url) || detectPaginationStyle(markdown, url) === "query_page") {
      u.searchParams.set("page", String(pageNum));
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  const links = markdownLinks(markdown);
  const next = links.find((l) => /next|›|»/i.test(l.text));
  if (next) return next.url;
  const pageLink = links.find((l) => {
    try {
      return new URL(l.url).searchParams.get("page") === String(pageNum);
    } catch {
      return false;
    }
  });
  return pageLink?.url || null;
}
