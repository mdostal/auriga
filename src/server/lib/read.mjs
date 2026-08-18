// Pure read layer over .pHive/ state: epics, story YAMLs, post-run audit
// records, and recent git log. Plain functions, no classes (matches this
// codebase's convention everywhere else — see
// src/router/lib/adapters/multica/backlog.mjs). Every function here is
// SYNCHRONOUS (fs.*Sync, execFileSync) — matches this codebase's established
// synchronous-CLI-wrapper convention (cli-runner.mjs's makeRun()); no
// async/Promise machinery is introduced because nothing here is genuinely
// asynchronous (local file reads, a single git subprocess call).
//
// Read-only, permanently: this module exposes no write/mutate functions at
// all — v1 is display-only by explicit design decision (see
// .pHive/epics/p3-auriga-ui/docs/design-discussion.md §1/§3), not an
// oversight to "fix" later.
//
// Every per-file read (one epic.yaml, one story yaml, one audit yaml) is
// wrapped in its own try/catch: a single malformed or unreadable file is
// skipped (with a stderr log, matching backlog.mjs's
// `process.stderr.write(...failed: ...)` convention) and never aborts the
// rest of a listing. This is the story's explicit, non-negotiable acceptance
// criterion, not a nice-to-have.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib/ -> server/ -> src/ -> repo root
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const DEFAULT_PHIVE_ROOT = path.join(REPO_ROOT, '.pHive');

// ---------------------------------------------------------------------------
// Minimal hand-rolled YAML reader for the specific subset of YAML actually
// used by .pHive/epics/*/epic.yaml, stories/*.yaml, and audits/post-run/*.yaml
// (block mappings/sequences, sequences-of-mappings, flow arrays `[a, b]`,
// block literal scalars `|`, quoted/unquoted scalars, numbers/booleans/null).
// Not a general-purpose YAML implementation — this repo adds zero new runtime
// dependencies for this story, so there is no js-yaml/yaml package available,
// and none is needed for the shapes this story actually has to parse.
// ---------------------------------------------------------------------------

function splitKeyValue(content) {
  let inQuote = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === ':' && (i + 1 === content.length || content[i + 1] === ' ')) {
      return { key: content.slice(0, i).trim(), rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseScalarToken(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function splitFlowItems(s) {
  const items = [];
  let cur = '';
  let inQuote = null;
  for (const ch of s) {
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; cur += ch; continue; }
    if (ch === ',') { items.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') items.push(cur);
  return items.map((t) => t.trim());
}

function parseFlowValue(s) {
  const trimmed = s.trim();
  if (trimmed.startsWith('[')) {
    const inner = trimmed.slice(1, trimmed.lastIndexOf(']'));
    if (inner.trim() === '') return [];
    return splitFlowItems(inner).map(parseScalarToken);
  }
  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1, trimmed.lastIndexOf('}'));
    const obj = {};
    if (inner.trim() === '') return obj;
    for (const pair of splitFlowItems(inner)) {
      const idx = pair.indexOf(':');
      if (idx === -1) continue;
      obj[pair.slice(0, idx).trim()] = parseScalarToken(pair.slice(idx + 1).trim());
    }
    return obj;
  }
  return parseScalarToken(trimmed);
}

/**
 * Parse a subset of YAML (block mappings/sequences, flow arrays, block
 * literal scalars, quoted/unquoted scalars) sufficient for this repo's own
 * .pHive/ epic/story/audit YAML shapes. Throws on structurally nonsensical
 * input (e.g. tabs where indentation is expected produce garbage rather than
 * a clean error) is NOT guaranteed — callers must not rely on this throwing
 * for every malformed file; listEpics/getEpic/getStory additionally validate
 * the parsed shape has the required fields (id/title/name) before trusting
 * it, which is what actually catches "malformed" files in practice.
 * @param {string} text
 * @returns {any}
 */
export function parseYaml(text) {
  const rawLines = String(text).replace(/\r\n/g, '\n').split('\n');
  const lines = rawLines.map((l) => {
    const m = l.match(/^(\s*)(.*)$/);
    return { indent: m[1].length, content: m[2] };
  });

  let pos = 0;

  function isBlank(line) { return line.content.trim() === ''; }
  function isComment(line) { return line.content.trim().startsWith('#'); }
  function skipNoise() { while (pos < lines.length && (isBlank(lines[pos]) || isComment(lines[pos]))) pos++; }
  function peek() { skipNoise(); return pos < lines.length ? lines[pos] : null; }

  function parseBlockScalar(parentIndent, chomp) {
    const contentLines = [];
    let baseIndent = null;
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.content.trim() === '') { contentLines.push(''); pos++; continue; }
      if (line.indent <= parentIndent) break;
      if (baseIndent === null) baseIndent = line.indent;
      contentLines.push(' '.repeat(Math.max(0, line.indent - baseIndent)) + line.content);
      pos++;
    }
    while (contentLines.length && contentLines[contentLines.length - 1] === '') contentLines.pop();
    let result = contentLines.join('\n');
    if (chomp !== '-') result += '\n';
    return result;
  }

  function parseValueForKey(rest, keyIndent) {
    if (rest === '') {
      const next = peek();
      if (next && next.indent > keyIndent) return parseBlock(next.indent);
      return null;
    }
    if (rest === '|' || rest === '|-' || rest === '|+') {
      const chomp = rest.includes('-') ? '-' : rest.includes('+') ? '+' : '';
      return parseBlockScalar(keyIndent, chomp);
    }
    if (rest.startsWith('[') || rest.startsWith('{')) return parseFlowValue(rest);
    return parseScalarToken(rest);
  }

  function parseMapping(indent) {
    const obj = {};
    while (true) {
      const line = peek();
      if (!line || line.indent !== indent) break;
      if (line.content.startsWith('- ') || line.content.trim() === '-') break;
      const split = splitKeyValue(line.content);
      if (!split) { pos++; continue; }
      pos++;
      obj[split.key] = parseValueForKey(split.rest, indent);
    }
    return obj;
  }

  function parseSequence(indent) {
    const arr = [];
    while (true) {
      const line = peek();
      if (!line || line.indent !== indent) break;
      const trimmed = line.content;
      if (!(trimmed.startsWith('- ') || trimmed.trim() === '-')) break;
      const dashIndent = line.indent;
      const contentCol = dashIndent + 2;
      if (trimmed.trim() === '-') {
        pos++;
        const next = peek();
        arr.push(next && next.indent > dashIndent ? parseBlock(next.indent) : null);
        continue;
      }
      const rest = trimmed.slice(2);
      const kv = splitKeyValue(rest);
      if (kv) {
        // "- key: value" — rewrite this line as a mapping-continuation line
        // at contentCol so parseMapping's ordinary key:value loop can read
        // it (and the item's remaining keys on subsequent, more-indented
        // lines) without a separate code path.
        lines[pos] = { indent: contentCol, content: rest };
        arr.push(parseMapping(contentCol));
      } else if (rest.trim() === '') {
        pos++;
        const next = peek();
        arr.push(next && next.indent > dashIndent ? parseBlock(next.indent) : null);
      } else {
        pos++;
        arr.push(parseValueForKey(rest.trim(), dashIndent));
      }
    }
    return arr;
  }

  function parseBlock(indent) {
    const first = peek();
    if (!first) return null;
    if (first.content.startsWith('- ') || first.content.trim() === '-') return parseSequence(indent);
    return parseMapping(indent);
  }

  const first = peek();
  if (!first) return null;
  return parseBlock(first.indent);
}

// ---------------------------------------------------------------------------
// File loaders — each wraps fs.readFileSync + parseYaml + minimal required-
// field validation in a single throwable unit, so every call site can catch
// exactly one error and skip-with-a-log per file.
// ---------------------------------------------------------------------------

function readEpicYaml(epicDir) {
  const raw = fs.readFileSync(path.join(epicDir, 'epic.yaml'), 'utf8');
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.name) {
    throw new Error("epic.yaml missing required 'name' field");
  }
  return parsed;
}

function readStoryYaml(storyPath) {
  const raw = fs.readFileSync(storyPath, 'utf8');
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.title) {
    throw new Error("story yaml missing required 'id'/'title' field");
  }
  return parsed;
}

function listStoryFiles(epicDir) {
  try {
    return fs.readdirSync(path.join(epicDir, 'stories'))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => path.join(epicDir, 'stories', f));
  } catch (e) {
    return [];
  }
}

function deriveEpicStatus(storyStatuses) {
  if (storyStatuses.length === 0) return 'planning';
  if (storyStatuses.every((s) => s === 'done')) return 'done';
  if (storyStatuses.some((s) => s !== 'pending')) return 'in-progress';
  return 'pending';
}

/**
 * [{id, title, status, story_count, docs_path}] built from
 * .pHive/epics/*\/epic.yaml on disk. `status` is a rollup derived from each
 * epic's stories/*.yaml statuses (epic.yaml itself carries no status field —
 * see .pHive/epics/p3-auriga-ui/docs/horizontal-plan.md's "status per story
 * rollup" note): 'done' if every story is done, 'in-progress' if any story
 * has moved off 'pending', 'planning' if the epic has no story files at all,
 * else 'pending'.
 * @param {string} [root] .pHive root — overridable for tests
 * @returns {Array<{id:string,title:string,status:string,story_count:number,docs_path:string}>}
 */
export function listEpics(root = DEFAULT_PHIVE_ROOT) {
  const epicsDir = path.join(root, 'epics');
  let dirEntries = [];
  try {
    dirEntries = fs.readdirSync(epicsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    process.stderr.write(`listEpics: cannot read epics dir ${epicsDir}: ${e.message}\n`);
    return [];
  }

  const out = [];
  for (const dirName of dirEntries) {
    const epicDir = path.join(epicsDir, dirName);
    let epic;
    try {
      epic = readEpicYaml(epicDir);
    } catch (e) {
      process.stderr.write(`listEpics: skipping ${dirName}/epic.yaml: ${e.message}\n`);
      continue;
    }

    const storyFiles = listStoryFiles(epicDir);
    const statuses = [];
    for (const storyPath of storyFiles) {
      try {
        const story = readStoryYaml(storyPath);
        statuses.push(String(story.status || 'pending'));
      } catch (e) {
        process.stderr.write(`listEpics: skipping malformed story ${storyPath}: ${e.message}\n`);
      }
    }

    out.push({
      id: epic.name || dirName,
      title: epic.title || epic.name || dirName,
      status: deriveEpicStatus(statuses),
      story_count: storyFiles.length,
      docs_path: path.relative(REPO_ROOT, path.join(epicDir, 'docs')),
    });
  }
  return out;
}

/**
 * One epic's detail: stories[] (id, title, status, complexity, depends_on)
 * and a list of its docs. Returns null if the epic id doesn't exist or its
 * epic.yaml is malformed/unreadable (the caller — index.mjs — turns that
 * into a 404, never a 500).
 * @param {string} id
 * @param {string} [root]
 */
export function getEpic(id, root = DEFAULT_PHIVE_ROOT) {
  const epicDir = path.join(root, 'epics', id);
  let epic;
  try {
    epic = readEpicYaml(epicDir);
  } catch (e) {
    process.stderr.write(`getEpic(${id}): ${e.message}\n`);
    return null;
  }

  const stories = [];
  for (const storyPath of listStoryFiles(epicDir)) {
    try {
      const story = readStoryYaml(storyPath);
      stories.push({
        id: story.id,
        title: story.title,
        status: story.status || 'pending',
        complexity: story.complexity || null,
        depends_on: Array.isArray(story.depends_on) ? story.depends_on : [],
      });
    } catch (e) {
      process.stderr.write(`getEpic(${id}): skipping malformed story ${storyPath}: ${e.message}\n`);
    }
  }

  const docsDir = path.join(epicDir, 'docs');
  let docs = [];
  try {
    docs = fs.readdirSync(docsDir).filter((f) => !f.startsWith('.'));
  } catch (e) {
    docs = [];
  }

  return {
    id: epic.name || id,
    title: epic.title || epic.name || id,
    methodology: epic.methodology || null,
    stories,
    docs,
    docs_path: path.relative(REPO_ROOT, docsDir),
  };
}

/**
 * One story's full YAML content. Returns null if the epic/story id doesn't
 * exist or the story yaml is malformed/unreadable (caller turns that into a
 * 404, never a 500).
 * @param {string} epicId
 * @param {string} storyId
 * @param {string} [root]
 */
export function getStory(epicId, storyId, root = DEFAULT_PHIVE_ROOT) {
  const storyPath = path.join(root, 'epics', epicId, 'stories', `${storyId}.yaml`);
  try {
    return readStoryYaml(storyPath);
  } catch (e) {
    process.stderr.write(`getStory(${epicId}, ${storyId}): ${e.message}\n`);
    return null;
  }
}

// Recent git log entries, via execFileSync — matches the router's
// established synchronous-CLI-wrapper convention (cli-runner.mjs's
// makeRun()/backlog.mjs's run()), not a new async pattern. Degrades
// gracefully to [] on any failure (e.g. cwd isn't a git repo), same
// read-degrades convention as backlog.mjs's getIssueRuns/getIssuePullRequests.
function gitLog(cwd, limit = 30) {
  try {
    const out = execFileSync('git', [
      'log', '-n', String(limit),
      '--pretty=format:%H%x1f%ad%x1f%s',
      '--date=iso-strict',
    ], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!out.trim()) return [];
    return out.split('\n')
      .map((line) => {
        const [hash, date, subject] = line.split('\x1f');
        return { type: 'commit', hash, date, subject, time: Date.parse(date) || 0 };
      })
      .filter((c) => c.hash);
  } catch (e) {
    process.stderr.write(`gitLog failed: ${e.message}\n`);
    return [];
  }
}

/**
 * Recent git log entries merged with .pHive/audits/post-run/*.yaml records,
 * sorted by time (most recent first). One malformed audit-record file is
 * skipped (with a stderr log) rather than aborting the whole merge.
 * @param {string} [root] .pHive root — overridable for tests
 * @param {string} [cwd] git working directory — overridable for tests
 */
export function listActivity(root = DEFAULT_PHIVE_ROOT, cwd = REPO_ROOT) {
  const commits = gitLog(cwd);

  const auditDir = path.join(root, 'audits', 'post-run');
  let files = [];
  try {
    files = fs.readdirSync(auditDir).filter((f) => f.endsWith('.yaml'));
  } catch (e) {
    files = [];
  }

  const audits = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(auditDir, f), 'utf8');
      const parsed = parseYaml(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('empty or invalid audit record');
      audits.push({
        type: 'audit',
        file: f,
        ...parsed,
        time: Date.parse(parsed.timestamp) || 0,
      });
    } catch (e) {
      process.stderr.write(`listActivity: skipping malformed audit file ${f}: ${e.message}\n`);
    }
  }

  return [...commits, ...audits].sort((a, b) => (b.time || 0) - (a.time || 0));
}
