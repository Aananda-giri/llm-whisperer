import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_TARGETS, clientTargets, type EmitContext } from "../src/clients.js";

const ctx: EmitContext = {
  profile: "email1",
  baseUrl: "http://localhost:9777",
  label: "Personal (email1)",
  models: [
    { id: "qwen", provider: "qwen", label: "qwen", kind: "browser" },
    { id: "qwen/qwen3-235b", provider: "qwen", model: "qwen3-235b", label: "qwen3-235b", kind: "browser" },
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
