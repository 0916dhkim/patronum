import path from "node:path";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { config } from "./config.js";
import { parseFrontmatter } from "./agents.js";

export interface SkillDef {
  name: string;
  description: string;
  body: string;
}

function buildSkills(): Record<string, SkillDef> {
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

    skills[name] = { name, description, body };
  }

  return skills;
}

function getSkills(): Record<string, SkillDef> {
  return buildSkills();
}

export function loadSkills(): Record<string, SkillDef> {
  return getSkills();
}

export function buildSkillsSummary(): string {
  const skills = getSkills();
  const entries = Object.values(skills);
  if (entries.length === 0) return "";

  const lines = entries.map((s) => `- **${s.name}**: ${s.description}`);
  return `[Available Skills]\n\n${lines.join("\n")}`;
}

export function getSkillBody(name: string): string | undefined {
  return getSkills()[name]?.body;
}

export function buildSkillBodies(): string {
  const skills = getSkills();
  const entries = Object.values(skills);
  if (entries.length === 0) return "";

  const sections = entries.map((s) => `## Skill: ${s.name}\n\n${s.body}`);
  return `[Skill Instructions]\n\n${sections.join("\n\n---\n\n")}`;
}
