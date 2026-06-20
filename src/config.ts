import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

// Directory of the compiled file (dist/) — used to find bundled providers.yaml.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface ProviderConfig {
  url: string;
  requiresLogin: boolean;
  newChatSelector?: string;
  inputSelector: string;
  sendSelector?: string;
  responseSelector: string;
  stopSelector?: string;
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

function findProvidersFile(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.PROVIDERS_FILE,
    resolve("providers.yaml"),                     // CWD override
    join(PKG_ROOT, "providers.yaml"),              // bundled with the package
  ].filter(Boolean) as string[];

  for (const f of candidates) {
    if (existsSync(f)) return f;
  }
  throw new Error(
    "providers.yaml not found. Place one in the current directory or set PROVIDERS_FILE.",
  );
}

export function loadConfig(file?: string): AppConfig {
  const configFile = findProvidersFile(file);
  const raw = yaml.load(readFileSync(configFile, "utf-8")) as {
    providers?: Record<string, Partial<ProviderConfig>>;
  };

  if (!raw?.providers || typeof raw.providers !== "object") {
    throw new Error(`No "providers" map found in ${configFile}`);
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

  const defaultProfilesDir = join(homedir(), ".config", "llm-whisper", "profiles");

  return {
    port: Number(process.env.PORT ?? 3000),
    profilesDir: process.env.PROFILES_DIR ?? defaultProfilesDir,
    headless: (process.env.HEADLESS ?? "false").toLowerCase() !== "false",
    providers,
  };
}
