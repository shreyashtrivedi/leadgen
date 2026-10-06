import { HaltError } from "../lib/firecrawl.js";
import { nowIso } from "../lib/text.js";
import { structuredScrapeBody } from "../config.js";
import { findTextPath } from "../lib/firecrawl.js";

export async function probeShapes(fc, store, callsAtStart) {
  const t0 = Date.now();
  const credits = await fc.creditUsage();
  if (!Number.isFinite(credits.remaining) || credits.remaining < 600) {
    throw new HaltError(`credits_remaining ${credits.remaining} < 600`, { credits });
  }

  const scrape = await fc.scrape(
    { url: "https://example.com", formats: [{ type: "markdown" }] },
    { stage: "probe", nodeName: "scrape_example", inputRef: "https://example.com" }
  );
  if (!scrape.markdown || !scrape.markdown.trim()) {
    throw new HaltError("scrape markdown empty; cannot locate non-empty markdown string", {
      body_keys: scrape.body ? Object.keys(scrape.body) : [],
    });
  }

  const jsonProbe = await fc.scrape(structuredScrapeBody("https://example.com"), {
    stage: "probe",
    nodeName: "scrape_json_shape",
    inputRef: "https://example.com",
  });
  const jsonExists = jsonProbe.json !== undefined && jsonProbe.json !== null;
  fc.shapes.json_path = jsonExists ? "$.data.json" : "MISSING";

  const mapped = await fc.map(
    { url: "https://www.asterhospitals.in", search: "contact", limit: 50 },
    { stage: "probe", nodeName: "map_aster", inputRef: "https://www.asterhospitals.in" }
  );
  if (!mapped.links.length) {
    throw new HaltError("map returned no links; cannot determine links shape");
  }
  const first = mapped.body?.links?.[0];
  const linkShape = typeof first === "string" ? "string[]" : "object[]";
  fc.shapes.map_links = linkShape;

  const sample = {
    credits_remaining: credits.remaining,
    credits_path: "$.data.remainingCredits",
    markdown_path: "$.data.markdown",
    markdown_len: scrape.markdown.length,
    json_path: fc.shapes.json_path,
    json_present: jsonExists,
    map_links: linkShape,
    map_first: typeof first === "string" ? first : { url: first?.url, keys: first ? Object.keys(first) : [] },
    map_count: mapped.links.length,
  };

  store.logRun({
    stage: "probe",
    node_name: "shapes",
    input_count: 3,
    output_count: 1,
    dropped_count: 0,
    sample_output_json: sample,
    firecrawl_calls: fc.calls - callsAtStart,
    duration_ms: Date.now() - t0,
    timestamp: nowIso(),
  });

  return { credits, sample, findTextPath };
}
