import type { ToolHandler } from "../types.js";
import { config } from "../config.js";

const SEARXNG_BASE = "https://searxng.probablydanny.com";
const TIMEOUT_MS = 10_000;
const MAX_RESULTS = 10;

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
}

interface SearxngResponse {
  results?: SearxngResult[];
  suggestions?: string[];
  query?: string;
}

export const searchTool: ToolHandler = {
  definition: {
    name: "search",
    description:
      "Search the web using a self-hosted SearXNG instance. Use this to find current information, look up topics, research questions.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        categories: {
          type: "string",
          description:
            'Search categories e.g. "general", "news", "science" — defaults to "general"',
        },
        pageno: {
          type: "integer",
          description: "Page number, defaults to 1",
        },
      },
      required: ["query"],
    },
  },

  async execute(input): Promise<string> {
    const query = input.query as string;
    const categories = (input.categories as string) || "general";
    const pageno = (input.pageno as number) || 1;

    const params = new URLSearchParams({
      q: query,
      format: "json",
      categories,
      pageno: String(pageno),
    });

    if (config.searxngToken) {
      params.append("token", config.searxngToken);
    }

    const url = `${SEARXNG_BASE}/search?${params}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return `Search unavailable: server returned ${response.status} ${response.statusText}`;
      }

      const data = (await response.json()) as SearxngResponse;
      const results = data.results || [];

      if (results.length === 0) {
        const msg = `No results found for "${query}"`;
        if (data.suggestions && data.suggestions.length > 0) {
          return `${msg}\n\nSuggestions: ${data.suggestions.join(", ")}`;
        }
        return msg;
      }

      const top = results.slice(0, MAX_RESULTS);
      const formatted = top
        .map((r, i) => {
          const parts = [`${i + 1}. ${r.title || "(no title)"}`];
          if (r.url) parts.push(`   ${r.url}`);
          if (r.content) parts.push(`   ${r.content}`);
          return parts.join("\n");
        })
        .join("\n\n");

      const header = `Search results for "${query}" (page ${pageno}, ${results.length} results):`;
      return `${header}\n\n${formatted}`;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Search unavailable: request timed out after 10 seconds";
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `Search unavailable: ${msg}`;
    }
  },
};
