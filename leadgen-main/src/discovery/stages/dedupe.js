import {
  hospitalId,
  normalizePhone,
  normalizeDomain,
  extractPincode,
  tokenSortRatio,
  countNonNull,
  websiteFromRaw,
  nowIso,
} from "../lib/text.js";
import { pipeJoin, pipeSplit } from "../lib/csv.js";
import { TOKEN_SORT_THRESHOLD } from "../config.js";

function isMobile(phone) {
  return Boolean(phone && String(phone).length === 10 && /^[6-9]/.test(phone));
}

function toHospitalRecord(raw, sourceUrl) {
  const name = raw.hospital_name;
  const pin = extractPincode(raw.pincode || raw.address || "") || raw.pincode || null;
  const phone = normalizePhone(raw.switchboard_phone);
  const website = websiteFromRaw(raw.website);
  const domain = normalizeDomain(website || raw.generic_email || "");
  return {
    hospital_id: hospitalId(name, pin),
    hospital_name: name,
    hospital_type: raw.hospital_type || "",
    bed_count: raw.bed_count ?? "",
    address: raw.address || "",
    locality: raw.locality || "",
    city: raw.city || "",
    district: raw.district || "",
    pincode: pin || "",
    latitude: "",
    longitude: "",
    switchboard_phone: phone || "",
    alt_phone: "",
    generic_email: raw.generic_email || "",
    website: website || "",
    domain: domain || "",
    nabh_accredited: raw.nabh_accredited === true || raw.nabh_accredited === "true" ? "true" : raw.nabh_accredited === false ? "false" : "",
    source_index: raw.source_key || "",
    source_urls: sourceUrl || raw.source_url || "",
    priority_score: "",
    needs_phone_call: "",
    scraped_at: raw.scraped_at || nowIso(),
    _contact_person: raw.contact_person || "",
  };
}

function mergePair(a, b, reason) {
  const pick = countNonNull(a) >= countNonNull(b) ? { ...a } : { ...b };
  const other = pick === a || (pick.hospital_id === a.hospital_id && pick.scraped_at === a.scraped_at) ? b : a;
  pick.source_index = pipeJoin([...pipeSplit(a.source_index), ...pipeSplit(b.source_index)]);
  pick.source_urls = pipeJoin([...pipeSplit(a.source_urls), ...pipeSplit(b.source_urls)]);
  for (const k of Object.keys(pick)) {
    if (k.startsWith("_")) continue;
    if (pick[k] === "" || pick[k] === null || pick[k] === undefined) pick[k] = other[k] ?? pick[k];
  }
  if (!pick.hospital_id) pick.hospital_id = a.hospital_id || b.hospital_id;
  pick._merge_reason = reason;
  return pick;
}

export function dedupeHospitals(rawRows) {
  const records = rawRows.map((r) => toHospitalRecord(r, r.source_url));
  const merges = [];

  const byDomain = new Map();
  const noDomain = [];
  for (const rec of records) {
    if (rec.domain) {
      const k = rec.domain;
      if (byDomain.has(k)) {
        const prev = byDomain.get(k);
        merges.push({
          key: "domain",
          kept: rec.hospital_name,
          dropped: prev.hospital_name,
          domain: k,
        });
        byDomain.set(k, mergePair(prev, rec, "domain"));
      } else byDomain.set(k, rec);
    } else noDomain.push(rec);
  }
  let pool = [...byDomain.values(), ...noDomain];

  const byPhone = new Map();
  const noPhone = [];
  for (const rec of pool) {
    if (isMobile(rec.switchboard_phone)) {
      const k = rec.switchboard_phone;
      if (byPhone.has(k)) {
        const prev = byPhone.get(k);
        merges.push({
          key: "phone",
          kept: rec.hospital_name,
          dropped: prev.hospital_name,
          phone: k,
        });
        byPhone.set(k, mergePair(prev, rec, "phone"));
      } else byPhone.set(k, rec);
    } else noPhone.push(rec);
  }
  pool = [...byPhone.values(), ...noPhone];

  const used = new Set();
  const out = [];
  for (let i = 0; i < pool.length; i += 1) {
    if (used.has(i)) continue;
    let acc = pool[i];
    for (let j = i + 1; j < pool.length; j += 1) {
      if (used.has(j)) continue;
      const b = pool[j];
      const samePin = acc.pincode && b.pincode && acc.pincode === b.pincode;
      if (!samePin) continue;
      const ratio = tokenSortRatio(acc.hospital_name, b.hospital_name);
      if (ratio >= TOKEN_SORT_THRESHOLD) {
        used.add(j);
        merges.push({
          key: "name+pincode",
          kept: acc.hospital_name,
          dropped: b.hospital_name,
          pincode: acc.pincode,
          ratio,
        });
        acc = mergePair(acc, b, "name+pincode");
      }
    }
    out.push(acc);
  }

  for (const rec of out) {
    rec.hospital_id = hospitalId(rec.hospital_name, rec.pincode);
  }

  return {
    input_count: records.length,
    output_count: out.length,
    dropped_count: records.length - out.length,
    records: out,
    merges,
  };
}
