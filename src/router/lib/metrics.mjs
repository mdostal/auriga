// metrics.mjs

const hourlyMetrics = new Map();

/**
 * Emit a metric for a dispatch.
 */
export function emitMetric({ model, latency, tokens, cost, taskType = 'default', fallbackChain = [] }) {
  const now = new Date();
  const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}T${now.getUTCHours()}:00:00Z`;

  if (!hourlyMetrics.has(hourKey)) {
    hourlyMetrics.set(hourKey, {
      totalCost: 0,
      models: new Map()
    });
  }

  const hourData = hourlyMetrics.get(hourKey);
  hourData.totalCost += cost;
  
  if (!hourData.models.has(model)) {
    hourData.models.set(model, { cost: 0, tokens: 0, calls: 0, totalLatency: 0 });
  }

  const modelData = hourData.models.get(model);
  modelData.cost += cost;
  modelData.tokens += tokens;
  modelData.calls += 1;
  modelData.totalLatency += latency;

  // Log to stdout (JSON lines)
  console.log(JSON.stringify({
    timestamp: now.toISOString(),
    event: 'dispatch_metric',
    model,
    latency,
    tokens,
    cost,
    taskType,
    fallbackChain
  }));
}

/**
 * Query hourly total cost by model.
 */
export function queryMetrics(hourKey) {
  // If no hourKey provided, use current hour
  if (!hourKey) {
    const now = new Date();
    hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}T${now.getUTCHours()}:00:00Z`;
  }
  
  const hourData = hourlyMetrics.get(hourKey);
  if (!hourData) {
    return { totalCost: 0, models: {} };
  }

  const models = {};
  for (const [m, data] of hourData.models.entries()) {
    models[m] = {
      totalCost: data.cost,
      totalTokens: data.tokens,
      averageLatency: data.calls > 0 ? data.totalLatency / data.calls : 0,
      calls: data.calls
    };
  }

  return {
    totalCost: hourData.totalCost,
    models
  };
}

export function resetMetrics() {
  hourlyMetrics.clear();
}
