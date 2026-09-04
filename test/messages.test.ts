import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pendingTurn, turnContainsUser, type Message } from "../src/providers/base.js";
import { anthropicToMessages, openaiToMessages } from "../src/server.js";

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });

describe("pendingTurn", () => {
  it("returns the whole array when there is no assistant message", () => {
    const messages = [user("hi")];
    assert.deepEqual(pendingTurn(messages), messages);
  });

  it("picks the trailing tool results over the stale user question", () => {
    const messages: Message[] = [
      user("what's the weather?"),
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "get_weather", arguments: "{}" }] },
      { role: "tool", content: '{"temp_c":12}', tool_call_id: "c1" },
      { role: "tool", content: '{"humidity":80}', tool_call_id: "c2" },
    ];
    const turn = pendingTurn(messages);
    assert.equal(turn.length, 2);
    assert.ok(turn.every((m) => m.role === "tool"));
    assert.equal(turn[0].tool_call_id, "c1");
    assert.equal(turn[1].tool_call_id, "c2");
    assert.ok(!turnContainsUser(turn));
  });

  it("sends a fresh user question after a completed assistant turn", () => {
    const messages: Message[] = [user("one"), assistant("one answer"), user("two")];
    const turn = pendingTurn(messages);
    assert.deepEqual(turn, [user("two")]);
    assert.ok(turnContainsUser(turn));
  });
});

describe("anthropicToMessages (browser providers, keepTools)", () => {
  it("round-trips tool_use into assistant.tool_calls", () => {
    const out = anthropicToMessages(
      null,
      [
        { role: "user", content: "check the weather" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking now…" },
            { type: "tool_use", id: "toolu_123", name: "get_weather", input: { city: "KTM" } },
          ],
        },
      ],
      true,
    );
    assert.equal(out[0].role, "user");
    assert.equal(out[1].role, "assistant");
    assert.equal(out[1].content, "Checking now…");
    assert.equal(out[1].tool_calls?.length, 1);
    assert.equal(out[1].tool_calls![0].id, "toolu_123");
    assert.equal(out[1].tool_calls![0].name, "get_weather");
    assert.equal(out[1].tool_calls![0].arguments, '{"city":"KTM"}');
  });

  it("round-trips tool_result into role: tool messages", () => {
    const out = anthropicToMessages(
      null,
      [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_123", content: '{"temp_c":12}' },
            { type: "tool_result", tool_use_id: "toolu_456", content: [{ type: "text", text: "all good" }] },
          ],
        },
      ],
      true,
    );
    assert.equal(out.length, 2);
    assert.ok(out.every((m) => m.role === "tool"));
    assert.equal(out[0].tool_call_id, "toolu_123");
    assert.equal(out[0].content, '{"temp_c":12}');
    assert.equal(out[1].tool_call_id, "toolu_456");
    assert.equal(out[1].content, "all good");
  });

  it("folds the separate system field into a leading system message", () => {
    const out = anthropicToMessages("Be concise.", [{ role: "user", content: "hi" }], true);
    assert.deepEqual(out[0], { role: "system", content: "Be concise." });
  });

  it("flattens tool blocks away when keepTools is false", () => {
    const out = anthropicToMessages(
      null,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_use", id: "toolu_1", name: "f", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "5" }],
        },
      ],
      false,
    );
    assert.equal(out[0].role, "assistant");
    assert.equal(out[0].content, "ok");
    assert.equal(out[0].tool_calls, undefined);
    assert.equal(out[1].role, "user");
    assert.equal(out[1].content, "");
  });
});

describe("openaiToMessages", () => {
  it("carries assistant tool_calls and role: tool messages through", () => {
    const out = openaiToMessages([
      { role: "user", content: "check" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"KTM"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: '{"temp_c":12}' },
    ]);
    assert.equal(out[0].role, "user");
    assert.equal(out[1].role, "assistant");
    assert.equal(out[1].tool_calls?.length, 1);
    assert.equal(out[1].tool_calls![0].name, "get_weather");
    assert.equal(out[1].tool_calls![0].arguments, '{"city":"KTM"}');
    assert.equal(out[2].role, "tool");
    assert.equal(out[2].tool_call_id, "c1");
    assert.equal(out[2].content, '{"temp_c":12}');
  });

  it("flattens a multimodal content array to text (the [object Object] fix)", () => {
    const out = openaiToMessages([
      { role: "user", content: [{ type: "text", text: "look at " }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
    ]);
    assert.equal(out[0].role, "user");
    assert.equal(out[0].content, "look at ");
  });
});

describe("anthropicToMessages — tool_result turns carrying text", () => {
  it("keeps user text that accompanies a tool_result block", () => {
    const out = anthropicToMessages(undefined, [
      { role: "user", content: "weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "12C" },
          { type: "text", text: "ALSO answer in Nepali" },
        ],
      },
    ], true);

    const last = out.slice(-2);
    assert.equal(last[0].role, "tool");
    assert.equal(last[0].content, "12C");
    assert.equal(last[0].tool_call_id, "t1");
    assert.equal(last[1].role, "user", "the accompanying instruction must not be dropped");
    assert.equal(last[1].content, "ALSO answer in Nepali");
  });

  it("emits no trailing user message when the turn is tool results only", () => {
    const out = anthropicToMessages(undefined, [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ], true);
    assert.equal(out.at(-1)?.role, "tool");
  });
});
