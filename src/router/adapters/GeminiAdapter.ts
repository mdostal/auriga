import { BaseDispatchAdapter, type AdapterConfig } from './BaseDispatchAdapter.ts';
import type { DispatchRequest, DispatchResponse } from './IDispatchAdapter.ts';

const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1/models';

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface GeminiAdapterConfig extends AdapterConfig {
  apiKey?: string;
  model?: string;
  maxOutputTokens?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Dispatch adapter for the Google Gemini API. Translates router requests
 * into Gemini `generateContent` calls and normalizes the response back to
 * the standard DispatchResponse shape.
 */
export class GeminiAdapter extends BaseDispatchAdapter {
  private apiKey: string;
  private model: string;
  private maxOutputTokens: number;
  private fetchImpl: typeof fetch;

  constructor(config: GeminiAdapterConfig = {}) {
    super(config);

    const apiKey = config.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new AuthenticationError('Invalid GOOGLE_API_KEY: no API key provided via config.apiKey or the GOOGLE_API_KEY environment variable');
    }

    this.apiKey = apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  protected async performDispatch(request: DispatchRequest): Promise<DispatchResponse> {
    const model = request.model || this.model;
    const prompt = this.buildPrompt(request);
    const start = Date.now();

    const httpResponse = await this.fetchImpl(
      `${GEMINI_API_BASE}/${model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: this.maxOutputTokens },
        }),
      }
    );

    if (httpResponse.status === 429) {
      throw new Error(`Gemini API rate limit exceeded (429) for model ${model}`);
    }

    if (!httpResponse.ok) {
      const body = await httpResponse.text().catch(() => '');
      throw new Error(`Gemini API request failed with status ${httpResponse.status}: ${body}`);
    }

    const latency = Date.now() - start;
    const payload = await httpResponse.json();

    return this.normalizeResponse(payload, model, latency);
  }

  private buildPrompt(request: DispatchRequest): string {
    return request.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
  }

  private normalizeResponse(payload: any, model: string, latency: number): DispatchResponse {
    const candidate = payload?.candidates?.[0];
    const blockReason = payload?.promptFeedback?.blockReason;

    if (!candidate || candidate.finishReason === 'SAFETY' || blockReason) {
      console.warn(`[GeminiAdapter] Response blocked by safety filter (model: ${model}, blockReason: ${blockReason ?? candidate?.finishReason ?? 'unknown'})`);
      return {
        tokens: payload?.usageMetadata?.totalTokenCount ?? 0,
        latency,
        response: { text: '', blocked: true, safetyRatings: candidate?.safetyRatings ?? payload?.promptFeedback?.safetyRatings ?? [] },
        model,
      };
    }

    const content = candidate.content?.parts?.map((part: any) => part.text).join('') ?? '';

    return {
      tokens: payload?.usageMetadata?.totalTokenCount ?? 0,
      latency,
      response: {
        text: content,
        safetyRatings: candidate.safetyRatings ?? [],
        finishReason: candidate.finishReason,
      },
      model,
    };
  }

  override async healthCheck(): Promise<boolean> {
    try {
      const httpResponse = await this.fetchImpl(`${GEMINI_API_BASE}/${this.model}?key=${this.apiKey}`, { method: 'GET' });
      return httpResponse.ok;
    } catch {
      return false;
    }
  }
}
