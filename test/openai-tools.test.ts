import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicUsage,
  openAIUsage,
  toolsToOpenAI,
  toolChoiceToOpenAI,
  ToolCallAccumulator,
  toOpenAIWire,
} from "../src/providers/openai-tools.js";
import { openaiToolChoiceToInternal, openaiToolsToDefs } from "../src/server.js";
import type { Message, Usage } from "../src/providers/base.js";

describe("toolsToOpenAI round-trips against openaiToolsToDefs", () => {
  const defs = [
    {
      name: "get_weather",
      description: "Get the weather.",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  ];

  it("encodes to the OpenAI function shape and decodes back", () => {
    const wired = toolsToOpenAI(defs);
    assert.equal(wired.length, 1);
    assert.equal(wired[0].type, "function");
    assert.equal(wired[0].function.name, "get_weather");
    assert.ok(wired[0].function.parameters.properties, "parameters survive");

    const back = openaiToolsToDefs(wired);
    assert.deepEqual(back, defs);
  });

  it("omits description/parameters when absent", () => {
    const wired = toolsToOpenAI([{ name: "a" }]);
    assert.deepEqual(wired, [{ type: "function", function: { name: "a" } }]);
  });
});

describe("toolChoiceToOpenAI round-trips against openaiToolChoiceToInternal", () => {
  it("maps the scalar directives", () => {
    for (const c of ["auto", "none", "required"]) {
      assert.equal(openaiToolChoiceToInternal(toolChoiceToOpenAI(c)), c);
    }
  });

  it("maps a named choice both ways", () => {
    const internal = openaiToolChoiceToInternal(toolChoiceToOpenAI({ name: "get_weather" }));
    assert.deepEqual(internal, { name: "get_weather" });
  });

  it("undefined becomes auto", () => {
    assert.equal(toolChoiceToOpenAI(undefined), "auto");
  });
});

describe("toOpenAIWire", () => {
  it("wraps internal assistant tool_calls and tool messages", () => {
    const messages: Message[] = [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ id: "c1", name: "get_weather", arguments: '{"city":"KTM"}' }],
      },
      { role: "tool", content: '{"temp_c":12}', tool_call_id: "c1", name: "get_weather" },
    ];
    const wire = toOpenAIWire(messages);
    assert.equal(wire[0].role, "user");
    assert.equal(wire[1].role, "assistant");
    assert.equal(wire[1].tool_calls[0].type, "function");
    assert.equal(wire[1].tool_calls[0].function.name, "get_weather");
    assert.equal(wire[1].tool_calls[0].function.arguments, '{"city":"KTM"}');
    assert.equal(wire[1].tool_calls[0].id, "c1");
    assert.equal(wire[2].role, "tool");
    assert.equal(wire[2].tool_call_id, "c1");
    assert.equal(wire[2].name, "get_weather");
  });
});

describe("ToolCallAccumulator", () => {
  it("folds arguments split mid-JSON", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, id: "c0", function: { name: "get_weather", arguments: '{"ci' } });
    acc.push({ index: 0, function: { arguments: 'ty":"KTM"}' } });
    const calls = acc.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "c0");
    assert.equal(calls[0].name, "get_weather");
    assert.equal(calls[0].arguments, '{"city":"KTM"}');
    assert.equal(acc.hasCalls, false, "flush clears the accumulator");
  });

  it("tracks two parallel calls at different indexes", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, id: "c0", function: { name: "get_weather", arguments: "{}" } });
    acc.push({ index: 1, id: "c1", function: { name: "get_news", arguments: '{"topic":"AI"}' } });
    const calls = acc.flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].id, "c0");
    assert.equal(calls[1].id, "c1");
    assert.equal(calls[1].name, "get_news");
    assert.equal(calls[1].arguments, '{"topic":"AI"}');
  });

  it("releases a partial call accumulated via char-by-char deltas", () => {
    const acc = new ToolCallAccumulator();
    const arg = '{"city":"KTM"}';
    for (let i = 0; i < arg.length; i++) {
      acc.push({ index: 0, id: i === 0 ? "c0" : undefined, function: { name: i === 0 ? "get_weather" : undefined, arguments: arg[i] } });
    }
    const calls = acc.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "c0");
    assert.equal(calls[0].arguments, '{"city":"KTM"}');
  });

  it("defaults missing id and arguments", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, function: { name: "f" } });
    const calls = acc.flush();
    assert.equal(calls[0].name, "f");
    assert.match(calls[0].id, /^call_/);
    assert.equal(calls[0].arguments, "{}");
  });
});

describe("usage mapping", () => {
  const usage: Usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };

  it("openAIUsage carries upstream numbers", () => {
    assert.deepEqual(openAIUsage(usage), {
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
    });
  });

  it("openAIUsage defaults missing fields to zero", () => {
    assert.deepEqual(openAIUsage(), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    assert.deepEqual(openAIUsage({ prompt_tokens: 5 }), {
      prompt_tokens: 5,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("anthropicUsage maps prompt/completion onto input/output tokens", () => {
    assert.deepEqual(anthropicUsage(usage), { input_tokens: 12, output_tokens: 7 });
  });

  it("anthropicUsage defaults to zero", () => {
    assert.deepEqual(anthropicUsage(), { input_tokens: 0, output_tokens: 0 });
  });
});
