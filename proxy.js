// proxy.js — codex-lb-lite (EXPERIMENTAL, opt-in).
//
// A local reverse proxy that rotates Codex accounts per-request with NO restarts,
// modeled on Soju06/codex-lb. Point Codex at it via ~/.codex/config.toml:
//
//   [model_providers.codex-swapper]
//   name = "openai"
//   base_url = "http://127.0.0.1:2455/backend-api/codex"
//   wire_api = "responses"
//   requires_openai_auth = true
//
// Then set `model_provider = "codex-swapper"`. The proxy injects a chosen
// account's Bearer token + chatgpt-account-id per request, refreshing tokens as
// needed and rotating away from accounts that are near their limit or 429.
//
// This is scaffolding: it has not been validated against the live desktop app
// (which also makes Electron-direct calls that bypass any proxy). The file-swap
// path in server.js remains the supported default.

const http = require('http');
const https = require('https');

const codex = require('./lib/codex');
const {
  REGISTRY_PATH,
  SETTINGS_PATH,
  UPSTREAM_BASE,
  readJson,
  writeJsonAtomic,
  extractAccountInfo,
  accountIdHeader,
  refreshTokens,
  fetchUsage,
  maxUsedPercent,
} = codex;

function rotationSettings() {
  const s = readJson(SETTINGS_PATH, {});
  return {
    preemptive: s.autoSwap !== false, // default on
    threshold: typeof s.swapThreshold === 'number' ? s.swapThreshold : 90,
  };
}

const UPSTREAM_HOST = new URL(UPSTREAM_BASE).hostname; // chatgpt.com
const REFRESH_SOON_MS = 5 * 60 * 1000;

function createProxy({ port = 2455 } = {}) {
  let server = null;
  const state = {
    running: false,
    // nickname -> {until: epochMs} cooldown set when upstream returns 429
    cooldown: new Map(),
    usageTimer: null,
  };

  function loadAccounts() {
    const registry = readJson(REGISTRY_PATH, {});
    return Object.keys(registry).map((nick) => ({ nick, acc: registry[nick] }));
  }

  // Choose the account with the most headroom that isn't on 429 cooldown.
  // Preemptively skip accounts at/above the swap threshold; if that leaves
  // nothing, fall back to the least-used account so requests still flow.
  function pickAccount() {
    const now = Date.now();
    const usable = loadAccounts()
      .filter(({ acc }) => acc.authData?.tokens?.refresh_token && !acc.refresh_error)
      .map((e) => ({ ...e, used: maxUsedPercent(e.acc.usage) }))
      .filter((e) => {
        const cd = state.cooldown.get(e.nick);
        return !cd || cd.until <= now;
      })
      .sort((a, b) => a.used - b.used);
    if (!usable.length) return null;
    const { preemptive, threshold } = rotationSettings();
    if (!preemptive) return usable[0];
    const underThreshold = usable.filter((e) => e.used < threshold);
    return underThreshold[0] || usable[0];
  }

  // Ensure the chosen account's access token is fresh; refresh + persist if not.
  async function ensureFreshToken(nick) {
    const registry = readJson(REGISTRY_PATH, {});
    const acc = registry[nick];
    if (!acc || !acc.authData) return null;
    if (acc.exp && acc.exp - Date.now() < REFRESH_SOON_MS && acc.authData.tokens?.refresh_token) {
      try {
        const updated = await refreshTokens(acc.authData);
        const info = extractAccountInfo(updated);
        registry[nick] = { ...acc, authData: updated, exp: info.exp, plan: info.plan, refresh_error: null };
        writeJsonAtomic(REGISTRY_PATH, registry);
        return registry[nick];
      } catch (e) {
        if (e.fatal) {
          registry[nick] = { ...acc, refresh_error: e.code || 'fatal' };
          writeJsonAtomic(REGISTRY_PATH, registry);
        }
        console.error(`[proxy] token refresh failed for "${nick}": ${e.message}`);
        return acc; // try with existing token anyway
      }
    }
    return acc;
  }

  function forward(req, res, account, bodyBuf) {
    const accessToken = account.authData.tokens.access_token;
    const acctId = accountIdHeader(account.authData);

    // Preserve the incoming path (e.g. /backend-api/codex/responses) verbatim.
    const upstreamUrl = new URL(req.url, UPSTREAM_BASE);

    const headers = { ...req.headers };
    // Rewrite hop-by-hop / auth headers.
    headers.host = UPSTREAM_HOST;
    headers.authorization = `Bearer ${accessToken}`;
    if (acctId) headers['chatgpt-account-id'] = acctId;
    delete headers['content-length']; // recomputed below
    delete headers['accept-encoding']; // let node handle; avoids double-decoding

    const options = {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: req.method,
      headers,
    };
    if (bodyBuf && bodyBuf.length) headers['content-length'] = Buffer.byteLength(bodyBuf);

    const upstream = https.request(options, (ur) => {
      // On 429, put this account on cooldown so the next request rotates away.
      if (ur.statusCode === 429) {
        const retryAfter = Number(ur.headers['retry-after']) || 60;
        state.cooldown.set(account.nick, { until: Date.now() + retryAfter * 1000 });
        console.log(`[proxy] 429 on "${account.nick}" — cooldown ${retryAfter}s`);
      }
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res); // stream SSE/responses straight through
    });

    upstream.on('error', (e) => {
      console.error('[proxy] upstream error:', e.message);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `proxy upstream error: ${e.message}` } }));
    });

    if (bodyBuf && bodyBuf.length) upstream.write(bodyBuf);
    upstream.end();
  }

  async function handle(req, res) {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chosen = pickAccount();
      return res.end(JSON.stringify({ ok: true, accounts: loadAccounts().length, chosen: chosen?.nick || null }));
    }

    // Buffer the request body (Codex requests are small JSON envelopes).
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const bodyBuf = Buffer.concat(chunks);
      const picked = pickAccount();
      if (!picked) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'no eligible Codex account available' } }));
      }
      const account = (await ensureFreshToken(picked.nick)) || picked.acc;
      account.nick = picked.nick;
      console.log(`[proxy] ${req.method} ${req.url} -> "${picked.nick}" (${picked.used}%)`);
      forward(req, res, account, bodyBuf);
    });
    req.on('error', () => {
      if (!res.headersSent) res.writeHead(400).end();
    });
  }

  async function refreshUsageLoop() {
    const registry = readJson(REGISTRY_PATH, {});
    let changed = false;
    for (const nick of Object.keys(registry)) {
      try {
        const payload = await fetchUsage(registry[nick].authData);
        registry[nick].usage = { ...payload, last_updated: new Date().toISOString() };
        changed = true;
      } catch (_) {
        /* ignore */
      }
    }
    if (changed) writeJsonAtomic(REGISTRY_PATH, registry);
  }

  return {
    get running() {
      return state.running;
    },
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(handle);
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
          state.running = true;
          state.usageTimer = setInterval(() => refreshUsageLoop().catch(() => {}), 60 * 1000);
          console.log(`[proxy] codex-lb-lite listening on http://127.0.0.1:${port}`);
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (state.usageTimer) clearInterval(state.usageTimer);
        state.usageTimer = null;
        state.running = false;
        if (server) server.close(() => resolve());
        else resolve();
      });
    },
  };
}

module.exports = { createProxy };
