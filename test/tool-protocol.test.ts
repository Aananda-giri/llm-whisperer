import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseToolCallJson,
  renderToolCalls,
  renderToolPreamble,
  renderToolResult,
  ToolCallScanner,
  compactSchema,
  extractJsonObject,
  stripChrome,
  truncateToolResults,
} from "../src/providers/tool-protocol.js";

const WEATHER = new Set(["get_weather"]);

describe("parseToolCallJson", () => {
  it("parses a valid call and normalizes arguments to a JSON string", () => {
    const call = parseToolCallJson(
      '{"name": "get_weather", "arguments": {"city": "Kathmandu"}}',
      WEATHER,
    );
    assert.ok(call, "should parse a valid call");
    assert.equal(call.name, "get_weather");
    assert.equal(call.arguments, '{"city":"Kathmandu"}');
    assert.ok(call.id.startsWith("call_"), "id should be wspr-generated");
  });

  it("keeps arguments already given as a JSON string", () => {
    const call = parseToolCallJson(
      '{"name":"f","arguments":"{\\"a\\":1}"}',
      new Set(["f"]),
    );
    assert.ok(call);
    assert.equal(call.arguments, '{"a":1}');
  });

  it("defaults missing arguments to an empty object", () => {
    const call = parseToolCallJson('{"name":"f"}', new Set(["f"]));
    assert.ok(call);
    assert.equal(call.arguments, "{}");
  });

  it("unwraps a ```json fence", () => {
    const call = parseToolCallJson('```json\n{"name":"f","arguments":{"a":1}}\n```', new Set(["f"]));
    assert.ok(call);
    assert.equal(call.name, "f");
  });

  it("normalizes smart quotes and strips zero-width characters", () => {
    // A chat UI substituted curly quotes for the whole JSON (the realistic case).
    const call = parseToolCallJson(
      "{\u201cname\u201d:\u201cf\u201d\u200b,\u201carguments\u201d:{\u201ccity\u201d:\u201cKTM\u201d}}",
      new Set(["f"]),
    );
    assert.ok(call);
    assert.equal(call.arguments, '{"city":"KTM"}');
  });

  it("tolerates a trailing comma", () => {
    const call = parseToolCallJson('{"name":"f","arguments":{"a":1,}}', new Set(["f"]));
    assert.ok(call);
    assert.equal(call.arguments, '{"a":1}');
  });

  it("rejects an unknown tool name (falls back to text, never throws)", () => {
    assert.equal(parseToolCallJson('{"name":"nope","arguments":{}}', WEATHER), null);
  });

  it("accepts any name when no tool list is supplied", () => {
    assert.ok(parseToolCallJson('{"name":"anything","arguments":{}}'));
  });

  it("returns null for malformed JSON or a missing name", () => {
    assert.equal(parseToolCallJson("not json at all", WEATHER), null);
    assert.equal(parseToolCallJson('{"arguments":{}}', WEATHER), null);
  });
});

describe("renderToolPreamble", () => {
  const tools = [
    {
      name: "get_weather",
      description: "Get the weather for a city.",
      parameters: { type: "object" },
    },
  ];

  it("lists every tool and its schema", () => {
    const p = renderToolPreamble(tools, "auto");
    assert.ok(p.includes("get_weather"));
    assert.ok(p.includes("Get the weather for a city."));
    // The default style is compact (a chat box has a length limit); the schema
    // is still there, just not pretty-printed.
    assert.ok(p.includes('{"type":"object"}'));
    assert.ok(!p.includes("must call"), "auto needs no directive");
  });

  it("pretty style keeps the indented JSON Schema", () => {
    const p = renderToolPreamble(tools, "auto", { style: "pretty" });
    assert.ok(p.includes('"type": "object"'));
  });

  it("returns empty for tool_choice none", () => {
    assert.equal(renderToolPreamble(tools, "none"), "");
  });

  it("adds a must-call directive for required", () => {
    assert.ok(renderToolPreamble(tools, "required").includes("You must call a tool"));
  });

  it("names the tool for a named tool_choice", () => {
    assert.ok(renderToolPreamble(tools, { name: "get_weather" }).includes('"get_weather" tool'));
  });

  it("returns empty when there are no tools", () => {
    assert.equal(renderToolPreamble([], "auto"), "");
  });
});

describe("renderToolResult / renderToolCalls", () => {
  it("renders a <tool_result> block", () => {
    const block = renderToolResult({
      content: '{"temp_c": 12}',
      tool_call_id: "call_a1b2",
      name: "get_weather",
    });
    assert.ok(block.startsWith('<tool_result tool_call_id="call_a1b2" name="get_weather">'));
    assert.ok(block.includes('{"temp_c": 12}'));
  });

  it("re-renders tool_calls back into <tool_call> blocks", () => {
    const blocks = renderToolCalls([{ id: "c1", name: "f", arguments: '{"a":1}' }]);
    assert.ok(blocks.includes("<tool_call>"));
    assert.ok(blocks.includes('{"name":"f","arguments":{"a":1}}'));
  });
});

describe("ToolCallScanner", () => {
  it("emits text before and after a single call", () => {
    const s = new ToolCallScanner(WEATHER);
    const out = s.push(
      'The weather is <tool_call>{"name":"get_weather","arguments":{"city":"KTM"}}</tool_call> today',
    );
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0].name, "get_weather");
    assert.ok(out.text.startsWith("The weather is"));
    assert.ok(out.text.endsWith("today"));
    assert.ok(!out.text.includes("tool_call"), "marker must not leak into text");
  });

  it("detects multiple calls in one reply", () => {
    const s = new ToolCallScanner(new Set(["a", "b"]));
    const out = s.push(
      '<tool_call>{"name":"a","arguments":{}}</tool_call> and ' +
        '<tool_call>{"name":"b","arguments":{}}</tool_call>',
    );
    assert.equal(out.calls.length, 2);
    assert.equal(out.calls[0].name, "a");
    assert.equal(out.calls[1].name, "b");
  });

  it("holds back a partial marker so it never leaks", () => {
    const s = new ToolCallScanner(WEATHER);
    let out = s.push("prefix <tool_ca");
    assert.equal(out.text, "prefix ");
    assert.equal(out.calls.length, 0);

    out = s.push('ll>{"name":"get_weather","arguments":{"city":"KTM"}}</tool_call>');
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0].name, "get_weather");
  });

  it("releases a never-closed block as plain text on flush", () => {
    const s = new ToolCallScanner(WEATHER);
    const out = s.push('<tool_call>{"name":"get_weather","arguments":{}}'); // no close
    assert.equal(out.calls.length, 0);
    const flushed = s.flush();
    assert.equal(flushed.calls.length, 0);
    assert.ok(flushed.text.includes("tool_call"));
    assert.ok(flushed.text.includes("get_weather"));
  });

  it("degrades a malformed block to prose instead of a call", () => {
    const s = new ToolCallScanner(WEATHER);
    const out = s.push('<tool_call>{"name":"get_weather","arguments":{}} broken </tool_call>');
    assert.equal(out.calls.length, 0);
    assert.ok(out.text.includes("broken"));
  });

  it("tolerates a fence and a trailing comma inside a streamed block", () => {
    const s = new ToolCallScanner(new Set(["f"]));
    const out = s.push('<tool_call>```json\n{"name":"f","arguments":{"a":1,}}\n```</tool_call>');
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0].name, "f");
  });

  it("falls back to text for an unknown tool name", () => {
    const s = new ToolCallScanner(WEATHER);
    const out = s.push('<tool_call>{"name":"nope","arguments":{}}</tool_call>');
    assert.equal(out.calls.length, 0);
    assert.ok(out.text.includes("nope"));
  });

  it("is a passthrough when no tools are declared", () => {
    const s = new ToolCallScanner(); // no tools
    const out = s.push("a <tool_call> b <tool_call>");
    assert.equal(out.calls.length, 0);
    assert.ok(out.text.includes("<tool_call>"));
  });
});

/**
 * Models routinely wrap the block in a Markdown code fence despite the preamble
 * telling them not to. The fence must be stripped when it only wrapped a call,
 * without ever swallowing a genuine code block in prose.
 */
describe("ToolCallScanner — fenced tool calls", () => {
  const feed = (deltas: string[], tools = WEATHER) => {
    const s = new ToolCallScanner(tools);
    let text = "";
    const calls = [];
    for (const d of deltas) {
      const out = s.push(d);
      text += out.text;
      calls.push(...out.calls);
    }
    const end = s.flush();
    return { text: text + end.text, calls: calls.concat(end.calls) };
  };
  const chars = (s: string) => s.split("");

  const FENCED =
    '```json\n<tool_call>\n{"name":"get_weather","arguments":{"city":"KTM"}}\n</tool_call>\n```';

  it("strips a fence that only wrapped a call (buffered)", () => {
    const out = feed([FENCED]);
    assert.equal(out.calls.length, 1);
    assert.equal(out.text, "", "no fence junk should surface as content");
  });

  it("strips a wrapping fence streamed one character at a time", () => {
    const out = feed(chars(FENCED));
    assert.equal(out.calls.length, 1);
    assert.equal(out.text, "", "the closing fence arrives after the call is parsed");
  });

  it("keeps the prose on both sides of a stripped fence separated", () => {
    const out = feed([`Checking.\n${FENCED}\nStandby.`]);
    assert.equal(out.calls.length, 1);
    assert.equal(out.text, "Checking.\n\nStandby.");
  });

  it("never swallows a genuine code block in prose", () => {
    const prose = "Here:\n```js\nlet x=1;\n```\nBye.";
    assert.equal(feed([prose]).text, prose);
    assert.equal(feed(chars(prose)).text, prose, "streamed char-by-char too");
  });

  it("releases a held trailing fence at flush", () => {
    assert.equal(feed(["text and a trailing fence ```"]).text, "text and a trailing fence ```");
  });

  it("releases a held partial marker at flush", () => {
    assert.equal(feed(["almost <tool_ca"]).text, "almost <tool_ca");
  });
});

describe("compactSchema / renderSchema", () => {
  // A coding agent declares ~12 tools; pretty-printing their schemas produces
  // tens of kilobytes, which is past what many chat boxes accept in one
  // message. Compact keeps every fact a model needs to fill the arguments.
  const readTool = {
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the file." },
        limit: { type: "number", description: "Max lines." },
        mode: { type: "string", enum: ["text", "bytes"] },
      },
      required: ["filePath"],
    },
  };

  it("states each parameter on one line with type, requiredness and description", () => {
    const lines = compactSchema(readTool.parameters);
    assert.ok(lines.some((l) => l.includes("filePath") && l.includes("required")));
    assert.ok(lines.some((l) => l.includes("Absolute path to the file.")));
    assert.ok(lines.some((l) => l.includes("limit") && !l.includes("required")));
    assert.ok(lines.some((l) => l.includes('one of ["text","bytes"]')));
  });

  it("falls back to one line of JSON for a schema it cannot summarise", () => {
    assert.deepEqual(compactSchema({ oneOf: [{ type: "string" }] }), ['{"oneOf":[{"type":"string"}]}']);
  });

  it("is dramatically smaller than pretty for an agent-sized tool set", () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ ...readTool, name: `tool_${i}` }));
    const compact = renderToolPreamble(tools, "auto", { style: "compact" });
    const pretty = renderToolPreamble(tools, "auto", { style: "pretty" });
    assert.ok(compact.length < pretty.length / 2, `${compact.length} vs ${pretty.length}`);
    // Still complete: every tool and its required parameter survive.
    for (const t of tools) assert.ok(compact.includes(t.name));
    assert.ok(compact.includes("filePath"));
  });
});

describe("truncateToolResults", () => {
  it("leaves messages under the cap untouched (and does not copy)", () => {
    const msgs = [{ role: "tool", content: "short" }];
    assert.equal(truncateToolResults(msgs, 100), msgs);
  });

  it("middle-out truncates an oversized tool result and marks the cut", () => {
    const body = "HEAD" + "x".repeat(500) + "TAIL";
    const [out] = truncateToolResults([{ role: "tool", content: body }], 120);
    assert.ok(out.content.length <= 120);
    assert.ok(out.content.startsWith("HEAD"), "the head survives");
    assert.ok(out.content.endsWith("TAIL"), "and so does the tail");
    assert.ok(/omitted by wspr/.test(out.content), "the model is told it is partial");
  });

  it("only touches tool messages", () => {
    const msgs = [{ role: "user", content: "y".repeat(500) }];
    assert.equal(truncateToolResults(msgs, 10), msgs);
  });
});

describe("extractJsonObject / stripChrome", () => {
  it("finds the balanced object and ignores braces inside strings", () => {
    const raw = 'noise {"a":"}{","b":{"c":1}} more';
    assert.equal(extractJsonObject(raw), '{"a":"}{","b":{"c":1}}');
  });

  it("returns null when there is no balanced object", () => {
    assert.equal(extractJsonObject('{"a":1'), null);
  });

  it("recovers a call wrapped in a chat UI's copy-button chrome", () => {
    const raw = 'json\nCopy\n{"name":"f","arguments":{"a":1}}\nCopied!';
    const call = parseToolCallJson(raw, new Set(["f"]));
    assert.ok(call, "chrome around the block must not defeat the parse");
    assert.equal(call.name, "f");
  });

  it("refuses to carve a call out of text the model actually wrote", () => {
    // The existing guarantee: unexpected prose degrades to prose, whole. Acting
    // on the JSON and dropping "broken" would hide what the model said.
    assert.equal(stripChrome('{"name":"f","arguments":{}} broken'), null);
    assert.equal(parseToolCallJson('{"name":"f","arguments":{}} broken', new Set(["f"])), null);
  });
});
