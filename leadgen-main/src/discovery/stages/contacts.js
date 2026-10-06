import { peopleScrapeBody, PATH_FILTER_RE, PATH_HIGH_RE, MAP_URL_CAP, DRY_RUN_HOSPITALS, BATCH_SIZE, BATCH_WAIT_MS, SKIP_IF_SCRAPED_WITHIN_DAYS, ROLE_RULES } from "../config.js";
import { peopleFromJson } from "../lib/extract.js";
import { HaltError } from "../lib/firecrawl.js";
import {
  nowIso,
  sleep,
  slugPerson,
  normalizePhone,
  normalizeDomain,
  websiteFromRaw,
} from "../lib/text.js";
import { readCsvFile } from "../lib/csv.js";

function rankMappedUrl(url) {
  const u = String(url || "").toLowerCase();
  if (PATH_HIGH_RE.test(u)) return 0;
  if (/empanel/.test(u)) return 1;
  if (/contact/.test(u)) return 2;
  if (/about|leadership|management|team|our-people|staff|administration/.test(u)) return 3;
  if (/departments/.test(u)) return 4;
  if (/careers|jobs/.test(u)) return 5;
  return 6;
}

export function classifyRole(designation, department) {
  const blob = `${designation || ""} ${department || ""}`;
  for (const rule of ROLE_RULES) {
    if (rule.re.test(blob)) return rule.bucket;
  }
  return "other";
}

function staleCheck(existingByDomain, domain) {
  if (!domain || !existingByDomain.has(domain)) return false;
  const prev = existingByDomain.get(domain);
  if (!prev?.scraped_at) return false;
  const then = Date.parse(prev.scraped_at);
  if (!Number.isFinite(then)) return false;
  const days = (Date.now() - then) / 86400000;
  return days < SKIP_IF_SCRAPED_WITHIN_DAYS;
}

function loadExistingHospitals(store) {
  const { rows } = readCsvFile(store.files.hospitals);
  const byDomain = new Map();
  for (const r of rows) {
    if (r.domain) byDomain.set(r.domain, r);
  }
  return byDomain;
}

async function resolveWebsite(fc, hospital, store) {
  if (hospital.website) return websiteFromRaw(hospital.website);
  const q = `"${hospital.hospital_name}" ${hospital.city || "Bengaluru"} official website`;
  try {
    const search = await fc.search(q, { limit: 5 }, {
      stage: "contacts",
      nodeName: "website_search",
      inputRef: hospital.hospital_id,
    });
    const hit = (search.hits || []).find((h) => {
      const u = String(h.url || "").toLowerCase();
      return !/facebook|twitter|linkedin|justdial|practo|sulekha|wikipedia|naukri|indeed/.test(u);
    });
    return hit?.url ? websiteFromRaw(hit.url) : null;
  } catch (err) {
    store.logError({
      stage: "contacts",
      node_name: "website_search",
      input_ref: hospital.hospital_id,
      error_message: err.message,
      http_status: err.httpStatus || "",
    });
    return null;
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function filterMapLinks(links) {
  const urls = links.map((l) => (typeof l === "string" ? l : l.url)).filter(Boolean);
  const filtered = urls.filter((u) => PATH_FILTER_RE.test(u));
  filtered.sort((a, b) => rankMappedUrl(a) - rankMappedUrl(b));
  const seen = new Set();
  const out = [];
  for (const u of filtered) {
    const k = u.split("#")[0];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
    if (out.length >= MAP_URL_CAP) break;
  }
  return out;
}

function personInMarkdown(name, markdown) {
  if (!name) return false;
  return String(markdown || "").toLowerCase().includes(String(name).toLowerCase().trim());
}

function toContact(hospitalId, person, url, confidence) {
  const name = person.name || person.person_name;
  const designation = person.designation || "";
  const department = person.department || "";
  const role = classifyRole(designation, department);
  const phone = normalizePhone(person.phone || person.direct_phone);
  const mobile =
    normalizePhone(person.mobile) ||
    (phone && /^[6-9]/.test(phone) ? phone : "");
  return {
    contact_id: `${hospitalId}-${slugPerson(name)}-${role}`,
    hospital_id: hospitalId,
    person_name: name,
    designation,
    department,
    role_bucket: role,
    direct_phone: phone || "",
    mobile: mobile || "",
    email: (person.email || "").toLowerCase(),
    contact_source_url: url,
    extraction_confidence: confidence,
    verified_by_call: "",
    call_status: "",
    call_notes: "",
    last_touch_date: "",
  };
}

async function extractHospitalPeople(fc, store, hospital, website) {
  const origin = originOf(website) || website;
  const mapped = await fc.map(
    { url: origin, search: "contact purchase vendor tender", limit: 50 },
    { stage: "contacts", nodeName: "map", inputRef: hospital.hospital_id }
  );
  let urls = filterMapLinks(mapped.links);
  if (!urls.length) urls = [origin];
  const pages = [];
  const contacts = [];
  let hasVendorPage = false;
  let sawEmpty = false;

  for (const url of urls) {
    if (PATH_HIGH_RE.test(url)) hasVendorPage = true;
    try {
      const scrape = await fc.scrape(peopleScrapeBody(url), {
        stage: "contacts",
        nodeName: "scrape_people",
        inputRef: url,
      });
      const rawPeople = peopleFromJson(scrape.json);
      if (!rawPeople.length) sawEmpty = true;
      pages.push({ url, raw_count: rawPeople.length, markdown_len: (scrape.markdown || "").length });
      for (const p of rawPeople) {
        const name = p.name || p.person_name;
        if (!name) continue;
        if (!personInMarkdown(name, scrape.markdown)) {
          store.logError({
            stage: "contacts",
            node_name: "hallucination_guard",
            input_ref: url,
            error_message: `hallucinated_name:${name}`,
            http_status: "",
          });
          continue;
        }
        contacts.push(toContact(hospital.hospital_id, p, url, rawPeople.length ? "0.8" : "0.4"));
      }
    } catch (err) {
      store.logError({
        stage: "contacts",
        node_name: "scrape_people",
        input_ref: url,
        error_message: err.message,
        http_status: err.httpStatus || "",
      });
    }
    await sleep(800);
  }

  return { contacts, pages, hasVendorPage, sawEmpty, website };
}

export async function stageContacts(fc, store, hospitals, { dryRunOnly = false, callsAtStart } = {}) {
  const t0 = Date.now();
  const existingByDomain = loadExistingHospitals(store);
  const withSite = [];
  const websiteFlags = new Map();

  const seedContacts = [];
  for (const h of hospitals) {
    if (h._contact_person) {
      const m = String(h._contact_person).split(/[-–—]/);
      const name = m[0].trim();
      const designation = m.slice(1).join("-").trim();
      if (name && name.length > 2 && !/^(\.|0+)$/.test(name)) {
        seedContacts.push(
          toContact(
            h.hospital_id,
            { name, designation, department: "", phone: h.switchboard_phone, email: h.generic_email },
            h.source_urls?.split("|")[0] || "",
            "source_index"
          )
        );
      }
    }
  }

  let resolved = 0;
  for (const h of hospitals) {
    let site = h.website;
    if (!site && resolved < 12) {
      site = await resolveWebsite(fc, h, store);
      resolved += 1;
      if (site) {
        h.website = site;
        h.domain = normalizeDomain(site) || h.domain;
      }
      await sleep(400);
    }
    if (site) withSite.push(h);
  }

  const targets = withSite.filter((h) => !staleCheck(existingByDomain, h.domain));
  const dryList = targets.slice(0, DRY_RUN_HOSPITALS);

  async function runBatch(list, label) {
    const allContacts = [];
    const pageStats = [];
    let emptyPages = 0;
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const batch = list.slice(i, i + BATCH_SIZE);
      for (const h of batch) {
        try {
          const result = await extractHospitalPeople(fc, store, h, h.website);
          allContacts.push(...result.contacts);
          pageStats.push(...result.pages);
          if (result.sawEmpty) emptyPages += 1;
          websiteFlags.set(h.hospital_id, {
            hasVendorPage: result.hasVendorPage,
            roles: [...new Set(result.contacts.map((c) => c.role_bucket))],
          });
        } catch (err) {
          store.logError({
            stage: "contacts",
            node_name: label,
            input_ref: h.hospital_id,
            error_message: err.message,
            http_status: err.httpStatus || "",
          });
        }
      }
      if (i + BATCH_SIZE < list.length) await sleep(BATCH_WAIT_MS);
    }
    return { allContacts, pageStats, emptyPages };
  }

  const dry = await runBatch(dryList, "dry_run");

  let controlEmpty = dry.pageStats.some((p) => p.raw_count === 0);
  if (!controlEmpty) {
    const control = await fc.scrape(peopleScrapeBody("https://example.com"), {
      stage: "contacts",
      nodeName: "extractor_empty_control",
      inputRef: "https://example.com",
    });
    const raw = peopleFromJson(control.json);
    dry.pageStats.push({ url: "https://example.com", raw_count: raw.length, markdown_len: (control.markdown || "").length });
    if (raw.length === 0) controlEmpty = true;
  }

  store.logRun({
    stage: "contacts",
    node_name: "dry_run",
    input_count: dryList.length,
    output_count: dry.allContacts.length,
    dropped_count: dry.pageStats.filter((p) => p.raw_count > 0).length,
    sample_output_json: {
      pages: dry.pageStats,
      empty_page_found: controlEmpty,
      sample_contacts: dry.allContacts.slice(0, 5),
    },
    firecrawl_calls: fc.calls - (callsAtStart || 0),
    duration_ms: Date.now() - t0,
  });

  if (!controlEmpty) {
    throw new HaltError("Extractor never returned [] on dry-run pages (including example.com control) — likely fabricating", {
      pages: dry.pageStats,
    });
  }

  let rest = { allContacts: [], pageStats: [], emptyPages: 0 };
  if (!dryRunOnly) {
    const remaining = targets.slice(DRY_RUN_HOSPITALS);
    rest = await runBatch(remaining, "full");
  }

  const contacts = [...seedContacts, ...dry.allContacts, ...rest.allContacts];
  const uniq = new Map();
  for (const c of contacts) {
    if (!uniq.has(c.contact_id)) uniq.set(c.contact_id, c);
  }
  const list = [...uniq.values()];
  store.upsertContacts(list);

  const hospitalsWithWebsite = withSite.length;
  const namedHit = new Set(list.filter((c) => c.extraction_confidence !== "source_index").map((c) => c.hospital_id)).size;
  const hitRate = hospitalsWithWebsite ? (namedHit / hospitalsWithWebsite) * 100 : 0;

  store.logRun({
    stage: "contacts",
    node_name: "named_person_extraction",
    input_count: targets.length,
    output_count: list.length,
    dropped_count: 0,
    sample_output_json: {
      hospitals_with_website: hospitalsWithWebsite,
      named_contact_hit_rate_pct: Number(hitRate.toFixed(2)),
      dry_run_hospitals: dryList.map((h) => h.hospital_name),
    },
    firecrawl_calls: fc.calls - (callsAtStart || 0),
    duration_ms: Date.now() - t0,
  });

  return {
    contacts: list,
    websiteFlags,
    hospitalsWithWebsite,
    namedHit,
    hitRate,
    dryPages: dry.pageStats,
  };
}

export { nowIso };
