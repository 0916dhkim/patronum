/**
 * Prompt override utilities for eval testing.
 * These are tools for ablation testing — stripping sections from AGENTS.md on the fly.
 */

/**
 * Strip a named section from markdown.
 * 
 * Finds a line matching `## <sectionName>` (exact match, case-sensitive).
 * Removes from that line up to (but not including) the next `## ` heading.
 * If the section is the last one, removes to end of string.
 * 
 * Throws if the section name is not found.
 * Collapses triple+ blank lines to double blank lines.
 */
export function stripSection(markdown: string, sectionName: string): string {
  // Build a regex to find `## <sectionName>` at the start of a line,
  // with optional trailing whitespace before the newline.
  const sectionRegex = new RegExp(`^## ${escapeRegex(sectionName)}\\s*$`, "m");

  const match = markdown.match(sectionRegex);
  if (!match) {
    throw new Error(`Section not found: "## ${sectionName}"`);
  }

  // Find the start index
  const sectionStart = match.index!;

  // Find the next `## ` heading at the same level (two hashes + space)
  const afterSection = markdown.slice(sectionStart + match[0].length);
  const nextHeadingMatch = afterSection.match(/^## /m);

  let sectionEnd: number;
  if (nextHeadingMatch && nextHeadingMatch.index !== undefined) {
    // Found another ## heading — remove up to (but not including) it
    sectionEnd = sectionStart + match[0].length + nextHeadingMatch.index;
  } else {
    // No more ## headings after this section — remove to end of string
    sectionEnd = markdown.length;
  }

  // Remove the section
  const result = markdown.slice(0, sectionStart) + markdown.slice(sectionEnd);

  // Collapse triple+ blank lines to double blank lines
  return result.replace(/\n\n\n+/g, "\n\n");
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
