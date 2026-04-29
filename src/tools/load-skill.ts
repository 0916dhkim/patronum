import type { ToolHandler } from "../types.js";
import { getSkillBody, type SkillOverrides } from "../skills.js";

// Module-level state for skill overrides (set during agent initialization)
let currentSkillOverrides: SkillOverrides | undefined = undefined;

export function setSkillOverrides(overrides?: SkillOverrides): void {
  currentSkillOverrides = overrides;
}

export const loadSkillTool: ToolHandler = {
  definition: {
    name: "load_skill",
    description:
      "Load the full body content of a skill by name. Returns the complete skill instructions. Use this when you need the detailed skill content referenced in the system prompt.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the skill to load (e.g., 'patronum-behavior-test', 'design-critique')",
        },
      },
      required: ["name"],
    },
  },

  async execute(input): Promise<string> {
    const name = input.name as string;

    if (!name || typeof name !== "string") {
      return "Error: skill name is required and must be a string";
    }

    const body = getSkillBody(name, currentSkillOverrides);

    if (body === undefined) {
      return `Error: skill not found: ${name}`;
    }

    return body;
  },
};
