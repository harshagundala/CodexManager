// lib/reload.js
// Makes a freshly-written ~/.codex/auth.json actually take effect in the running
// Codex desktop app, with the least disruption possible.
//
// Why this is non-trivial: the desktop app drives the real `codex` CLI as one or
// more `codex app-server` subprocesses. Each one reads auth.json ONCE at startup
// and caches the tokens in memory, talking to Electron over an anonymous unix
// socketpair (no port we can inject into). So:
//   * A renderer reload (Cmd+R) alone does NOT change the account — the app-server
//     keeps the old token. (This is why the old version threw "hot swap" errors.)
//   * NEW conversations spawn a fresh `codex app-server --listen stdio://` that
//     reads the new auth.json — so a plain file rewrite already works for the next
//     conversation, with zero restart.
//   * The long-lived "primary" app-server (`--analytics-default-enabled`) owns the
//     account/rate-limit state shown in the UI. To move the *active* account we
//     bounce just that control-plane process and reload the renderer; Electron
//     re-establishes the connection and re-reads auth.json. We deliberately do NOT
//     kill per-conversation (`--listen stdio://`) servers that may be mid-turn.
//
// Reload modes (least -> most disruptive):
//   'new-sessions'  : rewrite auth.json only (caller already did). New convos pick it up.
//   'soft'          : new-sessions + bounce the primary app-server + renderer reload. (default)
//   'relaunch'      : full quit + relaunch of Codex.app. Most reliable, most disruptive.

const { exec } = require('child_process');

function sh(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// All running codex app-server processes, classified.
async function listAppServers() {
  const { stdout } = await sh(`ps -axo pid=,command= | grep "codex app-server" | grep -v grep`);
  if (!stdout) return [];
  return stdout
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) return null;
      const pid = Number(m[1]);
      const cmd = m[2];
      const perConversation = /--listen\s+stdio/.test(cmd);
      const primary = /--analytics-default-enabled/.test(cmd) || !perConversation;
      return { pid, cmd, primary, perConversation };
    })
    .filter(Boolean);
}

// Best-effort "is this process mid-turn?" heuristic: an app-server actively
// streaming a response holds ESTABLISHED https connections to OpenAI hosts.
async function isBusy(pid) {
  const { stdout } = await sh(`lsof -nP -p ${pid} 2>/dev/null | grep -i "TCP" | grep -i "ESTABLISHED"`);
  return !!stdout;
}

// Reload the renderer without stealing focus (View > Reload Browser Page),
// falling back to activating + Cmd+R.
async function reloadRenderer() {
  const menu = [
    'tell application "System Events" to tell process "Codex" to if exists (menu item "Reload Browser Page" of menu "View" of menu bar 1) then',
    'click menu item "Reload Browser Page" of menu "View" of menu bar 1',
    'return "clicked"',
    'else',
    'return "not_found"',
    'end if',
  ]
    .map((l) => `-e '${l}'`)
    .join(' ');
  const r = await sh(`osascript ${menu}`);
  if (!r.err && r.stdout === 'clicked') return 'menu';

  const fb = await sh(
    `osascript -e 'tell application "Codex" to activate' -e 'delay 0.4' -e 'tell application "System Events" to keystroke "r" using command down'`
  );
  return fb.err ? 'failed' : 'keystroke';
}

async function isCodexRunning() {
  const { stdout } = await sh(`pgrep -x Codex`);
  return !!stdout;
}

// Bounce only the control-plane app-server(s). Returns pids we signalled.
// Skips any app-server that looks busy unless force=true.
async function bouncePrimaryAppServer({ force = false } = {}) {
  const servers = await listAppServers();
  const targets = servers.filter((s) => s.primary);
  const killed = [];
  for (const s of targets) {
    if (!force && (await isBusy(s.pid))) {
      console.log(`[reload] primary app-server ${s.pid} looks busy — skipping bounce`);
      continue;
    }
    await sh(`kill ${s.pid}`);
    killed.push(s.pid);
  }
  return killed;
}

async function relaunchApp() {
  await sh(`pkill -x Codex ; pkill -f "codex app-server" ; pkill -f "node_repl"`);
  await new Promise((r) => setTimeout(r, 1200));
  const r = await sh(`open -a Codex`);
  return !r.err;
}

// Orchestrate a reload after auth.json has already been written.
// Returns a short human-readable description of what was done.
async function performSwapReload(mode = 'soft', { force = false } = {}) {
  const running = await isCodexRunning();
  if (!running) {
    return 'Codex not running — new auth will load on next launch';
  }

  if (mode === 'new-sessions') {
    return 'auth.json updated — next new conversation will use the new account';
  }

  if (mode === 'relaunch') {
    const ok = await relaunchApp();
    return ok ? 'relaunched Codex.app' : 'relaunch attempt failed';
  }

  // default: 'soft'
  const killed = await bouncePrimaryAppServer({ force });
  const how = await reloadRenderer();
  const parts = [];
  parts.push(killed.length ? `bounced primary app-server (${killed.join(', ')})` : 'no idle primary app-server to bounce');
  parts.push(`renderer reload: ${how}`);
  return parts.join('; ');
}

module.exports = {
  listAppServers,
  isBusy,
  reloadRenderer,
  isCodexRunning,
  bouncePrimaryAppServer,
  relaunchApp,
  performSwapReload,
};
