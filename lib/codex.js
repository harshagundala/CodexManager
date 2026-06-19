// lib/codex.js
// Shared Codex auth + usage core. Used by both the file-swap server and the proxy.
// No external dependencies — native node only.

const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');

const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const AUTH_PATH = path.join(CODEX_DIR, 'auth.json');
const REGISTRY_PATH = path.join(CODEX_DIR, 'auth_registry.json');
const SETTINGS_PATH = path.join(CODEX_DIR, 'swapper_settings.json');

// OAuth + endpoints — confirmed against openai/codex Rust source (codex-rs/login).
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const UPSTREAM_BASE = 'https://chatgpt.com/backend-api';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Codex/26.527.31326 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36';

// Refresh-token error codes that mean the token is permanently dead (do not retry).
const FATAL_REFRESH_ERRORS = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
]);

// ---------------------------------------------------------------------------
// JSON / file helpers (atomic writes so we never leave a half-written auth.json)
// ---------------------------------------------------------------------------

function decodeJwt(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function readJson(filePath, defaultVal = {}) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`[codex] error reading ${filePath}:`, e.message);
    return defaultVal;
  }
}

// Atomic write: write to a temp file in the same dir, fsync, then rename over
// the target. Rename is atomic on the same filesystem, so a reader (the live
// app-server) can never observe a truncated/partial file.
function writeJsonAtomic(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
    const json = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    console.error(`[codex] error writing ${filePath}:`, e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account info
// ---------------------------------------------------------------------------

function extractAccountInfo(authData) {
  if (!authData || !authData.tokens) return null;
  const decoded = decodeJwt(authData.tokens.id_token);
  if (!decoded) return null;
  const oa = decoded['https://api.openai.com/auth'] || {};
  return {
    email: decoded.email || decoded.name || 'Unknown Email',
    name: decoded.name || 'Codex User',
    plan: oa.chatgpt_plan_type || 'free',
    // account_id is the chatgpt_account_id claim; auth.json stores the same value
    // in tokens.account_id. Prefer the stored token value so we never drift.
    account_id: authData.tokens.account_id || oa.chatgpt_account_id || 'Unknown ID',
    user_id: oa.chatgpt_user_id || 'Unknown User ID',
    exp: decoded.exp ? decoded.exp * 1000 : null,
  };
}

// The header value Codex sends upstream to identify the workspace/account.
function accountIdHeader(authData) {
  if (!authData || !authData.tokens) return null;
  if (authData.tokens.account_id) return authData.tokens.account_id;
  const decoded = decodeJwt(authData.tokens.id_token);
  const oa = (decoded && decoded['https://api.openai.com/auth']) || {};
  return oa.chatgpt_account_id || null;
}

function sameAccount(a, b) {
  if (!a || !b) return false;
  return a.user_id === b.user_id && a.account_id === b.account_id;
}

// ---------------------------------------------------------------------------
// Low-level HTTP (returns status + headers + parsed/raw body so callers can read
// the x-codex-* rate-limit headers too).
// ---------------------------------------------------------------------------

function request(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': UA,
        ...headers,
      },
    };
    if (payload != null && !opts.headers['Content-Length']) {
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try {
          json = buf ? JSON.parse(buf) : null;
        } catch (_) {
          /* leave json null */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    }
    if (payload != null) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Token refresh — JSON body, refresh_token grant. Persists rotated refresh
// tokens (OpenAI revokes reused ones, so this is mandatory) and surfaces fatal
// errors instead of looping.
// ---------------------------------------------------------------------------

async function refreshTokens(authData) {
  if (!authData || !authData.tokens || !authData.tokens.refresh_token) {
    throw new Error('no refresh_token available');
  }
  const refreshToken = authData.tokens.refresh_token;

  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
  });

  if (res.status < 200 || res.status >= 300) {
    // OpenAI returns either {error: "code", error_description} or
    // {error: {code, type, message}}. Normalize to a string code.
    let code = null;
    if (res.json) {
      const e = res.json.error;
      if (typeof e === 'string') code = e;
      else if (e && typeof e === 'object') code = e.code || e.type || null;
      code = code || res.json.error_code || null;
    }
    // A 400/401 from the token endpoint means the refresh token is bad/revoked —
    // permanent until the account logs in again. Don't keep retrying it.
    const fatal = res.status === 400 || res.status === 401 || (code && FATAL_REFRESH_ERRORS.has(code));
    const err = new Error(`token refresh failed (${res.status})${code ? ': ' + code : ''}`);
    err.fatal = !!fatal;
    err.code = code || `http_${res.status}`;
    throw err;
  }

  const r = res.json || {};
  if (!r.access_token || !r.id_token) {
    throw new Error('refresh response missing access_token/id_token');
  }

  // Build the refreshed auth.json payload. Preserve the original account_id —
  // never re-derive it (re-deriving was the source of account corruption).
  const updated = {
    auth_mode: authData.auth_mode || 'chatgpt',
    OPENAI_API_KEY: authData.OPENAI_API_KEY ?? null,
    tokens: {
      id_token: r.id_token,
      access_token: r.access_token,
      // rotation: prefer the newly issued refresh_token, fall back to the old one
      refresh_token: r.refresh_token || refreshToken,
      account_id: authData.tokens.account_id || null,
    },
    last_refresh: new Date().toISOString(),
  };
  return updated;
}

// ---------------------------------------------------------------------------
// Usage / rate limits. Sends chatgpt-account-id (required for some accounts)
// and also parses the x-codex-* rate-limit response headers as a fallback.
// ---------------------------------------------------------------------------

function parseRateLimitHeaders(headers) {
  const num = (k) => (headers[k] != null ? Number(headers[k]) : undefined);
  const has = (k) => headers[k] != null;
  const win = (prefix) => {
    if (!has(`x-codex-${prefix}-used-percent`)) return undefined;
    return {
      used_percent: num(`x-codex-${prefix}-used-percent`),
      limit_window_seconds:
        headers[`x-codex-${prefix}-window-minutes`] != null
          ? Number(headers[`x-codex-${prefix}-window-minutes`]) * 60
          : undefined,
      reset_at: num(`x-codex-${prefix}-reset-at`),
    };
  };
  const primary = win('primary');
  const secondary = win('secondary');
  if (!primary && !secondary) return null;
  return { primary_window: primary, secondary_window: secondary };
}

async function fetchUsage(authData) {
  if (!authData || !authData.tokens || !authData.tokens.access_token) {
    throw new Error('no access_token for usage fetch');
  }
  const headers = { Authorization: `Bearer ${authData.tokens.access_token}`, Accept: 'application/json' };
  const acct = accountIdHeader(authData);
  if (acct) headers['chatgpt-account-id'] = acct;

  const res = await request(USAGE_URL, { method: 'GET', headers });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`usage fetch failed (${res.status})`);
  }
  const payload = res.json || {};
  // Some windows may only be present in headers — merge them in if missing.
  if (!payload.rate_limit) {
    const hdr = parseRateLimitHeaders(res.headers);
    if (hdr) payload.rate_limit = hdr;
  }
  return payload;
}

// Highest of the two windows' used_percent (the binding constraint).
function maxUsedPercent(usage) {
  const rl = usage && usage.rate_limit;
  if (!rl) return 0;
  const p = rl.primary_window?.used_percent ?? 0;
  const s = rl.secondary_window?.used_percent ?? 0;
  return Math.max(p, s);
}

module.exports = {
  CODEX_DIR,
  AUTH_PATH,
  REGISTRY_PATH,
  SETTINGS_PATH,
  OAUTH_CLIENT_ID,
  TOKEN_URL,
  USAGE_URL,
  UPSTREAM_BASE,
  decodeJwt,
  readJson,
  writeJsonAtomic,
  extractAccountInfo,
  accountIdHeader,
  sameAccount,
  request,
  refreshTokens,
  fetchUsage,
  parseRateLimitHeaders,
  maxUsedPercent,
};
