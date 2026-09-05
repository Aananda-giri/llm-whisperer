import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_TARGETS, clientTargets, type EmitContext } from "../src/clients.js";

const ctx: EmitContext = {
  profile: "email1",
  baseUrl: "http://localhost:9777",
  label: "Personal (email1)",
  models: [
    { id: "qwen", provider: "qwen", label: "qwen", kind: "browser", verified: true },
    {
      id: "qwen/qwen3-235b",
      provider: "qwen",
      model: "qwen3-235b",
      label: "qwen3-235b",
      kind: "browser",
      verified: true,
    },
    { id: "groq", provider: "groq", label: "groq", kind: "api" },
  ],
};

describe("opencode emitter", () => {
  it("emits parseable JSON with the right base URL and model ids", () => {
    const doc = JSON.parse(CLIENT_TARGETS.opencode.emit(ctx));
    assert.equal(doc.provider.email1.npm, "@ai-sdk/openai-compatible");
    assert.equal(doc.provider.email1.name, "Personal (email1)");
    assert.equal(doc.provider.email1.options.baseURL, "http://localhost:9777/p/email1/v1");
    assert.ok("qwen" in doc.provider.email1.models);
    assert.ok("qwen/qwen3-235b" in doc.provider.email1.models);
    assert.equal(doc.provider.email1.models["qwen/qwen3-235b"].name, "qwen3-235b");
  });

  it("declares tool_call on every model — without it opencode sends no tools", () => {
    const models = JSON.parse(CLIENT_TARGETS.opencode.emit(ctx)).provider.email1.models;
    for (const m of Object.values<any>(models)) assert.equal(m.tool_call, true);
  });

  it("tells opencode a browser model has no sampling controls", () => {
    const models = JSON.parse(CLIENT_TARGETS.opencode.emit(ctx)).provider.email1.models;
    assert.equal(models.qwen.temperature, false, "browser providers ignore params");
    assert.equal(models.qwen.attachment, false, "and are text-only");
    assert.equal(models.groq.temperature, true, "API providers forward them natively");
  });

  it("gives every model a limit with both required fields", () => {
    const models = JSON.parse(CLIENT_TARGETS.opencode.emit(ctx)).provider.email1.models;
    for (const m of Object.values<any>(models)) {
      assert.ok(Number.isFinite(m.limit.context), "limit.context is required by the schema");
      assert.ok(Number.isFinite(m.limit.output), "so is limit.output");
    }
  });

  it("prefers a provider-declared limit over the default", () => {
    const doc = JSON.parse(
      CLIENT_TARGETS.opencode.emit({
        ...ctx,
        models: [{ ...ctx.models[0], contextLimit: 1_000_000, outputLimit: 64_000 }],
      }),
    );
    assert.deepEqual(doc.provider.email1.models.qwen.limit, { context: 1_000_000, output: 64_000 });
  });

  it("sizes the chunk timeout from the slowest browser turn", () => {
    const doc = JSON.parse(
      CLIENT_TARGETS.opencode.emit({
        ...ctx,
        models: [{ ...ctx.models[0], timeoutMs: 120_000 }],
      }),
    );
    // A buffered tool turn sends nothing until the answer settles, so this is
    // the timeout that would fire first if it were left at opencode's default.
    assert.equal(doc.provider.email1.options.chunkTimeout, 180_000);
    assert.ok(doc.provider.email1.options.timeout > 180_000);
  });

  describe("small_model", () => {
    it("points title generation at an API provider, off the browser tabs", () => {
      const doc = JSON.parse(CLIENT_TARGETS.opencode.emit(ctx));
      assert.equal(doc.small_model, "email1/groq");
    });

    it("prefers one whose key is actually set", () => {
      const doc = JSON.parse(
        CLIENT_TARGETS.opencode.emit({
          ...ctx,
          models: [
            { id: "openai", provider: "openai", label: "openai", kind: "api", keyPresent: false },
            { id: "gemini", provider: "gemini", label: "gemini", kind: "api", keyPresent: true },
          ],
        }),
      );
      assert.equal(doc.small_model, "email1/gemini");
    });

    it("is omitted for a browser-only profile rather than named blindly", () => {
      const doc = JSON.parse(
        CLIENT_TARGETS.opencode.emit({ ...ctx, models: ctx.models.filter((m) => m.kind === "browser") }),
      );
      assert.equal("small_model" in doc, false);
    });
  });
});

describe("env emitters", () => {
  it("openai — base URL under /p/<profile>/v1", () => {
    const out = CLIENT_TARGETS.openai.emit(ctx);
    assert.match(out, /OPENAI_BASE_URL=http:\/\/localhost:9777\/p\/email1\/v1/);
    assert.match(out, /OPENAI_API_KEY=not-needed/);
  });

  it("anthropic — base URL under /p/<profile> (SDK appends /v1/messages)", () => {
    const out = CLIENT_TARGETS.anthropic.emit(ctx);
    assert.match(out, /ANTHROPIC_BASE_URL=http:\/\/localhost:9777\/p\/email1/);
  });
});

describe("continue emitter", () => {
  it("emits a models block referencing the scoped apiBase", () => {
    const out = CLIENT_TARGETS.continue.emit(ctx);
    assert.match(out, /models:/);
    assert.match(out, /apiBase: http:\/\/localhost:9777\/p\/email1\/v1/);
    assert.match(out, /name: qwen\/qwen3-235b/);
  });
});

describe("registry", () => {
  it("exposes the known targets in order", () => {
    const ids = clientTargets().map((t) => t.id);
    assert.deepEqual(ids, ["opencode", "openai", "anthropic", "continue"]);
  });
});

describe("opencode emitter — verified flag", () => {
  it("leaves a verified browser model's name untouched", () => {
    const doc = JSON.parse(CLIENT_TARGETS.opencode.emit(ctx));
    assert.equal(doc.provider.email1.models["qwen/qwen3-235b"].name, "qwen3-235b");
  });

  it("flags an unverified browser model right in the picker", () => {
    const doc = JSON.parse(
      CLIENT_TARGETS.opencode.emit({
        ...ctx,
        models: [
          { id: "chatgpt", provider: "chatgpt", label: "chatgpt", kind: "browser", verified: false },
        ],
      }),
    );
    assert.equal(doc.provider.email1.models.chatgpt.name, "chatgpt (untested)");
  });

  it("never flags an API model — it isn't selector-scraped, so the concept doesn't apply", () => {
    const doc = JSON.parse(
      CLIENT_TARGETS.opencode.emit({
        ...ctx,
        models: [{ id: "openai", provider: "openai", label: "openai", kind: "api", verified: false }],
      }),
    );
    assert.equal(doc.provider.email1.models.openai.name, "openai");
  });
});
