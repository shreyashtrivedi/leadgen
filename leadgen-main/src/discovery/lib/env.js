import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../../..");

export function loadEnv(root = ROOT) {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  if (!process.env.FIRECRAWL_API_KEY && process.env["Firecrawl API_KEY"]) {
    process.env.FIRECRAWL_API_KEY = process.env["Firecrawl API_KEY"];
  }
}

export function requireApiKey() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    throw new Error(
      "FIRECRAWL_API_KEY is not set. Put it in .env as FIRECRAWL_API_KEY or Firecrawl API_KEY."
    );
  }
  return key;
}
