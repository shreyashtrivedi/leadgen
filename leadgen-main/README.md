# EaseMed Hospital Contact Discovery

Local Node.js pipeline that harvests Karnataka hospital indexes via Firecrawl, dedupes them, extracts named purchasing/admin contacts, and writes a scored call list as CSVs under `data/`.

n8n Cloud has no persistent filesystem, so this does **not** run inside n8n. The same stages can be scheduled later with `n8n-nodes-base.httpRequest` plus the `Firecrawl API` header credential if you want a timer — still write CSVs from this repo, not from n8n.

## Setup

1. Node 20+.
2. `.env` at the repo root with `FIRECRAWL_API_KEY=...` (legacy name `Firecrawl API_KEY` is also accepted). Never commit `.env`.
3. `npm run discover`

Outputs (gitignored):

- `data/hospitals_raw.csv` — append-only scrape audit
- `data/hospitals.csv` — deduped, scored hospitals
- `data/contacts.csv` — named people (`call_status` starts empty)
- `data/errors.csv` — failures, including `hallucinated_name`
- `data/run_log.csv` — per-stage counts and Firecrawl call totals
- `data/run_report.md` — last run report

Re-runs upsert on each file’s key. Domains scraped fewer than 30 days ago are skipped in Stage 3.

## Add a source adapter

There is **one** generic adapter (`src/discovery/adapter.js` + `src/discovery/lib/extract.js`) driven by a config object in `src/discovery/config.js` → `SOURCES`.

Add an entry:

```js
{
  source_key: "my_directory",          // stable id, used in source_index
  search_query: "…",                   // POST /v2/search query
  fields_available: ["hospital_name", "address", "city"],
  // optional: when live pages are paywalled but a local listing exists
  local_fallback: {
    file: "some-list.md",              // repo-relative, pipe table with ProviderName
    source_url: "https://original.example/list",
  },
}
```

At runtime the adapter fills `{ url_pattern, pagination_style, content_type, fields_available }` from the canary scrape (`none | query_page | link_next | pdf | local_markdown`). Do not add bespoke per-source parsers unless the page is a local markdown table (the optional `local_fallback`).

Canary (automated): markdown ≥ 500 chars, no login/captcha wall, ≥ 10 Karnataka hospital rows. Failures go to `run_log.csv`.

## Re-run for another city

```bash
DISCOVERY_CITY="Mysuru" DISCOVERY_STATE="Karnataka" npm run discover
```

Then edit the `search_query` strings in `SOURCES` (replace Bengaluru/Bangalore/Karnataka as needed) and, if you have a city listing file, point `local_fallback.file` at it. `hospital_id` is `{normalised-name}-{pincode}`, so a new city merges cleanly with existing CSVs. Set `MAX_FIRECRAWL_CALLS` (default 600) to cap spend.

## Cost per 100 hospitals

Measured against Firecrawl v2 (search = 2 credits; scrape/map ≈ 1+ depending on `json` format):

| Step | Per 100 hospitals with websites (typical) |
| --- | --- |
| Ten index searches + canaries | ~30–80 credits (fixed, not per hospital) |
| Stage 3 map (1/domain) | ~100 credits |
| Stage 3 scrape, up to 8 URLs, markdown+json | ~400–800 credits (json extraction is the bulk) |
| **All-in** | **roughly 5–10 credits per hospital with a website**, plus a ~50-credit index overhead |

Hospitals without a website cost ~0 after harvest. Re-runs inside 30 days skip Stage 3 for known domains. Halt if remaining credits start below 600 or if `MAX_FIRECRAWL_CALLS` is exceeded (partial CSVs are kept).

## Assertions (pipeline halts)

Credits &lt; 600 · scrape/map shape missing · &lt; 3 surviving sources · &lt; 200 raw rows · dedupe output &gt; input · people extractor never returns `[]` · call budget exceeded.
