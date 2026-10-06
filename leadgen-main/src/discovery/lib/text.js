const STRIP_NAME_RE =
  /\b(hospitals?|multispeciality|multi\s*speciality|multi-speciality|superspeciality|super\s*speciality|pvt|ltd|limited|private|llp)\b/gi;

export const KA_GEO_RE =
  /\b(karnataka|bengaluru|bangalore|bengalooru|mysuru|mysore|hubballi|hubli|mangaluru|mangalore|belagavi|belgaum|kalaburagi|gulbarga|ballari|bellary|davanagere|davangere|shivamogga|shimoga|tumakuru|tumkur|vijayapura|bijapur|raichur|bidar|udupi|hassan|mandya|chitradurga|kolar|chikkamagaluru|chikmagalur|kodagu|coorg|gadag|haveri|bagalkot|bagalkote|yadgir|koppal|chamarajanagar|ramanagara|chikkaballapur|dakshina\s+kannada|uttara\s+kannada|vijayanagara|madikeri|puttur|manipal|whitefield|koramangala|indiranagar|jayanagar|hebbal|yelahanka|electronic\s+city)\b/i;

export const KA_PIN_RE = /\b(5[6-9]\d{4})\b/;

export function collapseWs(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function nullIfEmpty(s) {
  const v = collapseWs(s);
  return v ? v : null;
}

export function normalizePhone(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw);

  const mobiles = text.match(/(?:\+91[\s-]*)?[6-9]\d{9}\b/g) || [];
  if (mobiles.length) {
    let d = mobiles[0].replace(/[^\d]/g, "");
    if (d.startsWith("91") && d.length > 10) d = d.slice(-10);
    return d.slice(-10);
  }

  const telChunk = text.split(/fax/i)[0];
  const grouped = telChunk.match(/\d{6,12}/g) || [];
  const std = (telChunk.match(/\b0\d{2,3}\b/) || [])[0];
  for (const g of grouped) {
    if (g.length === 10 && /^[6-9]/.test(g)) return g;
    if (g.length === 8 && std) {
      const combined = (std + g).replace(/[^\d]/g, "");
      return combined.slice(-10);
    }
    if (g.length === 10 || g.length === 11) {
      let d = g.replace(/[^\d]/g, "");
      if (d.startsWith("91") && d.length > 10) d = d.slice(-10);
      return d.slice(-10);
    }
  }

  let digits = telChunk.replace(/[^\d]/g, "");
  if (digits.startsWith("91") && digits.length >= 12) digits = digits.slice(2);
  if (digits.length > 10) digits = digits.slice(-10);
  if (digits.length < 8) return null;
  return digits;
}

export function extractPincode(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

export function normalizeDomain(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^mailto:/, "");
  if (s.includes("@") && !s.includes("://")) {
    s = s.split("@").pop();
  }
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.replace(/\.$/, "");
  if (!s || s === "gmail.com" || s === "yahoo.com" || s === "hotmail.com" || s === "rediffmail.com" || s === "outlook.com") {
    return s && !["gmail.com", "yahoo.com", "hotmail.com", "rediffmail.com", "outlook.com"].includes(s) ? s : null;
  }
  return s || null;
}

export function websiteFromRaw(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.replace(/\/$/, "");
    } catch {
      return s;
    }
  }
  if (/^[\w.-]+\.[a-z]{2,}/i.test(s)) return `https://${s.replace(/^www\./i, "")}`;
  return null;
}

export function stripHospitalTokens(name) {
  return collapseWs(
    String(name || "")
      .toLowerCase()
      .replace(STRIP_NAME_RE, " ")
      .replace(/[&,.]/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
  );
}

export function normalisedNameSlug(name) {
  const s = stripHospitalTokens(name).replace(/\s+/g, "-");
  return s || "unnamed";
}

export function hospitalId(name, pincode) {
  return `${normalisedNameSlug(name)}-${pincode || "nopin"}`;
}

export function tokenSort(name) {
  return stripHospitalTokens(name)
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}

/** 0–100, fuzzywuzzy-style token_sort_ratio via Levenshtein. */
export function tokenSortRatio(a, b) {
  const sa = tokenSort(a);
  const sb = tokenSort(b);
  if (!sa && !sb) return 100;
  if (!sa || !sb) return 0;
  const dist = levenshtein(sa, sb);
  const maxLen = Math.max(sa.length, sb.length);
  return Math.round((1 - dist / maxLen) * 100);
}

export const OTHER_STATE_RE =
  /\b(delhi|new delhi|noida|gurgaon|gurugram|mumbai|navi mumbai|thane|pune|hyderabad|chennai|kolkata|jaipur|surat|nagpur|chandigarh|lucknow|kanpur|indore|bhopal|patna|ahmedabad|vadodara|rajkot|coimbatore|madurai|theni|aligarh|jalandhar|rewari|kochi|thiruvananthapuram|visakhapatnam|vijayawada|ranchi|raipur|dehradun|jammu|srinagar|guwahati|cuttack|bhubaneswar)\b/i;

export function looksKarnataka(row, pageHint = "") {
  const blob = [
    row.hospital_name,
    row.address,
    row.locality,
    row.city,
    row.district,
    row.pincode,
    pageHint,
  ]
    .filter(Boolean)
    .join(" ");
  if (KA_GEO_RE.test(blob)) return true;
  if (KA_PIN_RE.test(blob)) return true;
  return false;
}

export function otherStateNotKarnataka(row) {
  const blob = [row.city, row.district, row.address, row.locality].filter(Boolean).join(" ");
  if (!blob) return false;
  if (KA_GEO_RE.test(blob) || KA_PIN_RE.test(blob)) return false;
  return OTHER_STATE_RE.test(blob);
}

export function pageIsKarnatakaScoped(markdown, url = "") {
  const blob = `${url}\n${markdown || ""}`.slice(0, 8000);
  return KA_GEO_RE.test(blob) || /karnataka|bengaluru|bangalore/i.test(blob);
}

export function looksLoginWall(markdown) {
  const t = String(markdown || "").toLowerCase();
  if (t.length < 80) return true;
  const hits = [
    "sign in to continue",
    "log in to continue",
    "please log in",
    "please sign in",
    "captcha",
    "verify you are human",
    "access denied",
    "cf-challenge",
    "just a moment",
  ].filter((p) => t.includes(p)).length;
  return hits >= 1 && t.length < 1500;
}

export function countNonNull(obj) {
  return Object.values(obj).filter((v) => v !== null && v !== undefined && v !== "").length;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowIso() {
  return new Date().toISOString();
}

export function slugPerson(name) {
  return collapseWs(String(name || "").toLowerCase())
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60) || "unknown";
}

export function extractEmails(text) {
  const out = [];
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let m;
  while ((m = re.exec(text || ""))) out.push(m[0].toLowerCase());
  return [...new Set(out)];
}

const GENERIC_NAME_RE =
  /^(welcome to|member hospitals?|private hospitals?|government hospitals?|nursing homes?( association)?|membership of|years of|it was|phana is|join the|best hospitals?|top hospitals?|list of|accredited hospitals?|network hospitals?|empanelled hospitals?|the private hospitals?|our hospitals?)\b/i;

export function isPlausibleHospitalName(name) {
  const n = collapseWs(name);
  if (!n || n.length < 5 || n.length > 120) return false;
  if (GENERIC_NAME_RE.test(n)) return false;
  if (/https?:|www\./i.test(n)) return false;
  if (!/[A-Za-z]/.test(n)) return false;
  const words = n.split(/\s+/);
  if (words.length < 2 && !/hospital|clinic|nethralaya|ashraya|manipal|apollo|fortis|aster|narayana/i.test(n)) {
    return false;
  }
  const first = words[0].toLowerCase();
  if (["the", "a", "an", "our", "this", "that", "these", "those", "and", "or", "for", "with"].includes(first)) {
    return false;
  }
  return true;
}

export function extractPhones(text) {
  const out = [];
  const re = /(?:\+91[\s-]?)?[6-9]\d{9}\b|(?:0\d{2,4}[\s-]?)?\d{6,8}\b/g;
  let m;
  while ((m = re.exec(text || ""))) {
    const n = normalizePhone(m[0]);
    if (n && n.length >= 10) out.push(n);
  }
  return [...new Set(out)];
}
