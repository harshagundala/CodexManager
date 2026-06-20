// lib/appserver.js
// Persistent JSON-RPC client for the Codex desktop app-server, used to actually
// RESUME paused autonomous goals (not just flip a DB column).
//
// Why this exists
// ---------------
// A goal's `status` in ~/.codex/goals_1.sqlite is *downstream display state*, not a
// control input. The Codex app runs a goal entirely over the renderer<->app-server
// JSON-RPC layer: it `thread/resume`s the conversation, then `thread/goal/set`s the
// goal `active`, which kicks the next turn; each time the turn goes idle the client
// re-issues `thread/goal/set active` to continue (see the app's
// `maybeContinueActiveThreadGoal`). Nothing polls the DB. So writing `active`
// straight into SQLite turns the dashboard dot green but never makes the app run
// anything — the "green but idle" bug.
//
// This module reproduces the app's own resume path against a `codex app-server` that
// WE spawn. Because an app-server reads ~/.codex/auth.json once at startup, spawning
// it *after* CodexManager has written the target account's tokens gives it the right
// credentials — which is what fixes the old `AuthorizationRequired` failures.
//
// Lifetime: a resumed goal's turns execute *inside* the spawned app-server process.
// If that process dies, the work dies. So we keep ONE long-lived app-server alive and
// drive the continue-loop ourselves. The set of threads we're responsible for is
// persisted so a CodexManager restart can re-attach to them.
//
// No external dependencies — native node only.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const MANAGED_PATH = path.join(CODEX_DIR, 'cm_managed_threads.json');

// Goal statuses we will resume on the user's behalf. Deliberately NARROW: these are
// goals the app parked because the account ran out of quota/budget — the app will not
// restart them itself, so resuming them can't race the app for a background thread.
// We never auto-resume `paused` (user paused it) or `blocked` (needs user input).
const RESUMABLE_STATUSES = new Set(['usage_limited', 'budget_limited']);

// Statuses that mean "stop driving this goal": it finished, or it parked again
// (out of quota -> the swap loop will move it to another account and re-resume),
// or the user/agent moved it out of our lane.
const STOP_DRIVING_STATUSES = new Set([
  'complete',
  'usage_limited',
  'budget_limited',
  'paused',
  'blocked',
]);

const CONTINUE_DEBOUNCE_MS = 400; // mirror the app's ~250ms debounce, a touch looser
const REQUEST_TIMEOUT_MS = 60000;
const INIT_TIMEOUT_MS = 20000;
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000; // stop the app-server after this long with nothing to drive
const MAX_RESTART_BACKOFF_MS = 30000;

function normId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

class AppServerManager {
  // opts: { binary, version, logger, getThreadMeta }
  //   binary       - path to the codex CLI
  //   getThreadMeta - async (threadId) => { rolloutPath, cwd } | null  (optional)
  constructor(opts = {}) {
    this.binary = opts.binary || 'codex';
    this.version = opts.version || '0.0.1';
    this.log = opts.logger || console;
    this.getThreadMeta = opts.getThreadMeta || (async () => null);

    this.child = null;
    this.initialized = false;
    this.initPromise = null;
    this.spawnAuthKey = null; // identity of the account this app-server was spawned under

    this.pending = new Map(); // requestId -> { resolve, reject, timer }
    this.buf = '';

    // normId -> { id, goalStatus, continueTimer }
    this.managed = new Map();

    this.stopped = false;
    this.restartTimer = null;
    this.restartBackoff = 0;
    this.idleTimer = null;

    this._loadManaged();
  }

  // ---- public API ---------------------------------------------------------

  // Ensure the app-server is running under `authInfo` (so resumed goals use the
  // intended account). Restarts the process if it was spawned under a different
  // account — an app-server caches auth.json at startup. Pass the result of
  // codex.extractAccountInfo(auth.json).
  async ensureFreshFor(authInfo) {
    const key = authInfo ? `${authInfo.user_id}:${authInfo.account_id}` : null;
    if (this.child && this.initialized && this.spawnAuthKey && this.spawnAuthKey === key) {
      return;
    }
    if (this.child) {
      this.log.log(`[appserver] account changed (${this.spawnAuthKey} -> ${key}); restarting app-server`);
      await this._kill();
    }
    this.spawnAuthKey = key;
    await this.ensureReady();
  }

  // Resume one thread and set its goal active so the app-server starts running it.
  // Idempotent: a thread we're already driving is skipped. Returns {ok, error?}.
  async resumeAndActivate(threadId) {
    const key = normId(threadId);
    if (this.managed.has(key)) {
      // Already tracked — re-verify it's actually producing turns.
      this._scheduleKickCheck(key);
      return { ok: true, already: true };
    }
    try {
      await this.ensureReady();
      const meta = (await this.getThreadMeta(threadId)) || {};
      await this.request('thread/resume', {
        threadId,
        history: null,
        path: meta.rolloutPath || null,
        model: null,
        modelProvider: null,
        cwd: meta.cwd || null,
        approvalPolicy: null,
        sandbox: null,
        config: null,
        personality: null,
        excludeTurns: true,
        persistExtendedHistory: false,
      });
      // Mark managed BEFORE activating so the idle->continue handler will drive it.
      this._setManaged(key, threadId, 'active');
      const m = this.managed.get(key);
      if (m) { m.cwd = meta.cwd || null; m.resumeAt = Date.now(); }
      const r = await this.request('thread/goal/set', { threadId, status: 'active' });
      const status = (r && r.goal && r.goal.status) || 'active';
      this._setManaged(key, threadId, status);
      this.log.log(`[appserver] resumed + activated goal ${threadId} (status=${status})`);
      // Setting the goal active normally makes the server start a turn. If it does
      // NOT (the "green but idle" failure), fall back to an explicit turn/start with
      // a "continue" message — the user-sanctioned last resort.
      this._scheduleKickCheck(key);
      return { ok: true };
    } catch (e) {
      this._unmanage(key);
      this.log.error(`[appserver] resume failed for ${threadId}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // Explicitly start a turn (produces tokens). Used as the "continue" fallback when
  // goal/set active didn't kick a turn on its own.
  async startTurn(threadId, text, cwd) {
    return this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: text || 'continue', text_elements: [] }],
      cwd: cwd || null,
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      model: null,
      serviceTier: null,
      effort: null,
      summary: 'auto',
      personality: null,
      outputSchema: null,
      collaborationMode: null,
      attachments: [],
    });
  }

  // ~9s after a resume, if no turn/started has been observed for the thread, the goal
  // is "active but idle" — inject an explicit `continue` turn to get it running.
  _scheduleKickCheck(key) {
    const m = this.managed.get(key);
    if (!m) return;
    if (m.kickTimer) clearTimeout(m.kickTimer);
    const since = Date.now();
    m.kickTimer = setTimeout(async () => {
      m.kickTimer = null;
      const cur = this.managed.get(key);
      if (!cur) return;
      if ((cur.lastTurnAt || 0) >= since) return; // a turn already started — good
      this.log.log(`[appserver] goal ${cur.id} active but no turn started; injecting "continue"`);
      try {
        await this.startTurn(cur.id, 'continue', cur.cwd);
      } catch (e) {
        this.log.error(`[appserver] continue fallback failed for ${cur.id}: ${e.message}`);
      }
    }, 9000);
  }

  // Gracefully pause every goal we're driving (drain-before-swap). Setting a goal
  // `paused` lets its CURRENT turn finish and commit before the loop stops, so a
  // subsequent app-server kill (the swap's relaunch) can't lose an in-flight turn.
  // Returns the thread ids we paused. Never throws.
  async pauseManaged() {
    const entries = [...this.managed.values()];
    const ids = [];
    for (const m of entries) {
      // cancel any pending continue/kick so we don't re-kick a turn we're draining
      if (m.continueTimer) { clearTimeout(m.continueTimer); m.continueTimer = null; }
      if (m.kickTimer) { clearTimeout(m.kickTimer); m.kickTimer = null; }
      m.goalStatus = 'paused';
      ids.push(m.id);
      try {
        await this.request('thread/goal/set', { threadId: m.id, status: 'paused' });
      } catch (e) {
        this.log.error(`[appserver] drain-pause failed for ${m.id}: ${e.message}`);
      }
    }
    if (ids.length) this.log.log(`[appserver] drain-paused ${ids.length} managed goal(s): ${ids.join(', ')}`);
    return ids;
  }

  // Resume a batch; never throws. Returns [{threadId, ok, error?}].
  async resumeMany(threadIds) {
    const out = [];
    for (const id of threadIds || []) {
      out.push({ threadId: id, ...(await this.resumeAndActivate(id)) });
    }
    return out;
  }

  listManaged() {
    return Array.from(this.managed.values()).map((m) => ({ threadId: m.id, goalStatus: m.goalStatus }));
  }

  // Permanently stop the manager (process shutdown / disable). Leaves the persisted
  // managed set intact so a future start can re-attach unless `forget` is true.
  async stop({ forget = false } = {}) {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (forget) {
      this.managed.clear();
      this._persistManaged();
    }
    await this._kill();
  }

  // ---- process lifecycle --------------------------------------------------

  ensureReady() {
    if (this.initialized && this.child) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.stopped = false;
    this.initPromise = this._spawnAndInit().catch((e) => {
      this.initPromise = null;
      throw e;
    });
    return this.initPromise;
  }

  async _spawnAndInit() {
    this._spawn();
    await this._initialize();
    this.initialized = true;
    this.restartBackoff = 0;
    this.initPromise = null;
  }

  _spawn() {
    const child = spawn(this.binary, ['app-server', '--analytics-default-enabled'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child = child;
    this.buf = '';

    child.stdout.on('data', (d) => this._onStdout(d));
    child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) this.log.error(`[appserver:stderr] ${s.slice(0, 500)}`);
    });
    child.on('error', (e) => {
      this.log.error(`[appserver] spawn error: ${e.message}`);
    });
    child.on('exit', (code, sig) => this._onExit(code, sig));
    this.log.log(`[appserver] spawned codex app-server (pid ${child.pid})`);
  }

  _initialize() {
    return new Promise((resolve, reject) => {
      const id = '__codex_initialize__';
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('app-server initialize timed out'));
      }, INIT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({
          id,
          method: 'initialize',
          params: {
            clientInfo: { name: 'CodexManager', title: 'CodexManager', version: this.version },
            capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
          },
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async _kill() {
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.initPromise = null;
    // Fail any in-flight requests so callers don't hang.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      try { p.reject(new Error('app-server stopped')); } catch (_) {}
    }
    this.pending.clear();
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
  }

  _onExit(code, sig) {
    const wasReady = this.initialized;
    this.child = null;
    this.initialized = false;
    this.initPromise = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      try { p.reject(new Error('app-server exited')); } catch (_) {}
    }
    this.pending.clear();
    if (this.stopped) return;
    if (this.managed.size === 0) {
      this.log.log(`[appserver] app-server exited (code=${code} sig=${sig}); nothing to drive`);
      return;
    }
    // We still owe work — restart with backoff and re-resume.
    this.restartBackoff = Math.min(this.restartBackoff ? this.restartBackoff * 2 : 1000, MAX_RESTART_BACKOFF_MS);
    this.log.error(
      `[appserver] app-server exited (code=${code} sig=${sig}) with ${this.managed.size} managed thread(s); ` +
        `restarting in ${this.restartBackoff}ms${wasReady ? '' : ' (never became ready)'}`
    );
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this._restartAndReattach(), this.restartBackoff);
  }

  async _restartAndReattach() {
    if (this.stopped) return;
    try {
      await this.ensureReady();
    } catch (e) {
      this.log.error(`[appserver] restart failed: ${e.message}`);
      return; // _onExit (if it fires) will reschedule; otherwise idle until next trigger
    }
    const ids = Array.from(this.managed.values()).map((m) => m.id);
    // Clear so resumeAndActivate doesn't short-circuit on "already managed".
    this.managed.clear();
    this.log.log(`[appserver] re-attaching to ${ids.length} managed thread(s) after restart`);
    await this.resumeMany(ids);
  }

  // Re-attach to the persisted managed set on daemon startup. `filterFn(threadId)`
  // (optional, async) lets the caller drop threads that are complete/disabled.
  async reattachPersisted(filterFn) {
    const ids = Array.from(this.managed.values()).map((m) => m.id);
    if (ids.length === 0) return [];
    this.managed.clear();
    const keep = [];
    for (const id of ids) {
      if (!filterFn || (await filterFn(id))) keep.push(id);
    }
    if (keep.length === 0) {
      this._persistManaged();
      return [];
    }
    this.log.log(`[appserver] re-attaching to ${keep.length} persisted thread(s) from previous run`);
    return this.resumeMany(keep);
  }

  // ---- JSON-RPC plumbing --------------------------------------------------

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('app-server not running'));
      const id = `${method}:${crypto.randomUUID()}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _send(obj) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('app-server stdin not writable');
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _onStdout(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue; // not JSON (stray log line) — ignore
      }
      this._route(msg);
    }
  }

  _route(msg) {
    // Response to one of our requests?
    if (msg.id != null && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const m = typeof msg.error === 'string' ? msg.error : msg.error.message || JSON.stringify(msg.error);
        p.reject(new Error(m));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // Otherwise it's a server->client notification (or a request from the server,
    // which we don't service). Dispatch by method.
    if (msg.method) this._onNotification(msg.method, msg.params || {});
  }

  _onNotification(method, params) {
    switch (method) {
      case 'turn/started': {
        const m = this.managed.get(normId(params.threadId));
        if (m) m.lastTurnAt = Date.now();
        return;
      }
      case 'thread/status/changed': {
        const key = normId(params.threadId);
        const m = this.managed.get(key);
        if (!m) return;
        const type = params.status && params.status.type;
        if (type === 'idle' && m.goalStatus === 'active') {
          this._scheduleContinue(key);
        }
        return;
      }
      case 'thread/goal/updated': {
        const key = normId(params.threadId);
        const m = this.managed.get(key);
        if (!m) return;
        const status = params.goal && params.goal.status;
        if (!status) return;
        m.goalStatus = status;
        if (STOP_DRIVING_STATUSES.has(status)) {
          this.log.log(`[appserver] goal ${m.id} -> ${status}; releasing it`);
          this._unmanage(key);
        }
        return;
      }
      default:
        return; // turn/*, item/*, account/* etc. — not needed to drive the loop
    }
  }

  // Mirror the app's maybeContinueActiveThreadGoal: when a turn goes idle and the
  // goal is still active, kick the next turn.
  _scheduleContinue(key) {
    const m = this.managed.get(key);
    if (!m) return;
    if (m.continueTimer) return; // debounce
    m.continueTimer = setTimeout(async () => {
      m.continueTimer = null;
      const cur = this.managed.get(key);
      if (!cur || cur.goalStatus !== 'active') return;
      try {
        await this.request('thread/goal/set', { threadId: cur.id, status: 'active' });
      } catch (e) {
        this.log.error(`[appserver] continue failed for ${cur.id}: ${e.message}`);
      }
    }, CONTINUE_DEBOUNCE_MS);
  }

  // ---- managed-set bookkeeping -------------------------------------------

  _setManaged(key, id, goalStatus) {
    const existing = this.managed.get(key);
    if (existing) {
      existing.goalStatus = goalStatus;
    } else {
      this.managed.set(key, { id, goalStatus, continueTimer: null });
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this._persistManaged();
  }

  _unmanage(key) {
    const m = this.managed.get(key);
    if (m && m.continueTimer) clearTimeout(m.continueTimer);
    if (m && m.kickTimer) clearTimeout(m.kickTimer);
    this.managed.delete(key);
    this._persistManaged();
    if (this.managed.size === 0 && !this.stopped && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.managed.size === 0 && !this.stopped) {
          this.log.log('[appserver] idle with no goals to drive — stopping app-server');
          this._kill();
        }
      }, IDLE_SHUTDOWN_MS);
    }
  }

  _persistManaged() {
    try {
      const data = Array.from(this.managed.values()).map((m) => ({ threadId: m.id, goalStatus: m.goalStatus }));
      const tmp = `${MANAGED_PATH}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, MANAGED_PATH);
    } catch (e) {
      this.log.error(`[appserver] failed to persist managed set: ${e.message}`);
    }
  }

  _loadManaged() {
    try {
      if (!fs.existsSync(MANAGED_PATH)) return;
      const data = JSON.parse(fs.readFileSync(MANAGED_PATH, 'utf8'));
      if (Array.isArray(data)) {
        for (const row of data) {
          if (row && row.threadId) {
            this.managed.set(normId(row.threadId), { id: row.threadId, goalStatus: row.goalStatus || 'active', continueTimer: null });
          }
        }
      }
    } catch (e) {
      this.log.error(`[appserver] failed to load managed set: ${e.message}`);
    }
  }
}

// Singleton accessor — one app-server per daemon.
let _instance = null;
function getAppServer(opts) {
  if (!_instance) _instance = new AppServerManager(opts);
  else if (opts) {
    // allow late-binding of config (binary/version/getThreadMeta) on first real use
    if (opts.binary) _instance.binary = opts.binary;
    if (opts.version) _instance.version = opts.version;
    if (opts.getThreadMeta) _instance.getThreadMeta = opts.getThreadMeta;
    if (opts.logger) _instance.log = opts.logger;
  }
  return _instance;
}

module.exports = {
  AppServerManager,
  getAppServer,
  RESUMABLE_STATUSES,
  STOP_DRIVING_STATUSES,
  normId,
  MANAGED_PATH,
};
