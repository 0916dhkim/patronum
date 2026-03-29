/**
 * Voyage AI embeddings client.
 * Uses voyage-3-large for high-quality semantic search.
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3-large";

let apiKey: string | undefined;

export function initEmbeddings(key: string): void {
  apiKey = key;
}

/**
 * Embed one or more texts. Returns an array of float arrays.
 * Voyage supports batching up to 128 texts per request.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!apiKey) throw new Error("Voyage API key not configured");
  if (texts.length === 0) return [];

  const response = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: texts,
      input_type: "document",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Voyage API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  return data.data.map((d) => d.embedding);
}

/**
 * Embed a single query (uses input_type: "query" for asymmetric search).
 */
export async function embedQuery(text: string): Promise<number[]> {
  if (!apiKey) throw new Error("Voyage API key not configured");

  const response = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: [text],
      input_type: "query",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Voyage API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  return data.data[0].embedding;
}
