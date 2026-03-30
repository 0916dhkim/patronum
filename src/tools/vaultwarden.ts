import crypto from "node:crypto";
import { config } from "../config.js";
import type { ToolHandler } from "../types.js";

// --- Types ---

interface VaultCipher {
  Id: string;
  Type: number; // 1=Login, 2=SecureNote, 3=Card, 4=Identity
  Name: string; // encrypted
  Notes: string | null; // encrypted
  Login:
    | {
        Username: string | null; // encrypted
        Password: string | null; // encrypted
        Totp: string | null; // encrypted
        Uris: Array<{ Uri: string }> | null; // each Uri is encrypted
      }
    | null;
}

interface DecryptedItem {
  id: string;
  type: string;
  name: string;
  username?: string;
  password?: string;
  notes?: string;
  urls?: string[];
  totp?: string;
}

interface ParsedCipher {
  type: number;
  iv: Buffer;
  ct: Buffer;
  mac: Buffer | null;
}

// --- Crypto functions ---

// CRITICAL: HKDF-Expand only — do NOT use crypto.hkdfSync
// Bitwarden treats the master key as the PRK directly, only doing the Expand step.
// crypto.hkdfSync does Extract+Expand and produces wrong keys.
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const hashLen = 32; // SHA-256
  const n = Math.ceil(length / hashLen);
  let prev = Buffer.alloc(0);
  const buffers: Buffer[] = [];
  for (let i = 1; i <= n; i++) {
    const hmac = crypto.createHmac("sha256", prk);
    hmac.update(prev);
    hmac.update(info);
    hmac.update(Buffer.from([i]));
    prev = hmac.digest();
    buffers.push(prev);
  }
  return Buffer.concat(buffers).subarray(0, length);
}

function parseCipherString(s: string): ParsedCipher {
  const dotIndex = s.indexOf(".");
  const type = parseInt(s.substring(0, dotIndex), 10);
  const rest = s.substring(dotIndex + 1);
  const parts = rest.split("|");
  return {
    type,
    iv: Buffer.from(parts[0], "base64"),
    ct: Buffer.from(parts[1], "base64"),
    mac: parts[2] ? Buffer.from(parts[2], "base64") : null,
  };
}

function decryptCipherString(cipherString: string, encKey: Buffer, macKey: Buffer): Buffer {
  const parsed = parseCipherString(cipherString);
  if (parsed.mac) {
    const macData = Buffer.concat([parsed.iv, parsed.ct]);
    const computed = crypto.createHmac("sha256", macKey).update(macData).digest();
    if (!crypto.timingSafeEqual(computed, parsed.mac)) {
      throw new Error("HMAC verification failed");
    }
  }
  const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, parsed.iv);
  return Buffer.concat([decipher.update(parsed.ct), decipher.final()]);
}

function decryptToString(cipherString: string | null, encKey: Buffer, macKey: Buffer): string | undefined {
  if (!cipherString) return undefined;
  try {
    return decryptCipherString(cipherString, encKey, macKey).toString("utf8");
  } catch {
    return undefined;
  }
}

// --- VaultSession class ---

class VaultSession {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private userEncKey: Buffer | null = null;
  private userMacKey: Buffer | null = null;
  private cachedCiphers: VaultCipher[] | null = null;
  private cacheTime: number = 0;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  async ensureAuth(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiry) return;

    const email = config.vaultwardenEmail;
    const password = config.vaultwardenMasterPassword;
    const baseUrl = config.vaultwardenUrl.replace(/\/$/, "");

    // Step 1: prelogin to get KDF params
    const preloginRes = await fetch(`${baseUrl}/api/accounts/prelogin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!preloginRes.ok) throw new Error(`Prelogin failed: ${preloginRes.status}`);
    const prelogin = (await preloginRes.json()) as { kdfIterations: number };

    // Step 2: derive master key
    const masterKey = crypto.pbkdf2Sync(
      Buffer.from(password, "utf8"),
      Buffer.from(email.toLowerCase(), "utf8"),
      prelogin.kdfIterations,
      32,
      "sha256"
    );

    // Step 3: derive master password hash
    const masterPasswordHash = crypto
      .pbkdf2Sync(masterKey, Buffer.from(password, "utf8"), 1, 32, "sha256")
      .toString("base64");

    // Step 4: login
    const body = new URLSearchParams({
      grant_type: "password",
      username: email,
      password: masterPasswordHash,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier: "patronum-agent",
      deviceName: "Patronum",
    });

    const loginRes = await fetch(`${baseUrl}/identity/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!loginRes.ok) {
      const text = await loginRes.text();
      throw new Error(`Login failed: ${loginRes.status} ${text}`);
    }
    const loginData = (await loginRes.json()) as {
      access_token: string;
      expires_in: number;
      Key: string;
    };

    this.accessToken = loginData.access_token;
    this.tokenExpiry = Date.now() + loginData.expires_in * 1000 - 60_000;

    // Step 5: decrypt user symmetric key
    const stretchedEncKey = hkdfExpand(masterKey, Buffer.from("enc"), 32);
    const stretchedMacKey = hkdfExpand(masterKey, Buffer.from("mac"), 32);
    const decryptedKey = decryptCipherString(loginData.Key, stretchedEncKey, stretchedMacKey);
    this.userEncKey = decryptedKey.subarray(0, 32);
    this.userMacKey = decryptedKey.subarray(32, 64);
    this.cachedCiphers = null; // force re-fetch
  }

  private retrying401 = false;

  async fetchVault(): Promise<VaultCipher[]> {
    const baseUrl = config.vaultwardenUrl.replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/api/sync`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) {
      if (this.retrying401) {
        this.retrying401 = false;
        throw new Error("Vault sync failed: 401 after re-authentication");
      }
      this.retrying401 = true;
      this.invalidate();
      await this.ensureAuth();
      const result = await this.fetchVault();
      this.retrying401 = false;
      return result;
    }
    if (!res.ok) throw new Error(`Vault sync failed: ${res.status}`);
    const data = (await res.json()) as { Ciphers: VaultCipher[] };
    return data.Ciphers;
  }

  async getItems(): Promise<VaultCipher[]> {
    if (this.cachedCiphers && Date.now() - this.cacheTime < VaultSession.CACHE_TTL_MS) {
      return this.cachedCiphers;
    }
    await this.ensureAuth();
    this.cachedCiphers = await this.fetchVault();
    this.cacheTime = Date.now();
    return this.cachedCiphers;
  }

  decryptItem(cipher: VaultCipher): DecryptedItem {
    const encKey = this.userEncKey!;
    const macKey = this.userMacKey!;

    const typeMap: Record<number, string> = {
      1: "Login",
      2: "SecureNote",
      3: "Card",
      4: "Identity",
    };

    const item: DecryptedItem = {
      id: cipher.Id,
      type: typeMap[cipher.Type] || `Type${cipher.Type}`,
      name: decryptToString(cipher.Name, encKey, macKey) || "(unknown)",
    };

    if (cipher.Login) {
      item.username = decryptToString(cipher.Login.Username, encKey, macKey);
      item.password = decryptToString(cipher.Login.Password, encKey, macKey);
      item.totp = decryptToString(cipher.Login.Totp, encKey, macKey);
      if (cipher.Login.Uris) {
        item.urls = cipher.Login.Uris.map(u => decryptToString(u.Uri, encKey, macKey)).filter(
          (u): u is string => !!u
        );
      }
    }

    item.notes = decryptToString(cipher.Notes, encKey, macKey);
    return item;
  }

  invalidate(): void {
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.userEncKey = null;
    this.userMacKey = null;
    this.cachedCiphers = null;
    this.retrying401 = false;
  }
}

const session = new VaultSession();

// --- Tool export ---

export const vaultwardenTool: ToolHandler = {
  definition: {
    name: "vaultwarden",
    description:
      "Access secrets from the Vaultwarden password vault. " +
      "Use 'list' to see all items, 'get' to retrieve a specific item's credentials, " +
      "or 'search' to find items by name.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "search"],
          description: "Action to perform",
        },
        query: {
          type: "string",
          description:
            "For 'get': exact name or ID of the item. For 'search': keyword to match against item names.",
        },
      },
      required: ["action"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    if (!config.vaultwardenUrl || !config.vaultwardenEmail || !config.vaultwardenMasterPassword) {
      return "Vaultwarden not configured. Add [vaultwarden] section to patronum.toml with url, email, and master_password.";
    }

    const action = input.action as string;
    const query = input.query as string | undefined;

    try {
      switch (action) {
        case "list": {
          const ciphers = await session.getItems();
          if (ciphers.length === 0) return "Vault is empty — no items found.";
          const items = ciphers.map(c => session.decryptItem(c));
          const lines = items.map(i => `• ${i.name} (${i.type})${i.username ? " — " + i.username : ""}`);
          return `Vault items (${items.length}):\n${lines.join("\n")}`;
        }

        case "get": {
          if (!query) return "Error: 'query' parameter required for 'get' action (item name or ID).";
          const ciphers = await session.getItems();
          const items = ciphers.map(c => session.decryptItem(c));
          const match =
            items.find(i => i.id === query) ||
            items.find(i => i.name.toLowerCase() === query.toLowerCase()) ||
            items.find(i => i.name.toLowerCase().includes(query.toLowerCase()));
          if (!match) return `No item found matching "${query}".`;

          const parts: string[] = [`Name: ${match.name}`, `Type: ${match.type}`];
          if (match.username) parts.push(`Username: ${match.username}`);
          if (match.password) parts.push(`Password: ${match.password}`);
          if (match.totp) parts.push(`TOTP: ${match.totp}`);
          if (match.urls?.length) parts.push(`URLs: ${match.urls.join(", ")}`);
          if (match.notes) parts.push(`Notes: ${match.notes}`);
          return parts.join("\n");
        }

        case "search": {
          if (!query) return "Error: 'query' parameter required for 'search' action.";
          const ciphers = await session.getItems();
          const items = ciphers.map(c => session.decryptItem(c));
          const q = query.toLowerCase();
          const matches = items.filter(i => i.name.toLowerCase().includes(q));
          if (matches.length === 0) return `No items matching "${query}".`;
          const lines = matches.map(i => `• ${i.name} (${i.type})${i.username ? " — " + i.username : ""}`);
          return `Found ${matches.length} item(s):\n${lines.join("\n")}`;
        }

        default:
          return `Unknown action: "${action}". Use "list", "get", or "search".`;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Vaultwarden error: ${msg}`;
    }
  },
};
