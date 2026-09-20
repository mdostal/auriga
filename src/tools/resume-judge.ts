#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  LEVEL_SCORE,
  MARKET_CLUSTERS,
  SKILL_TAXONOMY,
  type MarketClusterId,
  type SkillDefinition,
  type SkillLevel,
} from '../skills/taxonomy.ts';

export interface SkillSignal {
  skill: string;
  label: string;
  level: SkillLevel;
  evidence: string[];
}

export interface SkillGap {
  skill: string;
  label: string;
  required_level: Exclude<SkillLevel, 'none'>;
  current_level: SkillLevel;
  gap: number;
  recommendation: string;
  evidence: {
    resume: string[];
    job: string[];
  };
}

export interface PositioningOpportunity {
  skill: string;
  label: string;
  current_level: SkillLevel;
  opportunity: string;
  suggested_positioning: string;
}

export interface MarketClusterRecommendation {
  id: MarketClusterId;
  label: string;
  description: string;
  score: number;
  matched_skills: string[];
  missing_skills: string[];
  recommendation: string;
}

export interface IdealMarketProfile {
  strongest_clusters: string[];
  differentiators: string[];
  target_role_keywords: string[];
  setup_questions: string[];
}

export interface ResumeJudgeResult {
  summary: {
    fit_score: number;
    matched_required_skills: number;
    total_required_skills: number;
    strongest_market_cluster: string | null;
  };
  skill_gaps: SkillGap[];
  positioning_opportunities: PositioningOpportunity[];
  market_clusters: MarketClusterRecommendation[];
  ideal_market_profile: IdealMarketProfile;
}

interface TextSkillMatch {
  skill: SkillDefinition;
  level: SkillLevel;
  evidence: string[];
}

interface JudgeOptions {
  resumeText: string;
  jobDescriptionText: string;
  profileText?: string;
}

const SENIOR_SIGNALS = [
  'senior',
  'staff',
  'principal',
  'lead',
  'architect',
  'architecture',
  'strategy',
  'mentored',
  'owned',
  'scaled',
  'roadmap',
  'cross-functional',
];

const JUNIOR_SIGNALS = ['junior', 'associate', 'entry-level', 'intern'];
const MID_SIGNALS = ['built', 'implemented', 'delivered', 'managed', 'maintained', 'designed'];

export function judgeResume(options: JudgeOptions): ResumeJudgeResult {
  const resumeMatches = extractSkillMatches(options.resumeText);
  const jobMatches = extractSkillMatches(options.jobDescriptionText);
  const profileMatches = options.profileText ? extractSkillMatches(options.profileText) : [];
  const resumeById = toMatchMap([...resumeMatches, ...profileMatches]);
  const jobById = toMatchMap(jobMatches);

  const skillGaps = buildSkillGaps(resumeById, jobById);
  const opportunities = buildPositioningOpportunities(resumeById, jobById);
  const clusters = buildMarketClusters(resumeById);
  const idealProfile = buildIdealMarketProfile(resumeById, clusters);
  const totalRequired = jobMatches.length;
  const matchedRequired = jobMatches.filter((match) => LEVEL_SCORE[resumeById.get(match.skill.id)?.level ?? 'none'] > 0).length;
  const fitScore = totalRequired === 0
    ? 0
    : Math.round((skillGaps.reduce((sum, gap) => sum + Math.max(0, 3 - gap.gap), 0) / (totalRequired * 3)) * 100);

  return {
    summary: {
      fit_score: fitScore,
      matched_required_skills: matchedRequired,
      total_required_skills: totalRequired,
      strongest_market_cluster: clusters[0]?.label ?? null,
    },
    skill_gaps: skillGaps,
    positioning_opportunities: opportunities,
    market_clusters: clusters,
    ideal_market_profile: idealProfile,
  };
}

export function extractSkills(text: string): SkillSignal[] {
  return extractSkillMatches(text).map((match) => ({
    skill: match.skill.id,
    label: match.skill.label,
    level: match.level,
    evidence: match.evidence,
  }));
}

function extractSkillMatches(text: string): TextSkillMatch[] {
  const normalized = normalize(text);
  const sentences = splitSentences(text);
  const matches: TextSkillMatch[] = [];

  for (const skill of SKILL_TAXONOMY) {
    const evidence = collectEvidence(skill, normalized, sentences);
    if (evidence.length === 0) continue;
    matches.push({
      skill,
      level: inferLevel(evidence.join(' ')),
      evidence: evidence.slice(0, 3),
    });
  }

  return matches;
}

function collectEvidence(skill: SkillDefinition, normalized: string, sentences: string[]): string[] {
  const evidence = new Set<string>();
  for (const alias of skill.aliases) {
    const aliasPattern = new RegExp(`(^|[^a-z0-9+.#-])${escapeRegExp(alias.toLowerCase())}([^a-z0-9+.#-]|$)`, 'i');
    if (!aliasPattern.test(normalized)) continue;
    const sentence = sentences.find((candidate) => aliasPattern.test(candidate.toLowerCase()));
    evidence.add(cleanSnippet(sentence ?? alias));
  }
  return [...evidence];
}

function inferLevel(evidenceText: string): SkillLevel {
  const text = normalize(evidenceText);
  if (SENIOR_SIGNALS.some((signal) => text.includes(signal))) return 'senior';
  if (JUNIOR_SIGNALS.some((signal) => text.includes(signal))) return 'junior';
  if (MID_SIGNALS.some((signal) => text.includes(signal))) return 'mid';
  return 'mid';
}

function toMatchMap(matches: TextSkillMatch[]): Map<string, TextSkillMatch> {
  const byId = new Map<string, TextSkillMatch>();
  for (const match of matches) {
    const current = byId.get(match.skill.id);
    if (!current || LEVEL_SCORE[match.level] > LEVEL_SCORE[current.level]) {
      byId.set(match.skill.id, match);
      continue;
    }
    if (current && LEVEL_SCORE[match.level] === LEVEL_SCORE[current.level]) {
      byId.set(match.skill.id, {
        ...current,
        evidence: [...new Set([...current.evidence, ...match.evidence])].slice(0, 4),
      });
    }
  }
  return byId;
}

function buildSkillGaps(resumeById: Map<string, TextSkillMatch>, jobById: Map<string, TextSkillMatch>): SkillGap[] {
  const gaps: SkillGap[] = [];
  for (const [skillId, required] of jobById) {
    const current = resumeById.get(skillId);
    const currentLevel = current?.level ?? 'none';
    const requiredLevel = required.level === 'none' ? 'mid' : required.level;
    const gap = Math.max(0, LEVEL_SCORE[requiredLevel] - LEVEL_SCORE[currentLevel]);
    gaps.push({
      skill: skillId,
      label: required.skill.label,
      required_level: requiredLevel,
      current_level: currentLevel,
      gap,
      recommendation: buildGapRecommendation(required.skill, requiredLevel, currentLevel, gap),
      evidence: {
        resume: current?.evidence ?? [],
        job: required.evidence,
      },
    });
  }
  return gaps.sort((a, b) => b.gap - a.gap || a.label.localeCompare(b.label));
}

function buildGapRecommendation(skill: SkillDefinition, requiredLevel: SkillLevel, currentLevel: SkillLevel, gap: number): string {
  if (gap === 0) {
    return `Keep ${skill.label} visible with one concrete proof point tied to the job description.`;
  }
  if (currentLevel === 'none') {
    return `Add credible ${skill.label} evidence if it exists; otherwise treat this as a development gap before targeting ${requiredLevel} roles.`;
  }
  return `Raise ${skill.label} from ${currentLevel} to ${requiredLevel} positioning by adding scope, outcomes, and ownership evidence.`;
}

function buildPositioningOpportunities(
  resumeById: Map<string, TextSkillMatch>,
  jobById: Map<string, TextSkillMatch>,
): PositioningOpportunity[] {
  const opportunities: PositioningOpportunity[] = [];
  for (const [skillId, resumeMatch] of resumeById) {
    const required = jobById.get(skillId);
    const resumeScore = LEVEL_SCORE[resumeMatch.level];
    const requiredScore = LEVEL_SCORE[required?.level ?? 'none'];
    if (resumeScore < 2) continue;
    if (!required || resumeScore > requiredScore) {
      opportunities.push({
        skill: skillId,
        label: resumeMatch.skill.label,
        current_level: resumeMatch.level,
        opportunity: required
          ? 'Resume evidence appears stronger than the role explicitly asks for.'
          : 'Resume contains a marketable strength that the job description does not directly request.',
        suggested_positioning: `Use ${resumeMatch.skill.label} as a differentiator, with a concise result-oriented bullet rather than a keyword-only mention.`,
      });
    }
  }
  return opportunities
    .sort((a, b) => LEVEL_SCORE[b.current_level] - LEVEL_SCORE[a.current_level] || a.label.localeCompare(b.label))
    .slice(0, 8);
}

function buildMarketClusters(resumeById: Map<string, TextSkillMatch>): MarketClusterRecommendation[] {
  return MARKET_CLUSTERS.map((cluster) => {
    const matched = cluster.coreSkills.filter((skillId) => resumeById.has(skillId));
    const score = Math.round(
      (cluster.coreSkills.reduce((sum, skillId) => sum + LEVEL_SCORE[resumeById.get(skillId)?.level ?? 'none'], 0) /
        (cluster.coreSkills.length * 3)) *
        100,
    );
    const missing = cluster.coreSkills.filter((skillId) => !resumeById.has(skillId));
    return {
      id: cluster.id,
      label: cluster.label,
      description: cluster.description,
      score,
      matched_skills: matched,
      missing_skills: missing,
      recommendation: score >= 70
        ? `Strong market fit. Lead with ${cluster.label.toLowerCase()} language and quantified proof.`
        : score >= 45
          ? `Promising fit. Add proof for ${missing.slice(0, 2).join(', ') || 'adjacent missing skills'} to compete more cleanly.`
          : `Secondary market. Pursue selectively or strengthen ${missing.slice(0, 2).join(', ') || 'core skills'} first.`,
    };
  }).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function buildIdealMarketProfile(
  resumeById: Map<string, TextSkillMatch>,
  clusters: MarketClusterRecommendation[],
): IdealMarketProfile {
  const seniorStrengths = [...resumeById.values()]
    .filter((match) => LEVEL_SCORE[match.level] >= 2)
    .sort((a, b) => LEVEL_SCORE[b.level] - LEVEL_SCORE[a.level] || a.skill.label.localeCompare(b.skill.label))
    .slice(0, 6);
  return {
    strongest_clusters: clusters.slice(0, 3).map((cluster) => cluster.label),
    differentiators: seniorStrengths.map((match) => match.skill.label),
    target_role_keywords: [
      ...new Set(
        clusters.slice(0, 3).flatMap((cluster) => [
          cluster.label,
          ...cluster.matched_skills.map((skillId) => SKILL_TAXONOMY.find((skill) => skill.id === skillId)?.label ?? skillId),
        ]),
      ),
    ].slice(0, 12),
    setup_questions: [
      'Which proof points are strongest by measured outcome, not just responsibility?',
      'Which clusters match the work you want to repeat for the next two years?',
      'Which missing skills are real gaps versus wording gaps in the resume?',
      'What role titles consistently combine the top two strongest clusters?',
    ],
  };
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cleanSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

async function readTextArg(args: Record<string, string | boolean>, key: string, fallback = ''): Promise<string> {
  const value = args[key];
  if (typeof value !== 'string') return fallback;
  return readFile(value, 'utf8');
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.resume || !args.job) {
    const script = basename(process.argv[1] ?? 'resume-judge');
    console.error(`Usage: node ${script} --resume resume.md --job job.md [--profile APPLICATION-KIT.md]`);
    process.exit(args.help ? 0 : 1);
  }

  const result = judgeResume({
    resumeText: await readTextArg(args, 'resume'),
    jobDescriptionText: await readTextArg(args, 'job'),
    profileText: await readTextArg(args, 'profile'),
  });

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
