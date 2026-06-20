// Extract a readable recent-activity summary from a (huge) Codex rollout JSONL.
// Usage: node extract_thread.js <thread_id>
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const tid = process.argv[2];
const GOALS = os.homedir() + '/.codex/goals_1.sqlite';

function sql(db, q) { try { return JSON.parse(execFileSync('sqlite3', ['-json', db, q], { encoding: 'utf8' }).trim() || '[]'); } catch { return []; } }
const goal = sql(GOALS, `SELECT objective,status,tokens_used FROM thread_goals WHERE thread_id='${tid}';`)[0] || {};
const rf = execFileSync('bash', ['-lc', `ls -t ~/.codex/sessions/*/*/*/*${tid}*.jsonl 2>/dev/null | head -1`], { encoding: 'utf8' }).trim();

console.log('OBJECTIVE:', (goal.objective || '').slice(0, 1500));
console.log('GOAL STATUS:', goal.status, '| tokens_used:', goal.tokens_used);
console.log('ROLLOUT:', rf.split('/').pop());
console.log('='.repeat(70));

// read last ~2.5MB of bytes, parse complete JSON lines
const size = fs.statSync(rf).size;
const start = Math.max(0, size - 2_500_000);
const fd = fs.openSync(rf, 'r');
const buf = Buffer.alloc(size - start);
fs.readSync(fd, buf, 0, buf.length, start);
fs.closeSync(fd);
const lines = buf.toString('utf8').split('\n');
lines.shift(); // drop first (possibly partial) line

const asst = [], reasoning = [], calls = [];
for (const line of lines) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  const p = o.payload; if (!p) continue;
  const ts = (o.timestamp || '').slice(11, 19);
  if (p.type === 'message' && p.role === 'assistant') {
    let t = Array.isArray(p.content) ? p.content.map(x => x.text || '').join('') : (p.text || '');
    if (t.trim()) asst.push(ts + '  ' + t.replace(/\s+/g, ' ').trim().slice(0, 700));
  } else if (p.type === 'reasoning') {
    let t = '';
    if (Array.isArray(p.summary)) t = p.summary.map(x => x.text || x).join(' ');
    else if (Array.isArray(p.content)) t = p.content.map(x => x.text || '').join(' ');
    else t = p.text || '';
    if (t.trim()) reasoning.push(ts + '  ' + t.replace(/\s+/g, ' ').trim().slice(0, 450));
  } else if (p.type === 'function_call') {
    let a = p.arguments || ''; if (typeof a !== 'string') a = JSON.stringify(a);
    calls.push(ts + '  ' + (p.name || 'call') + ' ' + a.replace(/\s+/g, ' ').slice(0, 220));
  } else if (p.type && /shell|exec|local_shell|tool/.test(p.type) && p.action) {
    calls.push(ts + '  ' + p.type + ' ' + JSON.stringify(p.action).slice(0, 220));
  }
}
const tail = (arr, n) => arr.slice(-n).join('\n');
console.log('\n### RECENT REASONING (last 14) ###\n' + tail(reasoning, 14));
console.log('\n### RECENT ASSISTANT MESSAGES (last 18) ###\n' + tail(asst, 18));
console.log('\n### RECENT ACTIONS/COMMANDS (last 30) ###\n' + tail(calls, 30));
