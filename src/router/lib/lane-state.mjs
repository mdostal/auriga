// A fresh, bounded read each cycle; never cache a failed read as disabled lanes.
export async function readLaneState({ baseUrl = process.env.HEIMDALL_URL || 'http://heimdall:4870', fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/lanes`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`GET /lanes: HTTP ${res.status}`);
    const lanes = await res.json();
    if (!Array.isArray(lanes) || lanes.some((lane) => !lane || typeof lane.lane_id !== 'string')) {
      throw new Error('GET /lanes: expected array of lane records');
    }
    return { lanes, error: null };
  } catch (error) {
    return { lanes: [], error: error.message };
  }
}

// Map keys are configured agent names, values are exact Heimdall lane IDs.
// Unknown agents/lanes retain their existing eligibility, never guessed by name.
export function withLaneState(cfg, snapshot) {
  const lanes = new Map(snapshot.lanes.map((lane) => [lane.lane_id, lane]));
  const agents = Object.fromEntries(Object.entries(cfg.AGENTS).map(([name, agent]) => {
    const laneId = cfg.AGENT_LANES?.[name];
    const lane = lanes.get(laneId);
    const enabled = !lane || (typeof lane.effective_enabled === 'boolean'
      ? lane.effective_enabled : lane.status === 'up');
    const unavailable = !snapshot.error && !enabled;
    return [name, { ...agent, available: agent.available !== false && !agent.archived && !agent.archived_at && !unavailable,
      laneId: laneId ?? null,
      availabilityReason: unavailable ? `heimdall:${laneId}:${lane.reason || lane.status || 'disabled'}` : agent.availabilityReason }];
  }));
  return { ...cfg, AGENTS: agents, laneState: snapshot };
}
