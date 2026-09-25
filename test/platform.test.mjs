// Tests run the real platform and the real SwitchBotApi (signing, status
// handling) against a fake fetch, and an in-memory stand-in for api.matter that
// mimics Homebridge 2.4's OnOff behavior: the handler runs first and the state
// is committed only if it succeeds; matter.js resolves Toggle into on()/off().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { SwitchBotIRMatterPlatform } from '../src/platform.js';
import { SwitchBotApi, loadCredentials } from '../src/switchbot-api.js';

const CRED = { token: 'test-token-DO-NOT-LOG', secret: 'test-secret-DO-NOT-LOG' };
const SCREEN = '02-000000000000-00000001';
const BUTTONS = [
  { deviceId: SCREEN, button: 'Down', name: 'Screen Down' },
  { deviceId: SCREEN, button: 'Up', name: 'Screen Up' },
  { deviceId: SCREEN, button: 'Stop', name: 'Screen Stop' },
];

class Busy extends Error {}

function fakeFetch({ statusCode = 100, delayMs = 0 } = {}) {
  const f = async (url, init) => {
    f.calls.push({ url, init, body: init.body && JSON.parse(init.body) });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const code = typeof f.statusCode === 'function' ? f.statusCode() : f.statusCode;
    return { status: 200, text: async () => JSON.stringify({ statusCode: code, body: {}, message: code === 100 ? 'success' : 'error' }) };
  };
  f.calls = [];
  f.statusCode = statusCode;
  return f;
}

function fakeMatter() {
  const m = {
    registered: new Map(),
    unregistered: [],
    deviceTypes: { OnOffOutlet: { name: 'OnOffPlugInUnit' } },
    clusterNames: { OnOff: 'onOff', BridgedDeviceBasicInformation: 'bridgedDeviceBasicInformation' },
    status: { Busy },
    async registerPlatformAccessories(_p, _n, accs) {
      for (const a of accs) {
        m.registered.set(a.UUID, { accessory: a, clusters: { ...structuredClone(a.clusters), bridgedDeviceBasicInformation: { reachable: true } } });
      }
    },
    async unregisterPlatformAccessories(_p, _n, accs) { m.unregistered.push(...accs.map((a) => a.UUID)); },
    async getAccessoryState(uuid, cluster) { return m.registered.get(uuid)?.clusters[cluster]; },
    async updateAccessoryState(uuid, cluster, attrs) { Object.assign(m.registered.get(uuid).clusters[cluster], attrs); },
    async command(uuid, name) {
      const r = m.registered.get(uuid);
      await r.accessory.handlers.onOff[name]();
      if (name === 'toggle') return m.command(uuid, r.clusters.onOff.onOff ? 'off' : 'on');
      r.clusters.onOff.onOff = name === 'on';
    },
  };
  return m;
}

function makeLog() {
  const lines = [];
  const log = { lines };
  for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (...a) => lines.push([level, a.join(' ')]);
  return log;
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function launch({ config = {}, fetch = fakeFetch(), matterEnabled = true, cached = [], apiFactory } = {}) {
  const api = new EventEmitter();
  api.hap = { uuid: { generate: (s) => {
    const h = crypto.createHash('sha1').update(s).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  } } };
  api.isMatterEnabled = () => matterEnabled;
  api.matter = matterEnabled ? fakeMatter() : undefined;
  const log = makeLog();
  const platform = new SwitchBotIRMatterPlatform(log, { buttons: BUTTONS, resetMs: 200, ...config }, api,
    { apiFactory: apiFactory ?? (() => new SwitchBotApi(CRED, { fetchImpl: fetch })) });
  for (const c of cached) platform.configureMatterAccessory(c);
  api.emit('didFinishLaunching');
  await settle();
  const uuidOf = (button) => [...platform.buttons].find(([, b]) => b.button === button)?.[0];
  const state = (button) => api.matter.registered.get(uuidOf(button)).clusters;
  return { api, platform, log, fetch, uuidOf, state, stop: () => api.emit('shutdown') };
}

test('publishes one OnOffOutlet per button with stable, bounded identifiers', async () => {
  const a = await launch();
  const b = await launch();
  try {
    assert.equal(a.api.matter.registered.size, 3);
    for (const { accessory } of a.api.matter.registered.values()) {
      assert.equal(accessory.deviceType.name, 'OnOffPlugInUnit');
      assert.ok(Buffer.byteLength(accessory.serialNumber) <= 32);
    }
    assert.deepEqual([...a.api.matter.registered.keys()], [...b.api.matter.registered.keys()]);
  } finally { a.stop(); b.stop(); }
});

test('on sends the customize command once, then falls back to off', async () => {
  const t = await launch();
  try {
    await t.api.matter.command(t.uuidOf('Down'), 'on');
    assert.equal(t.fetch.calls.length, 1);
    const { url, init, body } = t.fetch.calls[0];
    assert.equal(url, `https://api.switch-bot.com/v1.1/devices/${SCREEN}/commands`);
    assert.equal(init.method, 'POST');
    assert.deepEqual(body, { command: 'Down', parameter: 'default', commandType: 'customize' });
    assert.equal(t.state('Down').onOff.onOff, true);
    await settle(300);
    assert.equal(t.state('Down').onOff.onOff, false, 'reset to off after resetMs');
  } finally { t.stop(); }
});

test('the same direction can be requested again and is sent again', async () => {
  const t = await launch();
  try {
    await t.api.matter.command(t.uuidOf('Down'), 'on');
    await t.api.matter.command(t.uuidOf('Down'), 'on'); // before the reset
    await settle(300);
    await t.api.matter.command(t.uuidOf('Down'), 'on'); // after the reset
    assert.equal(t.fetch.calls.length, 3);
  } finally { t.stop(); }
});

test('a second request for a button still in flight is refused, not sent', async () => {
  const t = await launch({ fetch: fakeFetch({ delayMs: 100 }) });
  try {
    const first = t.api.matter.command(t.uuidOf('Down'), 'on');
    await assert.rejects(t.api.matter.command(t.uuidOf('Down'), 'on'), Busy);
    await first;
    assert.equal(t.fetch.calls.length, 1);
    // A different button is independent (e.g. Stop while Down is in flight).
    const f2 = fakeFetch({ delayMs: 100 });
    const t2 = await launch({ fetch: f2 });
    await Promise.all([t2.api.matter.command(t2.uuidOf('Down'), 'on'), t2.api.matter.command(t2.uuidOf('Stop'), 'on')]);
    assert.equal(f2.calls.length, 2);
    t2.stop();
  } finally { t.stop(); }
});

test('offline hub: command fails, state stays off, marked unreachable until a success', async () => {
  const f = fakeFetch({ statusCode: 171 });
  const t = await launch({ fetch: f });
  try {
    await assert.rejects(t.api.matter.command(t.uuidOf('Down'), 'on'), /statusCode 171/);
    await settle();
    assert.equal(t.state('Down').onOff.onOff, false);
    assert.equal(t.state('Down').bridgedDeviceBasicInformation.reachable, false);
    assert.equal(f.calls.length, 1, 'not retried');
    f.statusCode = 100;
    await t.api.matter.command(t.uuidOf('Down'), 'on');
    await settle();
    assert.equal(t.state('Down').bridgedDeviceBasicInformation.reachable, true);
  } finally { t.stop(); }
});

test('other API errors fail the command without marking unreachable', async () => {
  const t = await launch({ fetch: fakeFetch({ statusCode: 190 }) });
  try {
    await assert.rejects(t.api.matter.command(t.uuidOf('Down'), 'on'), /statusCode 190/);
    await settle();
    assert.equal(t.state('Down').bridgedDeviceBasicInformation.reachable, true);
  } finally { t.stop(); }
});

test('off sends nothing; toggle sends exactly one press', async () => {
  const t = await launch();
  try {
    await t.api.matter.command(t.uuidOf('Up'), 'off');
    assert.equal(t.fetch.calls.length, 0);
    await t.api.matter.command(t.uuidOf('Up'), 'toggle');
    assert.equal(t.fetch.calls.length, 1);
  } finally { t.stop(); }
});

test('is detected as a dynamic platform (otherwise Homebridge drops cached Matter accessories)', async () => {
  const t = await launch();
  try {
    // Mirrors HomebridgeAPI.isDynamicPlatformPlugin in Homebridge 2.4.
    assert.ok('configureAccessory' in t.platform);
  } finally { t.stop(); }
});

test('cached buttons no longer configured are removed; configured ones kept', async () => {
  const probe = await launch();
  const keep = probe.uuidOf('Down');
  probe.stop();
  const t = await launch({ cached: [{ UUID: keep }, { UUID: 'stale-uuid' }] });
  try {
    assert.deepEqual(t.api.matter.unregistered, ['stale-uuid']);
  } finally { t.stop(); }
});

test('Matter disabled or credentials missing: nothing is published', async () => {
  const a = await launch({ matterEnabled: false });
  assert.ok(a.log.lines.some(([l, m]) => l === 'error' && /Matter is not enabled/.test(m)));
  a.stop();
  const b = await launch({ apiFactory: () => loadCredentials('/nonexistent/credentials.json') });
  assert.ok(b.log.lines.some(([l, m]) => l === 'error' && /credentials file not found/.test(m)));
  assert.equal(b.api.matter.registered.size, 0);
  b.stop();
});

test('credentials never appear in logs or request bodies; sign matches the documented scheme', async () => {
  const t = await launch({ fetch: fakeFetch({ statusCode: 161 }) });
  try {
    await t.api.matter.command(t.uuidOf('Down'), 'on').catch(() => {});
    await t.api.matter.command(t.uuidOf('Up'), 'on').catch(() => {});
    const logged = t.log.lines.map(([, m]) => m).join('\n');
    assert.ok(!logged.includes(CRED.token) && !logged.includes(CRED.secret));
    const { init } = t.fetch.calls[0];
    assert.ok(!init.body.includes(CRED.token) && !init.body.includes(CRED.secret));
    const h = init.headers;
    const expected = crypto.createHmac('sha256', CRED.secret).update(CRED.token + h.t + h.nonce).digest('base64');
    assert.equal(h.sign, expected);
    assert.equal(h.Authorization, CRED.token);
    assert.match(h.t, /^\d{13}$/);
  } finally { t.stop(); }
});

test('loadCredentials refuses files readable by group/others', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbir-'));
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, JSON.stringify(CRED));
  fs.chmodSync(f, 0o644);
  assert.throws(() => loadCredentials(f), /chmod 600/);
  fs.chmodSync(f, 0o600);
  assert.deepEqual(loadCredentials(f), CRED);
  fs.rmSync(dir, { recursive: true });
});
