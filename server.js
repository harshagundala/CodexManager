// server.js — Codex Account Hot Swapper daemon.
//
// Records authenticated Codex accounts and hot-swaps the active one before rate
// limits are hit. Two mechanisms:
//   * File-swap (default): rewrite ~/.codex/auth.json + reliably reload the app
//     (see lib/reload.js). Works with the Codex desktop app today.
//   * Proxy (opt-in/experimental): a local load balancer that rotates accounts
//     per-request with no restarts (see proxy.js). Off unless enabled in settings.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');

const codex = require('./lib/codex');
const reload = require('./lib/reload');
const { getAppServer } = require('./lib/appserver');

// Version string we report to the app-server in the `initialize` handshake.
const APPSERVER_CLIENT_VERSION = '0.1.0';

const {
  AUTH_PATH,
  REGISTRY_PATH,
  SETTINGS_PATH,
  CODEX_DIR,
  readJson,
  writeJsonAtomic,
  extractAccountInfo,
  sameAccount,
  refreshTokens,
  fetchUsage,
  maxUsedPercent,
} = codex;

const PORT = Number(process.env.SWAPPER_PORT) || 19000;

if (!fs.existsSync(CODEX_DIR)) fs.mkdirSync(CODEX_DIR, { recursive: true });
const DISABLED_THREADS_PATH = path.join(CODEX_DIR, 'disabled_threads.json');
let clients = [];

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  autoSwap: true,
  swapThreshold: 90, // swap the active account once its worst window hits this %
  reloadMode: 'soft', // 'new-sessions' | 'soft' | 'relaunch'
  refreshExpiryWindowMin: 15, // refresh stored tokens expiring within this many minutes
  proxyEnabled: false,
  proxyPort: 2455,
};

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) };
}
function saveSettings(partial) {
  const merged = { ...getSettings(), ...partial };
  writeJsonAtomic(SETTINGS_PATH, merged);
  return merged;
}

// --------------------------------------------------------------------------
// One-time backup of the existing session
// --------------------------------------------------------------------------

(function ensureBackup() {
  const backupPath = `${AUTH_PATH}.backup_swapper`;
  if (fs.existsSync(AUTH_PATH) && !fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(AUTH_PATH, backupPath);
      console.log(`[backup] saved initial session to ${backupPath}`);
    } catch (e) {
      console.error('[backup] failed:', e.message);
    }
  }
})();

// --------------------------------------------------------------------------
// SQLite Thread/Goal helpers
// --------------------------------------------------------------------------

function readThreadNames() {
  const sessionIndexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  const namesMap = {};
  if (!fs.existsSync(sessionIndexPath)) {
    return namesMap;
  }
  try {
    const content = fs.readFileSync(sessionIndexPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.id && obj.thread_name) {
          namesMap[obj.id] = obj.thread_name;
        }
      } catch (e) {
        // ignore malformed line
      }
    }
  } catch (err) {
    console.error('[server] failed to read session_index.jsonl:', err.message);
  }
  return namesMap;
}

function getActiveGoals() {
  return new Promise((resolve) => {
    const goalsDb = path.join(os.homedir(), '.codex', 'goals_1.sqlite');
    const stateDb = path.join(os.homedir(), '.codex', 'state_5.sqlite');
    if (!fs.existsSync(goalsDb) || !fs.existsSync(stateDb)) {
      return resolve([]);
    }
    const cmd = `sqlite3 -json "${goalsDb}" "ATTACH '${stateDb}' AS state; SELECT tg.thread_id, t.title, tg.status, t.cwd FROM thread_goals tg JOIN state.threads t ON tg.thread_id = t.id WHERE tg.status != 'complete';"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err || !stdout) return resolve([]);
      try {
        const goals = JSON.parse(stdout.trim());
        const disabledThreads = readJson(DISABLED_THREADS_PATH, []);
        const threadNames = readThreadNames();
        const annotated = goals.map(g => {
          const project = g.cwd ? path.basename(g.cwd) : 'General';
          const title = threadNames[g.thread_id] || g.title;
          return {
            thread_id: g.thread_id,
            title: title,
            status: g.status,
            project: project,
            disabled: disabledThreads.includes(g.thread_id)
          };
        });
        resolve(annotated);
      } catch (e) {
        console.error('[server] failed to parse goals JSON:', e.message);
        resolve([]);
      }
    });
  });
}

// Thread IDs of goals the app parked because the account ran out of quota/budget,
// excluding any the user has disabled. These are the goals safe to auto-resume: the
// desktop app will not restart them itself, so resuming them can't race the app for a
// background thread. We do NOT touch 'paused' (user paused) or 'blocked' (needs input).
function getResumableThreadIds() {
  return new Promise((resolve) => {
    const goalsDb = path.join(os.homedir(), '.codex', 'goals_1.sqlite');
    if (!fs.existsSync(goalsDb)) return resolve([]);
    const cmd = `sqlite3 -json "${goalsDb}" "SELECT thread_id FROM thread_goals WHERE status IN ('usage_limited','budget_limited');"`;
    exec(cmd, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      try {
        const rows = JSON.parse(stdout.trim());
        const disabled = new Set(readJson(DISABLED_THREADS_PATH, []));
        resolve(rows.map(r => r.thread_id).filter(id => !disabled.has(id)));
      } catch (e) {
        resolve([]);
      }
    });
  });
}

// Every goal that a swap would interrupt and must be resumed afterward: anything
// actively running OR parked for quota/budget. A *preemptive* swap (at the % threshold)
// interrupts goals while they're still 'active' — if we only resumed usage_limited ones
// they'd be stranded (running in the now-killed app-server, never resumed). We exclude
// 'paused' (user paused), 'blocked' (needs user input), 'complete', and disabled threads.
function getActiveAndLimitedThreadIds() {
  return new Promise((resolve) => {
    const goalsDb = path.join(os.homedir(), '.codex', 'goals_1.sqlite');
    if (!fs.existsSync(goalsDb)) return resolve([]);
    const cmd = `sqlite3 -json "${goalsDb}" "SELECT thread_id FROM thread_goals WHERE status IN ('active','usage_limited','budget_limited');"`;
    exec(cmd, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      try {
        const rows = JSON.parse(stdout.trim());
        const disabled = new Set(readJson(DISABLED_THREADS_PATH, []));
        resolve(rows.map(r => r.thread_id).filter(id => !disabled.has(id)));
      } catch (e) {
        resolve([]);
      }
    });
  });
}

// mtimes (ms) of session rollout files touched in the last ~2 min — i.e. threads/sub-
// agents that have produced output recently. Used to detect when everything is quiescent.
function recentRolloutMtimes() {
  try {
    const dir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(dir)) return [];
    const out = execSync(`find "${dir}" -name '*.jsonl' -mmin -2 2>/dev/null`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return out.trim().split('\n').filter(Boolean).map((p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } });
  } catch (e) {
    return [];
  }
}

// Wait until NO rollout (any thread or sub-agent) has been written for `quietMs`, or until
// `maxMs` elapses. This is the cross-cutting guard so the swap's relaunch pkill doesn't
// land in the middle of an in-flight turn (goal OR sub-agent) and lose its uncommitted work.
function waitForQuiescence({ maxMs = 45000, quietMs = 3500 } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    const tick = () => {
      const now = Date.now();
      const mtimes = recentRolloutMtimes();
      const mostRecent = mtimes.length ? Math.max(...mtimes) : 0;
      if (now - mostRecent >= quietMs) return resolve({ quiet: true, waitedMs: maxMs - (deadline - now) });
      if (now >= deadline) return resolve({ quiet: false, waitedMs: maxMs });
      setTimeout(tick, 1000);
    };
    tick();
  });
}

// Drain before a disruptive (relaunch/soft) reload: gracefully pause the goals we drive
// so their CURRENT turns finish + commit, then wait for global quiescence (covers sub-
// agents and desktop-run goals we can't pause by RPC). After this, the relaunch pkill
// only ever lands between turns, so resume continues exactly where it left off with no
// lost/redone turn. Best-effort for continuously-busy sub-agents (bounded by maxMs).
async function drainBeforeSwap() {
  try {
    await appServer().pauseManaged();
  } catch (e) {
    console.error('[drain] pauseManaged error:', e.message);
  }
  const r = await waitForQuiescence({ maxMs: 45000, quietMs: 3500 });
  console.log(`[drain] quiescence before swap: ${r.quiet ? 'reached' : 'TIMEOUT (some turn may still be in-flight)'} after ~${Math.round(r.waitedMs / 1000)}s`);
  return r;
}

// Thread ids are Codex UUIDs (hex + hyphens). Validate before ever interpolating one
// into a sqlite3 shell command, so a malformed/tampered id can't inject shell or SQL.
function isValidThreadId(id) {
  return typeof id === 'string' && /^[a-fA-F0-9-]{8,64}$/.test(id);
}

// Current goal status for a thread, or null if it has no goal row.
function getGoalStatus(threadId) {
  return new Promise((resolve) => {
    if (!isValidThreadId(threadId)) return resolve(null);
    const goalsDb = path.join(os.homedir(), '.codex', 'goals_1.sqlite');
    if (!fs.existsSync(goalsDb)) return resolve(null);
    const cmd = `sqlite3 -json "${goalsDb}" "SELECT status FROM thread_goals WHERE thread_id = '${threadId}' LIMIT 1;"`;
    exec(cmd, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const rows = JSON.parse(stdout.trim());
        resolve(rows[0] ? rows[0].status : null);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// rollout_path + cwd for a thread, used to populate thread/resume params. Pulled from
// state_5.sqlite (the desktop app's own thread store).
function getThreadMeta(threadId) {
  return new Promise((resolve) => {
    if (!isValidThreadId(threadId)) return resolve(null);
    const stateDb = path.join(os.homedir(), '.codex', 'state_5.sqlite');
    if (!fs.existsSync(stateDb)) return resolve(null);
    const cmd = `sqlite3 -json "${stateDb}" "SELECT rollout_path, cwd FROM threads WHERE id = '${threadId}' LIMIT 1;"`;
    exec(cmd, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const rows = JSON.parse(stdout.trim());
        if (rows[0]) return resolve({ rolloutPath: rows[0].rollout_path, cwd: rows[0].cwd });
      } catch (e) {
        /* fall through */
      }
      resolve(null);
    });
  });
}

function appServer() {
  return getAppServer({
    binary: resolveCodexBinary(),
    version: APPSERVER_CLIENT_VERSION,
    getThreadMeta,
  });
}

// Resume + activate a batch of threads through a codex app-server WE control. The
// app-server reads ~/.codex/auth.json at startup, so we (re)spawn it under `authInfo`
// (the account currently in auth.json) first — that's what makes resumed turns run on
// the right, in-quota account instead of failing with AuthorizationRequired.
async function resumeThreadsViaAppServer(threadIds, { authInfo } = {}) {
  if (!threadIds || threadIds.length === 0) return [];
  const as = appServer();
  let info = authInfo;
  if (!info) {
    const a = readJson(AUTH_PATH, null);
    info = a ? extractAccountInfo(a) : null;
  }
  try {
    await as.ensureFreshFor(info);
  } catch (e) {
    console.error('[resume] could not start app-server:', e.message);
    return [];
  }
  const results = await as.resumeMany(threadIds);
  const ok = results.filter(r => r.ok).length;
  console.log(`[resume] app-server now running ${ok}/${threadIds.length} goal(s): ${threadIds.join(', ')}`);
  return results;
}

// On daemon startup, re-attach to goals we were driving before a restart (the app-server
// dies with the daemon, so its turns stopped). Drops threads that are gone, complete, or
// user-disabled.
async function reattachManagedGoals() {
  const as = appServer();
  if (as.listManaged().length === 0) return;
  const activeAuth = readJson(AUTH_PATH, null);
  const activeInfo = activeAuth ? extractAccountInfo(activeAuth) : null;
  try {
    await as.ensureFreshFor(activeInfo);
  } catch (e) {
    console.error('[resume] could not start app-server for reattach:', e.message);
    return;
  }
  await as.reattachPersisted(async (threadId) => {
    const disabled = readJson(DISABLED_THREADS_PATH, []);
    if (disabled.includes(threadId)) return false;
    const status = await getGoalStatus(threadId);
    return status && status !== 'complete';
  });
}


// --------------------------------------------------------------------------
// Registry helpers
// --------------------------------------------------------------------------

function findNicknameForInfo(registry, info) {
  if (!info) return null;
  for (const nick of Object.keys(registry)) {
    if (sameAccount(registry[nick], info)) return nick;
  }
  return null;
}

function uniqueNickname(registry, base) {
  let candidate = base || 'account';
  let n = 1;
  while (registry[candidate]) candidate = `${base}-${n++}`;
  return candidate;
}

// Refresh a stored account's tokens, persist to registry + auth.json (if active),
// and return {ok, account, error, fatal}. Never throws.
async function refreshStoredAccount(nickname) {
  const registry = readJson(REGISTRY_PATH, {});
  const account = registry[nickname];
  if (!account || !account.authData) return { ok: false, error: 'account not found' };

  try {
    const updatedAuth = await refreshTokens(account.authData);
    const info = extractAccountInfo(updatedAuth);
    registry[nickname] = {
      ...account,
      email: info.email,
      name: info.name,
      plan: info.plan,
      account_id: info.account_id,
      user_id: info.user_id,
      exp: info.exp,
      authData: updatedAuth,
      refresh_error: null,
    };
    writeJsonAtomic(REGISTRY_PATH, registry);

    // If this is the active session, push the refreshed token back to auth.json.
    const activeAuth = readJson(AUTH_PATH, null);
    const activeInfo = activeAuth ? extractAccountInfo(activeAuth) : null;
    if (activeInfo && sameAccount(activeInfo, info)) {
      writeJsonAtomic(AUTH_PATH, updatedAuth);
    }
    console.log(`[refresh] refreshed "${nickname}" (${info.email})`);
    return { ok: true, account: registry[nickname] };
  } catch (e) {
    if (e.fatal) {
      registry[nickname] = { ...account, refresh_error: e.code || 'fatal' };
      writeJsonAtomic(REGISTRY_PATH, registry);
      console.error(`[refresh] FATAL for "${nickname}": ${e.message} (account needs re-login)`);
    } else {
      console.error(`[refresh] failed for "${nickname}": ${e.message}`);
    }
    return { ok: false, error: e.message, fatal: !!e.fatal };
  }
}

// Fetch + cache usage for a stored account. Mutates `account.usage`. Never throws.
async function cacheUsage(nickname, account) {
  if (!account || !account.authData) return null;
  try {
    const payload = await fetchUsage(account.authData);
    account.usage = { ...payload, last_updated: new Date().toISOString() };
    return account.usage;
  } catch (e) {
    console.error(`[usage] "${nickname}": ${e.message}`);
    return null;
  }
}

// --------------------------------------------------------------------------
// The swap itself
// --------------------------------------------------------------------------

async function swapTo(nickname, { reloadMode } = {}) {
  const settings = getSettings();
  let registry = readJson(REGISTRY_PATH, {});
  let account = registry[nickname];
  if (!account || !account.authData) throw new Error('account not found in registry');

  // CRITICAL: snapshot the currently-active account's freshest tokens into the
  // vault BEFORE we overwrite auth.json. The live Codex app rotates its refresh
  // token roughly hourly; if our vaulted copy is older, swapping back to that
  // account later would use a stale token and fail. Capturing it here keeps the
  // account we're leaving usable for a future swap-back.
  const currentAuth = readJson(AUTH_PATH, null);
  const currentInfo = currentAuth ? extractAccountInfo(currentAuth) : null;
  if (currentInfo) {
    const curNick = findNicknameForInfo(registry, currentInfo);
    if (curNick && curNick !== nickname) {
      registry[curNick].authData = currentAuth;
      registry[curNick].exp = currentInfo.exp;
      registry[curNick].plan = currentInfo.plan;
      writeJsonAtomic(REGISTRY_PATH, registry);
      console.log(`[swap] snapshotted freshest tokens for "${curNick}" before leaving it`);
    }
  }

  // Make sure we don't swap onto a stale/expired access token.
  const soonMs = (settings.refreshExpiryWindowMin || 15) * 60 * 1000;
  if (account.exp && account.exp - Date.now() < soonMs && account.authData.tokens?.refresh_token) {
    const r = await refreshStoredAccount(nickname);
    if (r.ok) {
      registry = readJson(REGISTRY_PATH, {});
      account = registry[nickname];
    }
  }

  // Snapshot EVERY goal this swap will interrupt (active + quota/budget-paused) BEFORE
  // we touch anything, so we can resume them all on the incoming account. Capturing
  // 'active' too prevents stranding goals when this is a preemptive swap.
  const threadsToResume = await getActiveAndLimitedThreadIds();

  // DRAIN: pause the goals we drive so their current turns commit, then wait for global
  // quiescence (sub-agents included) — so the relaunch pkill below never interrupts an
  // in-flight turn. This is what makes resume continue EXACTLY where it left off with
  // zero redone turns.
  await drainBeforeSwap();

  if (!writeJsonAtomic(AUTH_PATH, account.authData)) {
    throw new Error('failed to write ~/.codex/auth.json');
  }

  const mode = reloadMode || settings.reloadMode || 'soft';
  let reloadResult = 'auth.json written';
  try {
    reloadResult = await reload.performSwapReload(mode, { force: true });
  } catch (e) {
    reloadResult = `auth.json written; reload error: ${e.message}`;
  }
  console.log(`[swap] -> "${nickname}" (${account.email}) [${mode}]: ${reloadResult}`);

  // Resume every interrupted goal on the NEW account via an app-server we control. This
  // re-activates each goal (authentically, via thread/goal/set) and starts it running
  // again from its last committed turn — no green-but-idle goals, no stranded goals.
  if (threadsToResume.length > 0) {
    const info = extractAccountInfo(account.authData);
    resumeThreadsViaAppServer(threadsToResume, { authInfo: info })
      .catch((e) => console.error('[swap] resume error:', e.message));
  }

  return { nickname, email: account.email, reload: reloadResult, mode };
}

// --------------------------------------------------------------------------
// Auto-swap: preemptively move off an account that's about to be limited
// --------------------------------------------------------------------------

function isEligible(account, threshold) {
  if (!account || !account.authData) return false;
  if (account.refresh_error) return false;
  return maxUsedPercent(account.usage) < threshold;
}

async function checkAndPerformAutoSwap() {
  const settings = getSettings();
  // Always run checkAndPerformAutoSwap unless autoSwap is explicitly disabled.
  if (settings.autoSwap === false) return;

  const activeAuth = readJson(AUTH_PATH, null);
  const activeInfo = activeAuth ? extractAccountInfo(activeAuth) : null;
  if (!activeInfo) return;

  const registry = readJson(REGISTRY_PATH, {});
  const activeNickname = findNicknameForInfo(registry, activeInfo);
  if (!activeNickname) return;

  const activeAccount = registry[activeNickname];
  const activeUsed = maxUsedPercent(activeAccount.usage);
  const activeLimited = activeAccount.usage?.rate_limit?.limit_reached || activeUsed >= settings.swapThreshold;

  if (!activeLimited) {
    // The active account has quota. If it has goals the app parked for quota/budget,
    // resume them in place (no swap needed) — the app-server already holds this
    // account's auth, so we just resume + activate.
    const threadsToResume = await getResumableThreadIds();
    if (threadsToResume.length > 0) {
      console.log(`[auto-swap] Active account "${activeNickname}" has quota; resuming ${threadsToResume.length} paused goal(s) without swapping.`);
      resumeThreadsViaAppServer(threadsToResume, { authInfo: activeInfo })
        .catch((e) => console.error('[auto-swap] resume error:', e.message));
    }
    return;
  }

  console.log(`[auto-swap] Active account "${activeNickname}" is rate-limited (${activeUsed}% used, limit_reached: ${!!activeAccount.usage?.rate_limit?.limit_reached})`);

  // Pick the eligible replacement with the most headroom (lowest used %).
  const candidates = Object.keys(registry)
    .filter((n) => n !== activeNickname)
    .map((n) => ({ nick: n, used: maxUsedPercent(registry[n].usage), acc: registry[n] }))
    .filter((c) => isEligible(c.acc, settings.swapThreshold))
    .sort((a, b) => a.used - b.used);

  if (!candidates.length) {
    console.log(`[auto-swap] Active account "${activeNickname}" is rate-limited but no other account has quota. Waiting for a reset...`);
    return;
  }

  const target = candidates[0];
  console.log(`[auto-swap] Auto-swapping active session -> "${target.nick}" (${target.used}%)`);
  try {
    // Use the configured reload mode (default 'soft'). We no longer force a full
    // relaunch: parked goals are resumed by the app-server we control, so the heavy
    // quit-and-relaunch (which also risks the desktop app re-running an open thread)
    // is unnecessary.
    await swapTo(target.nick);
  } catch (e) {
    console.error('[auto-swap] swap failed:', e.message);
  }
}

// --------------------------------------------------------------------------
// Background loop: sync active tokens back, refresh expiring stored tokens,
// poll usage, then evaluate auto-swap.
// --------------------------------------------------------------------------

async function backgroundTick() {
  const settings = getSettings();
  const activeAuth = readJson(AUTH_PATH, null);
  const activeInfo = activeAuth ? extractAccountInfo(activeAuth) : null;
  let registry = readJson(REGISTRY_PATH, {});
  let changed = false;

  // 1. Capture tokens the live app-server may have rotated into auth.json.
  if (activeInfo) {
    const nick = findNicknameForInfo(registry, activeInfo);
    if (nick) {
      const acc = registry[nick];
      if (!acc.authData || JSON.stringify(acc.authData.tokens) !== JSON.stringify(activeAuth.tokens)) {
        acc.authData = activeAuth;
        acc.plan = activeInfo.plan;
        acc.exp = activeInfo.exp;
        changed = true;
        console.log(`[sync] captured rotated tokens for active "${nick}"`);
      }
    }
  }

  // 2. Refresh stored (non-active) tokens that are expiring soon, so they are
  //    ready for an instant swap.
  const soonMs = (settings.refreshExpiryWindowMin || 15) * 60 * 1000;
  for (const nick of Object.keys(registry)) {
    const acc = registry[nick];
    const isActive = activeInfo && sameAccount(acc, activeInfo);
    if (isActive || acc.refresh_error) continue;
    if (acc.exp && acc.exp - Date.now() < soonMs && acc.authData?.tokens?.refresh_token) {
      await refreshStoredAccount(nick);
      registry = readJson(REGISTRY_PATH, {});
    }
  }

  // 3. Poll usage for everyone (skip accounts whose tokens are known-dead).
  for (const nick of Object.keys(registry)) {
    if (registry[nick].refresh_error) continue;
    const u = await cacheUsage(nick, registry[nick]);
    if (u) changed = true;
  }

  if (changed) writeJsonAtomic(REGISTRY_PATH, registry);

  // Evaluate auto-swap. This also resumes quota/budget-paused goals when the active
  // account has headroom, so a dedicated periodic "heal" pass is no longer needed:
  // the app-server keeps the goals it owns running and self-restarts if it dies.
  await checkAndPerformAutoSwap();
}

// SWAPPER_NO_BACKGROUND=1 disables the live polling/auto-swap loop (used for tests).
if (process.env.SWAPPER_NO_BACKGROUND !== '1') {
  setInterval(backgroundTick, 1 * 60 * 1000); // Check every 1 minute
  setTimeout(backgroundTick, 10 * 1000);
}

// --------------------------------------------------------------------------
// Proxy (opt-in) control
// --------------------------------------------------------------------------

let proxyInstance = null;
function getProxyStatus() {
  const settings = getSettings();
  return {
    enabled: !!settings.proxyEnabled,
    running: !!(proxyInstance && proxyInstance.running),
    port: settings.proxyPort,
    configSnippet: proxyConfigSnippet(settings.proxyPort),
  };
}
function proxyConfigSnippet(port) {
  return [
    '# Add to ~/.codex/config.toml, then set model_provider = "codex-swapper"',
    '[model_providers.codex-swapper]',
    'name = "openai"',
    `base_url = "http://127.0.0.1:${port}/backend-api/codex"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
  ].join('\n');
}
async function startProxy() {
  if (proxyInstance && proxyInstance.running) return getProxyStatus();
  const settings = getSettings();
  const { createProxy } = require('./proxy');
  proxyInstance = createProxy({ port: settings.proxyPort });
  await proxyInstance.start();
  saveSettings({ proxyEnabled: true });
  return getProxyStatus();
}
async function stopProxy() {
  if (proxyInstance) await proxyInstance.stop();
  saveSettings({ proxyEnabled: false });
  return getProxyStatus();
}

// --------------------------------------------------------------------------
// Safe credential capture — run the bundled `codex login` in an ISOLATED
// CODEX_HOME so a new account's OAuth session is minted independently. We never
// delete or overwrite the live ~/.codex/auth.json and never log out, so the
// currently active account's session is never terminated.
// --------------------------------------------------------------------------

const CAPTURE_TIMEOUT_MS = 3 * 60 * 1000;
const captures = new Map(); // id -> { status, tempHome, proc, error, account, log }

function resolveCodexBinary() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    '/Applications/Codex.app/Contents/Resources/codex',
    '/usr/local/bin/codex',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return 'codex'; // fall back to PATH
}

function cleanupCapture(rec) {
  try {
    if (rec._check) clearInterval(rec._check);
    if (rec._timeout) clearTimeout(rec._timeout);
  } catch (_) {}
  try {
    if (rec.proc && !rec.proc.killed) rec.proc.kill();
  } catch (_) {}
  try {
    if (rec.tempHome && fs.existsSync(rec.tempHome)) fs.rmSync(rec.tempHome, { recursive: true, force: true });
  } catch (_) {}
}

async function importCapturedAuth(rec) {
  // Claim synchronously so the file-watcher and the exit handler can't both import.
  if (rec.status !== 'pending') return;
  rec.status = 'importing';
  if (rec._check) {
    clearInterval(rec._check);
    rec._check = null;
  }
  const authPath = path.join(rec.tempHome, 'auth.json');
  try {
    const authData = readJson(authPath, null);
    const info = extractAccountInfo(authData);
    if (!info) throw new Error('captured auth.json is invalid or has no tokens');

    const registry = readJson(REGISTRY_PATH, {});
    // If this account is already vaulted, update it in place; else add it.
    let nick = findNicknameForInfo(registry, info);
    if (!nick) {
      const base = (info.email.split('@')[0] || 'account').replace(/[^a-zA-Z0-9-_]/g, '');
      nick = uniqueNickname(registry, base);
    }
    const acc = {
      nickname: nick,
      email: info.email,
      name: info.name,
      plan: info.plan,
      account_id: info.account_id,
      user_id: info.user_id,
      exp: info.exp,
      addedAt: registry[nick]?.addedAt || new Date().toISOString(),
      authData,
      refresh_error: null,
      source: 'capture',
    };
    await cacheUsage(nick, acc);
    registry[nick] = acc;
    writeJsonAtomic(REGISTRY_PATH, registry);

    rec.account = { nickname: nick, email: info.email, plan: info.plan };
    rec.status = 'completed';
    console.log(`[capture] imported account "${nick}" (${info.email}) — live session untouched`);
  } catch (e) {
    rec.error = e.message;
    rec.status = 'failed';
    console.error('[capture] import failed:', e.message);
  } finally {
    cleanupCapture(rec);
  }
}

function startCapture() {
  const id = 'cap_' + Date.now();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgr_login_'));
  const bin = resolveCodexBinary();
  const rec = { id, status: 'pending', tempHome, proc: null, error: null, account: null, log: '', startedAt: Date.now() };
  captures.set(id, rec);

  // spawn with an argument array (no shell) — safe from injection.
  const proc = spawn(bin, ['login'], {
    env: { ...process.env, CODEX_HOME: tempHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rec.proc = proc;
  proc.stdout.on('data', (d) => (rec.log += d.toString()));
  proc.stderr.on('data', (d) => (rec.log += d.toString()));
  proc.on('error', (e) => {
    if (rec.status === 'pending') {
      rec.status = 'failed';
      rec.error = `could not launch codex login: ${e.message}`;
      cleanupCapture(rec);
    }
  });

  const authPath = path.join(tempHome, 'auth.json');
  rec._timeout = setTimeout(() => {
    if (rec.status === 'pending') {
      rec.status = 'failed';
      rec.error = 'login timed out (no account captured)';
      cleanupCapture(rec);
    }
  }, CAPTURE_TIMEOUT_MS);
  rec._check = setInterval(() => {
    if (rec.status === 'pending' && fs.existsSync(authPath)) {
      clearInterval(rec._check);
      rec._check = null;
      importCapturedAuth(rec);
    }
  }, 1000);
  proc.on('exit', (code) => {
    // Give the file a beat to flush, then import or fail.
    setTimeout(() => {
      if (rec.status !== 'pending') return;
      if (fs.existsSync(authPath)) importCapturedAuth(rec);
      else {
        rec.status = 'failed';
        rec.error = code === 0 ? 'login finished but no credentials were written' : `codex login exited (code ${code})`;
        cleanupCapture(rec);
      }
    }, 600);
  });

  return id;
}

function captureStatus(id) {
  const rec = captures.get(id);
  if (!rec) return { error: 'unknown capture id' };
  return { id, status: rec.status, account: rec.account, error: rec.error };
}

function cancelCapture(id) {
  const rec = captures.get(id);
  if (!rec) return { error: 'unknown capture id' };
  if (rec.status === 'pending') {
    rec.status = 'cancelled';
    cleanupCapture(rec);
  }
  return { id, status: rec.status };
}

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve(null);
      }
    });
  });
}

const STATIC = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/client.js': ['client.js', 'application/javascript'],
};

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const pathname = req.url.split('?')[0];
  console.log(`${method} ${req.url}`);

  // Static assets
  if (method === 'GET' && STATIC[pathname]) {
    const [file, type] = STATIC[pathname];
    const fp = path.join(__dirname, file);
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': type });
      fs.createReadStream(fp).pipe(res);
    } else {
      res.writeHead(404).end('Not Found');
    }
    return;
  }

  try {
    // GET /api/status/events — SSE client connection
    if (method === 'GET' && pathname === '/api/status/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('data: connected\n\n');
      clients.push(res);
      req.on('close', () => {
        clients = clients.filter(c => c !== res);
      });
      return;
    }

    // GET /api/status — active account + full registry (auto-registers the active one)
    if (method === 'GET' && pathname === '/api/status') {
      const activeAuth = readJson(AUTH_PATH, null);
      const activeInfo = activeAuth ? extractAccountInfo(activeAuth) : null;
      const registry = readJson(REGISTRY_PATH, {});
      let changed = false;

      if (activeInfo) {
        const nick = findNicknameForInfo(registry, activeInfo);
        if (nick) {
          const acc = registry[nick];
          if (!acc.authData || JSON.stringify(acc.authData.tokens) !== JSON.stringify(activeAuth.tokens)) {
            acc.authData = activeAuth;
            acc.plan = activeInfo.plan;
            acc.exp = activeInfo.exp;
            changed = true;
          }
        } else {
          const base = (activeInfo.email.split('@')[0] || 'account').replace(/[^a-zA-Z0-9-_]/g, '');
          const target = uniqueNickname(registry, base);
          const acc = {
            nickname: target,
            email: activeInfo.email,
            name: activeInfo.name,
            plan: activeInfo.plan,
            account_id: activeInfo.account_id,
            user_id: activeInfo.user_id,
            exp: activeInfo.exp,
            addedAt: new Date().toISOString(),
            authData: activeAuth,
          };
          await cacheUsage(target, acc);
          registry[target] = acc;
          changed = true;
          console.log(`[auto-register] "${target}"`);
        }
      }
      if (changed) writeJsonAtomic(REGISTRY_PATH, registry);
      const goals = await getActiveGoals();
      return sendJson(res, 200, { active: activeInfo, registry, goals });
    }

    // GET /api/settings
    if (method === 'GET' && pathname === '/api/settings') {
      return sendJson(res, 200, getSettings());
    }
    // POST /api/settings
    if (method === 'POST' && pathname === '/api/settings') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'invalid body' });
      const allowed = ['autoSwap', 'swapThreshold', 'reloadMode', 'refreshExpiryWindowMin', 'proxyPort'];
      const patch = {};
      for (const k of allowed) if (k in body) patch[k] = body[k];
      return sendJson(res, 200, saveSettings(patch));
    }

    // Proxy control
    if (method === 'GET' && pathname === '/api/proxy/status') {
      return sendJson(res, 200, getProxyStatus());
    }
    if (method === 'POST' && pathname === '/api/proxy/start') {
      try {
        return sendJson(res, 200, await startProxy());
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (method === 'POST' && pathname === '/api/proxy/stop') {
      return sendJson(res, 200, await stopProxy());
    }

    // Safe credential capture (isolated `codex login` — no logout, no auth.json touch)
    if (method === 'POST' && pathname === '/api/capture/start') {
      const bin = resolveCodexBinary();
      if (bin === 'codex' && !fs.existsSync('/Applications/Codex.app/Contents/Resources/codex')) {
        // best-effort note; spawn will surface a real error if codex is missing
      }
      const id = startCapture();
      return sendJson(res, 200, { id, status: 'pending' });
    }
    if (method === 'GET' && pathname === '/api/capture/status') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      return sendJson(res, 200, captureStatus(id));
    }
    if (method === 'POST' && pathname === '/api/capture/cancel') {
      const body = await readBody(req);
      return sendJson(res, 200, cancelCapture(body && body.id));
    }

    // POST /api/goals/toggle-disable {thread_id}
    if (method === 'POST' && pathname === '/api/goals/toggle-disable') {
      const body = await readBody(req);
      if (!body || !body.thread_id) return sendJson(res, 400, { error: 'thread_id required' });
      const thread_id = String(body.thread_id).trim();
      let disabled = readJson(DISABLED_THREADS_PATH, []);
      if (disabled.includes(thread_id)) {
        disabled = disabled.filter(id => id !== thread_id);
      } else {
        disabled.push(thread_id);
      }
      if (!writeJsonAtomic(DISABLED_THREADS_PATH, disabled)) {
        return sendJson(res, 500, { error: 'failed to write disabled threads config' });
      }
      return sendJson(res, 200, { success: true, disabled });
    }

    // POST /api/goals/force-resume {thread_ids?} — resume + run specific threads (or
    // all quota/budget-paused ones) on the currently-active account, via the app-server.
    if (method === 'POST' && pathname === '/api/goals/force-resume') {
      const body = (await readBody(req)) || {};
      let ids = Array.isArray(body.thread_ids) ? body.thread_ids.filter(isValidThreadId) : null;
      if (!ids || ids.length === 0) ids = await getResumableThreadIds();
      const results = await resumeThreadsViaAppServer(ids);
      return sendJson(res, 200, { success: true, requested: ids, results });
    }

    // GET /api/appserver/status — what the app-server is currently driving.
    if (method === 'GET' && pathname === '/api/appserver/status') {
      const as = appServer();
      return sendJson(res, 200, { initialized: !!as.initialized, alive: !!as.child, managed: as.listManaged() });
    }

    // POST /api/register {nickname}
    if (method === 'POST' && pathname === '/api/register') {
      const body = await readBody(req);
      if (!body || !body.nickname) return sendJson(res, 400, { error: 'nickname required' });
      const nickname = String(body.nickname).trim();
      const authData = readJson(AUTH_PATH, null);
      if (!authData) return sendJson(res, 404, { error: 'no active session in ~/.codex/auth.json' });
      const info = extractAccountInfo(authData);
      if (!info) return sendJson(res, 400, { error: 'active session has no valid tokens' });

      const registry = readJson(REGISTRY_PATH, {});
      const acc = {
        nickname,
        email: info.email,
        name: info.name,
        plan: info.plan,
        account_id: info.account_id,
        user_id: info.user_id,
        exp: info.exp,
        addedAt: new Date().toISOString(),
        authData,
      };
      await cacheUsage(nickname, acc);
      registry[nickname] = acc;
      if (!writeJsonAtomic(REGISTRY_PATH, registry)) return sendJson(res, 500, { error: 'failed to write registry' });
      return sendJson(res, 200, { success: true, account: registry[nickname] });
    }

    // POST /api/swap {nickname, reloadMode?}
    if (method === 'POST' && pathname === '/api/swap') {
      const body = await readBody(req);
      if (!body || !body.nickname) return sendJson(res, 400, { error: 'nickname required' });
      try {
        const result = await swapTo(String(body.nickname), { reloadMode: body.reloadMode });
        return sendJson(res, 200, { success: true, ...result });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // POST /api/clear-active — soft logout to add a new account
    if (method === 'POST' && pathname === '/api/clear-active') {
      try {
        if (fs.existsSync(AUTH_PATH)) fs.unlinkSync(AUTH_PATH);
        console.log('[clear-active] removed auth.json; relaunching Codex');
      } catch (e) {
        return sendJson(res, 500, { error: 'failed to clear active session' });
      }
      await reload.relaunchApp();
      return sendJson(res, 200, { success: true });
    }

    // POST /api/refresh {nickname}
    if (method === 'POST' && pathname === '/api/refresh') {
      const body = await readBody(req);
      if (!body || !body.nickname) return sendJson(res, 400, { error: 'nickname required' });
      const r = await refreshStoredAccount(String(body.nickname));
      if (!r.ok) return sendJson(res, 500, { error: r.error, fatal: r.fatal });
      const registry = readJson(REGISTRY_PATH, {});
      await cacheUsage(body.nickname, registry[body.nickname]);
      writeJsonAtomic(REGISTRY_PATH, registry);
      return sendJson(res, 200, { success: true, account: registry[body.nickname] });
    }

    // POST /api/refresh-all — sync active session and recheck limits for all accounts
    if (method === 'POST' && pathname === '/api/refresh-all') {
      let registry = readJson(REGISTRY_PATH, {});
      let changed = false;

      // Sync active session if present
      const activeAuth = readJson(AUTH_PATH, null);
      const activeInfo = activeAuth ? extractAccountInfo(activeAuth) : null;
      if (activeInfo) {
        const nick = findNicknameForInfo(registry, activeInfo);
        if (nick) {
          const acc = registry[nick];
          if (!acc.authData || JSON.stringify(acc.authData.tokens) !== JSON.stringify(activeAuth.tokens)) {
            acc.authData = activeAuth;
            acc.plan = activeInfo.plan;
            acc.exp = activeInfo.exp;
            changed = true;
          }
        }
      }

      // Recheck limits for all accounts
      for (const nick of Object.keys(registry)) {
        if (registry[nick].refresh_error) continue;
        const u = await cacheUsage(nick, registry[nick]);
        if (u) changed = true;
      }

      if (changed) writeJsonAtomic(REGISTRY_PATH, registry);
      await checkAndPerformAutoSwap();
      return sendJson(res, 200, { success: true });
    }

    // POST /api/update-usage {nickname}
    if (method === 'POST' && pathname === '/api/update-usage') {
      const body = await readBody(req);
      if (!body || !body.nickname) return sendJson(res, 400, { error: 'nickname required' });
      const registry = readJson(REGISTRY_PATH, {});
      const acc = registry[body.nickname];
      if (!acc) return sendJson(res, 404, { error: 'account not found' });
      const usage = await cacheUsage(body.nickname, acc);
      if (!usage) return sendJson(res, 500, { error: 'failed to fetch usage' });
      writeJsonAtomic(REGISTRY_PATH, registry);
      return sendJson(res, 200, { success: true, usage, account: acc });
    }

    // POST /api/sync — register/refresh the active session into the registry
    if (method === 'POST' && pathname === '/api/sync') {
      const authData = readJson(AUTH_PATH, null);
      if (!authData) return sendJson(res, 404, { error: 'no active session' });
      const info = extractAccountInfo(authData);
      if (!info) return sendJson(res, 400, { error: 'active session has no valid tokens' });
      const registry = readJson(REGISTRY_PATH, {});
      let target = findNicknameForInfo(registry, info);
      if (!target) {
        const base = (info.email.split('@')[0] || 'account').replace(/[^a-zA-Z0-9-_]/g, '');
        target = uniqueNickname(registry, base);
      }
      const acc = {
        nickname: target,
        email: info.email,
        name: info.name,
        plan: info.plan,
        account_id: info.account_id,
        user_id: info.user_id,
        exp: info.exp,
        addedAt: registry[target]?.addedAt || new Date().toISOString(),
        authData,
      };
      await cacheUsage(target, acc);
      registry[target] = acc;
      if (!writeJsonAtomic(REGISTRY_PATH, registry)) return sendJson(res, 500, { error: 'failed to write registry' });
      return sendJson(res, 200, { success: true, nickname: target, account: registry[target] });
    }

    // POST /api/rename {oldNickname, newNickname}
    if (method === 'POST' && pathname === '/api/rename') {
      const body = await readBody(req);
      if (!body || !body.oldNickname || !body.newNickname) return sendJson(res, 400, { error: 'oldNickname and newNickname required' });
      const oldN = String(body.oldNickname).trim();
      const newN = String(body.newNickname).trim();
      if (!/^[a-zA-Z0-9-_ ]+$/.test(newN)) return sendJson(res, 400, { error: 'invalid nickname characters' });
      const registry = readJson(REGISTRY_PATH, {});
      if (!registry[oldN]) return sendJson(res, 404, { error: 'account not found' });
      if (registry[newN] && oldN !== newN) return sendJson(res, 400, { error: `"${newN}" already exists` });
      const acc = registry[oldN];
      acc.nickname = newN;
      if (oldN !== newN) {
        registry[newN] = acc;
        delete registry[oldN];
      }
      if (!writeJsonAtomic(REGISTRY_PATH, registry)) return sendJson(res, 500, { error: 'failed to write registry' });
      return sendJson(res, 200, { success: true, nickname: newN, account: registry[newN] });
    }

    // POST /api/delete {nickname}
    if (method === 'POST' && pathname === '/api/delete') {
      const body = await readBody(req);
      if (!body || !body.nickname) return sendJson(res, 400, { error: 'nickname required' });
      const registry = readJson(REGISTRY_PATH, {});
      if (!registry[body.nickname]) return sendJson(res, 404, { error: 'account not found' });
      delete registry[body.nickname];
      if (!writeJsonAtomic(REGISTRY_PATH, registry)) return sendJson(res, 500, { error: 'failed to write registry' });
      return sendJson(res, 200, { success: true });
    }
  } catch (e) {
    console.error('[server] unhandled error:', e);
    return sendJson(res, 500, { error: e.message });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

let debounceTimer = null;
function notifyClients() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log('[sse] pushing update to clients...');
    for (const client of clients) {
      client.write('data: update\n\n');
    }
  }, 100);
}

function startFileWatcher() {
  const codexDir = path.join(os.homedir(), '.codex');
  if (fs.existsSync(codexDir)) {
    try {
      fs.watch(codexDir, (eventType, filename) => {
        const targets = [
          'goals_1.sqlite',
          'goals_1.sqlite-wal',
          'session_index.jsonl',
          'disabled_threads.json',
          'auth_registry.json',
          'auth.json'
        ];
        if (targets.includes(filename)) {
          notifyClients();
        }
      });
      console.log('[watcher] Watching directory ~/.codex for changes');
    } catch (e) {
      console.error('[watcher] failed to watch directory ~/.codex:', e.message);
    }
  }
}

// Start the daemon only when run directly (so tests can require this module).
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Codex Account Hot Swapper running at http://localhost:${PORT}`);
    // Start file watcher for real-time dashboard events
    startFileWatcher();
    // Resume the proxy if it was left enabled.
    if (getSettings().proxyEnabled) {
      startProxy().catch((e) => console.error('[proxy] auto-start failed:', e.message));
    }
    // Re-attach to any goals we were driving before a restart (the app-server dies
    // with the daemon, so their turns stopped). Delay a few seconds to let things settle.
    setTimeout(() => {
      reattachManagedGoals().catch((e) => console.error('[resume] error in startup reattach:', e.message));
    }, 3000);
  });
}

module.exports = {
  checkAndPerformAutoSwap,
  swapTo,
  backgroundTick,
  getSettings,
  saveSettings,
  refreshStoredAccount,
};
