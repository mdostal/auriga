import { BaseDispatchAdapter, type AdapterConfig } from './BaseDispatchAdapter.ts';
import type { DispatchMessage, DispatchRequest, DispatchResponse } from './IDispatchAdapter.ts';

const DEFAULT_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

type FetchLike = (input: string, init: Record<string, any>) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<any>;
  text?(): Promise<string>;
}>;

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface ClaudeAdapterConfig extends AdapterConfig {
  apiKey?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  messagesUrl?: string;
  anthropicVersion?: string;
  maxTokens?: number;
}

export interface ClaudeDispatchResponse extends DispatchResponse {
  completion: string;
  inputTokens: number;
  outputTokens: number;
}

export class ClaudeAdapter extends BaseDispatchAdapter {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly messagesUrl: string;
  private readonly anthropicVersion: string;
  private readonly defaultMaxTokens: number;

  constructor(config: ClaudeAdapterConfig = {}) {
    super(config);

    const env = config.env ?? process.env;
    const apiKey = config.apiKey ?? env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      throw new AuthenticationError(
        'Missing Anthropic API key. Set ANTHROPIC_API_KEY or pass apiKey when creating ClaudeAdapter.'
      );
    }

    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('ClaudeAdapter requires a fetch implementation.');
    }

    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl as FetchLike;
    this.messagesUrl = config.messagesUrl ?? DEFAULT_MESSAGES_URL;
    this.anthropicVersion = config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
    this.defaultMaxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  protected async performDispatch(request: DispatchRequest): Promise<ClaudeDispatchResponse> {
    const start = Date.now();
    const response = await this.fetchImpl(this.messagesUrl, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(request)),
    });
    const latency = Date.now() - start;

    const payload = await readPayload(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError(
          `Anthropic authentication failed (${response.status}). Check ANTHROPIC_API_KEY and retry.`
        );
      }
      throw new Error(`Anthropic Messages API failed (${response.status}): ${errorMessage(payload, response.statusText)}`);
    }

    const inputTokens = Number(payload?.usage?.input_tokens ?? 0);
    const outputTokens = Number(payload?.usage?.output_tokens ?? 0);
    const completion = extractCompletion(payload);

    return {
      model: payload?.model ?? request.model,
      tokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      latency,
      completion,
      response: {
        completion,
        raw: payload,
      },
    };
  }

  private buildBody(request: DispatchRequest): Record<string, any> {
    const body: Record<string, any> = {
      model: request.model,
      max_tokens: Number(request.maxTokens ?? request.max_tokens ?? this.defaultMaxTokens),
      messages: normalizeMessages(request),
    };

    for (const key of ['system', 'temperature', 'top_p', 'top_k', 'stop_sequences']) {
      if (request[key] !== undefined) body[key] = request[key];
    }

    return body;
  }
}

function normalizeMessages(request: DispatchRequest): DispatchMessage[] {
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return request.messages;
  }

  if (typeof request.prompt === 'string' && request.prompt.length > 0) {
    return [{ role: 'user', content: request.prompt }];
  }

  throw new Error('ClaudeAdapter dispatch requires messages or prompt.');
}

async function readPayload(response: Awaited<ReturnType<FetchLike>>): Promise<any> {
  if (response.text) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  }

  try {
    return await response.json();
  } catch {
    return {};
  }
}

function extractCompletion(payload: any): string {
  const content = payload?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('');
}

function errorMessage(payload: any, fallback = 'request failed'): string {
  if (typeof payload?.error?.message === 'string') return payload.error.message;
  if (typeof payload?.message === 'string') return payload.message;
  if (typeof payload?.error === 'string') return payload.error;
  return fallback;
}
