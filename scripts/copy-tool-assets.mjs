import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = ["vaultwarden_helper.cjs", "vaultwarden_secrets.cjs"];

mkdirSync(path.join(root, "dist", "tools"), { recursive: true });
for (const asset of assets) {
  cpSync(path.join(root, "src", "tools", asset), path.join(root, "dist", "tools", asset));
  console.log(`copied ${asset} -> dist/tools/`);
}
