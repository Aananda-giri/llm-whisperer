import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type AppConfig } from "../src/config.js";
import { listModels, resolveModel } from "../src/models.js";

const YAML = `
providers:
  qwen:
    url: "https://qwen.example/"
    requiresLogin: true
    inputSelector: "textarea"
    responseSelector: ".resp"
    timeoutMs: 60000
    stabilizeMs: 2000
    models:
      "qwen3-235b":   ""
      "qwen2.5-max":  ""
      "qwen2.5-coder": ""
  grok:
    url: "https://grok.example/"
    requiresLogin: true
    inputSelector: "textarea"
    responseSelector: ".resp"
    timeoutMs: 60000
    stabilizeMs: 2000
    models:
      "grok-3": ""
  groq:
    api:
      baseUrl: "https://api.groq.com/openai/v1"
      model: "llama-3.3-70b-versatile"
      keyEnv: "GROQ_API_KEY"
  openrouter:
    api:
      baseUrl: "https://openrouter.ai/api/v1"
      model: "openai/gpt-oss-120b:free"
      keyEnv: "OPENROUTER_API_KEY"
  cloudflare:
    api:
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/\${CLOUDFLARE_ACCOUNT_ID}/ai/v1"
      model: "@cf/meta/llama-3.1-8b-instruct"
      keyEnv: "CLOUDFLARE_API_TOKEN"
profiles:
  email1:
    providers:
      qwen: ["qwen3-235b", "qwen2.5-coder"]
      groq: "*"
  work:
    providers:
      grok: ["grok-3"]
`;

function load(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "wspr-models-"));
  const file = join(dir, "providers.yaml");
  writeFileSync(file, YAML);
  return loadConfig(file);
}

describe("resolveModel — first-slash split", () => {
  const config = load();

  it("keeps a slashed OpenRouter id intact after the provider", () => {
    const r = resolveModel(config, undefined, "openrouter/openai/gpt-oss-120b:free");
    assert.ok(!("error" in r), `expected success, got: ${(r as any).error}`);
    assert.equal(r.provider, "openrouter");
    assert.equal(r.model, "openai/gpt-oss-120b:free");
  });

  it("keeps a slashed Cloudflare @cf id intact (the historical split('/') defect)", () => {
    const r = resolveModel(config, undefined, "cloudflare/@cf/meta/llama-3.1-8b-instruct");
    assert.ok(!("error" in r));
    assert.equal(r.provider, "cloudflare");
    assert.equal(r.model, "@cf/meta/llama-3.1-8b-instruct");
  });

  it("resolves a bare provider alias to the provider default", () => {
    const r = resolveModel(config, undefined, "grok");
    assert.ok(!("error" in r));
    assert.equal(r.provider, "grok");
    assert.equal(r.model, undefined);
  });

  it("rejects an unknown provider", () => {
    const r = resolveModel(config, undefined, "nope/model");
    assert.ok("error" in r);
    assert.match((r as any).error, /Unknown provider "nope"/);
  });
});

describe("resolveModel — profile scoping", () => {
  const config = load();

  it("allows a model the profile lists", () => {
    const r = resolveModel(config, "email1", "qwen/qwen3-235b");
    assert.ok(!("error" in r));
    assert.equal(r.model, "qwen3-235b");
  });

  it("rejects a model the profile hides", () => {
    const r = resolveModel(config, "email1", "qwen/qwen2.5-max");
    assert.ok("error" in r);
    assert.match((r as any).error, /not exposed by profile "email1"/);
  });

  it("rejects a provider the profile hides", () => {
    const r = resolveModel(config, "email1", "grok");
    assert.ok("error" in r);
    assert.match((r as any).error, /not exposed by profile "email1"/);
  });

  it("allows a bare alias matching an exposed provider", () => {
    const r = resolveModel(config, "email1", "qwen");
    assert.ok(!("error" in r));
    assert.equal(r.model, undefined);
  });

  it("honours '*' for an API provider", () => {
    const r = resolveModel(config, "email1", "groq/llama-3.1-8b-instant");
    assert.ok(!("error" in r));
    assert.equal(r.provider, "groq");
    assert.equal(r.model, "llama-3.1-8b-instant");
  });

  it("an undeclared profile exposes every provider", () => {
    const r = resolveModel(config, "ghost", "openrouter/openai/gpt-oss-120b:free");
    assert.ok(!("error" in r));
    assert.equal(r.provider, "openrouter");
  });

  it("rejects a model a browser provider does not know", () => {
    const r = resolveModel(config, undefined, "qwen/does-not-exist");
    assert.ok("error" in r);
    assert.match((r as any).error, /Unknown model "does-not-exist"/);
  });
});

describe("listModels", () => {
  const config = load();

  it("emits the bare alias plus each browser model", () => {
    const ids = listModels(config, undefined).map((e) => e.id);
    assert.ok(ids.includes("qwen"));
    assert.ok(ids.includes("qwen/qwen3-235b"));
    assert.ok(ids.includes("qwen/qwen2.5-coder"));
  });

  it("includes an API default and respects profile filters", () => {
    const ids = listModels(config, "email1").map((e) => e.id);
    assert.ok(ids.includes("groq/llama-3.3-70b-versatile"));
    assert.ok(ids.includes("qwen/qwen3-235b"));
    assert.ok(ids.includes("qwen/qwen2.5-coder"));
    assert.ok(!ids.includes("qwen/qwen2.5-max"), "filtered-out model must not appear");
    assert.ok(!ids.includes("grok"), "hidden provider must not appear");
  });

  it("keeps slashed API ids whole in the catalog", () => {
    const ids = listModels(config, undefined).map((e) => e.id);
    assert.ok(ids.includes("openrouter/openai/gpt-oss-120b:free"));
    assert.ok(ids.includes("cloudflare/@cf/meta/llama-3.1-8b-instruct"));
  });

  it("an undeclared profile returns every provider", () => {
    const ids = listModels(config, "ghost").map((e) => e.id);
    assert.ok(ids.includes("grok/grok-3"));
    assert.ok(ids.includes("openrouter/openai/gpt-oss-120b:free"));
  });

  it("marks kind and label", () => {
    const entry = listModels(config, "email1").find((e) => e.id === "qwen/qwen3-235b")!;
    assert.equal(entry.kind, "browser");
    assert.equal(entry.label, "qwen3-235b");
    assert.equal(entry.provider, "qwen");
  });
});
