import type { ToolHandler } from "../types.js";
import { config } from "../config.js";

const KAGI_BASE = "https://kagi.com/api/v1/search";
const TIMEOUT_MS = 10_000;
const MAX_RESULTS = 10;

type Workflow = "search" | "images" | "videos" | "news" | "podcasts";

// Response key used for results varies by workflow (singular for media types).
const WORKFLOW_DATA_KEY: Record<Workflow, string> = {
  search: "search",
  images: "image",
  videos: "video",
  news: "news",
  podcasts: "podcast",
};

interface KagiItem {
  url?: string;
  title?: string;
  snippet?: string;
  image?: { url?: string };
  published?: string;
}

interface KagiResponse {
  meta?: { trace?: string; ms?: number };
  data?: Record<string, unknown> | null;
  errors?: Array<{ code?: string; message?: string }>;
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const searchTool: ToolHandler = {
  definition: {
    name: "search",
    description:
      "Search the web using the Kagi Search API. Use this to find current information, look up topics, research questions.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        workflow: {
          type: "string",
          enum: ["search", "images", "videos", "news", "podcasts"],
          description:
            'Type of results: "search" (web), "images", "videos", "news", or "podcasts" — defaults to "search"',
        },
      },
      required: ["query"],
    },
  },

  async execute(input): Promise<string> {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) return "Search unavailable: empty query";

    const workflow = (input.workflow as Workflow) || "search";
    const validWorkflows: Workflow[] = ["search", "images", "videos", "news", "podcasts"];
    const effectiveWorkflow = validWorkflows.includes(workflow) ? workflow : "search";

    if (!config.kagiToken) {
      return "Search unavailable: no Kagi API token configured";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(KAGI_BASE, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.kagiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, workflow: effectiveWorkflow }),
      });

      clearTimeout(timeout);

      let data: KagiResponse | null = null;
      try {
        data = (await response.json()) as KagiResponse;
      } catch {
        // Non-JSON error body; fall through with status text
      }

      if (!response.ok) {
        const detail = data?.errors?.[0]?.message;
        const code = data?.errors?.[0]?.code;
        if (detail) {
          return `Search unavailable: ${response.status} ${response.statusText} — ${detail}`;
        }
        if (code) {
          return `Search unavailable: ${response.status} ${response.statusText} (${code})`;
        }
        return `Search unavailable: server returned ${response.status} ${response.statusText}`;
      }

      const dataKey = WORKFLOW_DATA_KEY[effectiveWorkflow];
      const rawResults = data?.data?.[dataKey];
      const results: KagiItem[] = Array.isArray(rawResults)
        ? (rawResults as KagiItem[])
        : [];

      if (results.length === 0) {
        const msg = `No results found for "${query}"`;
        const related = data?.data?.related_search;
        if (Array.isArray(related) && related.length > 0) {
          const terms = related
            .map((r) => (r as { title?: string }).title)
            .filter(Boolean)
            .join(", ");
          if (terms) return `${msg}\n\nRelated searches: ${terms}`;
        }
        return msg;
      }

      const top = results.slice(0, MAX_RESULTS);
      const formatted = top
        .map((r, i) => {
          const parts = [`${i + 1}. ${r.title || "(no title)"}`];
          if (r.url) parts.push(`   ${r.url}`);
          if (r.image?.url) parts.push(`   image: ${r.image.url}`);
          if (r.snippet) parts.push(`   ${stripHtml(r.snippet)}`);
          if (r.published) parts.push(`   published: ${r.published}`);
          return parts.join("\n");
        })
        .join("\n\n");

      const header = `Search results for "${query}" (${effectiveWorkflow}, ${results.length} results):`;
      return `${header}\n\n${formatted}`;
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        return "Search unavailable: request timed out after 10 seconds";
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `Search unavailable: ${msg}`;
    }
  },
};
