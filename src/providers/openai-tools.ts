import type { Message, Usage } from "./base.js";
import { newCallId, type ToolCall, type ToolChoice, type ToolDefinition } from "./tool-protocol.js";

/**
 * Re-present an upstream {@link Usage} as an OpenAI `usage` block. Missing
 * fields become `0` so the response is always well-formed.
 */
export function openAIUsage(u?: Usage): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  return {
    prompt_tokens: u?.prompt_tokens ?? 0,
    completion_tokens: u?.completion_tokens ?? 0,
    total_tokens: u?.total_tokens ?? 0,
  };
}

/** Re-present an upstream {@link Usage} as an Anthropic `usage` block. */
export function anthropicUsage(u?: Usage): { input_tokens: number; output_tokens: number } {
  return {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,
  };
}

/**
 * Translate internal {@link ToolDefinition}s into the OpenAI `tools` array
 * (function shape). This is the inverse of the server's `openaiToolsToDefs`, so
 * an API-key provider forwards the same schemas it received.
 */
export function toolsToOpenAI(tools: ToolDefinition[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.parameters ? { parameters: t.parameters } : {}),
    },
  }));
}

/** Translate the internal normalized {@link ToolChoice} back to the OpenAI shape. */
export function toolChoiceToOpenAI(choice: ToolChoice | undefined): unknown {
  if (!choice || choice === "auto") return "auto";
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  return { type: "function", function: { name: choice.name } };
}

/**
 * Re-present internal {@link Message}s as OpenAI wire messages so an API-key
 * provider can forward a tool loop upstream. Used by the Anthropic dialect,
 * whose blocks must be flattened into OpenAI's `assistant.tool_calls` +
 * `role: "tool"` shape before the provider sends them.
 */
export function toOpenAIWire(messages: Message[]): any[] {
  return messages.map((m) => {
    const base: any = { role: m.role, content: m.content };
    if (m.role === "assistant" && m.tool_calls?.length) {
      base.tool_calls = m.tool_calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    if (m.role === "tool") {
      base.tool_call_id = m.tool_call_id;
      if (m.name !== undefined) base.name = m.name;
    }
    return base;
  });
}

interface DeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

/**
 * Folds OpenAI streamed `delta.tool_calls` fragments into completed
 * {@link ToolCall}s. A tool call arrives across many chunks (index, id,
 * function.name, function.arguments split at arbitrary boundaries), and several
 * calls can be in flight in parallel — so entries are merged per `index` and
 * only released by {@link flush} once the stream signals completion.
 */
export class ToolCallAccumulator {
  private calls = new Map<number, { id: string; name: string; arguments: string }>();
  private cursor = 0;

  /** Merge one streamed `delta.tool_calls` entry. Returns nothing mid-flight. */
  push(tc: DeltaToolCall): void {
    const index = tc.index ?? this.cursor++;
    let acc = this.calls.get(index);
    if (!acc) {
      acc = { id: "", name: "", arguments: "" };
      this.calls.set(index, acc);
    }
    if (tc.id) acc.id = tc.id;
    if (tc.function?.name) acc.name = tc.function.name;
    if (tc.function?.arguments != null) {
      const frag =
        typeof tc.function.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments);
      acc.arguments += frag;
    }
  }

  /** Release every completed call and reset for the next tool loop. */
  flush(): ToolCall[] {
    const out: ToolCall[] = [];
    for (const acc of this.calls.values()) {
      out.push({
        id: acc.id || newCallId(),
        name: acc.name,
        arguments: acc.arguments || "{}",
      });
    }
    this.calls.clear();
    return out;
  }

  /** Non-destructive peek: are any calls pending? */
  get hasCalls(): boolean {
    return this.calls.size > 0;
  }
}
