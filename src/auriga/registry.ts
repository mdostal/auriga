export interface ProjectRegistryEntry {
  name: string;
  workspacePath: string;
  /** GitHub slug (owner/repo) the agnostic build lanes must clone/push to for this project. */
  repoSlug: string;
}

export const PROJECT_REGISTRY: ProjectRegistryEntry[] = [
  { name: 'Consus', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/consus', repoSlug: 'mdostal/consus' },
  { name: 'Heimdall', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/heimdall', repoSlug: 'mdostal/heimdall' },
  { name: 'Pantheon Orchestrator', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/pantheon-orchestrator', repoSlug: 'mdostal/pantheon-orchestrator' },
  { name: 'Minerva', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/minerva', repoSlug: 'mdostal/minerva' },
  { name: 'Mnemosyne', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/mnemosyne', repoSlug: 'mdostal/mnemosyne' },
  { name: 'Votum', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/votum', repoSlug: 'mdostal/votum' },
  { name: 'Vulcan', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/vulcan', repoSlug: 'mdostal/vulcan' },
  { name: 'House Finder', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/house-finder', repoSlug: 'mdostal/house-finder' },
  { name: 'CADEX Legacy', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/cadex-legacy', repoSlug: 'mdostal/cadex-legacy' },
  { name: 'Cron Maker', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/cron-maker', repoSlug: 'mdostal/cron-maker' },
  { name: 'Logic Loops', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/logic-loops', repoSlug: 'mdostal/logic-loops' },
  { name: 'Gig Radar', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/gig-radar', repoSlug: 'mdostal/gig-radar' },
  { name: 'Auriga', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/auriga', repoSlug: 'mdostal/auriga' },
  { name: 'Money Lab', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/money-lab', repoSlug: 'mdostal/money-lab' },
  { name: 'Salus', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/salus', repoSlug: 'mdostal/salus' },
  { name: 'Cura', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/cura', repoSlug: 'mdostal/cura' },
  { name: 'Venatio', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/venatio', repoSlug: 'mdostal/venatio' },
  { name: 'Venator', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/venator', repoSlug: 'mdostal/venator' },
  { name: 'Janus', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/janus', repoSlug: 'mdostal/janus' },
  { name: 'Pantheon V2', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/pantheon-v2', repoSlug: 'mdostal/pantheon-v2' },
  { name: 'Claud-ometer', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/Claud-ometer', repoSlug: 'mdostal/Claud-ometer' },
  { name: 'Argus', workspacePath: '/Users/dostal/.minerva/runs/f46fc4e9-b06d-4a12-8261-e856afa6e656/workspace/argus', repoSlug: 'mdostal/argus' },
];
