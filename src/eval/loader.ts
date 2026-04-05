import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { config } from "../config.js";

export interface EvalTestInput {
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  message: string;
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
  agent?: string;
  tags?: string[];
  input: EvalTestInput;
  assertions: EvalTestAssertions;
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
  if (!input.message || typeof input.message !== "string") {
    throw new Error(`Invalid test in ${filename}: input.message is required (string)`);
  }

  // Validate history if present
  let history: Array<{ role: "user" | "assistant"; content: string }> | undefined;
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

      if (!h.content || typeof h.content !== "string") {
        throw new Error(`Invalid test in ${filename}: input.history[${i}].content must be a string`);
      }

      history.push({
        role: h.role as "user" | "assistant",
        content: h.content,
      });
    }
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

  return {
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    agent,
    tags,
    input: {
      history,
      message: input.message,
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
