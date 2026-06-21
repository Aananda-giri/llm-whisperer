import type { AppConfig } from "../config.js";
import type { SessionPool } from "../session-pool.js";
import { WebLLMProvider, type LLMProvider } from "./base.js";
import { ApiLLMProvider } from "./api.js";

/**
 * Subclasses for services that need behavior beyond config can be registered
 * here, keyed by provider name. Everything else uses the generic
 * WebLLMProvider — adding a new provider is usually just a providers.yaml edit.
 */
const OVERRIDES: Record<
  string,
  new (...args: ConstructorParameters<typeof WebLLMProvider>) => WebLLMProvider
> = {
  // e.g. chatgpt: ChatGPTProvider,
};

export function buildProviders(
  config: AppConfig,
  pool: SessionPool,
): Map<string, LLMProvider> {
  const providers = new Map<string, LLMProvider>();
  for (const [name, cfg] of Object.entries(config.providers)) {
    if (cfg.api) {
      providers.set(name, new ApiLLMProvider(name, cfg));
      continue;
    }
    const Cls = OVERRIDES[name] ?? WebLLMProvider;
    providers.set(name, new Cls(name, cfg, pool));
  }
  return providers;
}
