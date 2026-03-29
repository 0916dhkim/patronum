import { Renderer, marked, type Tokens } from "marked";

/**
 * Convert CommonMark markdown to Telegram-compatible HTML.
 *
 * Telegram supports a limited subset of HTML:
 *   <b>, <i>, <s>, <u>, <code>, <pre>, <a href="">, <blockquote>, <tg-spoiler>
 *
 * We use `marked` with a custom renderer to produce valid Telegram HTML.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class TelegramRenderer extends Renderer {
  // Block-level

  heading(token: Tokens.Heading): string {
    return `<b>${this.parser.parseInline(token.tokens)}</b>\n\n`;
  }

  paragraph(token: Tokens.Paragraph): string {
    return `${this.parser.parseInline(token.tokens)}\n\n`;
  }

  blockquote(token: Tokens.Blockquote): string {
    const body = this.parser.parse(token.tokens);
    return `<blockquote>${body.trim()}</blockquote>\n\n`;
  }

  code(token: Tokens.Code): string {
    const escaped = escapeHtml(token.text);
    return `<pre><code>${escaped}</code></pre>\n\n`;
  }

  list(token: Tokens.List): string {
    let body = "";
    for (let i = 0; i < token.items.length; i++) {
      const item = token.items[i];
      const prefix = token.ordered ? `${(token.start || 1) + i}. ` : "• ";
      const content = this.parser.parse(item.tokens).trim();
      body += `${prefix}${content}\n`;
    }
    return `${body}\n`;
  }

  listitem(item: Tokens.ListItem): string {
    return `• ${this.parser.parse(item.tokens).trim()}\n`;
  }

  hr(): string {
    return "\n";
  }

  // Inline-level

  strong(token: Tokens.Strong): string {
    return `<b>${this.parser.parseInline(token.tokens)}</b>`;
  }

  em(token: Tokens.Em): string {
    return `<i>${this.parser.parseInline(token.tokens)}</i>`;
  }

  codespan(token: Tokens.Codespan): string {
    return `<code>${escapeHtml(token.text)}</code>`;
  }

  del(token: Tokens.Del): string {
    return `<s>${this.parser.parseInline(token.tokens)}</s>`;
  }

  link(token: Tokens.Link): string {
    const text = this.parser.parseInline(token.tokens);
    return `<a href="${escapeHtml(token.href)}">${text}</a>`;
  }

  image(token: Tokens.Image): string {
    return `<a href="${escapeHtml(token.href)}">${escapeHtml(token.text || "image")}</a>`;
  }

  text(token: Tokens.Text | Tokens.Escape | Tokens.Tag): string {
    if ("tokens" in token && token.tokens) {
      return this.parser.parseInline(token.tokens);
    }
    return token.text;
  }

  html(token: Tokens.HTML): string {
    return escapeHtml(token.text);
  }

  br(): string {
    return "\n";
  }

  space(): string {
    return "";
  }

  checkbox(token: Tokens.Checkbox): string {
    return token.checked ? "☑ " : "☐ ";
  }

  table(token: Tokens.Table): string {
    // Telegram doesn't support tables — render as preformatted
    let out = "";
    // Header
    const headerCells = token.header.map((c) => this.parser.parseInline(c.tokens));
    out += headerCells.join(" | ") + "\n";
    out += headerCells.map(() => "---").join(" | ") + "\n";
    // Rows
    for (const row of token.rows) {
      const cells = row.map((c) => this.parser.parseInline(c.tokens));
      out += cells.join(" | ") + "\n";
    }
    return `<pre>${escapeHtml(out)}</pre>\n\n`;
  }

  tablerow(token: Tokens.TableRow): string {
    return `${token.text}\n`;
  }

  tablecell(token: Tokens.TableCell): string {
    return this.parser.parseInline(token.tokens);
  }
}

// Configure marked with our renderer
const renderer = new TelegramRenderer();

export function markdownToTelegramHtml(text: string): string {
  const result = marked.parse(text, {
    renderer,
    async: false,
    breaks: false,
    gfm: true,
  }) as string;

  // Clean up excessive newlines (more than 2 consecutive)
  return result.replace(/\n{3,}/g, "\n\n").trim();
}
