/**
 * The simulated tool-calling wire protocol for browser-driven providers.
 *
 * A browser chat UI can only ever give us rendered text, so tool calling is
 * simulated by describing tools in the prompt, asking the model to emit a
 * recognizable block, and parsing that block back into a real `tool_calls`
 * response. This module is pure — no DOM, no Playwright, no HTTP — so every
 * part of the risky logic can be unit-tested without a browser.
 *
 * Model emits (angle brackets survive chat UIs, which render model-authored
 * HTML as literal text, and need no Markdown code fence):
 *
 *   <tool_call>
 *   {"name": "get_weather", "arguments": {"city": "Kathmandu"}}
 *   </tool_call>
 *
 * wspr renders a `role: "tool"` message back into the next browser turn as:
 *
 *   <tool_result tool_call_id="call_a1b2" name="get_weather">
 *   {"temp_c": 12}
 *   </tool_result>
 */

import type { SchemaStyle } from "../config.js";

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema object describing the tool's parameters. */
  parameters?: Record<string, unknown>;
}

export interface ToolCall {
  /** wspr-generated id (`call_<random>`). The client echoes it back as `tool_call_id`. */
  id: string;
  name: string;
  /** JSON string, OpenAI's shape — whether the model wrote an object or a string. */
  arguments: string;
}

/** Normalized tool selection directive used internally by providers. */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { name: string };

/** The subset of a `role: "tool"` message that {@link renderToolResult} needs. */
export interface ToolResultInput {
  content: string;
  tool_call_id?: string;
  name?: string;
}

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";
const FENCE = "```";

// Both keep their surrounding newline in capture group 1, so stripping a fence
// that only wrapped a tool call does not jam the prose on either side together.
/** A Markdown fence opening immediately before a `<tool_call>` block. */
const FENCE_OPEN_RE = /(\n)?[ \t]*```[a-z]*[ \t]*\n?$/i;
/** A Markdown fence closing immediately after a `</tool_call>` block. */
const FENCE_CLOSE_RE = /^[ \t]*\n?[ \t]*```[ \t]*(\n)?/;

/** Generate a fresh, collision-safe tool call id. No server-side state is needed. */
export function newCallId(): string {
  return `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Renders the instruction block that tells the model it has tools and how to
 * call them. Returns "" when `tool_choice` is "none" (or there are no tools),
 * so callers can skip the block entirely.
 */
export function renderToolPreamble(
  tools: ToolDefinition[],
  toolChoice?: ToolChoice,
  opts: { style?: SchemaStyle } = {},
): string {
  if (!tools.length) return "";
  if (toolChoice === "none") return "";
  const style = opts.style ?? "compact";

  const lines: string[] = [
    "You have access to the following tools. To call one, output a single block " +
      "in exactly this format, with nothing else if you are only calling tools:",
    "",
    "<tool_call>",
    '{"name": "<tool_name>", "arguments": { ... }}',
    "</tool_call>",
    "",
    "Do not wrap the block in a Markdown code fence. You may call many tools, " +
      "each in its own <tool_call> block. If you have a normal answer, reply with " +
      "plain text instead of a block.",
    "",
  ];

  if (toolChoice === "required") {
    lines.push("You must call a tool this turn.");
    lines.push("");
  } else if (typeof toolChoice === "object" && toolChoice?.name) {
    lines.push(`You must call the "${toolChoice.name}" tool this turn.`);
    lines.push("");
  }

  for (const tool of tools) {
    lines.push(`### Tool: ${tool.name}`);
    if (tool.description) lines.push(tool.description);
    if (tool.parameters) {
      lines.push(...renderSchema(tool.parameters, style));
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Render a `role: "tool"` message back into the `<tool_result>` block. */
export function renderToolResult(msg: ToolResultInput): string {
  const idAttr = msg.tool_call_id ? ` tool_call_id="${escapeAttr(msg.tool_call_id)}"` : "";
  const nameAttr = msg.name ? ` name="${escapeAttr(msg.name)}"` : "";
  return `<tool_result${idAttr}${nameAttr}>\n${msg.content}\n</tool_result>`;
}

/**
 * Re-render an assistant turn's `tool_calls` back into `<tool_call>` blocks, so
 * a `newChat: true` replay of a tool loop is faithful. `arguments` (a JSON
 * string) is re-parsed so the block is real JSON, as the model would have
 * emitted it.
 */
export function renderToolCalls(calls: ToolCall[]): string {
  return calls
    .map((c) => {
      let args: unknown = c.arguments;
      try {
        args = JSON.parse(c.arguments);
      } catch {
        // leave the raw string — it is already JSON-shaped.
      }
      const block = JSON.stringify({ name: c.name, arguments: args });
      return `${OPEN}\n${block}\n${CLOSE}`;
    })
    .join("\n\n");
}

/**
 * Lenient parser for one `<tool_call>` payload. Returns null when the payload
 * is not a valid tool call (malformed JSON, missing name, or a name that is not
 * in `toolNames`) — a null degrades to prose, never throws.
 *
 * Leniency: unwraps a ```json fence, normalizes smart quotes, strips zero-width
 * characters, and tolerates trailing commas.
 */
export function parseToolCallJson(raw: string, toolNames?: ReadonlySet<string>): ToolCall | null {
  // Strip zero-width characters and unwrap a ```json fence (both safe, and the
  // fence can only appear here). Smart-quote normalization is applied as a
  // *fallback only* — the parser first tries the raw string, because a value
  // that legitimately contains curly quotes must survive unmodified.
  let text = raw.trim().replace(/[\u200b-\u200d\u2060\ufeff]/g, "");
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();

  let obj: unknown;
  const normable = [
    (s: string) => s,
    (s: string) => smartQuotes(s),
    (s: string) => removeTrailingCommas(s),
    (s: string) => smartQuotes(removeTrailingCommas(s)),
    // Last resort: carve the balanced object out of the chat UI's own chrome
    // ("Copy", "Copied!", a language tag) which innerText scrapes along with
    // the block. Deliberately *not* a general "find the JSON somewhere in
    // here" — text the model itself wrote around a call still degrades to
    // prose, because acting on half of an unexpected answer is worse than
    // showing all of it.
    (s: string) => stripChrome(s) ?? s,
    (s: string) => smartQuotes(removeTrailingCommas(stripChrome(s) ?? s)),
  ];
  for (const norm of normable) {
    try {
      obj = JSON.parse(norm(text));
      if (obj && typeof obj === "object" && !Array.isArray(obj)) break;
    } catch {
      // try the next lenient variant
    }
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name) return null;
  if (toolNames && !toolNames.has(record.name)) return null;

  const rawArgs = record.arguments;
  let argsStr: string;
  if (typeof rawArgs === "string") {
    argsStr = rawArgs;
  } else if (rawArgs != null) {
    try {
      argsStr = JSON.stringify(rawArgs);
    } catch {
      argsStr = "{}";
    }
  } else {
    argsStr = "{}";
  }

  return { id: newCallId(), name: record.name, arguments: argsStr };
}

/**
 * A hold-back buffer for streamed text. It emits everything up to an opening
 * `<tool_call>`, holds the JSON until the closing tag arrives, and then yields
 * a parsed {@link ToolCall}. It also holds back any trailing suffix that is a
 * prefix of the opening marker, so a partially-typed marker never leaks onto
 * the wire.
 *
 * When no tools are configured, don't use a scanner — a model legitimately
 * writing `<tool_call>` in prose would otherwise get mangled.
 */
export class ToolCallScanner {
  private buffer = "";
  private tools: ReadonlySet<string> | undefined;
  private open = false;
  private disabled: boolean;
  /** A call just closed — a wrapping fence may still be arriving. */
  private justClosed = false;

  constructor(tools?: ReadonlySet<string>) {
    this.tools = tools;
    // With no tools there is nothing to look for — treat `<tool_call>` as
    // ordinary prose and pass every delta straight through.
    this.disabled = !tools || tools.size === 0;
  }

  push(delta: string): { text: string; calls: ToolCall[] } {
    if (this.disabled) return { text: delta, calls: [] };

    this.buffer += delta;

    let text = "";
    const calls: ToolCall[] = [];

    for (;;) {
      if (!this.open) {
        // A call just closed: drop a fence that only wrapped it. While the
        // buffer could still grow into one, hold rather than emit.
        if (this.justClosed) {
          const stripped = this.buffer.replace(FENCE_CLOSE_RE, (_m, nl) => nl ?? "");
          if (stripped !== this.buffer) {
            this.buffer = stripped;
            this.justClosed = false;
          } else if (couldBecomeFenceClose(this.buffer)) {
            break;
          } else {
            this.justClosed = false;
          }
        }

        const openIdx = this.buffer.indexOf(OPEN);
        if (openIdx === -1) {
          // No opening marker yet. Hold back a trailing suffix that could
          // become `<tool_call>` — or a ``` fence wrapping one — once a few
          // more chars arrive; emit the rest.
          const hold = holdLength(this.buffer);
          const emitLen = this.buffer.length - hold;
          if (emitLen > 0) {
            text += this.buffer.slice(0, emitLen);
            this.buffer = this.buffer.slice(emitLen);
          }
          break;
        }
        // Models often wrap the block in a code fence despite the preamble
        // telling them not to. Drop a fence that only exists to wrap the call,
        // so it does not surface as junk `content` / a stray text block.
        text += this.buffer.slice(0, openIdx).replace(FENCE_OPEN_RE, (_m, nl) => nl ?? "");
        this.buffer = this.buffer.slice(openIdx + OPEN.length);
        this.open = true;
        continue;
      }

      const closeIdx = this.buffer.indexOf(CLOSE);
      if (closeIdx === -1) {
        // Still inside a block; emit nothing until it closes.
        break;
      }
      const json = this.buffer.slice(0, closeIdx);
      this.buffer = this.buffer.slice(closeIdx + CLOSE.length);
      this.open = false;

      const call = parseToolCallJson(json, this.tools);
      if (call) {
        calls.push(call);
        // The matching closing fence may not have streamed in yet, so the
        // strip is deferred to the top of the loop rather than done here.
        this.justClosed = true;
      } else {
        // Malformed or unknown: degrade to prose rather than dropping data.
        text += `${OPEN}\n${json}\n${CLOSE}`;
      }
    }

    return { text, calls };
  }

  /**
   * Release any never-closed block (or held-back text) as plain text, so a
   * truncated stream degrades to prose instead of vanishing.
   */
  flush(): { text: string; calls: ToolCall[] } {
    if (this.disabled) return { text: "", calls: [] };

    if (this.justClosed) {
      this.buffer = this.buffer.replace(FENCE_CLOSE_RE, (_m, nl) => nl ?? "");
      this.justClosed = false;
    }
    let text = this.buffer;
    this.buffer = "";
    if (this.open) {
      text = `${OPEN}\n${text}`;
      this.open = false;
    }
    // A never-closed block could also be a partial marker; release it as-is.
    return { text, calls: [] };
  }
}

/**
 * How much of the buffer's tail to withhold because it might still become a
 * `<tool_call>` block — including a Markdown fence wrapping one. Covers a
 * partial marker, a fence-open sitting immediately before a partial marker
 * (```` ```json ```` then `<tool_c`), and a bare partial fence. Anything held is
 * released by the next `push()` or by `flush()`, so a genuine code block in
 * prose is never swallowed.
 */
function holdLength(s: string): number {
  const marker = prefixSuffixLength(s, OPEN);
  const head = marker ? s.slice(0, s.length - marker) : s;
  const fence = head.match(FENCE_OPEN_RE);
  if (fence) return marker + fence[0].length;
  return marker || prefixSuffixLength(s, FENCE);
}

/**
 * Could this buffer still grow into the closing fence of a wrapped tool call?
 * True for the partial forms that arrive when a fence streams in one character
 * at a time ("\n", "\n`", "\n``"), so they are held rather than emitted.
 */
function couldBecomeFenceClose(s: string): boolean {
  return /^[ \t]*\n?[ \t]*`{0,3}[ \t]*$/.test(s);
}

/** Longest length of a suffix of `s` that is a prefix of `marker`. */
function prefixSuffixLength(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

/** Remove trailing commas before `}` or `]` (the lenient-JSON tolerance). */
function removeTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}

/** Normalize smart/curly quotes to straight ASCII quotes. */
function smartQuotes(s: string): string {
  return s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a tool's parameter schema for the prompt preamble.
 *
 * The prompt is typed into a web chat box, and a coding agent declares a dozen
 * tools whose schemas pretty-print to tens of kilobytes — past what many chat
 * UIs accept in one message. `compact` states each top-level parameter as one
 * line, which is what a model actually needs to fill the arguments in, and
 * falls back to single-line JSON for a schema too nested to summarise. The
 * other two styles exist to debug a model that is mis-filling arguments.
 */
export function renderSchema(params: Record<string, unknown>, style: SchemaStyle): string[] {
  if (style === "pretty") {
    return ["Parameters (JSON Schema):", JSON.stringify(params, null, 2)];
  }
  if (style === "json") {
    return ["Parameters (JSON Schema):", JSON.stringify(params)];
  }

  const lines = compactSchema(params);
  return lines.length ? ["Parameters:", ...lines] : [];
}

/**
 * One line per top-level property: `name (type, required): description`.
 * Returns [] when the schema has no usable `properties` object, so the caller
 * can fall back rather than emit a misleading empty parameter list.
 */
export function compactSchema(params: Record<string, unknown>): string[] {
  const props = params?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    // Not an object schema we can summarise (oneOf, $ref, a bare type…).
    // One line of JSON still beats dropping the schema on the floor.
    return [JSON.stringify(params)];
  }
  const required = new Set(Array.isArray(params.required) ? (params.required as string[]) : []);

  const lines: string[] = [];
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const spec = (raw ?? {}) as Record<string, unknown>;
    const bits: string[] = [];
    const type = spec.type ?? (Array.isArray(spec.enum) ? "enum" : undefined);
    if (typeof type === "string") bits.push(type);
    else if (Array.isArray(type)) bits.push(type.join("|"));
    if (required.has(name)) bits.push("required");
    if (Array.isArray(spec.enum)) bits.push(`one of ${JSON.stringify(spec.enum)}`);

    const head = bits.length ? `- ${name} (${bits.join(", ")})` : `- ${name}`;
    const desc = typeof spec.description === "string" ? spec.description.replace(/\s+/g, " ").trim() : "";
    lines.push(desc ? `${head}: ${desc}` : head);
  }
  return lines;
}

/** Thrown when a prompt cannot be shrunk under a provider's `maxPromptChars`. */
export class PromptTooLargeError extends Error {
  constructor(
    public provider: string,
    public chars: number,
    public limit: number,
  ) {
    super(
      `Prompt for "${provider}" is ${chars} characters, over the ${limit}-character limit. ` +
        `A chat website silently truncates a long message (or turns it into a file ` +
        `attachment), so wspr refuses rather than send a half prompt. Raise ` +
        `maxPromptChars for this provider in providers.yaml, set toolResultMaxChars ` +
        `to trim tool output, or use an API-key provider for this workload.`,
    );
    this.name = "PromptTooLargeError";
  }
}

/**
 * Middle-out truncate any `tool` message whose content exceeds `cap`, keeping
 * the head and tail (where a file's structure and a command's exit status
 * live) and marking the cut so the model knows the result is partial rather
 * than believing the file simply ends there.
 *
 * Returns the original array when nothing needed trimming, so the common path
 * allocates nothing.
 */
export function truncateToolResults<T extends { role: string; content: string }>(
  messages: T[],
  cap: number,
): T[] {
  if (!(cap > 0)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= cap) return m;
    changed = true;
    return { ...m, content: middleOut(m.content, cap) };
  });
  return changed ? out : messages;
}

/** Keep the first ~60% and last ~40% of the budget, with a marker between. */
export function middleOut(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const marker = (n: number) => `\n…[${n} characters omitted by wspr]…\n`;
  const omitted = text.length - cap;
  const budget = Math.max(0, cap - marker(omitted).length);
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head)}${marker(text.length - head - tail)}${tail ? text.slice(-tail) : ""}`;
}

/**
 * Pull the outermost brace-balanced JSON object out of a string, ignoring
 * braces inside string literals. A chat UI contributes its own chrome to the
 * scraped text — a "Copy"/"Copied!" button label, a language tag, a stray
 * prose sentence — which lands inside the `<tool_call>` block and defeats a
 * plain JSON.parse. Returns null when there is no balanced object.
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Chat-UI decoration that `innerText()` picks up from around a rendered code
 * block. Everything here is chrome a *site* drew, never text a model wrote.
 */
const CHROME = new Set([
  "copy",
  "copy code",
  "copied",
  "copied!",
  "copy to clipboard",
  "json",
  "javascript",
  "js",
  "python",
  "text",
  "plaintext",
  "\u590d\u5236",
  "\u5df2\u590d\u5236",
]);

/**
 * Return the balanced JSON object inside `raw` — but only when everything
 * around it is whitespace, code-fence backticks, or a {@link CHROME} token.
 *
 * The restriction is the point. `{"name":"f","arguments":{}} broken` must stay
 * prose: trailing words are the model saying something we did not anticipate,
 * and silently executing the prefix would hide that. `Copy\n{…}\nCopied!` is
 * the same call with a button's label glued to it, and is safe to recover.
 */
export function stripChrome(raw: string): string | null {
  const obj = extractJsonObject(raw);
  if (obj === null) return null;

  const at = raw.indexOf(obj);
  const outside = [raw.slice(0, at), raw.slice(at + obj.length)];
  for (const side of outside) {
    for (const line of side.split(/\n+/)) {
      const token = line.replace(/`+/g, "").trim().toLowerCase();
      if (token && !CHROME.has(token)) return null;
    }
  }
  return obj;
}
