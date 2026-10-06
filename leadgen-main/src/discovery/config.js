export const DATA_DIR = "data";

export const MAX_FIRECRAWL_CALLS = Number(process.env.MAX_FIRECRAWL_CALLS || 600);
export const BATCH_SIZE = 5;
export const BATCH_WAIT_MS = 2000;
export const CONCURRENCY = 2;
export const SKIP_IF_SCRAPED_WITHIN_DAYS = 30;
export const DRY_RUN_HOSPITALS = 5;
export const MAP_URL_CAP = 8;
export const CANARY_MIN_MARKDOWN = 500;
export const CANARY_MIN_ROWS = 10;
export const MIN_SURVIVING_SOURCES = 3;
export const MIN_RAW_ROWS = 200;
export const TOKEN_SORT_THRESHOLD = 88;
export const HARVEST_PAGE_CAP = 12;
export const SEARCH_LIMIT = 8;

export const CITY = process.env.DISCOVERY_CITY || "Bengaluru";
export const STATE = process.env.DISCOVERY_STATE || "Karnataka";

export const HOSPITALS_RAW_HEADERS = [
  "run_id",
  "source_key",
  "source_url",
  "payload_json",
  "scraped_at",
];

export const HOSPITALS_HEADERS = [
  "hospital_id",
  "hospital_name",
  "hospital_type",
  "bed_count",
  "address",
  "locality",
  "city",
  "district",
  "pincode",
  "latitude",
  "longitude",
  "switchboard_phone",
  "alt_phone",
  "generic_email",
  "website",
  "domain",
  "nabh_accredited",
  "source_index",
  "source_urls",
  "priority_score",
  "needs_phone_call",
  "scraped_at",
];

export const CONTACTS_HEADERS = [
  "contact_id",
  "hospital_id",
  "person_name",
  "designation",
  "department",
  "role_bucket",
  "direct_phone",
  "mobile",
  "email",
  "contact_source_url",
  "extraction_confidence",
  "verified_by_call",
  "call_status",
  "call_notes",
  "last_touch_date",
];

export const ERRORS_HEADERS = [
  "run_id",
  "stage",
  "node_name",
  "input_ref",
  "error_message",
  "http_status",
  "retry_count",
  "timestamp",
];

export const RUN_LOG_HEADERS = [
  "run_id",
  "stage",
  "node_name",
  "input_count",
  "output_count",
  "dropped_count",
  "sample_output_json",
  "firecrawl_calls",
  "duration_ms",
  "timestamp",
];

export const HOSPITAL_EXTRACT_PROMPT =
  "Extract every hospital or healthcare institution listed on this page, one object per hospital. If a field is not present on the page, return null. Do not infer, do not guess, do not fill from general knowledge.";

export const HOSPITAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    hospitals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hospital_name: { type: ["string", "null"] },
          hospital_type: { type: ["string", "null"] },
          bed_count: { type: ["number", "null"] },
          address: { type: ["string", "null"] },
          locality: { type: ["string", "null"] },
          city: { type: ["string", "null"] },
          district: { type: ["string", "null"] },
          pincode: { type: ["string", "null"] },
          switchboard_phone: { type: ["string", "null"] },
          generic_email: { type: ["string", "null"] },
          website: { type: ["string", "null"] },
          nabh_accredited: { type: ["boolean", "null"] },
        },
        required: ["hospital_name"],
      },
    },
  },
};

export const PEOPLE_EXTRACT_PROMPT = `Extract named people who work at this hospital (staff, leadership, department heads, purchase/materials/pharmacy contacts).
Return an empty array if no named people appear. Never invent a plausible name.
If a field is not present on the page, return null. Do not infer, do not guess, do not fill from general knowledge.`;

export const PEOPLE_JSON_SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: ["string", "null"] },
          designation: { type: ["string", "null"] },
          department: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
        },
      },
    },
  },
};

export const PATH_FILTER_RE =
  /contact|about|team|management|administration|leadership|our-people|staff|departments|careers|jobs|tender|tenders|vendor|supplier|procurement|purchase|empanel/i;

export const PATH_HIGH_RE = /vendor|supplier|tender|procurement|purchase/i;

export const ROLE_RULES = [
  {
    bucket: "purchase",
    priority: 1,
    re: /\b(purchase|materials?|stores?|supply\s*chain|procurement|vendor)\b/i,
  },
  {
    bucket: "pharmacy",
    priority: 2,
    re: /\b(pharmac)/i,
  },
  {
    bucket: "admin_exec",
    priority: 3,
    re: /\b(medical\s*superintendent|hospital\s*administrator|administrator|coo|ceo|chief\s*executive|gm[\s-]*ops|gm[\s-]*operations|director|managing\s*director|medical\s*director|ms\b)/i,
  },
  {
    bucket: "finance",
    priority: 4,
    re: /\b(cfo|finance|accounts)\b/i,
  },
];

export const SOURCES = [
  {
    source_key: "phana_members",
    search_query: "PHANA member hospitals directory Bangalore",
    fields_available: ["hospital_name", "address", "city", "switchboard_phone"],
  },
  {
    source_key: "cmai_karnataka",
    search_query: "CMAI member institutions Karnataka cmai.org",
    fields_available: ["hospital_name", "address", "city"],
  },
  {
    source_key: "chai_karnataka",
    search_query: "Catholic Health Association India Karnataka member institutions",
    fields_available: ["hospital_name", "address", "city"],
  },
  {
    source_key: "nabh_karnataka",
    search_query: "NABH accredited hospitals list Karnataka",
    fields_available: ["hospital_name", "address", "city", "nabh_accredited"],
  },
  {
    source_key: "sast_network",
    search_query: "SAST network hospitals list Karnataka site:karnataka.gov.in",
    fields_available: ["hospital_name", "address", "city", "district"],
  },
  {
    source_key: "kpme_beds",
    search_query: "KPME private hospitals bed details Karnataka arogya",
    fields_available: ["hospital_name", "bed_count", "address", "city"],
  },
  {
    source_key: "pmjay_karnataka",
    search_query: "PMJAY hospital finder Karnataka empanelled list",
    fields_available: ["hospital_name", "address", "city", "district"],
  },
  {
    source_key: "rohini",
    search_query: "ROHINI registry hospital search IIB",
    fields_available: ["hospital_name", "address", "city"],
  },
  {
    source_key: "insurer_network",
    search_query: "network hospital list Bengaluru PDF",
    fields_available: ["hospital_name", "address", "city", "switchboard_phone"],
    local_fallback: {
      file: "bangalore-hospital-list.md",
      source_url: "https://www.scribd.com/document/557856549/Bangalore-Hospital-List",
    },
  },
  {
    source_key: "jobs_purchase",
    search_query: '"Purchase Executive" hospital Bengaluru naukri',
    fields_available: ["hospital_name", "city", "website"],
  },
];

export function structuredScrapeBody(url) {
  return {
    url,
    formats: [
      { type: "markdown" },
      {
        type: "json",
        prompt: HOSPITAL_EXTRACT_PROMPT,
        schema: HOSPITAL_JSON_SCHEMA,
      },
    ],
    onlyMainContent: true,
    waitFor: 2000,
  };
}

export function peopleScrapeBody(url) {
  return {
    url,
    formats: [
      { type: "markdown" },
      {
        type: "json",
        prompt: PEOPLE_EXTRACT_PROMPT,
        schema: PEOPLE_JSON_SCHEMA,
      },
    ],
    onlyMainContent: true,
    waitFor: 2000,
  };
}
