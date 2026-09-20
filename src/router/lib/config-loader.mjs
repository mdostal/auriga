// Reads an optional JSON config file from the path given in AURIGA_CONFIG.
// Returns the parsed object (may be partial — callers apply per-key fallbacks).
// Exits non-zero with a clear message on unreadable or malformed input so a
// mis-scoped instance never silently falls back to the full default project list.
import fs from 'node:fs';

export function loadExternalConfig(envPath = process.env.AURIGA_CONFIG) {
  if (!envPath) return {};

  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    process.stderr.write(`[auriga] AURIGA_CONFIG=${envPath} is unreadable: ${e.message}\n`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[auriga] AURIGA_CONFIG=${envPath} is malformed JSON: ${e.message}\n`);
    process.exit(1);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? 'array' : typeof parsed;
    process.stderr.write(`[auriga] AURIGA_CONFIG=${envPath} must be a JSON object, got ${got}\n`);
    process.exit(1);
  }

  return parsed;
}
