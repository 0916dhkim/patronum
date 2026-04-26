import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { config } from "../config.js";

// Content blocks that can appear in test history
export type ContentBlock =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      | {
          type: "tool_result";
          tool_use_id: string;
          content: Array<{ type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } }>;
        }
    >;

export interface EvalTestInput {
  history?: Array<{ role: "user" | "assistant"; content: ContentBlock }>;
  history_file?: string;
  message?: string;
  mock_recall?: string;
}

export interface EvalTestAssertions {
  tools_called?: string[];
  tools_not_called?: string[];
  graded?: string[];
  response_contains?: string[];
  response_not_contains?: string[];
}

export interface EvalTest {
  name: string;
  description?: string;
  comments?: string;
  agent?: string;
  tags?: string[];
  input: EvalTestInput;
  assertions: EvalTestAssertions;
}

/**
 * Resolve fixture references in history content blocks.
 * For each type: "image" block where source.type === "fixture":
 * - Validate the fixture path (no ".." or leading "/")
 * - Resolve to tests/fixtures/<path>
 * - Check file exists
 * - Detect media type from extension
 * - Read and base64-encode the file
 * - Replace source with { type: "base64", media_type, data: <base64> }
 * 
 * Walks two nesting levels:
 * 1. Top-level image blocks in history entries
 * 2. Image blocks nested inside tool_result content arrays
 */
function resolveFixtures(history: Array<{ role: string; content: ContentBlock }> | undefined, filename: string): void {
  if (!history) {
    return;
  }

  for (const entry of history) {
    // Handle content that is an array of content blocks
    if (Array.isArray(entry.content)) {
      resolveFixturesInContentArray(entry.content, filename);
    }
  }
}

function resolveFixturesInContentArray(
  content: Array<{
    type: string;
    text?: string;
    source?: unknown;
    tool_use_id?: string;
    content?: Array<unknown>;
    [key: string]: unknown;
  }>,
  filename: string
): void {
  for (let i = 0; i < content.length; i++) {
    const block = content[i];

    // Handle top-level image blocks
    if (block.type === "image") {
      resolveFixtureInImageBlock(block as any, filename);
    }

    // Handle tool_result blocks with nested content
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      for (let j = 0; j < block.content.length; j++) {
        const innerBlock = block.content[j] as any;
        if (innerBlock?.type === "image") {
          resolveFixtureInImageBlock(innerBlock, filename);
        }
      }
    }
  }
}

function resolveFixtureInImageBlock(
  block: any,
  filename: string
): void {
  const source = block.source;
  if (!source || source.type !== "fixture") {
    return;
  }

  const fixturePath = source.path;
  if (!fixturePath || typeof fixturePath !== "string") {
    throw new Error(`Invalid fixture path in ${filename}: path must be a non-empty string`);
  }

  // Validate: no ".." or leading "/"
  if (fixturePath.includes("..") || fixturePath.startsWith("/")) {
    throw new Error(`Fixture path must be relative and cannot contain '..': ${fixturePath}`);
  }

  // Resolve to tests/fixtures/<path>
  const fullPath = path.join(config.workspace, "tests", "fixtures", fixturePath);

  // Check file exists
  if (!existsSync(fullPath)) {
    throw new Error(`Fixture not found: ${fixturePath} (in ${filename})`);
  }

  // Detect media type from extension
  const ext = path.extname(fixturePath).toLowerCase();
  let mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";

  switch (ext) {
    case ".png":
      mediaType = "image/png";
      break;
    case ".jpg":
    case ".jpeg":
      mediaType = "image/jpeg";
      break;
    case ".gif":
      mediaType = "image/gif";
      break;
    case ".webp":
      mediaType = "image/webp";
      break;
    default:
      throw new Error(`Unsupported fixture extension: ${ext} (in ${filename})`);
  }

  // Read and base64-encode
  const data = readFileSync(fullPath, "base64");

  // Replace source
  block.source = {
    type: "base64",
    media_type: mediaType,
    data: data,
  };
}

function validateTest(test: unknown, filename: string): EvalTest {
  if (typeof test !== "object" || test === null) {
    throw new Error(`Invalid test in ${filename}: expected object`);
  }

  const obj = test as Record<string, unknown>;

  // Validate name
  if (!obj.name || typeof obj.name !== "string") {
    throw new Error(`Invalid test in ${filename}: missing required field 'name' (string)`);
  }

  // Validate input
  if (!obj.input || typeof obj.input !== "object") {
    throw new Error(`Invalid test in ${filename}: missing required field 'input' (object)`);
  }

  const input = obj.input as Record<string, unknown>;
  if (input.message !== undefined && typeof input.message !== "string") {
    throw new Error(`Invalid test in ${filename}: input.message must be a string if provided`);
  }

  // Validate history_file if present and load it
  let historyFromFile: Array<{ role: "user" | "assistant"; content: ContentBlock }> = [];
  if (input.history_file !== undefined) {
    if (typeof input.history_file !== "string") {
      throw new Error(`Invalid test in ${filename}: input.history_file must be a string`);
    }

    const historyFilePath = path.join(config.workspace, input.history_file);
    if (!existsSync(historyFilePath)) {
      throw new Error(`History file not found: ${input.history_file} (resolved to ${historyFilePath})`);
    }

    try {
      const fileContent = readFileSync(historyFilePath, "utf-8");
      const parsed = JSON.parse(fileContent);

      if (!Array.isArray(parsed)) {
        throw new Error(`History file must contain a JSON array of messages`);
      }

      for (let i = 0; i < parsed.length; i++) {
        const entry = parsed[i];
        if (typeof entry !== "object" || entry === null) {
          throw new Error(`History file entry[${i}] must be an object`);
        }

        const h = entry as Record<string, unknown>;
        if (!h.role || typeof h.role !== "string" || !["user", "assistant"].includes(h.role)) {
          throw new Error(`History file entry[${i}].role must be "user" or "assistant"`);
        }

        if (h.content === undefined) {
          throw new Error(`History file entry[${i}].content is required`);
        }

        // Accept string or array content
        if (typeof h.content === "string") {
          historyFromFile.push({
            role: h.role as "user" | "assistant",
            content: h.content,
          });
        } else if (Array.isArray(h.content)) {
          historyFromFile.push({
            role: h.role as "user" | "assistant",
            content: h.content as ContentBlock,
          });
        } else {
          throw new Error(`History file entry[${i}].content must be a string or array`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load history file ${input.history_file}: ${message}`);
    }
  }

  // Validate inline history if present
  let history: Array<{ role: "user" | "assistant"; content: ContentBlock }> | undefined;
  if (input.history !== undefined) {
    if (!Array.isArray(input.history)) {
      throw new Error(`Invalid test in ${filename}: input.history must be an array`);
    }

    history = [];
    for (let i = 0; i < input.history.length; i++) {
      const entry = input.history[i];
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`Invalid test in ${filename}: input.history[${i}] must be an object`);
      }

      const h = entry as Record<string, unknown>;
      if (!h.role || typeof h.role !== "string" || !["user", "assistant"].includes(h.role)) {
        throw new Error(`Invalid test in ${filename}: input.history[${i}].role must be "user" or "assistant"`);
      }

      // Content can be a string or an array of content blocks
      if (h.content === undefined) {
        throw new Error(`Invalid test in ${filename}: input.history[${i}].content is required`);
      }

      // Accept string or array content
      if (typeof h.content === "string") {
        history.push({
          role: h.role as "user" | "assistant",
          content: h.content,
        });
      } else if (Array.isArray(h.content)) {
        history.push({
          role: h.role as "user" | "assistant",
          content: h.content as ContentBlock,
        });
      } else {
        throw new Error(`Invalid test in ${filename}: input.history[${i}].content must be a string or array`);
      }
    }
  }

  // Merge history: history_file prepended before inline history
  if (historyFromFile.length > 0 || history) {
    history = [...historyFromFile, ...(history || [])];
  }

  // Validate assertions if present
  let assertions: EvalTestAssertions = {};
  if (obj.assertions && typeof obj.assertions === "object") {
    assertions = obj.assertions as EvalTestAssertions;
  }

  // Validate agent if present
  let agent: string | undefined;
  if (obj.agent !== undefined) {
    if (typeof obj.agent !== "string") {
      throw new Error(`Invalid test in ${filename}: agent must be a string (got ${typeof obj.agent})`);
    }
    agent = obj.agent;
  }

  // Validate tags if present
  let tags: string[] | undefined;
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags)) {
      throw new Error(`Invalid test in ${filename}: tags must be an array`);
    }
    tags = [];
    for (let i = 0; i < obj.tags.length; i++) {
      const tag = obj.tags[i];
      if (typeof tag !== "string") {
        throw new Error(`Invalid test in ${filename}: tags[${i}] must be a string`);
      }
      if (tag !== tag.toLowerCase()) {
        throw new Error(`Invalid test in ${filename}: tags[${i}] must be lowercase (got "${tag}")`);
      }
      if (tag.includes(" ")) {
        throw new Error(`Invalid test in ${filename}: tags[${i}] must not contain spaces (got "${tag}")`);
      }
      tags.push(tag);
    }
  }

  // Resolve fixture references in history
  resolveFixtures(history, filename);

  return {
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    comments: typeof obj.comments === "string" ? obj.comments : undefined,
    agent,
    tags,
    input: {
      history,
      message: typeof input.message === "string" ? input.message : undefined,
      mock_recall: typeof input.mock_recall === "string" ? input.mock_recall : undefined,
    },
    assertions,
  };
}

export interface LoadResult {
  tests: EvalTest[];
  errors: Array<{ file: string; message: string }>;
}

export function loadAllTests(): LoadResult {
  const testsDir = path.join(config.workspace, "tests");

  if (!existsSync(testsDir)) {
    return { tests: [], errors: [] };
  }

  const files = readdirSync(testsDir).filter((f) => f.endsWith(".yaml"));
  const tests: EvalTest[] = [];
  const errors: Array<{ file: string; message: string }> = [];

  for (const file of files) {
    try {
      const testPath = path.join(testsDir, file);
      const content = readFileSync(testPath, "utf-8");
      const parsed = parseYaml(content);
      const test = validateTest(parsed, file);
      tests.push(test);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file, message });
    }
  }

  return { tests, errors };
}

export function loadTest(name: string): EvalTest {
  const testsDir = path.join(config.workspace, "tests");
  const testPath = path.join(testsDir, `${name}.yaml`);

  if (!existsSync(testPath)) {
    throw new Error(`Test not found: ${name}`);
  }

  const content = readFileSync(testPath, "utf-8");
  const parsed = parseYaml(content);
  return validateTest(parsed, `${name}.yaml`);
}

/**
 * Filter tests by one or more tags (OR logic).
 * Returns tests that have at least one matching tag.
 */
export function filterByTags(tests: EvalTest[], tags: string[]): EvalTest[] {
  if (tags.length === 0) return tests;
  const tagSet = new Set(tags);
  return tests.filter((test) => {
    if (!test.tags) return false;
    return test.tags.some((tag) => tagSet.has(tag));
  });
}
