import type { IDispatchAdapter, DispatchRequest, DispatchResponse } from './IDispatchAdapter.ts';
import { modelRegistry } from '../../auriga/model-registry.ts';
import { emitMetric } from '../lib/metrics.mjs';

export interface AdapterConfig {
  maxAttempts?: number;
  timeoutMs?: number;
  costWarningThreshold?: number;
  [key: string]: any;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export abstract class BaseDispatchAdapter implements IDispatchAdapter {
  protected config: AdapterConfig;

  constructor(config: AdapterConfig) {
    if (!config) {
      throw new Error("Invalid config: config object is required");
    }
    
    // Derived classes should perform more specific validation (e.g. checking for apiKey)
    this.config = {
      maxAttempts: 3,
      timeoutMs: 30000,
      ...config
    };
  }

  // Abstract method that subclasses must implement to perform the actual provider call
  protected abstract performDispatch(request: DispatchRequest): Promise<DispatchResponse>;

  async dispatch(request: DispatchRequest): Promise<DispatchResponse> {
    const maxAttempts = this.config.maxAttempts ?? 3;
    let lastErr: any;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this._dispatchWithTimeout(request);
        
        // Calculate cost if not provided by the specific adapter
        let cost = result.cost;
        if (cost === undefined) {
          const profile = modelRegistry.hasModel(result.model) ? modelRegistry.getModel(result.model) : null;
          // Approximate using inputPerToken since we don't have separate input/output token counts in DispatchResponse yet
          const perTokenPrice = profile ? profile.cost.inputPerToken : 0;
          cost = result.tokens * perTokenPrice;
        }

        result.cost = cost;

        // Check for threshold
        const threshold = this.config.costWarningThreshold ?? 0.5; // Default $0.50 warning threshold
        if (cost > threshold) {
          console.warn(`[BaseDispatchAdapter] WARNING: Dispatch cost ($${cost.toFixed(4)}) exceeds threshold ($${threshold}) for model ${result.model}`);
        }

        // Log telemetry
        console.log(`[BaseDispatchAdapter] Success - Model: ${result.model}, Latency: ${result.latency}ms, Tokens: ${result.tokens}, Cost: $${cost.toFixed(6)}`);
        
        emitMetric({
          model: result.model,
          latency: result.latency,
          tokens: result.tokens,
          cost: cost,
          taskType: request.taskType || 'default',
          fallbackChain: request.fallbackChain || []
        });

        return result;
      } catch (err: any) {
        lastErr = err;
        
        if (i === maxAttempts - 1) {
          throw err;
        }
        
        // Exponential backoff up to max attempts
        await sleep(Math.pow(2, i) * 1000);
      }
    }
    throw lastErr;
  }

  private async _dispatchWithTimeout(request: DispatchRequest): Promise<DispatchResponse> {
    const timeoutMs = this.config.timeoutMs ?? 30000;
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Network timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.performDispatch(request)
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  async healthCheck(): Promise<boolean> {
    return true; // Default implementation, subclasses can override
  }
}
