import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advanceKey,
  assistantStep,
  foldKey,
  planTurn,
  SEED,
  type PlanArgs,
} from "../src/providers/conversation.js";
import type { Message } from "../src/providers/base.js";
import type { ToolCall } from "../src/providers/tool-protocol.js";

const call = (id: string, name = "read"): ToolCall => ({ id, name, arguments: "{}" });

const plan = (over: Partial<PlanArgs>) =>
  planTurn({
    messages: [],
    tabKey: undefined,
    continuity: "auto",
    systemMode: "ignore",
    stateless: false,
    ...over,
  });

describe("conversation key — the round-trip identity", () => {
  // The whole design rests on this: the key a turn advances to must equal the
  // key the *client's next request* produces for its prefix. If these ever
  // diverge, every turn scores a miss and replays the transcript.
  it("advancing after a turn lands on the next request's prefix key", () => {
    const system: Message = { role: "system", content: "You are a coding agent." };
    const user: Message = { role: "user", content: "read package.json" };
    const calls = [call("call_a1")];

    // Request 1: [system, user] onto a fresh tab. Nothing to rebuild over, so
    // it just types the transcript in — no "new chat" click needed.
    const turn1 = plan({ messages: [system, user], stateless: true });
    assert.equal(turn1.mode, "continue");
    assert.deepEqual(turn1.promptMessages, [system, user]);
    const afterTurn1 = advanceKey(turn1, calls, "ignore");

    // Request 2: the client echoes our assistant turn and appends the result.
    const assistant: Message = { role: "assistant", content: "", tool_calls: calls };
    const result: Message = {
      role: "tool",
      content: '{"version":"0.1.5"}',
      tool_call_id: "call_a1",
      name: "read",
    };
    const turn2 = plan({
      messages: [system, user, assistant, result],
      tabKey: afterTurn1,
      stateless: true,
    });

    assert.equal(turn2.prefixKey, afterTurn1, "the tab's key must match the new prefix");
    assert.equal(turn2.mode, "continue", "so the turn continues instead of replaying");
    assert.deepEqual(turn2.promptMessages, [result], "and types only the tool result");
  });

  it("holds across a second round trip", () => {
    const msgs: Message[] = [
      { role: "user", content: "list files" },
      { role: "assistant", content: "", tool_calls: [call("c1", "list")] },
      { role: "tool", content: "a.js\nb.js", tool_call_id: "c1", name: "list" },
    ];
    const t1 = plan({ messages: msgs, tabKey: undefined, stateless: true });
    const k1 = advanceKey(t1, [call("c2", "read")], "ignore");

    const next: Message[] = [
      ...msgs,
      { role: "assistant", content: "", tool_calls: [call("c2", "read")] },
      { role: "tool", content: "contents", tool_call_id: "c2", name: "read" },
    ];
    const t2 = plan({ messages: next, tabKey: k1, stateless: true });
    assert.equal(t2.mode, "continue");
    assert.equal(t2.prefixKey, k1);
  });
});

describe("conversation key — what it does and does not notice", () => {
  const base: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello there!", tool_calls: [call("c1")] },
  ];

  it("ignores assistant prose — the client re-renders it lossily", () => {
    const reworded: Message[] = [
      base[0],
      { role: "assistant", content: "hello there", tool_calls: [call("c1")] },
    ];
    assert.equal(foldKey(SEED, base, "ignore"), foldKey(SEED, reworded, "ignore"));
  });

  it("notices a different tool_call id — those round-trip verbatim", () => {
    const other: Message[] = [base[0], { role: "assistant", content: "", tool_calls: [call("c2")] }];
    assert.notEqual(foldKey(SEED, base, "ignore"), foldKey(SEED, other, "ignore"));
  });

  it("notices changed user content", () => {
    const other: Message[] = [{ role: "user", content: "hi!" }, base[1]];
    assert.notEqual(foldKey(SEED, base, "ignore"), foldKey(SEED, other, "ignore"));
  });

  it("notices a changed tool result", () => {
    const a: Message[] = [{ role: "tool", content: "1", tool_call_id: "c", name: "n" }];
    const b: Message[] = [{ role: "tool", content: "2", tool_call_id: "c", name: "n" }];
    assert.notEqual(foldKey(SEED, a, "ignore"), foldKey(SEED, b, "ignore"));
  });

  it("notices reordering", () => {
    const a: Message[] = [{ role: "user", content: "x" }, { role: "user", content: "y" }];
    assert.notEqual(foldKey(SEED, a, "ignore"), foldKey(SEED, [a[1], a[0]], "ignore"));
  });

  it("is stable across calls (no time or randomness in the input)", () => {
    assert.equal(foldKey(SEED, base, "ignore"), foldKey(SEED, base, "ignore"));
  });

  it("assistantStep matches folding the equivalent assistant message", () => {
    const calls = [call("c9")];
    const folded = foldKey(SEED, [{ role: "assistant", content: "anything", tool_calls: calls }], "ignore");
    assert.equal(assistantStep(SEED, calls), folded);
  });
});

describe("conversation key — system mode", () => {
  // Why the default is `ignore`: a coding agent rebuilds its system prompt on
  // every request with volatile context. Hashing it would score every turn as
  // a miss and replay the entire transcript into the chat box each time.
  const withCwd = (cwd: string): Message[] => [
    { role: "system", content: `You are an agent. cwd: ${cwd}. Today is 2026-09-05.` },
    { role: "user", content: "hi" },
  ];

  it("ignore: a rotating system prompt does not break continuity", () => {
    assert.equal(
      foldKey(SEED, withCwd("/tmp/a"), "ignore"),
      foldKey(SEED, withCwd("/tmp/b"), "ignore"),
    );
  });

  it("hash: the same change does break it", () => {
    assert.notEqual(
      foldKey(SEED, withCwd("/tmp/a"), "hash"),
      foldKey(SEED, withCwd("/tmp/b"), "hash"),
    );
  });
});

describe("planTurn", () => {
  const convo: Message[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "a", tool_calls: [call("c1")] },
    { role: "tool", content: "r", tool_call_id: "c1", name: "read" },
  ];

  it("newChat always replays, even on a matching tab", () => {
    const key = foldKey(SEED, convo.slice(0, 2), "ignore");
    const p = plan({ messages: convo, tabKey: key, newChat: true });
    assert.equal(p.mode, "replay");
    assert.deepEqual(p.promptMessages, convo);
  });

  it("continuity=replay always replays", () => {
    const key = foldKey(SEED, convo.slice(0, 2), "ignore");
    assert.equal(plan({ messages: convo, tabKey: key, continuity: "replay" }).mode, "replay");
  });

  it("continuity=tab always continues, even on a mismatched tab", () => {
    const p = plan({ messages: convo, tabKey: "something-else", continuity: "tab" });
    assert.equal(p.mode, "continue");
    assert.deepEqual(p.promptMessages, [convo[2]]);
  });

  it("a matching tab continues and sends only the pending turn", () => {
    const key = foldKey(SEED, convo.slice(0, 2), "ignore");
    const p = plan({ messages: convo, tabKey: key });
    assert.equal(p.mode, "continue");
    assert.deepEqual(p.promptMessages, [convo[2]]);
    assert.equal(p.needsPreamble, false, "a tool-result-only turn restates nothing");
  });

  it("a mismatched tab replays the whole transcript", () => {
    const p = plan({ messages: convo, tabKey: "stale" });
    assert.equal(p.mode, "replay");
    assert.deepEqual(p.promptMessages, convo);
    assert.equal(p.needsPreamble, true, "a replay reopens with the user question");
  });

  it("an unknown tab replays rather than appending to a stranger's thread", () => {
    assert.equal(plan({ messages: convo, tabKey: undefined }).mode, "replay");
  });

  describe("empty prefix — the ambiguous case", () => {
    const lone: Message[] = [{ role: "user", content: "and in Nepali?" }];
    const opening: Message[] = [
      { role: "system", content: "You are an agent." },
      { role: "user", content: "read package.json" },
    ];

    it("a lone message with no tools continues — the documented /chat story", () => {
      const p = plan({ messages: lone, tabKey: "whatever-the-tab-holds", stateless: false });
      assert.equal(p.mode, "continue");
    });

    it("an agent client opening a session gets a clean thread", () => {
      const p = plan({ messages: opening, tabKey: "someone-elses-conversation", stateless: true });
      assert.equal(p.mode, "replay");
    });

    it("but not a pointless one when the tab is already untouched", () => {
      assert.equal(plan({ messages: opening, tabKey: undefined, stateless: true }).mode, "continue");
    });
  });
});
