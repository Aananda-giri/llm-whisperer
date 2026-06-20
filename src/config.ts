import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export interface ProviderConfig {
  url: string;
  requiresLogin: boolean;
  newChatSelector?: string;
  inputSelector: string;
  sendSelector?: string;
  responseSelector: string;
  stopSelector?: string;
  /** If this selector is visible, we're logged out → raise LoginRequiredError. */
  loggedOutSelector?: string;
  timeoutMs: number;
  stabilizeMs: number;
}

export interface AppConfig {
  port: number;
  profilesDir: string;
  headless: boolean;
  providers: Record<string, ProviderConfig>;
}

const REQUIRED_FIELDS: (keyof ProviderConfig)[] = [
  "url",
  "inputSelector",
  "responseSelector",
];

export function loadConfig(file = "providers.yaml"): AppConfig {
  const raw = yaml.load(readFileSync(resolve(file), "utf-8")) as {
    providers?: Record<string, Partial<ProviderConfig>>;
  };

  if (!raw?.providers || typeof raw.providers !== "object") {
    throw new Error(`No "providers" map found in ${file}`);
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, cfg] of Object.entries(raw.providers)) {
    for (const field of REQUIRED_FIELDS) {
      if (!cfg?.[field]) {
        throw new Error(`Provider "${name}" is missing required field "${field}"`);
      }
    }
    providers[name] = {
      requiresLogin: false,
      timeoutMs: 90000,
      stabilizeMs: 2000,
      ...cfg,
    } as ProviderConfig;
  }

  return {
    port: Number(process.env.PORT ?? 3000),
    profilesDir: process.env.PROFILES_DIR ?? "./profiles",
    headless: (process.env.HEADLESS ?? "true").toLowerCase() !== "false",
    providers,
  };
}
