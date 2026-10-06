import path from "node:path";
import { upsertCsv, pipeJoin } from "./csv.js";
import {
  DATA_DIR,
  HOSPITALS_RAW_HEADERS,
  HOSPITALS_HEADERS,
  CONTACTS_HEADERS,
  ERRORS_HEADERS,
  RUN_LOG_HEADERS,
} from "../config.js";
import { ROOT } from "./env.js";
import { nowIso } from "./text.js";

export function dataPath(name) {
  return path.join(ROOT, DATA_DIR, name);
}

export function createStore(runId) {
  const files = {
    raw: dataPath("hospitals_raw.csv"),
    hospitals: dataPath("hospitals.csv"),
    contacts: dataPath("contacts.csv"),
    errors: dataPath("errors.csv"),
    runLog: dataPath("run_log.csv"),
  };

  function logError(row) {
    upsertCsv(
      files.errors,
      ERRORS_HEADERS,
      [
        {
          run_id: runId,
          stage: row.stage || "",
          node_name: row.node_name || "",
          input_ref: row.input_ref || "",
          error_message: String(row.error_message || "").slice(0, 2000),
          http_status: row.http_status ?? "",
          retry_count: row.retry_count ?? "",
          timestamp: row.timestamp || nowIso(),
        },
      ],
      (r) => `${r.run_id}|${r.stage}|${r.node_name}|${r.input_ref}|${r.timestamp}|${r.error_message}`
    );
  }

  function logRun(row) {
    const ts = row.timestamp || nowIso();
    upsertCsv(
      files.runLog,
      RUN_LOG_HEADERS,
      [
        {
          run_id: runId,
          stage: row.stage,
          node_name: row.node_name,
          input_count: row.input_count ?? "",
          output_count: row.output_count ?? "",
          dropped_count: row.dropped_count ?? "",
          sample_output_json: typeof row.sample_output_json === "string"
            ? row.sample_output_json
            : JSON.stringify(row.sample_output_json || {}).slice(0, 4000),
          firecrawl_calls: row.firecrawl_calls ?? "",
          duration_ms: row.duration_ms ?? "",
          timestamp: ts,
        },
      ],
      (r) => `${r.run_id}|${r.stage}|${r.node_name}|${r.timestamp}`
    );
  }

  function appendRaw(rows) {
    upsertCsv(
      files.raw,
      HOSPITALS_RAW_HEADERS,
      rows.map((r) => ({
        run_id: runId,
        source_key: r.source_key,
        source_url: r.source_url,
        payload_json: typeof r.payload_json === "string" ? r.payload_json : JSON.stringify(r.payload_json),
        scraped_at: r.scraped_at || nowIso(),
      })),
      (r) => `${r.run_id}|${r.source_key}|${String(r.payload_json).slice(0, 80)}|${r.source_url}`
    );
  }

  // raw key per spec: run_id + source_key + row_index — caller should pass row_index in payload
  function appendRawIndexed(sourceKey, sourceUrl, payloads, scrapedAt) {
    const rows = payloads.map((p, i) => ({
      run_id: runId,
      source_key: sourceKey,
      source_url: sourceUrl,
      payload_json: JSON.stringify({ row_index: i, ...p }),
      scraped_at: scrapedAt,
    }));
    upsertCsv(
      files.raw,
      HOSPITALS_RAW_HEADERS,
      rows,
      (r) => {
        let idx = "";
        try {
          idx = JSON.parse(r.payload_json).row_index;
        } catch {
          idx = "";
        }
        return `${r.run_id}|${r.source_key}|${idx}`;
      }
    );
  }

  return {
    files,
    runId,
    logError,
    logRun,
    appendRaw,
    appendRawIndexed,
    upsertHospitals(rows) {
      return upsertCsv(files.hospitals, HOSPITALS_HEADERS, rows, (r) => r.hospital_id);
    },
    upsertContacts(rows) {
      return upsertCsv(files.contacts, CONTACTS_HEADERS, rows, (r) => r.contact_id);
    },
    pipeJoin,
  };
}
