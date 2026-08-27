export function renderMarkdownForQQ(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").trim().split("\n");
  const rendered: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  let displayMath: { close: "\\]" | "$$"; lines: string[] } | undefined;
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

    if (displayMath) {
      if (line.trim() === displayMath.close) {
        rendered.push("[Formula]", renderLatexForQQ(displayMath.lines.join("\n")));
        displayMath = undefined;
      } else {
        displayMath.lines.push(line);
      }
      continue;
    }

    const completeFormula = readCompleteDisplayFormula(line);
    if (completeFormula !== undefined) {
      rendered.push("[Formula]", renderLatexForQQ(completeFormula));
      continue;
    }
    const formulaClose = displayFormulaClose(line);
    if (formulaClose) {
      displayMath = { close: formulaClose, lines: [] };
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

  if (displayMath) {
    rendered.push("[Formula]", renderLatexForQQ(displayMath.lines.join("\n")));
  }

  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function findStreamingSplit(
  text: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (minimum > maximum || text.length < minimum) return undefined;
  const { blockBreaks, lineBreaks, inProtectedBlockAtMaximum } =
    markdownBreaks(text, maximum);
  const blockBreak = blockBreaks.find(
    (position) => position >= minimum && position <= maximum,
  );
  if (blockBreak !== undefined) return blockBreak;
  if (text.length < maximum || inProtectedBlockAtMaximum) return undefined;

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

export function renderLatexForQQ(latex: string): string {
  return normalizeMathText(parseLatex(latex, 0).value);
}

function renderInlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  const mathSpans: string[] = [];
  let rendered = text.replace(/(`+)(.+?)\1/g, (_match, _ticks, code: string) => {
    const index = codeSpans.push(code) - 1;
    return `\u0000CODE${index}\u0000`;
  });

  rendered = rendered
    .replace(/\\\((.+?)\\\)/g, (_match, formula: string) => {
      const index = mathSpans.push(renderLatexForQQ(formula)) - 1;
      return `\u0000MATH${index}\u0000`;
    })
    .replace(
      /(?<![\\$])\$(?![$\s])(\S(?:[^$\n]*?\S)?)(?<!\\)\$(?![$\d])/g,
      (_match, formula: string) => {
        const index = mathSpans.push(renderLatexForQQ(formula)) - 1;
        return `\u0000MATH${index}\u0000`;
      },
    )
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
    .replace(/_(\S(?:.*?\S)?)_/g, "$1")
    .replace(/\u0000MATH(\d+)\u0000/g, (_match, index: string) =>
      mathSpans[Number(index)] ?? "")
    .replace(/\\\$/g, "$");

  return rendered.replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) =>
    `[${codeSpans[Number(index)] ?? ""}]`);
}

interface LatexParseResult {
  value: string;
  index: number;
}

function parseLatex(
  source: string,
  start: number,
  terminator?: string,
): LatexParseResult {
  let value = "";
  let index = start;

  while (index < source.length) {
    const character = source[index]!;
    if (terminator && character === terminator) {
      return { value, index: index + 1 };
    }
    if (character === "\\") {
      const command = parseLatexCommand(source, index);
      value += command.value;
      index = command.index;
      continue;
    }
    if (character === "{") {
      const group = parseLatex(source, index + 1, "}");
      value += group.value;
      index = group.index;
      continue;
    }
    if (character === "^" || character === "_") {
      const argument = parseLatexArgument(source, index + 1);
      value += renderMathScript(argument.value, character);
      index = argument.index;
      continue;
    }
    if (character === "~") {
      value += " ";
    } else if (character === "&") {
      value += " ";
    } else {
      value += character;
    }
    index++;
  }

  return { value, index };
}

function parseLatexCommand(source: string, slashIndex: number): LatexParseResult {
  const first = source[slashIndex + 1];
  if (!first) return { value: "", index: slashIndex + 1 };
  if (!/[A-Za-z]/.test(first)) {
    return {
      value: LATEX_ESCAPES[first] ?? first,
      index: slashIndex + 2,
    };
  }

  let index = slashIndex + 2;
  while (index < source.length && /[A-Za-z]/.test(source[index]!)) index++;
  const command = source.slice(slashIndex + 1, index);

  if (TEXT_COMMANDS.has(command)) {
    return parseLatexArgument(source, index);
  }
  if (command === "frac" || command === "dfrac" || command === "tfrac") {
    const numerator = parseLatexArgument(source, index);
    const denominator = parseLatexArgument(source, numerator.index);
    return {
      value: `${wrapMathPart(numerator.value)} / ${wrapMathPart(denominator.value)}`,
      index: denominator.index,
    };
  }
  if (command === "sqrt") {
    const rootIndex = parseOptionalRootIndex(source, index);
    const radicand = parseLatexArgument(source, rootIndex.index);
    const radical =
      rootIndex.value === "3"
        ? "∛"
        : rootIndex.value === "4"
          ? "∜"
          : rootIndex.value
            ? `root[${rootIndex.value}]`
            : "√";
    return {
      value: `${radical}${wrapRadicand(radicand.value)}`,
      index: radicand.index,
    };
  }
  if (ACCENT_COMMANDS[command]) {
    const argument = parseLatexArgument(source, index);
    return {
      value: `${argument.value}${ACCENT_COMMANDS[command]}`,
      index: argument.index,
    };
  }
  if (command === "begin" || command === "end") {
    const environment = parseLatexArgument(source, index);
    return { value: "", index: environment.index };
  }
  if (DELIMITER_COMMANDS.has(command)) {
    return { value: "", index };
  }

  return {
    value: LATEX_SYMBOLS[command] ?? command,
    index,
  };
}

function parseLatexArgument(source: string, start: number): LatexParseResult {
  let index = start;
  while (index < source.length && /\s/.test(source[index]!)) index++;
  if (source[index] === "{") return parseLatex(source, index + 1, "}");
  if (source[index] === "\\") return parseLatexCommand(source, index);
  const character = source.codePointAt(index);
  if (character === undefined) return { value: "", index };
  const value = String.fromCodePoint(character);
  return { value, index: index + value.length };
}

function parseOptionalRootIndex(
  source: string,
  start: number,
): LatexParseResult {
  let index = start;
  while (index < source.length && /\s/.test(source[index]!)) index++;
  if (source[index] !== "[") return { value: "", index };
  const end = source.indexOf("]", index + 1);
  if (end === -1) return { value: "", index };
  return {
    value: renderLatexForQQ(source.slice(index + 1, end)),
    index: end + 1,
  };
}

function renderMathScript(value: string, marker: "^" | "_"): string {
  const map = marker === "^" ? SUPERSCRIPT : SUBSCRIPT;
  const converted = [...value].map((character) => map[character]);
  if (converted.every((character) => character !== undefined)) {
    return converted.join("");
  }
  return marker === "^" ? `^(${value})` : `_(${value})`;
}

function wrapMathPart(value: string): string {
  const trimmed = value.trim();
  return isSimpleMathPart(trimmed) ? trimmed : `(${trimmed})`;
}

function wrapRadicand(value: string): string {
  const trimmed = value.trim();
  return isSimpleMathPart(trimmed) ? trimmed : `(${trimmed})`;
}

function isSimpleMathPart(value: string): boolean {
  return /^[\p{L}\p{N}⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+$/u.test(value);
}

function normalizeMathText(value: string): string {
  return value
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s*([=≠≈≃≡≤≥∈∉⊂⊆⊃⊇→←↔⇒⇔])\s*/g, " $1 ")
    .replace(/,\s*/g, ", ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function readCompleteDisplayFormula(line: string): string | undefined {
  const trimmed = line.trim();
  const bracketed = trimmed.match(/^\\\[(.*)\\\]$/);
  if (bracketed) return bracketed[1]!;
  const dollarDelimited = trimmed.match(/^\$\$(.*)\$\$$/);
  return dollarDelimited?.[1];
}

function displayFormulaClose(line: string): "\\]" | "$$" | undefined {
  const trimmed = line.trim();
  if (trimmed === "\\[") return "\\]";
  if (trimmed === "$$") return "$$";
  return undefined;
}

const TEXT_COMMANDS = new Set([
  "text",
  "textrm",
  "textsf",
  "texttt",
  "mathrm",
  "mathbf",
  "mathit",
  "mathsf",
  "mathtt",
  "operatorname",
  "overline",
  "underline",
]);

const DELIMITER_COMMANDS = new Set([
  "left",
  "right",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "biggl",
  "biggr",
  "Biggl",
  "Biggr",
]);

const LATEX_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\n",
  ",": " ",
  ":": " ",
  ";": " ",
  "!": "",
  " ": " ",
  "{": "{",
  "}": "}",
  "_": "_",
  "%": "%",
  "$": "$",
  "#": "#",
  "&": "&",
  "|": "‖",
};

const ACCENT_COMMANDS: Readonly<Record<string, string>> = {
  bar: "\u0304",
  dot: "\u0307",
  hat: "\u0302",
  tilde: "\u0303",
  vec: "\u20d7",
};

const LATEX_SYMBOLS: Readonly<Record<string, string>> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ϵ",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "ϕ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  times: "×",
  cdot: "·",
  div: "÷",
  pm: "±",
  mp: "∓",
  ast: "∗",
  star: "⋆",
  circ: "∘",
  bullet: "∙",
  eq: "=",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  simeq: "≃",
  equiv: "≡",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ll: "≪",
  gg: "≫",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  varnothing: "∅",
  infinity: "∞",
  infty: "∞",
  sum: "Σ",
  prod: "Π",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  neg: "¬",
  land: "∧",
  wedge: "∧",
  lor: "∨",
  vee: "∨",
  therefore: "∴",
  because: "∵",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  mapsto: "↦",
  ldots: "…",
  dots: "…",
  cdots: "⋯",
  vdots: "⋮",
  ddots: "⋱",
  angle: "∠",
  degree: "°",
  prime: "′",
  quad: "  ",
  qquad: "    ",
  colon: ":",
  sin: "sin",
  cos: "cos",
  tan: "tan",
  cot: "cot",
  sec: "sec",
  csc: "csc",
  log: "log",
  ln: "ln",
  exp: "exp",
  lim: "lim",
  min: "min",
  max: "max",
};

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  a: "ᵃ",
  b: "ᵇ",
  c: "ᶜ",
  d: "ᵈ",
  e: "ᵉ",
  f: "ᶠ",
  g: "ᵍ",
  h: "ʰ",
  i: "ⁱ",
  j: "ʲ",
  k: "ᵏ",
  l: "ˡ",
  m: "ᵐ",
  n: "ⁿ",
  o: "ᵒ",
  p: "ᵖ",
  r: "ʳ",
  s: "ˢ",
  t: "ᵗ",
  u: "ᵘ",
  v: "ᵛ",
  w: "ʷ",
  x: "ˣ",
  y: "ʸ",
  z: "ᶻ",
};

const SUBSCRIPT: Readonly<Record<string, string>> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  x: "ₓ",
};

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
  inProtectedBlockAtMaximum: boolean;
} {
  const blockBreaks: number[] = [];
  const lineBreaks: number[] = [];
  let fence: { marker: string; length: number } | undefined;
  let displayMath: "\\]" | "$$" | undefined;
  let offset = 0;
  let inProtectedBlockAtMaximum = false;

  for (const part of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!part) continue;
    const lineStart = offset;
    const line = part.endsWith("\n") ? part.slice(0, -1) : part;
    const wasProtected = Boolean(fence || displayMath);
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];

    if (!displayMath && marker) {
      if (!fence) {
        fence = { marker: marker[0]!, length: marker.length };
      } else if (marker[0] === fence.marker && marker.length >= fence.length) {
        fence = undefined;
      }
    }
    if (!fence) {
      if (displayMath && line.trim() === displayMath) {
        displayMath = undefined;
      } else if (!displayMath) {
        displayMath = displayFormulaClose(line);
      }
    }

    offset += part.length;
    if (lineStart < maximum && offset >= maximum) {
      inProtectedBlockAtMaximum =
        wasProtected || Boolean(fence || displayMath);
    }
    if (!fence && !displayMath && part.endsWith("\n")) lineBreaks.push(offset);
    if (
      !wasProtected &&
      !fence &&
      !displayMath &&
      !line.trim()
    ) {
      blockBreaks.push(offset);
    }
    if (
      !wasProtected &&
      !fence &&
      !displayMath &&
      lineStart > 0 &&
      /^\s{0,3}#{1,6}\s+/.test(line)
    ) {
      blockBreaks.push(lineStart);
    }
  }

  return { blockBreaks, lineBreaks, inProtectedBlockAtMaximum };
}
