// Minimal SwitchBot OpenAPI v1.1 client: signing, device list, one command.
// Credentials never leave this module except inside request headers.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const API_BASE = 'https://api.switch-bot.com';
export const DEFAULT_CREDENTIALS_PATH = path.join(os.homedir(), '.config', 'switchbot-ir', 'credentials.json');

// statusCode values from the OpenAPI README ("Send device control commands").
export const STATUS = { SUCCESS: 100, DEVICE_OFFLINE: 161, HUB_OFFLINE: 171 };

// Plain http is allowed only to these hosts (a local fake API for testing).
// URL.hostname keeps the brackets of an IPv6 literal.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

// The token and signature go to whatever base is used, so refuse anything but
// https, or http to a loopback host. The message shows only protocol and host,
// never a path, query, or userinfo that the value might carry.
function checkBase(base) {
  let url;
  try { url = new URL(base); } catch {
    throw new Error('invalid SwitchBot API base: not a URL (expected https://...)');
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return;
  throw new Error(`refusing SwitchBot API base ${url.protocol}//${url.host}: only https, or http to a loopback host, is allowed`);
}

export class SwitchBotApiError extends Error {
  constructor(message, { http, statusCode } = {}) {
    super(message);
    this.name = 'SwitchBotApiError';
    this.http = http;
    this.statusCode = statusCode;
  }

  get offline() {
    return this.statusCode === STATUS.DEVICE_OFFLINE || this.statusCode === STATUS.HUB_OFFLINE;
  }
}

// Read {"token","secret"} from a file that only the owner can access.
export function loadCredentials(file = DEFAULT_CREDENTIALS_PATH) {
  const resolved = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
  let st;
  try { st = fs.statSync(resolved); } catch {
    throw new Error(`credentials file not found: ${resolved}`);
  }
  if (st.mode & 0o077) throw new Error(`${resolved} must not be accessible by group/others (chmod 600)`);
  const text = fs.readFileSync(resolved, 'utf8');
  let c;
  // The SyntaxError message quotes part of the file (possibly the token), so
  // neither its message nor the error itself (as cause) is passed on.
  try { c = JSON.parse(text); } catch {
    throw new Error(`${resolved}: not valid JSON (expected {"token":"...","secret":"..."})`);
  }
  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    throw new Error(`${resolved}: expected a JSON object {"token":"...","secret":"..."}`);
  }
  if (!c.token || !c.secret) throw new Error(`${resolved} needs "token" and "secret"`);
  return { token: String(c.token), secret: String(c.secret) };
}

// Official scheme: sign = base64(HMAC-SHA256(secret, token + t + nonce)).
export function signHeaders({ token, secret }, now = Date.now(), nonce = crypto.randomUUID()) {
  const t = String(now);
  const sign = crypto.createHmac('sha256', secret).update(token + t + nonce).digest('base64');
  return { Authorization: token, sign, t, nonce, 'Content-Type': 'application/json; charset=utf8' };
}

export class SwitchBotApi {
  constructor(credentials, { base = API_BASE, timeoutMs = 10000, fetchImpl = fetch } = {}) {
    checkBase(base);
    this.credentials = credentials;
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(method, pathname, body) {
    const res = await this.fetch(this.base + pathname, {
      method,
      headers: signHeaders(this.credentials),
      body: body ? JSON.stringify(body) : undefined,
      // Never follow a redirect: the signed headers would go along with it.
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body, e.g. 401 */ }
    return { http: res.status, json, text };
  }

  async listDevices() {
    const r = await this.request('GET', '/v1.1/devices');
    if (r.http !== 200 || r.json?.statusCode !== STATUS.SUCCESS) {
      throw new SwitchBotApiError(`device list failed: HTTP ${r.http}, statusCode ${r.json?.statusCode}, ${r.json?.message ?? r.text.slice(0, 80)}`,
        { http: r.http, statusCode: r.json?.statusCode });
    }
    return r.json.body;
  }

  // Send one customized button of a virtual IR remote ("Others"/DIY). Resolves
  // when the cloud accepted it (statusCode 100) — that is not proof the device
  // received the infrared signal. Never retries.
  async pressButton(deviceId, button) {
    if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
      throw new Error(`invalid deviceId ${JSON.stringify(deviceId)}: only letters, digits, and "-" are allowed`);
    }
    const r = await this.request('POST', `/v1.1/devices/${encodeURIComponent(deviceId)}/commands`,
      { command: button, parameter: 'default', commandType: 'customize' });
    const statusCode = r.json?.statusCode;
    if (r.http !== 200 || statusCode !== STATUS.SUCCESS) {
      throw new SwitchBotApiError(`HTTP ${r.http}, statusCode ${statusCode}, ${r.json?.message ?? r.text.slice(0, 80)}`,
        { http: r.http, statusCode });
    }
    return { statusCode };
  }
}
