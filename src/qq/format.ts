export function renderMarkdownForQQ(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").trim().split("\n");
  const rendered: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  let inTable = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^`]*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) {
        fence = { marker: marker[0]!, length: marker.length };
        const language = fenceMatch[2]!.trim();
        rendered.push(language ? `[Code: ${language}]` : "[Code]");
      } else if (
        marker[0] === fence.marker &&
        marker.length >= fence.length
      ) {
        fence = undefined;
      } else {
        rendered.push(`  ${line}`);
      }
      continue;
    }
    if (fence) {
      rendered.push(line ? `  ${line}` : "");
      continue;
    }

    if (isTableRow(line) && isTableSeparator(lines[index + 1])) {
      rendered.push(renderTableRow(line));
      inTable = true;
      index++;
      continue;
    }
    if (inTable) {
      if (isTableRow(line)) {
        rendered.push(renderTableRow(line));
        continue;
      }
      inTable = false;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      rendered.push(`[${renderInlineMarkdown(heading[1]!)}]`);
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      rendered.push("--------------------------------");
      continue;
    }

    const quote = line.match(/^(\s*)>\s?(.*)$/);
    if (quote) {
      rendered.push(`${quote[1]}| ${renderInlineMarkdown(quote[2]!)}`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-+*]\s+(.*)$/);
    if (bullet) {
      rendered.push(`${bullet[1]}- ${renderInlineMarkdown(bullet[2]!)}`);
      continue;
    }

    rendered.push(renderInlineMarkdown(line).trimEnd());
  }

  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function findStreamingSplit(
  text: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (minimum > maximum || text.length < minimum) return undefined;
  const { blockBreaks, lineBreaks, inFenceAtMaximum } =
    markdownBreaks(text, maximum);
  const blockBreak = blockBreaks.find(
    (position) => position >= minimum && position <= maximum,
  );
  if (blockBreak !== undefined) return blockBreak;
  if (text.length < maximum || inFenceAtMaximum) return undefined;

  const lineBreak = lineBreaks
    .filter((position) => position >= minimum && position <= maximum)
    .at(-1);
  if (lineBreak !== undefined) return lineBreak;

  const space = text.lastIndexOf(" ", maximum);
  return space >= minimum ? space + 1 : maximum;
}

export function trimBlockStart(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "");
}

export function splitText(text: string, limit: number): string[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError("Text chunk limit must be a positive integer");
  }
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    let boundary: "newline" | "space" | "hard" = "newline";
    if (splitAt < limit / 2) {
      splitAt = remaining.lastIndexOf(" ", limit);
      boundary = "space";
    }
    if (splitAt < limit / 2) {
      splitAt = limit;
      boundary = "hard";
    }
    if (
      /[\uD800-\uDBFF]/.test(remaining[splitAt - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(remaining[splitAt] ?? "")
    ) {
      splitAt = splitAt === 1 ? 2 : splitAt - 1;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining =
      boundary === "newline"
        ? remaining.slice(splitAt + 1).replace(/^\n+/, "")
        : boundary === "space"
          ? remaining.slice(splitAt + 1).trimStart()
          : remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function renderInlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  let rendered = text.replace(/(`+)(.+?)\1/g, (_match, _ticks, code: string) => {
    const index = codeSpans.push(code) - 1;
    return `\u0000CODE${index}\u0000`;
  });

  rendered = rendered
    .replace(
      /!\[([^\]]*)\]\((\S+?)(?:\s+["'][^"']*["'])?\)/g,
      (_match, alt: string, url: string) =>
        alt ? `[Image: ${alt}] ${url}` : `[Image] ${url}`,
    )
    .replace(/\[([^\]]+)\]\((\S+?)(?:\s+["'][^"']*["'])?\)/g, "$1 ($2)")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1")
    .replace(/\*\*\*(\S(?:.*?\S)?)\*\*\*/g, "$1")
    .replace(/___(\S(?:.*?\S)?)___/g, "$1")
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1")
    .replace(/__(\S(?:.*?\S)?)__/g, "$1")
    .replace(/~~(\S(?:.*?\S)?)~~/g, "$1")
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    .replace(/_(\S(?:.*?\S)?)_/g, "$1");

  return rendered.replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) =>
    `[${codeSpans[Number(index)] ?? ""}]`);
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.split("|").filter((cell) => cell.trim()).length >= 2;
}

function isTableSeparator(line: string | undefined): boolean {
  return Boolean(
    line &&
    /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line),
  );
}

function renderTableRow(line: string): string {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => renderInlineMarkdown(cell.trim()))
    .join(" | ");
}

function markdownBreaks(
  text: string,
  maximum: number,
): {
  blockBreaks: number[];
  lineBreaks: number[];
  inFenceAtMaximum: boolean;
} {
  const blockBreaks: number[] = [];
  const lineBreaks: number[] = [];
  let fence: { marker: string; length: number } | undefined;
  let offset = 0;
  let inFenceAtMaximum = false;

  for (const part of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!part) continue;
    const lineStart = offset;
    const line = part.endsWith("\n") ? part.slice(0, -1) : part;
    const wasInFence = Boolean(fence);
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];

    if (marker) {
      if (!fence) {
        fence = { marker: marker[0]!, length: marker.length };
      } else if (marker[0] === fence.marker && marker.length >= fence.length) {
        fence = undefined;
      }
    }

    offset += part.length;
    if (lineStart < maximum && offset >= maximum) {
      inFenceAtMaximum = wasInFence || Boolean(fence);
    }
    if (!fence && part.endsWith("\n")) lineBreaks.push(offset);
    if (!wasInFence && !fence && !line.trim()) blockBreaks.push(offset);
    if (
      !wasInFence &&
      !fence &&
      lineStart > 0 &&
      /^\s{0,3}#{1,6}\s+/.test(line)
    ) {
      blockBreaks.push(lineStart);
    }
  }

  return { blockBreaks, lineBreaks, inFenceAtMaximum };
}
