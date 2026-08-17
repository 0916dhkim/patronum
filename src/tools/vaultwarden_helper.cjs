#!/usr/bin/env node
/**
 * Vaultwarden helper — CLI for retrieving secrets by item name and field.
 * Used by Cognee start.sh / backup.sh for runtime-only secret injection.
 * Usage: vaultwarden_helper.cjs "Item Name" field
 *
 * Only prints the secret value, nothing else. Never persists to disk.
 *
 * Paths are resolved relative to this file, so it works identically whether
 * run from src/tools/ (tracked source) or dist/tools/ (build copy).
 */
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const prev = process.env.NODE_PATH || "";
process.env.NODE_PATH = path.join(ROOT, "node_modules") + (prev ? ":" + prev : "");
require("module").Module._initPaths();

const itemName = process.argv[2];
const field = (process.argv[3] || "password").toLowerCase();

if (!itemName) {
  process.stderr.write("Usage: vaultwarden_helper.cjs \"Item Name\" [field]\n");
  process.exit(1);
}

async function main() {
  const cfgMod = require(path.join(ROOT, "dist", "config.js"));
  await cfgMod.initConfig();

  const { vaultwardenTool } = require(path.join(ROOT, "dist", "tools", "vaultwarden.js"));
  const result = await vaultwardenTool.execute({ action: "get", query: itemName });

  // Try exact match first, then case-insensitive
  for (const line of result.split("\n")) {
    const colonIdx = line.indexOf(": ");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    if (key.toLowerCase() === field) {
      const value = line.substring(colonIdx + 2).trim();
      process.stdout.write(value + "\n");
      process.exit(0);
    }
  }

  process.stderr.write(`Field "${field}" not found for item "${itemName}"\n`);
  process.exit(1);
}

main().catch(e => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
