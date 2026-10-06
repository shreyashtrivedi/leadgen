import fs from "node:fs";
import path from "node:path";
import {
  SOURCES,
  SEARCH_LIMIT,
  HARVEST_PAGE_CAP,
  structuredScrapeBody,
  MIN_SURVIVING_SOURCES,
  MIN_RAW_ROWS,
} from "../config.js";
import { HaltError, findTextPath } from "../lib/firecrawl.js";
import { looksLoginWall, nowIso, sleep } from "../lib/text.js";
import { canaryScore, parseLocalHospitalMarkdown, rowsFromScrape } from "../adapter.js";
import { detectPaginationStyle, nextPageUrl } from "../lib/extract.js";
import { ROOT } from "../lib/env.js";
import { BATCH_WAIT_MS } from "../config.js";

function preferUrl(url) {
  const u = String(url || "").toLowerCase();
  let score = 0;
  if (/\.pdf($|\?)/.test(u)) score += 8;
  if (/karnataka\.gov\.in|pmjay|nabh\.co|phana|cmai\.org|chai-india|rohini|sast|kpme|arogya/.test(u)) score += 12;
  if (/scribd|facebook|twitter|linkedin|youtube|instagram/.test(u)) score -= 6;
  if (/list|directory|member|empanel|network|hospital/.test(u)) score += 4;
  if (/wikipedia\.org/.test(u)) score += 6;
  return score;
}

function skipCanaryUrl(url) {
  const u = String(url || "").toLowerCase();
  return /facebook\.com|twitter\.com|x\.com|linkedin\.com|instagram\.com|youtube\.com|tiktok\.com/.test(u);
}

function pickCandidates(urls, n = 4) {
  const scored = [...urls]
    .filter(Boolean)
    .filter((u) => !skipCanaryUrl(u))
    .sort((a, b) => preferUrl(b) - preferUrl(a));
  const out = [];
  const seenHost = new Set();
  for (const u of scored) {
    let host = u;
    try {
      host = new URL(u).hostname.replace(/^www\./i, "");
    } catch {
      /* keep */
    }
    if (seenHost.has(host)) continue;
    seenHost.add(host);
    out.push(u);
    if (out.length >= n) break;
  }
  if (out.length < n) {
    for (const u of scored) {
      if (out.includes(u)) continue;
      out.push(u);
      if (out.length >= n) break;
    }
  }
  return out;
}

async function tryParsePdf(fc, store, pdfUrl) {
  const t0 = Date.now();
  try {
    const res = await fetch(pdfUrl, { redirect: "follow" });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") || "";
    if (!/pdf|octet-stream/i.test(ct) && buf.length < 1000) {
      throw new Error(`not a pdf (${ct}, ${buf.length} bytes)`);
    }
    const parsed = await fc.parseFile(buf, "seed.pdf", {
      stage: "probe",
      nodeName: "parse_pdf",
      inputRef: pdfUrl,
    });
    const paths = findTextPath(parsed.body);
    const textPath = paths.sort((a, b) => b.length - a.length)[0]?.path || null;
    fc.shapes.parse_text_path = textPath;
    fc.shapes.pdf_parse_ok = true;
    store.logRun({
      stage: "probe",
      node_name: "parse_pdf",
      input_count: 1,
      output_count: 1,
      dropped_count: 0,
      sample_output_json: { pdfUrl, textPath, http: parsed.status, keys: Object.keys(parsed.body || {}) },
      firecrawl_calls: 1,
      duration_ms: Date.now() - t0,
    });
    return { ok: true, textPath, body: parsed.body };
  } catch (err) {
    fc.shapes.pdf_parse_ok = false;
    store.logError({
      stage: "probe",
      node_name: "parse_pdf",
      input_ref: pdfUrl,
      error_message: err.message,
      http_status: err.httpStatus || "",
      retry_count: 0,
    });
    store.logRun({
      stage: "probe",
      node_name: "parse_pdf",
      input_count: 1,
      output_count: 0,
      dropped_count: 1,
      sample_output_json: { pdfUrl, error: err.message, skipped_pdf_sources: true },
      firecrawl_calls: 0,
      duration_ms: Date.now() - t0,
    });
    return { ok: false, error: err.message };
  }
}

async function canaryOne(fc, url, sourceKey) {
  const scraped_at = nowIso();
  const result = await fc.scrape(structuredScrapeBody(url), {
    stage: "harvest",
    nodeName: "canary",
    inputRef: `${sourceKey}|${url}`,
  });
  const source = { source_key: sourceKey, source_url: url, scraped_at };
  const extracted = rowsFromScrape(result, source);
  const loginWall = looksLoginWall(result.markdown);
  const score = canaryScore({
    markdown: result.markdown,
    rows: extracted.rows,
    loginWall,
  });
  return {
    url,
    score,
    loginWall,
    markdown: result.markdown,
    json: result.json,
    rows: extracted.rows,
    via: extracted.via,
    pagination_style: detectPaginationStyle(result.markdown, url),
    content_type: /\.pdf($|\?)/i.test(url) ? "pdf" : "html",
  };
}

export async function stageHarvest(fc, store, callsAtStart) {
  const t0 = Date.now();
  const resolved = [];
  const scoring = [];
  const survivors = [];
  let skipPdf = false;

  for (const src of SOURCES) {
    let hits = [];
    try {
      const search = await fc.search(src.search_query, { limit: SEARCH_LIMIT }, {
        stage: "harvest",
        nodeName: "search",
        inputRef: src.source_key,
      });
      hits = search.hits || [];
      resolved.push({
        source_key: src.source_key,
        query: src.search_query,
        urls: hits.map((h) => h.url).filter(Boolean),
        titles: hits.map((h) => h.title),
      });
      console.log(`search ${src.source_key}: ${hits.length} hits`);
    } catch (err) {
      store.logError({
        stage: "harvest",
        node_name: "search",
        input_ref: src.source_key,
        error_message: err.message,
        http_status: err.httpStatus || "",
      });
      resolved.push({ source_key: src.source_key, query: src.search_query, urls: [], error: err.message });
    }
    await sleep(400);
  }

  const allUrls = resolved.flatMap((r) => r.urls || []);
  const pdfUrl = allUrls.find((u) => /\.pdf($|\?)/i.test(u));
  if (pdfUrl) {
    const parsed = await tryParsePdf(fc, store, pdfUrl);
    skipPdf = !parsed.ok;
  } else {
    store.logRun({
      stage: "probe",
      node_name: "parse_pdf",
      input_count: 0,
      output_count: 0,
      dropped_count: 0,
      sample_output_json: { note: "no pdf in seed search results" },
      firecrawl_calls: 0,
      duration_ms: 0,
    });
  }

  const rawAcc = [];

  for (const src of SOURCES) {
    const rec = resolved.find((r) => r.source_key === src.source_key);
    const candidates = pickCandidates(rec?.urls || [], 4);

    console.log(`canary ${src.source_key} candidates=${candidates.length}`);
    let winner = null;
    const attempts = [];

    for (const url of candidates) {
      if (skipPdf && /\.pdf($|\?)/i.test(url)) {
        attempts.push({ url, rejected: "pdf_parse_failed_skip" });
        continue;
      }
      try {
        const can = await canaryOne(fc, url, src.source_key);
        attempts.push({
          url,
          pass: can.score.pass,
          reasons: can.score.reasons,
          markdown_len: can.score.markdown_len,
          row_count: can.score.row_count,
          via: can.via,
        });
        if (can.score.pass) {
          winner = can;
          break;
        }
      } catch (err) {
        attempts.push({ url, error: err.message });
        store.logError({
          stage: "harvest",
          node_name: "canary",
          input_ref: `${src.source_key}|${url}`,
          error_message: err.message,
          http_status: err.httpStatus || "",
        });
      }
      await sleep(BATCH_WAIT_MS);
    }

    if (!winner && src.local_fallback) {
      const localRows = parseLocalHospitalMarkdown(
        src.local_fallback.file,
        src.source_key,
        src.local_fallback.source_url
      );
      const localMd = fs.existsSync(path.join(ROOT, src.local_fallback.file))
        ? fs.readFileSync(path.join(ROOT, src.local_fallback.file), "utf8")
        : "";
      const score = canaryScore({
        markdown: localMd,
        rows: localRows,
        loginWall: false,
      });
      attempts.push({
        url: src.local_fallback.source_url,
        pass: score.pass,
        reasons: score.reasons,
        markdown_len: score.markdown_len,
        row_count: score.row_count,
        via: "local_markdown_fallback",
      });
      if (score.pass) {
        winner = {
          url: src.local_fallback.source_url,
          score,
          rows: localRows,
          markdown: localMd,
          json: null,
          via: "local_markdown_fallback",
          pagination_style: "none",
          content_type: "local_markdown",
          local: true,
        };
      }
    }

    const entry = {
      source_key: src.source_key,
      query: src.search_query,
      resolved_urls: rec?.urls || [],
      attempts,
      survived: Boolean(winner),
      winner_url: winner?.url || null,
      pagination_style: winner?.pagination_style || null,
      content_type: winner?.content_type || null,
      canary_rows: winner?.score.row_count || 0,
      reject_reasons: winner ? [] : attempts.flatMap((a) => a.reasons || (a.error ? [a.error] : [a.rejected].filter(Boolean))),
    };
    console.log(
      `${src.source_key} ${winner ? "SURVIVE" : "REJECT"} rows=${winner?.rows.length || 0} via=${winner?.via || "—"} url=${winner?.url || "—"}`
    );
    scoring.push(entry);

    if (!winner) {
      store.logRun({
        stage: "harvest",
        node_name: `canary_reject:${src.source_key}`,
        input_count: candidates.length,
        output_count: 0,
        dropped_count: 1,
        sample_output_json: entry,
        firecrawl_calls: fc.calls - callsAtStart,
        duration_ms: Date.now() - t0,
      });
      continue;
    }

    const harvested = [...winner.rows];
    if (!winner.local && winner.pagination_style !== "none" && winner.pagination_style !== "pdf") {
      for (let page = 2; page <= HARVEST_PAGE_CAP; page += 1) {
        const next = nextPageUrl(winner.url, winner.markdown, page);
        if (!next || next === winner.url) break;
        try {
          const scraped_at = nowIso();
          const pageScrape = await fc.scrape(structuredScrapeBody(next), {
            stage: "harvest",
            nodeName: "paginate",
            inputRef: `${src.source_key}|${next}`,
          });
          const extra = rowsFromScrape(pageScrape, {
            source_key: src.source_key,
            source_url: next,
            scraped_at,
          });
          if (!extra.rows.length) break;
          harvested.push(...extra.rows);
          winner.markdown = pageScrape.markdown;
          await sleep(BATCH_WAIT_MS);
        } catch (err) {
          store.logError({
            stage: "harvest",
            node_name: "paginate",
            input_ref: `${src.source_key}|${next}`,
            error_message: err.message,
            http_status: err.httpStatus || "",
          });
          break;
        }
      }
    }

    // extra search-result pages that look like lists, for thin winners
    if (harvested.length < 40 && !winner.local) {
      const extras = candidates.filter((u) => u !== winner.url).slice(0, 2);
      for (const url of extras) {
        if (skipPdf && /\.pdf($|\?)/i.test(url)) continue;
        try {
          const scraped_at = nowIso();
          const extraScrape = await fc.scrape(structuredScrapeBody(url), {
            stage: "harvest",
            nodeName: "harvest_extra",
            inputRef: `${src.source_key}|${url}`,
          });
          const extra = rowsFromScrape(extraScrape, {
            source_key: src.source_key,
            source_url: url,
            scraped_at,
          });
          harvested.push(...extra.rows);
        } catch (err) {
          store.logError({
            stage: "harvest",
            node_name: "harvest_extra",
            input_ref: `${src.source_key}|${url}`,
            error_message: err.message,
            http_status: err.httpStatus || "",
          });
        }
        await sleep(BATCH_WAIT_MS);
      }
    }

    store.appendRawIndexed(src.source_key, winner.url, harvested, nowIso());
    rawAcc.push(...harvested);
    survivors.push({
      source_key: src.source_key,
      url: winner.url,
      rows: harvested.length,
      pagination_style: winner.pagination_style,
      content_type: winner.content_type,
      fields_available: src.fields_available,
      via: winner.via,
    });
  }

  store.logRun({
    stage: "harvest",
    node_name: "index_harvest",
    input_count: SOURCES.length,
    output_count: rawAcc.length,
    dropped_count: SOURCES.length - survivors.length,
    sample_output_json: {
      surviving_sources: survivors,
      scoring,
      resolved,
    },
    firecrawl_calls: fc.calls - callsAtStart,
    duration_ms: Date.now() - t0,
  });

  if (survivors.length < MIN_SURVIVING_SOURCES || rawAcc.length < MIN_RAW_ROWS) {
    throw new HaltError(
      `Stage 1 assert failed: surviving_sources=${survivors.length} (need ${MIN_SURVIVING_SOURCES}), raw_rows=${rawAcc.length} (need ${MIN_RAW_ROWS})`,
      { scoring, survivors, resolved, raw_rows: rawAcc.length }
    );
  }

  return { resolved, scoring, survivors, rawRows: rawAcc, skipPdf };
}
