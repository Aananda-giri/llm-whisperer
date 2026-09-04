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
export function renderToolPreamble(tools: ToolDefinition[], toolChoice?: ToolChoice): string {
  if (!tools.length) return "";
  if (toolChoice === "none") return "";

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
      lines.push("Parameters (JSON Schema):");
      lines.push(JSON.stringify(tool.parameters, null, 2));
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
