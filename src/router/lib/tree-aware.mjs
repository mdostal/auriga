// Tree-path agent matching for Auriga routing.

export function getIssueTreePath(issue) {
  const value = issue?.tree_path ?? issue?.treePath ?? issue?.metadata?.tree_path ?? issue?.metadata?.treePath;
  return normalizeTreePath(value);
}

export function normalizeTreePath(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts.join('/') : null;
}

export function treePathWithAncestors(treePath) {
  const normalized = normalizeTreePath(treePath);
  if (!normalized) return [];
  const parts = normalized.split('/');
  const paths = [];
  for (let i = parts.length; i > 0; i -= 1) paths.push(parts.slice(0, i).join('/'));
  return paths;
}

export function getEligibleAgentsByTreePath(issue, cfg) {
  const treePath = getIssueTreePath(issue);
  if (!treePath) return [];

  const attachments = cfg.TREE_AGENT_ATTACHMENTS || cfg.TREE_PATH_AGENT_ATTACHMENTS || {};
  const eligible = [];
  const seen = new Set();
  for (const path of treePathWithAncestors(treePath)) {
    for (const ref of attachedAgentRefs(attachments[path])) {
      const agent = resolveAgentName(ref, cfg.AGENTS);
      if (!agent || seen.has(agent)) continue;
      seen.add(agent);
      eligible.push(agent);
    }
  }
  return eligible;
}

function attachedAgentRefs(entry) {
  if (!entry) return [];
  if (Array.isArray(entry)) return entry;
  if (Array.isArray(entry.agents)) return entry.agents;
  if (Array.isArray(entry.attached?.agents)) return entry.attached.agents;
  return [];
}

function resolveAgentName(ref, agents) {
  if (typeof ref !== 'string') return null;
  if (agents[ref]) return ref;
  return Object.entries(agents).find(([, agent]) => agent.id === ref)?.[0] || null;
}
