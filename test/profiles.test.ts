import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

const yaml = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), "wspr-profiles-"));
  const file = join(dir, "providers.yaml");
  writeFileSync(file, body);
  return file;
};

const HEADER = `
providers:
  qwen:
    url: "https://qwen.example/"
    requiresLogin: true
    inputSelector: "textarea"
    responseSelector: ".resp"
    timeoutMs: 60000
    stabilizeMs: 2000
    models:
      "qwen3-235b": ""
      "qwen2.5-max": ""
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
`;

const base = HEADER;

describe("profiles validation", () => {
  it("accepts a well-formed profiles block", () => {
    const file = yaml(`${base}
profiles:
  email1:
    label: "Personal"
    providers:
      qwen: ["qwen3-235b"]
      groq: "*"
`);
    const cfg = loadConfig(file);
    assert.equal(cfg.profiles.email1.label, "Personal");
    assert.deepEqual(cfg.profiles.email1.providers.qwen, ["qwen3-235b"]);
    assert.equal(cfg.profiles.email1.providers.groq, "*");
  });

  it("rejects an unknown provider key (names the typo)", () => {
    const file = yaml(`${base}
profiles:
  email1:
    providers:
      qwenx: ["qwen3-235b"]
`);
    assert.throws(() => loadConfig(file), /unknown provider "qwenx"/);
  });

  it("rejects an unknown browser model", () => {
    const file = yaml(`${base}
profiles:
  email1:
    providers:
      qwen: ["qwen3-999"]
`);
    assert.throws(() => loadConfig(file), /unknown model "qwen3-999"/);
  });

  it("allows any model id for an API provider", () => {
    const file = yaml(`${base}
profiles:
  email1:
    providers:
      groq: ["llama-3.1-8b-instant"]
`);
    const cfg = loadConfig(file);
    assert.deepEqual(cfg.profiles.email1.providers.groq, ["llama-3.1-8b-instant"]);
  });

  it("rejects an invalid profile name", () => {
    const file = yaml(`${base}
profiles:
  "bad name":
    providers:
      qwen: ["qwen3-235b"]
`);
    assert.throws(() => loadConfig(file), /Invalid browser profile/);
  });

  it("rejects a profiles entry without a providers map", () => {
    const file = yaml(`${base}
profiles:
  email1:
    label: "no providers"
`);
    assert.throws(() => loadConfig(file), /"providers" map is required/);
  });

  it("no profiles block ⇒ unchanged behaviour (empty map)", () => {
    const cfg = loadConfig(yaml(base));
    assert.deepEqual(cfg.profiles, {});
  });
});
