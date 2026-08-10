import { BaseDispatchAdapter, type AdapterConfig } from './BaseDispatchAdapter.ts';
import type { DispatchMessage, DispatchRequest, DispatchResponse } from './IDispatchAdapter.ts';

const COMPLETIONS_URL = 'https://api.openai.com/v1/completions';
const DEFAULT_MODEL = 'code-davinci-002';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0;

export class AuthenticationError extends Error {
  constructor(message = 'Invalid or missing OPENAI_API_KEY') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface CodexAdapterConfig extends AdapterConfig {
  apiKey?: string;
  model?: string;
}

function buildPrompt(messages: DispatchMessage[]): string {
  return (messages ?? []).map((m) => m.content).join('\n');
}

export class CodexAdapter extends BaseDispatchAdapter {
  private apiKey: string;
  private model: string;

  constructor(config: CodexAdapterConfig = {}) {
    super(config);

    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new AuthenticationError();
    }

    this.apiKey = apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  protected async performDispatch(request: DispatchRequest): Promise<DispatchResponse> {
    const prompt = buildPrompt(request.messages);
    const start = Date.now();

    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        max_tokens: DEFAULT_MAX_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
      }),
    });

    const latency = Date.now() - start;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new AuthenticationError(`Codex API rejected credentials: ${body}`);
      }
      throw new Error(`Codex API request failed with status ${res.status}: ${body}`);
    }

    const json = await res.json();
    const choice = json.choices?.[0] ?? {};
    const code = choice.text ?? '';
    const finishReason = choice.finish_reason ?? null;
    const tokens = json.usage?.total_tokens ?? 0;

    return {
      tokens,
      latency,
      response: { code, finishReason, raw: json },
      model: json.model ?? this.model,
    };
  }
}
