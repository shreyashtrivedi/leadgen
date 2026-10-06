import { readCsvFile, writeCsvFile } from "./lib/csv.js";
import { HOSPITALS_HEADERS, CONTACTS_HEADERS } from "./config.js";
import { otherStateNotKarnataka, isPlausibleHospitalName, looksKarnataka, normalizeDomain, websiteFromRaw, slugPerson, normalizePhone, tokenSortRatio } from "./lib/text.js";
import { classifyRole } from "./stages/contacts.js";
import { parseLocalHospitalMarkdown } from "./adapter.js";
import { dedupeHospitals } from "./stages/dedupe.js";
import { scoreHospitals } from "./stages/score.js";

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

export function cleanRawRow(payload, fallbackUrl) {
  const row = { ...payload };
  row.source_url = row.source_url || fallbackUrl;
  if (!isPlausibleHospitalName(row.hospital_name)) return null;
  if (/^\*/.test(String(row.hospital_name || "").trim()) || /\*\*/.test(String(row.hospital_name || ""))) {
    return null;
  }
  if (otherStateNotKarnataka(row)) return null;
  const kaSources = new Set(["phana_members", "insurer_network", "kpme_beds", "pmjay_karnataka"]);
  if (!looksKarnataka(row, "")) {
    if (row.city || row.pincode || row.address) return null;
    if (!kaSources.has(row.source_key)) return null;
  }
  const site = websiteFromRaw(row.website);
  const host = normalizeDomain(site);
  if (host && DIRECTORY_HOSTS.has(host)) {
    row.website = null;
    row.domain = null;
  }
  return row;
}

export function loadRawHospitals(store) {
  const { rows } = readCsvFile(store.files.raw);
  const out = [];
  for (const r of rows) {
    let payload;
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      continue;
    }
    const cleaned = cleanRawRow(payload, r.source_url);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

export function mergeLocalInsurer(existing) {
  const local = parseLocalHospitalMarkdown(
    "bangalore-hospital-list.md",
    "insurer_network",
    "https://www.scribd.com/document/557856549/Bangalore-Hospital-List"
  );
  return [...existing, ...local];
}

function seedContact(hospital) {
  const raw = hospital._contact_person;
  if (!raw) return null;
  const m = String(raw).split(/[-–—]/);
  const name = m[0].trim();
  const designation = m.slice(1).join("-").trim();
  if (!name || name.length < 3 || /^(\.|0+)$/.test(name)) return null;
  const role = classifyRole(designation, "");
  const phone = normalizePhone(hospital.switchboard_phone);
  return {
    contact_id: `${hospital.hospital_id}-${slugPerson(name)}-${role}`,
    hospital_id: hospital.hospital_id,
    person_name: name,
    designation,
    department: "",
    role_bucket: role,
    direct_phone: phone || "",
    mobile: phone && /^[6-9]/.test(phone) ? phone : "",
    email: hospital.generic_email || "",
    contact_source_url: (hospital.source_urls || "").split("|")[0],
    extraction_confidence: "source_index",
    verified_by_call: "",
    call_status: "",
    call_notes: "",
    last_touch_date: "",
  };
}

function applyWebsiteFromContact(contact, hospital) {
  if (!hospital || hospital.website) return;
  if (contact.extraction_confidence === "source_index") return;
  const site = websiteFromRaw(contact.contact_source_url);
  const host = normalizeDomain(site);
  if (site && host && !DIRECTORY_HOSTS.has(host)) {
    hospital.website = site;
    hospital.domain = host;
  }
}

function remapContacts(oldContacts, hospitals) {
  const byId = new Map(hospitals.map((h) => [h.hospital_id, h]));
  const out = [];
  for (const c of oldContacts) {
    if (byId.has(c.hospital_id)) {
      applyWebsiteFromContact(c, byId.get(c.hospital_id));
      out.push(c);
      continue;
    }
    let best = null;
    let bestR = 0;
    const needle = String(c.hospital_id || "").replace(/-nopin$/, "").replace(/-/g, " ");
    for (const h of hospitals) {
      const r = tokenSortRatio(needle, h.hospital_name);
      if (r > bestR) {
        bestR = r;
        best = h;
      }
    }
    if (best && bestR >= 88) {
      applyWebsiteFromContact(c, best);
      const role = c.role_bucket || "other";
      out.push({
        ...c,
        hospital_id: best.hospital_id,
        contact_id: `${best.hospital_id}-${slugPerson(c.person_name)}-${role}`,
      });
    }
  }
  return out;
}

export function reprocessOffline(store) {
  const fromRaw = loadRawHospitals(store);
  const merged = mergeLocalInsurer(fromRaw);
  const dedupe = dedupeHospitals(merged);
  const { rows: oldContacts } = readCsvFile(store.files.contacts);
  const remapped = remapContacts(oldContacts, dedupe.records);
  const seeds = dedupe.records.map(seedContact).filter(Boolean);
  const uniq = new Map();
  for (const c of [...remapped, ...seeds]) {
    if (c.contact_id && !uniq.has(c.contact_id)) uniq.set(c.contact_id, c);
  }
  const keptContacts = [...uniq.values()];
  const flags = new Map();
  for (const c of keptContacts) {
    if (!flags.has(c.hospital_id)) flags.set(c.hospital_id, { hasVendorPage: false, roles: [] });
    const f = flags.get(c.hospital_id);
    if (!f.roles.includes(c.role_bucket)) f.roles.push(c.role_bucket);
  }
  const scored = scoreHospitals(dedupe.records, keptContacts, flags).map(
    ({ _contact_person, _merge_reason, ...row }) => row
  );
  writeCsvFile(store.files.hospitals, HOSPITALS_HEADERS, scored);
  writeCsvFile(store.files.contacts, CONTACTS_HEADERS, keptContacts);
  return {
    fromRaw: fromRaw.length,
    localAdded: merged.length - fromRaw.length,
    dedupe,
    scored,
    contacts: keptContacts.length,
  };
}

