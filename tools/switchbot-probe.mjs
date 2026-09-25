#!/usr/bin/env node
// SwitchBot OpenAPI v1.1 probe: list virtual IR remotes and send one customize
// command with timing, so API latency can be told apart from device latency.
//
// Credentials are read from a local JSON file ({"token": "...", "secret": "..."})
// that must not be readable by group/others. They are never printed.
//
//   node tools/switchbot-probe.mjs list
//   node tools/switchbot-probe.mjs send --device <deviceId> --button <name> [--observe]
//
// `send` issues exactly one request and never retries: a delayed IR command
// that is retried can fire twice. With --observe, press Enter the moment the
// device starts moving to record that time.

import readline from 'node:readline';

import { DEFAULT_CREDENTIALS_PATH, SwitchBotApi, loadCredentials } from '../src/switchbot-api.js';

const CRED_PATH = process.env.SWITCHBOT_CREDENTIALS || DEFAULT_CREDENTIALS_PATH;

const iso = (ms) => new Date(ms).toISOString();

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function list(client) {
  const { deviceList = [], infraredRemoteList = [] } = await client.listDevices();
  console.log('Hubs:');
  for (const d of deviceList.filter((d) => /hub/i.test(d.deviceType ?? ''))) {
    console.log(`  ${d.deviceId}  ${d.deviceType}  "${d.deviceName}"  cloud=${d.enableCloudService}`);
  }
  console.log('Virtual IR remotes (infraredRemoteList):');
  for (const d of infraredRemoteList) {
    console.log(`  ${d.deviceId}  ${d.remoteType}  "${d.deviceName}"  hub=${d.hubDeviceId}`);
  }
}

async function send(client) {
  const device = arg('device');
  const button = arg('button');
  if (!device || !button) {
    console.error('usage: send --device <deviceId> --button <name> [--observe]');
    process.exit(2);
  }
  const observe = process.argv.includes('--observe');

  let movedAt = null;
  let rl;
  if (observe) {
    rl = readline.createInterface({ input: process.stdin });
    rl.once('line', () => { movedAt = Date.now(); console.log(`device moved: ${iso(movedAt)}`); rl.close(); });
  }

  const sentAt = Date.now();
  console.log(`request sent: ${iso(sentAt)}  POST /v1.1/devices/${device}/commands  command="${button}"`);
  let recvAt;
  try {
    const r = await client.pressButton(device, button);
    recvAt = Date.now();
    console.log(`response:     ${iso(recvAt)}  +${recvAt - sentAt} ms  statusCode ${r.statusCode}`);
  } catch (e) {
    console.log(`request failed after ${Date.now() - sentAt} ms: ${e.name}: ${e.message} (not retried)`);
    rl?.close();
    process.exit(1);
  }
  console.log('note: statusCode 100 means the cloud accepted the command, not that the device moved.');

  if (observe) {
    if (movedAt === null) {
      console.log('press Enter when the device starts moving (Ctrl+C if it never does)...');
      await new Promise((resolve) => rl.once('close', resolve));
    }
    console.log(`summary: API ${recvAt - sentAt} ms; request -> movement ${movedAt - sentAt} ms; response -> movement ${movedAt - recvAt} ms`);
  }
}

const cmd = process.argv[2];
try {
  const client = new SwitchBotApi(loadCredentials(CRED_PATH), { timeoutMs: 15000 });
  if (cmd === 'list') await list(client);
  else if (cmd === 'send') await send(client);
  else { console.error('usage: switchbot-probe.mjs list | send --device <id> --button <name> [--observe]'); process.exit(2); }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
