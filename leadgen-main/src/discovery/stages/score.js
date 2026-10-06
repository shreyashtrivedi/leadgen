import { pipeSplit } from "../lib/csv.js";

function bedsScore(bedCount) {
  const n = Number(bedCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 50 && n <= 250) return 30;
  if (n >= 251 && n <= 500) return 10;
  return 0;
}

export function scoreHospitals(hospitals, contacts, websiteFlags) {
  const byHospital = new Map();
  for (const c of contacts) {
    if (!byHospital.has(c.hospital_id)) byHospital.set(c.hospital_id, []);
    byHospital.get(c.hospital_id).push(c);
  }

  const scored = hospitals.map((h) => {
    const people = byHospital.get(h.hospital_id) || [];
    const flags = websiteFlags.get(h.hospital_id) || { hasVendorPage: false, roles: [] };
    const roles = new Set([...people.map((p) => p.role_bucket), ...(flags.roles || [])]);
    const sources = pipeSplit(h.source_index);
    let score = 0;
    score += bedsScore(h.bed_count);
    if (roles.has("purchase")) score += 25;
    else if (roles.has("pharmacy")) score += 15;
    else if (roles.has("admin_exec") && !roles.has("purchase") && !roles.has("pharmacy")) score += 8;
    const hasDirect = people.some((p) => p.direct_phone || p.mobile);
    if (hasDirect) score += 15;
    if (sources.length >= 3) score += 10;
    if (h.nabh_accredited === true || h.nabh_accredited === "true") score += 10;
    if (flags.hasVendorPage) score += 10;
    const needsCall = !roles.has("purchase") && !roles.has("pharmacy");
    return {
      ...h,
      priority_score: String(score),
      needs_phone_call: needsCall ? "TRUE" : "FALSE",
    };
  });

  scored.sort((a, b) => Number(b.priority_score) - Number(a.priority_score) || a.hospital_name.localeCompare(b.hospital_name));
  return scored;
}
