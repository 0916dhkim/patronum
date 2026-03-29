import crypto from "node:crypto";

export interface SecretPartyConfig {
  apiUrl: string;
  environmentId: string;
  privateKeyBase64: string;
}

export interface Secrets {
  claudeToken: string;
  telegramBotToken: string;
}

function derivePublicKeyBase64(privateKeyBase64: string): string {
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = crypto
    .createPublicKey(privateKeyObj)
    .export({ format: "der", type: "spki" });
  return Buffer.from(publicKeyDer).toString("base64");
}

async function unwrapDek(
  dekWrappedBase64: string,
  privateKeyBase64: string,
): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(privateKeyBase64, "base64"),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const dekBytes = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    Buffer.from(dekWrappedBase64, "base64"),
  );
  return Buffer.from(dekBytes).toString("base64");
}

function decryptSecretValue(valueEncrypted: string, dekBase64: string): string {
  const [ivB64, ciphertextB64] = valueEncrypted.split(";");
  if (!ivB64 || !ciphertextB64) {
    throw new Error(
      "Invalid encrypted secret format (expected ivBase64;ciphertextBase64)",
    );
  }

  const iv = Buffer.from(ivB64, "base64");
  const combined = Buffer.from(ciphertextB64, "base64");
  const dek = Buffer.from(dekBase64, "base64");
  const ciphertext = combined.subarray(0, combined.length - 16);
  const authTag = combined.subarray(combined.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

async function fetchSecret(
  config: SecretPartyConfig,
  key: string,
): Promise<string> {
  const publicKeyBase64 = derivePublicKeyBase64(config.privateKeyBase64);
  const url = `${config.apiUrl.replace(/\/$/, "")}/api/v1/environments/${encodeURIComponent(config.environmentId)}/secrets/${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${publicKeyBase64}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(
      `Secret Party: failed to fetch ${key}: ${res.status} ${res.statusText}`,
    );
  }

  const data = (await res.json()) as {
    dekWrappedByClientPublicKey: string;
    valueEncrypted: string;
  };
  const dek = await unwrapDek(
    data.dekWrappedByClientPublicKey,
    config.privateKeyBase64,
  );
  return decryptSecretValue(data.valueEncrypted, dek);
}

export async function loadSecrets(): Promise<Secrets> {
  const apiUrl = process.env.SECRET_PARTY_API_URL;
  const environmentId = process.env.SECRET_PARTY_ENVIRONMENT_ID;
  const privateKeyBase64 = process.env.SECRET_PARTY_PRIVATE_KEY_BASE64;

  if (!apiUrl || !environmentId || !privateKeyBase64) {
    throw new Error(
      "Missing Secret Party config: SECRET_PARTY_API_URL, SECRET_PARTY_ENVIRONMENT_ID, SECRET_PARTY_PRIVATE_KEY_BASE64",
    );
  }

  const cfg: SecretPartyConfig = { apiUrl, environmentId, privateKeyBase64 };

  console.log("[secrets] Fetching secrets from Secret Party...");
  const [claudeToken, telegramBotToken] = await Promise.all([
    fetchSecret(cfg, "CLAUDE_TOKEN"),
    fetchSecret(cfg, "TELEGRAM_BOT_TOKEN"),
  ]);
  console.log("[secrets] Secrets loaded successfully");

  return { claudeToken, telegramBotToken };
}
