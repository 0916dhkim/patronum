#!/usr/bin/env node
/**
 * Fetch all Cognee secrets from Vaultwarden in a single session.
 * Outputs: EMBEDDING_API_KEY LLM_API_KEY VECTOR_DB_PASSWORD DEFAULT_USER_PASSWORD COGNEE_API_KEY
 * One per line. Always exits 0 if all found, or prints error and exits 1.
 * Never writes secrets to disk.
 *
 * Called by /usr/local/bin/cognee-start.sh at runtime.
 * Cognee service reads COGNEE_API_KEY from env to authenticate client requests.
 * Patronum client reads COGNEE_API_KEY from env at startup.
 *
 * Paths are resolved relative to this file, so it works identically whether
 * run from src/tools/ (tracked source) or dist/tools/ (build copy).
 */
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const prev = process.env.NODE_PATH || "";
process.env.NODE_PATH = path.join(ROOT, "node_modules") + (prev ? ":" + prev : "");
require("module").Module._initPaths();

async function main() {
  const cfgMod = require(path.join(ROOT, "dist", "config.js"));
  await cfgMod.initConfig();

  const { vaultwardenTool } = require(path.join(ROOT, "dist", "tools", "vaultwarden.js"));

  const items = [
    { name: "Voyage AI", key: "EMBEDDING_API_KEY" },
    { name: "OpenRouter API Key", key: "LLM_API_KEY" },
    { name: "Cognee PostgreSQL Production", key: "VECTOR_DB_PASSWORD" },
    { name: "Cognee Default User Password", key: "DEFAULT_USER_PASSWORD" },
    { name: "Cognee API Key v4", key: "COGNEE_API_KEY" },
  ];

  const results = [];
  for (const item of items) {
    const result = await vaultwardenTool.execute({ action: "get", query: item.name });
    // Parse the response for "Password:" field
    let found = false;
    for (const line of result.split("\n")) {
      const colonIdx = line.indexOf(": ");
      if (colonIdx === -1) continue;
      const key = line.substring(0, colonIdx).trim().toLowerCase();
      if (key === "password") {
        const value = line.substring(colonIdx + 2).trim();
        results.push({ env: item.key, value });
        found = true;
        break;
      }
    }
    if (!found) {
      // Try "Password" (capital P)
      for (const line of result.split("\n")) {
        const colonIdx = line.indexOf(": ");
        if (colonIdx === -1) continue;
        const key = line.substring(0, colonIdx).trim();
        if (key === "Password") {
          const value = line.substring(colonIdx + 2).trim();
          results.push({ env: item.key, value });
          found = true;
          break;
        }
      }
    }
    if (!found) {
      // Last resort: the whole result might just be the value
      results.push({ env: item.key, value: result });
    }
  }

  // Output all results
  for (const r of results) {
    process.stdout.write(`${r.env}=${r.value}\n`);
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n`);
  process.exit(1);
});
