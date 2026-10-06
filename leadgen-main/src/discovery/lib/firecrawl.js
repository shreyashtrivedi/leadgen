import { requireApiKey } from "./env.js";
import { sleep } from "./text.js";
import { MAX_FIRECRAWL_CALLS, CONCURRENCY } from "../config.js";

export class HaltError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HaltError";
    this.details = details;
    this.halt = true;
  }
}

export class BudgetError extends HaltError {
  constructor(calls) {
    super(`MAX_FIRECRAWL_CALLS exceeded (${calls} > ${MAX_FIRECRAWL_CALLS})`, {
      firecrawl_calls: calls,
    });
    this.name = "BudgetError";
  }
}

const BASE = "https://api.firecrawl.dev";

export function createFirecrawl({ onError } = {}) {
  const key = requireApiKey();
  let calls = 0;
  const shapes = {
    markdown_path: "$.data.markdown",
    json_path: "$.data.json",
    map_links: "object[]",
    map_links_path: "$.links",
    search_path: "$.data.web",
    credits_path: "$.data.remainingCredits",
    parse_text_path: null,
    pdf_parse_ok: null,
  };

  async function rawFetch(method, apiPath, { jsonBody, form, timeoutMs = 120000 } = {}) {
    const headers = { Authorization: `Bearer ${key}` };
    let body;
    if (form) {
      body = form;
    } else if (jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(jsonBody);
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(BASE + apiPath, {
        method,
        headers,
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text.slice(0, 4000) };
      }
      return { status: res.status, ok: res.ok, body: parsed, text };
    } finally {
      clearTimeout(t);
    }
  }

  async function withRetry(fn, { nodeName, inputRef, stage } = {}) {
    let last = null;
    let attempts = 0;
    const runOnce = async () => {
      attempts += 1;
      return fn();
    };
    for (let i = 0; i < 3; i += 1) {
      try {
        return await runOnce();
      } catch (err) {
        last = err;
        if (err?.noRetry) break;
        if (i < 2) await sleep(5000);
      }
    }
    if (!last?.noRetry) {
      for (let j = 0; j < 2; j += 1) {
        await sleep(30000);
        try {
          return await runOnce();
        } catch (err) {
          last = err;
          if (err?.noRetry) break;
        }
      }
    }
    if (onError) {
      onError({
        stage: stage || "firecrawl",
        node_name: nodeName || "http",
        input_ref: inputRef || "",
        error_message: last?.message || String(last),
        http_status: last?.httpStatus || "",
        retry_count: attempts,
      });
    }
    throw last;
  }

  function bump() {
    calls += 1;
    if (calls > MAX_FIRECRAWL_CALLS) throw new BudgetError(calls);
  }

  async function request(method, apiPath, opts, meta = {}) {
    bump();
    return withRetry(
      async () => {
        const res = await rawFetch(method, apiPath, opts);
        if (res.status === 429) {
          const err = new Error(`Firecrawl 429 on ${apiPath}`);
          err.httpStatus = 429;
          throw err;
        }
        if (!res.ok) {
          const err = new Error(
            `Firecrawl ${res.status} ${apiPath}: ${JSON.stringify(res.body).slice(0, 400)}`
          );
          err.httpStatus = res.status;
          err.body = res.body;
          err.noRetry = res.status === 401 || res.status === 402 || res.status === 403 || res.status === 404;
          if (res.status >= 500 && /SCRAPE_SITE_ERROR|ERR_TUNNEL/.test(JSON.stringify(res.body))) {
            err.noRetry = true;
          }
          throw err;
        }
        return res;
      },
      meta
    );
  }

  function markdownOf(body) {
    const md = body?.data?.markdown;
    return typeof md === "string" ? md : "";
  }

  function jsonOf(body) {
    return body?.data?.json ?? null;
  }

  function mapLinksOf(body) {
    const links = body?.links;
    if (!Array.isArray(links)) return [];
    return links.map((item) => {
      if (typeof item === "string") return { url: item };
      return { url: item?.url, title: item?.title, description: item?.description };
    }).filter((x) => x.url);
  }

  function searchHitsOf(body) {
    const web = body?.data?.web;
    if (Array.isArray(web)) return web;
    if (Array.isArray(body?.data)) return body.data;
    if (Array.isArray(body?.results)) return body.results;
    return [];
  }

  async function creditUsage() {
    bump();
    let res = await rawFetch("GET", "/v2/team/credit-usage");
    if (!res.ok) res = await rawFetch("GET", "/team/credit-usage");
    const remaining =
      res.body?.data?.remainingCredits ??
      res.body?.remainingCredits ??
      res.body?.credits_remaining ??
      res.body?.data?.credits_remaining;
    return {
      http: res.status,
      remaining: Number(remaining),
      raw: res.body,
    };
  }

  async function scrape(jsonBody, meta) {
    const res = await request("POST", "/v2/scrape", { jsonBody, timeoutMs: 180000 }, meta);
    return {
      status: res.status,
      markdown: markdownOf(res.body),
      json: jsonOf(res.body),
      metadata: res.body?.data?.metadata || {},
      body: res.body,
      creditsUsed: res.body?.data?.metadata?.creditsUsed || res.body?.creditsUsed || null,
    };
  }

  async function map(jsonBody, meta) {
    const res = await request("POST", "/v2/map", { jsonBody, timeoutMs: 120000 }, meta);
    const links = mapLinksOf(res.body);
    const sample = links[0];
    shapes.map_links = sample && typeof sample.url === "string" && !links.every((l) => typeof l === "string")
      ? "object[]"
      : Array.isArray(res.body?.links) && typeof res.body.links[0] === "string"
        ? "string[]"
        : shapes.map_links;
    return { status: res.status, links, body: res.body };
  }

  async function search(query, extra = {}, meta) {
    const res = await request(
      "POST",
      "/v2/search",
      { jsonBody: { query, limit: extra.limit ?? 8, country: extra.country || "IN" }, timeoutMs: 90000 },
      meta
    );
    return {
      status: res.status,
      id: res.body?.id,
      creditsUsed: res.body?.creditsUsed,
      hits: searchHitsOf(res.body),
      body: res.body,
    };
  }

  async function parseFile(buf, filename, meta) {
    bump();
    return withRetry(
      async () => {
        const form = new FormData();
        form.append("file", new Blob([buf]), filename);
        form.append("options", JSON.stringify({ parsers: [{ type: "pdf", pageMarkers: true }] }));
        const res = await rawFetch("POST", "/v2/parse", { form, timeoutMs: 180000 });
        if (!res.ok) {
          const err = new Error(`Firecrawl parse ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
          err.httpStatus = res.status;
          throw err;
        }
        return res;
      },
      meta
    );
  }

  let active = 0;
  const waiters = [];
  async function limit(fn) {
    while (active >= CONCURRENCY) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  }

  return {
    shapes,
    get calls() {
      return calls;
    },
    creditUsage,
    scrape: (body, meta) => limit(() => scrape(body, meta)),
    map: (body, meta) => limit(() => map(body, meta)),
    search: (q, extra, meta) => limit(() => search(q, extra, meta)),
    parseFile: (buf, name, meta) => limit(() => parseFile(buf, name, meta)),
    markdownOf,
    jsonOf,
    mapLinksOf,
    searchHitsOf,
  };
}

export function findMarkdownPath(obj, path = "$") {
  const hits = [];
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const p = `${path}.${k}`;
      if (k.toLowerCase() === "markdown" && typeof v === "string" && v.trim()) {
        hits.push({ path: p, length: v.length });
      }
      if (v && typeof v === "object") hits.push(...findMarkdownPath(v, Array.isArray(obj) ? `${path}[${k}]` : p));
    }
  }
  return hits;
}

export function findTextPath(obj, path = "$") {
  const hits = [];
  if (!obj || typeof obj !== "object") return hits;
  for (const [k, v] of Object.entries(obj)) {
    const p = `${path}.${k}`;
    if (typeof v === "string" && v.length > 80 && /markdown|text|content/i.test(k)) {
      hits.push({ path: p, length: v.length });
    }
    if (v && typeof v === "object" && hits.length < 20) hits.push(...findTextPath(v, p));
  }
  return hits;
}
