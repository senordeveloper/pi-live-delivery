/**
 * A small, dependency-free Markdown → HTML renderer for the delivery surface.
 *
 * Supports: ATX headings (`#`..`######`), fenced code blocks (``` ```），
 * unordered (`-`,`*`,`+`) and ordered (`1.`) lists, blockquotes, horizontal
 * rules, paragraphs, and inline: code spans, bold, italic, and links.
 *
 * Security: ALL text is HTML-escaped first, so raw HTML embedded in the source
 * markdown is rendered as visible text, never executed. Link hrefs are scrubbed
 * to http/https/mailto/relative to prevent `javascript:` injection. This makes
 * it safe to render untrusted file contents inline.
 *
 * This is intentionally not a full CommonMark implementation — it covers the
 * constructs a deliverable draft actually uses. No OpenClaw imports.
 */

/** Escape the five HTML-significant characters. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Allow only safe link targets; anything else becomes "#". */
function safeHref(raw: string): string {
  const trimmed = raw.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) {
    return trimmed;
  }
  // Relative links (no scheme, no protocol-relative "//").
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith('//')) {
    return trimmed;
  }
  return '#';
}

/**
 * Render inline markdown within already-HTML-escaped text. Order matters:
 * code spans first (their contents are literal), then links, then bold/italic.
 */
function renderInline(escaped: string): string {
  let out = escaped;

  // Inline code: `code` — contents are already escaped; wrap verbatim.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);

  // Links: [text](href) — href was escaped, so &quot; etc. are decoded enough
  // for scheme checks; scrub then re-escape the attribute.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    const cleaned = safeHref(href.replace(/&amp;/g, '&'));
    return `<a href="${escapeHtml(cleaned)}" rel="noopener noreferrer">${text}</a>`;
  });

  // Bold then italic (bold first so ** isn't eaten by * rule).
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');

  return out;
}

type ListState = { type: 'ul' | 'ol'; open: boolean };

/**
 * Render a markdown document to an HTML fragment (no surrounding page shell).
 */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  const list: ListState = { type: 'ul', open: false };
  let inCode = false;
  let codeLang = '';
  const codeBuf: string[] = [];
  let paraBuf: string[] = [];

  const closeList = (): void => {
    if (list.open) {
      html.push(list.type === 'ul' ? '</ul>' : '</ol>');
      list.open = false;
    }
  };
  const flushPara = (): void => {
    if (paraBuf.length) {
      html.push(`<p>${renderInline(escapeHtml(paraBuf.join(' ')))}</p>`);
      paraBuf = [];
    }
  };

  for (const line of lines) {
    // Fenced code blocks toggle on ``` (with optional language).
    const fence = /^```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        html.push(
          `<pre class="code"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ''}><code>${escapeHtml(
            codeBuf.join('\n'),
          )}</code></pre>`,
        );
        codeBuf.length = 0;
        inCode = false;
        codeLang = '';
      } else {
        flushPara();
        closeList();
        inCode = true;
        codeLang = fence[1] ?? '';
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      closeList();
      html.push('<hr />');
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      closeList();
      html.push(`<blockquote>${renderInline(escapeHtml(quote[1]))}</blockquote>`);
      continue;
    }

    const ulItem = /^\s*[-*+]\s+(.*)$/.exec(line);
    const olItem = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ulItem || olItem) {
      flushPara();
      const type = ulItem ? 'ul' : 'ol';
      if (list.open && list.type !== type) {
        closeList();
      }
      if (!list.open) {
        html.push(type === 'ul' ? '<ul>' : '<ol>');
        list.type = type;
        list.open = true;
      }
      const text = (ulItem ? ulItem[1] : olItem![1]) ?? '';
      html.push(`<li>${renderInline(escapeHtml(text))}</li>`);
      continue;
    }

    // Otherwise accumulate into the current paragraph.
    closeList();
    paraBuf.push(line.trim());
  }

  if (inCode) {
    html.push(`<pre class="code"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  flushPara();
  closeList();
  return html.join('\n');
}
