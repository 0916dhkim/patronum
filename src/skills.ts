import path from "node:path";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { config } from "./config.js";
import { parseFrontmatter } from "./agents.js";

export interface SkillDef {
  name: string;
  description: string;
  body: string;
}

export type SkillOverrides = Record<string, string>; // skill name -> override body content

function buildSkills(overrides?: SkillOverrides): Record<string, SkillDef> {
  const skillsDir = path.join(config.workspace, "skills");
  const skills: Record<string, SkillDef> = {};

  if (!existsSync(skillsDir)) return skills;

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const raw = readFileSync(skillPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    const name = frontmatter.name || entry.name;
    const description = frontmatter.description;

    if (!description) {
      console.warn(`[skills] ${name}/SKILL.md is missing required 'description' frontmatter — skipping`);
      continue;
    }

    // Use override body if provided, otherwise use the disk body
    const skillBody = overrides?.[name] !== undefined ? overrides[name] : body;
    skills[name] = { name, description, body: skillBody };
  }

  // Validate that all override keys correspond to skills that were actually loaded
  if (overrides) {
    for (const overrideName of Object.keys(overrides)) {
      if (!skills[overrideName]) {
        throw new Error(`Skill override specified for non-existent skill: ${overrideName}`);
      }
    }
  }

  return skills;
}

function getSkills(overrides?: SkillOverrides): Record<string, SkillDef> {
  return buildSkills(overrides);
}

export function loadSkills(overrides?: SkillOverrides): Record<string, SkillDef> {
  return getSkills(overrides);
}

export function buildSkillsSummary(overrides?: SkillOverrides): string {
  const skills = getSkills(overrides);
  const entries = Object.values(skills);
  if (entries.length === 0) return "";

  const lines = entries.map((s) => `- **${s.name}**: ${s.description}`);
  return `[Available Skills]\n\n${lines.join("\n")}`;
}

export function getSkillBody(name: string, overrides?: SkillOverrides): string | undefined {
  return getSkills(overrides)[name]?.body;
}

export function buildSkillBodies(overrides?: SkillOverrides): string {
  const skills = getSkills(overrides);
  const entries = Object.values(skills);
  if (entries.length === 0) return "";

  const sections = entries.map((s) => `## Skill: ${s.name}\n\n${s.body}`);
  return `[Skill Instructions]\n\n${sections.join("\n\n---\n\n")}`;
}
