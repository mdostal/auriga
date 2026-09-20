import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractSkills, judgeResume } from './resume-judge.ts';

const execFileAsync = promisify(execFile);

const resume = `
Senior engineer and technical lead who designed TypeScript and Node.js automation systems.
Built OpenAI agent routing workflows, APIs, Postgres schemas, dashboards, and stakeholder documentation.
Owned product strategy for internal developer tools and mentored cross-functional teams.
`;

const job = `
We need a senior AI platform engineer to lead LLM automation, TypeScript services, APIs, cloud deployments,
and data analysis for operational dashboards. React experience is helpful.
`;

test('extractSkills finds resume skill signals with inferred levels', () => {
  const skills = extractSkills(resume);
  const byId = Object.fromEntries(skills.map((skill) => [skill.skill, skill]));

  assert.equal(byId.ai_llm.level, 'mid');
  assert.equal(byId.typescript.level, 'senior');
  assert.equal(byId.databases.level, 'mid');
});

test('judgeResume surfaces skill gaps and matched proof', () => {
  const result = judgeResume({ resumeText: resume, jobDescriptionText: job });
  const bySkill = Object.fromEntries(result.skill_gaps.map((gap) => [gap.skill, gap]));

  assert.equal(bySkill.react_nextjs.current_level, 'none');
  assert.ok(bySkill.react_nextjs.gap > 0);
  assert.equal(bySkill.ai_llm.gap, 1);
  assert.ok(result.summary.fit_score > 50);
});

test('judgeResume identifies positioning opportunities and strongest markets', () => {
  const result = judgeResume({ resumeText: resume, jobDescriptionText: job });

  assert.ok(result.positioning_opportunities.some((opportunity) => opportunity.skill === 'product_strategy'));
  assert.equal(result.market_clusters[0].id, 'ai_automation_platforms');
  assert.ok(result.ideal_market_profile.strongest_clusters.includes('AI automation platforms'));
});

test('CLI emits dashboard-ready JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resume-judge-'));
  try {
    const resumePath = join(dir, 'resume.md');
    const jobPath = join(dir, 'job.md');
    await writeFile(resumePath, resume);
    await writeFile(jobPath, job);

    const { stdout } = await execFileAsync(process.execPath, ['src/tools/resume-judge.ts', '--resume', resumePath, '--job', jobPath]);
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.summary.strongest_market_cluster, 'AI automation platforms');
    assert.ok(Array.isArray(parsed.skill_gaps));
    assert.ok(Array.isArray(parsed.market_clusters));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
