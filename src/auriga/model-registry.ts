/**
 * Model registry — the single source of truth for what LLM backends exist,
 * what they can do, and what they cost.
 *
 * Note: capability is a string-literal union rather than a TS `enum`. This
 * repo executes .ts files directly via Node's native type-stripping, which
 * does not support enum syntax (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) — see
 * src/domain/ContentType.ts for the same pattern already in use.
 */

export type ModelCapability =
  | 'code-generation'
  | 'reasoning'
  | 'long-context'
  | 'vision'
  | 'fast-response';

export interface ModelRateLimit {
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export interface ModelCost {
  /** USD per input token. */
  inputPerToken: number;
  /** USD per output token. */
  outputPerToken: number;
}

export interface ModelProfile {
  name: string;
  provider: string;
  capabilities: ModelCapability[];
  contextWindowTokens: number;
  cost: ModelCost;
  rateLimit: ModelRateLimit;
}

const DEFAULT_MODELS: ModelProfile[] = [
  {
    name: 'claude-sonnet',
    provider: 'anthropic',
    capabilities: ['code-generation', 'reasoning', 'long-context', 'fast-response'],
    contextWindowTokens: 200_000,
    cost: { inputPerToken: 0.000003, outputPerToken: 0.000015 },
    rateLimit: { requestsPerMinute: 50, tokensPerMinute: 200_000 },
  },
  {
    name: 'claude-opus',
    provider: 'anthropic',
    capabilities: ['code-generation', 'reasoning', 'long-context', 'vision'],
    contextWindowTokens: 200_000,
    cost: { inputPerToken: 0.000015, outputPerToken: 0.000075 },
    rateLimit: { requestsPerMinute: 20, tokensPerMinute: 100_000 },
  },
  {
    name: 'codex',
    provider: 'openai',
    capabilities: ['code-generation', 'fast-response'],
    contextWindowTokens: 128_000,
    cost: { inputPerToken: 0.0000015, outputPerToken: 0.000006 },
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 150_000 },
  },
  {
    name: 'gemini-2.0',
    provider: 'google',
    capabilities: ['code-generation', 'reasoning', 'vision', 'fast-response'],
    contextWindowTokens: 1_000_000,
    cost: { inputPerToken: 0.0000005, outputPerToken: 0.0000015 },
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 250_000 },
  },
];

export class ModelRegistry {
  private models: Map<string, ModelProfile> = new Map();

  constructor(models: ModelProfile[] = DEFAULT_MODELS) {
    for (const model of models) {
      this.register(model);
    }
  }

  register(profile: ModelProfile): void {
    this.models.set(profile.name, profile);
  }

  /**
   * Returns the capability profile for a model, or throws if the name is
   * not registered.
   */
  getModel(name: string): ModelProfile {
    const profile = this.models.get(name);
    if (!profile) {
      const known = Array.from(this.models.keys()).join(', ');
      throw new Error(`Unknown model "${name}". Known models: ${known}`);
    }
    return profile;
  }

  hasModel(name: string): boolean {
    return this.models.has(name);
  }

  listModels(): ModelProfile[] {
    return Array.from(this.models.values());
  }

  getModelsByCapability(capability: ModelCapability): ModelProfile[] {
    return this.listModels().filter((profile) => profile.capabilities.includes(capability));
  }
}

export const modelRegistry = new ModelRegistry();
