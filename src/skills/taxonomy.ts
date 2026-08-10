export type SkillLevel = 'none' | 'junior' | 'mid' | 'senior';

export type SkillCategory =
  | 'engineering_leadership'
  | 'backend_platform'
  | 'ai_automation'
  | 'data_systems'
  | 'frontend_product'
  | 'cloud_devops'
  | 'product_strategy'
  | 'communication';

export type MarketClusterId =
  | 'ai_automation_platforms'
  | 'technical_program_leadership'
  | 'backend_platform_engineering'
  | 'developer_tools'
  | 'data_workflow_systems'
  | 'product_engineering';

export interface SkillDefinition {
  id: string;
  label: string;
  category: SkillCategory;
  aliases: string[];
  marketClusters: MarketClusterId[];
}

export interface MarketClusterDefinition {
  id: MarketClusterId;
  label: string;
  description: string;
  coreSkills: string[];
}

export const LEVEL_SCORE: Record<SkillLevel, number> = {
  none: 0,
  junior: 1,
  mid: 2,
  senior: 3,
};

export const SKILL_TAXONOMY: SkillDefinition[] = [
  {
    id: 'technical_leadership',
    label: 'Technical leadership',
    category: 'engineering_leadership',
    aliases: ['technical leadership', 'tech lead', 'engineering leadership', 'staff engineer', 'principal engineer', 'architecture leadership'],
    marketClusters: ['technical_program_leadership', 'backend_platform_engineering', 'ai_automation_platforms'],
  },
  {
    id: 'systems_architecture',
    label: 'Systems architecture',
    category: 'backend_platform',
    aliases: ['systems architecture', 'system design', 'distributed systems', 'service architecture', 'architecture', 'scalability'],
    marketClusters: ['backend_platform_engineering', 'developer_tools', 'data_workflow_systems'],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    category: 'frontend_product',
    aliases: ['typescript', 'ts', 'node.js', 'nodejs', 'node'],
    marketClusters: ['product_engineering', 'developer_tools', 'ai_automation_platforms'],
  },
  {
    id: 'react_nextjs',
    label: 'React / Next.js',
    category: 'frontend_product',
    aliases: ['react', 'next.js', 'nextjs', 'frontend', 'front-end', 'ui engineering'],
    marketClusters: ['product_engineering', 'developer_tools'],
  },
  {
    id: 'python',
    label: 'Python',
    category: 'backend_platform',
    aliases: ['python', 'fastapi', 'django', 'flask'],
    marketClusters: ['backend_platform_engineering', 'ai_automation_platforms', 'data_workflow_systems'],
  },
  {
    id: 'ai_llm',
    label: 'AI / LLM systems',
    category: 'ai_automation',
    aliases: ['ai', 'llm', 'large language model', 'openai', 'rag', 'agent', 'agents', 'prompting', 'prompt engineering'],
    marketClusters: ['ai_automation_platforms', 'developer_tools', 'technical_program_leadership'],
  },
  {
    id: 'automation_orchestration',
    label: 'Automation / orchestration',
    category: 'ai_automation',
    aliases: ['automation', 'orchestration', 'workflow automation', 'scheduler', 'cron', 'agent routing', 'pipeline automation'],
    marketClusters: ['ai_automation_platforms', 'data_workflow_systems', 'developer_tools'],
  },
  {
    id: 'apis_integrations',
    label: 'APIs and integrations',
    category: 'backend_platform',
    aliases: ['api', 'apis', 'rest', 'graphql', 'integration', 'webhook', 'oauth'],
    marketClusters: ['backend_platform_engineering', 'developer_tools', 'product_engineering'],
  },
  {
    id: 'databases',
    label: 'Databases',
    category: 'data_systems',
    aliases: ['postgres', 'postgresql', 'sql', 'database', 'prisma', 'supabase', 'schema design'],
    marketClusters: ['backend_platform_engineering', 'data_workflow_systems', 'product_engineering'],
  },
  {
    id: 'cloud_infrastructure',
    label: 'Cloud infrastructure',
    category: 'cloud_devops',
    aliases: ['aws', 'gcp', 'azure', 'cloud', 'docker', 'kubernetes', 'terraform', 'ci/cd', 'deployment'],
    marketClusters: ['backend_platform_engineering', 'developer_tools', 'data_workflow_systems'],
  },
  {
    id: 'data_analysis',
    label: 'Data analysis',
    category: 'data_systems',
    aliases: ['analytics', 'data analysis', 'metrics', 'dashboard', 'reporting', 'experimentation', 'insights'],
    marketClusters: ['data_workflow_systems', 'product_engineering', 'technical_program_leadership'],
  },
  {
    id: 'product_strategy',
    label: 'Product strategy',
    category: 'product_strategy',
    aliases: ['product strategy', 'roadmap', 'customer discovery', 'go-to-market', 'market research', 'positioning', 'strategy'],
    marketClusters: ['technical_program_leadership', 'product_engineering', 'ai_automation_platforms'],
  },
  {
    id: 'stakeholder_communication',
    label: 'Stakeholder communication',
    category: 'communication',
    aliases: ['stakeholder', 'executive communication', 'cross-functional', 'requirements', 'documentation', 'presented', 'communication'],
    marketClusters: ['technical_program_leadership', 'product_engineering'],
  },
];

export const MARKET_CLUSTERS: MarketClusterDefinition[] = [
  {
    id: 'ai_automation_platforms',
    label: 'AI automation platforms',
    description: 'Roles building LLM-backed workflows, agent tooling, and automation systems.',
    coreSkills: ['ai_llm', 'automation_orchestration', 'typescript', 'python', 'technical_leadership'],
  },
  {
    id: 'technical_program_leadership',
    label: 'Technical program leadership',
    description: 'Hybrid technical leadership roles coordinating strategy, delivery, and cross-functional execution.',
    coreSkills: ['technical_leadership', 'product_strategy', 'stakeholder_communication', 'systems_architecture', 'data_analysis'],
  },
  {
    id: 'backend_platform_engineering',
    label: 'Backend platform engineering',
    description: 'Platform roles centered on services, scalability, APIs, databases, and cloud reliability.',
    coreSkills: ['systems_architecture', 'apis_integrations', 'databases', 'cloud_infrastructure', 'python', 'technical_leadership'],
  },
  {
    id: 'developer_tools',
    label: 'Developer tools',
    description: 'Tooling roles for engineering productivity, CI, automation, integrations, and internal platforms.',
    coreSkills: ['typescript', 'systems_architecture', 'automation_orchestration', 'apis_integrations', 'cloud_infrastructure'],
  },
  {
    id: 'data_workflow_systems',
    label: 'Data workflow systems',
    description: 'Roles designing data-heavy workflows, operational dashboards, reporting, and decision systems.',
    coreSkills: ['data_analysis', 'databases', 'automation_orchestration', 'python', 'systems_architecture'],
  },
  {
    id: 'product_engineering',
    label: 'Product engineering',
    description: 'Full-stack product roles that value user-facing delivery, strategy, analytics, and iteration speed.',
    coreSkills: ['react_nextjs', 'typescript', 'apis_integrations', 'product_strategy', 'data_analysis'],
  },
];

export const getSkillById = (id: string): SkillDefinition | undefined =>
  SKILL_TAXONOMY.find((skill) => skill.id === id);
