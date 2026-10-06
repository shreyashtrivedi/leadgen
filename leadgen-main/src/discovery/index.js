import fs from "node:fs";
import path from "node:path";
import { loadEnv, ROOT } from "./lib/env.js";
import { createFirecrawl, HaltError, BudgetError } from "./lib/firecrawl.js";
import { createStore } from "./lib/store.js";
import { probeShapes } from "./stages/probe.js";
import { stageHarvest } from "./stages/harvest.js";
import { dedupeHospitals } from "./stages/dedupe.js";
import { stageContacts } from "./stages/contacts.js";
import { scoreHospitals } from "./stages/score.js";
import { readCsvFile } from "./lib/csv.js";
import { nowIso } from "./lib/text.js";
import { reprocessOffline } from "./reprocess.js";
import { DATA_DIR } from "./config.js";

loadEnv();
if (!process.stdout.isTTY) {
  process.stdout.write = process.stdout.write.bind(process.stdout);
}

function runId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function csvCounts(store) {
  return {
    hospitals_raw: readCsvFile(store.files.raw).rows.length,
    hospitals: readCsvFile(store.files.hospitals).rows.length,
    contacts: readCsvFile(store.files.contacts).rows.length,
    errors: readCsvFile(store.files.errors).rows.length,
    run_log: readCsvFile(store.files.runLog).rows.length,
  };
}

function writeReport(store, report) {
  const dest = path.join(ROOT, DATA_DIR, "run_report.md");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, report, "utf8");
}

function formatReport(ctx) {
  const errors = readCsvFile(ctx.store.files.errors).rows;
  const hospitals = readCsvFile(ctx.store.files.hospitals).rows
    .slice()
    .sort((a, b) => Number(b.priority_score) - Number(a.priority_score));
  const top20 = hospitals.slice(0, 20);
  const errBody = errors.length
    ? errors.map((e) => `- ${e.timestamp} [${e.stage}/${e.node_name}] ${e.input_ref}: ${e.error_message}`).join("\n")
    : "(empty)";
  const topTable = [
    "| score | hospital | city | pin | phone | sources | needs_call |",
    "| ---: | --- | --- | --- | --- | --- | --- |",
    ...top20.map(
      (h) =>
        `| ${h.priority_score} | ${h.hospital_name} | ${h.city} | ${h.pincode} | ${h.switchboard_phone} | ${h.source_index} | ${h.needs_phone_call} |`
    ),
  ].join("\n");

  return `# EaseMed discovery run ${ctx.runId}

## 1. Substrate
**Local Node.js script** (\`src/discovery/\`) because this n8n instance is Cloud (no persistent filesystem). \`readWriteFile\` exists as a node but cannot satisfy \`./data/*.csv\` on Cloud.
Team projects: none returned (\`projectId\`: n/a). Personal Cloud workspace.

## 2. Credits and calls
- Credits before: **${ctx.creditsBefore}**
- Credits after: **${ctx.creditsAfter}**
- Firecrawl calls this run: **${ctx.fc.calls}**
- Probe shapes: markdown \`$.data.markdown\`; json \`$.data.json\`; map links **${ctx.shapes.map_links}** at \`$.links\`; search hits \`$.data.web\`; credits \`$.data.remainingCredits\`
- PDF parse: ${ctx.shapes.pdf_parse_ok === true ? `ok, text path ${ctx.shapes.parse_text_path}` : ctx.shapes.pdf_parse_ok === false ? "error (PDF sources skipped where applicable)" : "no PDF in seeds / not run"}

## 3. Resolved seeds and canary scoring
${ctx.harvest.scoring.map((s) => {
  const status = s.survived ? "SURVIVED" : "REJECTED";
  return `### ${s.source_key} — ${status}
- Query: \`${s.query}\`
- Search URLs: ${(s.resolved_urls || []).join(", ") || "(none)"}
- Winner: ${s.winner_url || "—"}
- Canary rows: ${s.canary_rows}
- Pagination: ${s.pagination_style || "—"} / ${s.content_type || "—"}
- Attempts: \`${JSON.stringify(s.attempts).slice(0, 1500)}\`
- Reject reasons: ${(s.reject_reasons || []).join("; ") || "—"}
`;
}).join("\n")}

## 4. Row counts
| Stage | input | output | dropped | notes |
| --- | ---: | ---: | ---: | --- |
| Harvest | ${ctx.harvest.resolved.length} sources | ${ctx.harvest.rawRows.length} | ${ctx.harvest.resolved.length - ctx.harvest.survivors.length} sources | survivors: ${ctx.harvest.survivors.map((s) => s.source_key).join(", ")} |
| Dedupe | ${ctx.dedupe.input_count} | ${ctx.dedupe.output_count} | ${ctx.dedupe.dropped_count} | key order: domain, phone, name+pincode |
| Contacts | ${ctx.contacts.hospitalsWithWebsite} hospitals with website | ${ctx.contacts.contacts.length} | — | dry-run pages: ${ctx.contacts.dryPages.length} |

## 5. Five example dedupe merges
${(ctx.dedupe.merges.slice(0, 5).length ? ctx.dedupe.merges.slice(0, 5) : [{ note: "no merges" }])
    .map((m, i) => `${i + 1}. \`${JSON.stringify(m)}\``)
    .join("\n")}

## 6. Named-contact hit rate
**${ctx.contacts.hitRate.toFixed(2)}%** of hospitals with a website (${ctx.contacts.namedHit}/${ctx.contacts.hospitalsWithWebsite}).

## 7. CSV row counts
${Object.entries(ctx.counts).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

## 8. errors.csv
${errBody}

## 9. Top 20 hospitals.csv by priority_score
${topTable}

## 10. README
See repo \`README.md\` for adding a source adapter, re-running for another city, and cost per 100 hospitals.
`;
}

async function main() {
  const id = runId();
  const store = createStore(id);
  const fc = createFirecrawl({
    onError: (row) => store.logError({ ...row, timestamp: nowIso() }),
  });

  console.log(`EaseMed discovery ${id}`);
  console.log("Substrate: local Node.js (n8n Cloud has no persistent filesystem). Team projectId: none.");

  let creditsBefore = null;
  const ctx = { runId: id, store, fc, shapes: fc.shapes };

  try {
    const calls0 = fc.calls;
    const probe = await probeShapes(fc, store, calls0);
    creditsBefore = probe.credits.remaining;
    ctx.creditsBefore = creditsBefore;
    console.log(`ASSERT credits_remaining=${creditsBefore} >= 600 OK`);
    console.log(`ASSERT markdown path $.data.markdown len=${probe.sample.markdown_len} OK`);
    console.log(`ASSERT map links shape ${probe.sample.map_links} OK`);

    const harvest = await stageHarvest(fc, store, fc.calls);
    ctx.harvest = harvest;
    console.log(`ASSERT surviving sources=${harvest.survivors.length} raw=${harvest.rawRows.length} OK`);

    const d0 = Date.now();
    const dedupe = dedupeHospitals(harvest.rawRows);
    if (dedupe.output_count > dedupe.input_count) {
      throw new HaltError(`dedupe output_count ${dedupe.output_count} > input_count ${dedupe.input_count}`);
    }
    store.logRun({
      stage: "dedupe",
      node_name: "normalise_dedupe",
      input_count: dedupe.input_count,
      output_count: dedupe.output_count,
      dropped_count: dedupe.dropped_count,
      sample_output_json: { merges: dedupe.merges.slice(0, 5) },
      firecrawl_calls: 0,
      duration_ms: Date.now() - d0,
    });
    ctx.dedupe = dedupe;
    console.log(`ASSERT dedupe ${dedupe.output_count} <= ${dedupe.input_count} OK; merges logged: ${Math.min(5, dedupe.merges.length)}`);

    const contactsStart = fc.calls;
    const contacts = await stageContacts(fc, store, dedupe.records, { callsAtStart: contactsStart });
    ctx.contacts = contacts;
    console.log(`ASSERT extractor returned [] on at least one dry-run page OK`);

    const scored = scoreHospitals(dedupe.records, contacts.contacts, contacts.websiteFlags);
    store.upsertHospitals(scored.map(({ _contact_person, _merge_reason, ...row }) => row));

    const offline = reprocessOffline(store);
    ctx.dedupe = offline.dedupe;
    ctx.contacts = {
      ...contacts,
      contacts: readCsvFile(store.files.contacts).rows,
      hitRate: contacts.hospitalsWithWebsite
        ? (new Set(readCsvFile(store.files.contacts).rows.filter((c) => c.extraction_confidence !== "source_index").map((c) => c.hospital_id)).size /
            contacts.hospitalsWithWebsite) *
          100
        : 0,
      namedHit: new Set(readCsvFile(store.files.contacts).rows.filter((c) => c.extraction_confidence !== "source_index").map((c) => c.hospital_id)).size,
    };
    store.logRun({
      stage: "reprocess",
      node_name: "karnataka_filter_plus_local_insurer",
      input_count: harvest.rawRows.length,
      output_count: offline.dedupe.output_count,
      dropped_count: harvest.rawRows.length - offline.fromRaw,
      sample_output_json: {
        from_raw_kept: offline.fromRaw,
        local_insurer_added: offline.localAdded,
        note: "Dropped other-state NABH rows; merged bangalore-hospital-list.md; stripped directory websites",
      },
      firecrawl_calls: 0,
      duration_ms: 0,
    });

    const creditsAfter = await fc.creditUsage();
    ctx.creditsAfter = creditsAfter.remaining;
    ctx.counts = csvCounts(store);

    const md = formatReport(ctx);
    writeReport(store, md);
    console.log(md);
    console.log(`\nWrote ${path.join(DATA_DIR, "*.csv")} and ${path.join(DATA_DIR, "run_report.md")}`);
    console.log(`Firecrawl calls=${fc.calls} credits ${creditsBefore} → ${creditsAfter.remaining}`);
  } catch (err) {
    const creditsAfter = await fc.creditUsage().catch(() => ({ remaining: "unknown" }));
    ctx.creditsBefore = creditsBefore;
    ctx.creditsAfter = creditsAfter.remaining;
    if (err.details?.scoring) {
      ctx.harvest = {
        scoring: err.details.scoring,
        survivors: err.details.survivors || [],
        rawRows: { length: err.details.raw_rows || 0 },
        resolved: err.details.resolved || [],
      };
    }
    ctx.harvest = ctx.harvest || { scoring: [], survivors: [], rawRows: [], resolved: [] };
    ctx.dedupe = ctx.dedupe || { input_count: 0, output_count: 0, dropped_count: 0, merges: [] };
    ctx.contacts = ctx.contacts || { contacts: [], websiteFlags: new Map(), hospitalsWithWebsite: 0, namedHit: 0, hitRate: 0, dryPages: [] };
    ctx.counts = csvCounts(store);
    ctx.shapes = fc.shapes;
    store.logError({
      stage: "halt",
      node_name: err.name || "HaltError",
      input_ref: id,
      error_message: err.message,
      http_status: err.httpStatus || "",
    });
    const md = formatReport(ctx) + `\n\n## HALT\n${err.message}\n\n\`\`\`json\n${JSON.stringify(err.details || {}, null, 2).slice(0, 8000)}\n\`\`\`\n`;
    writeReport(store, md);
    console.error(md);
    if (err instanceof BudgetError) {
      console.error("Partial run written; exiting clean after budget halt.");
      process.exit(0);
    }
    process.exit(2);
  }
}

main();
