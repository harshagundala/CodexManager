#!/usr/bin/env node
// validate_targets.js — ground-truth check that goals are ACTUALLY running (producing
// tokens), not just showing a green status. Samples tokens_used + rollout file size
// twice, ~SAMPLE_MS apart, and reports growth per thread.
//
// Usage: node tools/validate_targets.js [sampleMs] <threadId> [threadId ...]
//   - sampleMs: optional integer (default 25000)
//   - threadId: one or more Codex thread UUIDs to check
// Thread ids are passed as args (not hardcoded) so no private context lives in the repo.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const GOALS = path.join(HOME, '.codex', 'goals_1.sqlite');
const STATE = path.join(HOME, '.codex', 'state_5.sqlite');
const AUTH = path.join(HOME, '.codex', 'auth.json');

let SAMPLE_MS = 25000;
const TARGETS = [];
for (const a of process.argv.slice(2)) {
  if (/^\d+$/.test(a)) SAMPLE_MS = Number(a);
  else if (/^[a-fA-F0-9-]{8,64}$/.test(a)) TARGETS.push({ id: a, name: a.slice(0, 8) });
}
if (TARGETS.length === 0) {
  console.error('usage: node tools/validate_targets.js [sampleMs] <threadId> [threadId ...]');
  process.exit(2);
}

function sql(db, q) {
  try { return JSON.parse(execFileSync('sqlite3', ['-json', db, q], { encoding: 'utf8' }).trim() || '[]'); }
  catch { return []; }
}
function snap(id) {
  const g = sql(GOALS, `SELECT status,tokens_used FROM thread_goals WHERE thread_id='${id}';`)[0] || {};
  const t = sql(STATE, `SELECT tokens_used,rollout_path FROM threads WHERE id='${id}';`)[0] || {};
  let size = -1; try { size = fs.statSync(t.rollout_path).size; } catch {}
  return { status: g.status, gTokens: g.tokens_used, sTokens: t.tokens_used, rollout: t.rollout_path, size };
}
function activeAccount() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
    const c = require(path.join(__dirname, '..', 'lib', 'codex'));
    const info = c.extractAccountInfo(a);
    return info ? info.email : 'unknown';
  } catch { return 'unknown'; }
}

(async () => {
  const acct = activeAccount();
  const before = {}; for (const t of TARGETS) before[t.id] = snap(t.id);
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  const out = { activeAccount: acct, sampleMs: SAMPLE_MS, threads: [], allRunning: true };
  for (const t of TARGETS) {
    const b = before[t.id], a = snap(t.id);
    const tokenGrew = (a.sTokens || 0) > (b.sTokens || 0) || (a.gTokens || 0) > (b.gTokens || 0);
    const rolloutGrew = a.size > b.size;
    const running = tokenGrew || rolloutGrew;
    if (!running) out.allRunning = false;
    out.threads.push({
      name: t.name, id: t.id, status: a.status,
      tokensDelta: (a.sTokens || 0) - (b.sTokens || 0),
      rolloutDelta: a.size - b.size, running,
    });
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.allRunning ? 0 : 1);
})();
