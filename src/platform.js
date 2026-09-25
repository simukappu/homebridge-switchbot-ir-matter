// Publishes customized buttons of SwitchBot virtual IR remotes as Matter
// On/Off Plug-in Units. Turning one on sends that button once through the
// SwitchBot OpenAPI; after success it falls back to off by itself, so the
// on/off state never pretends to be the device's position or power.

import { DEFAULT_CREDENTIALS_PATH, SwitchBotApi, loadCredentials } from './switchbot-api.js';

export const PLUGIN_NAME = 'homebridge-switchbot-ir-matter';
export const PLATFORM_NAME = 'SwitchBotIRMatter';

// BridgedDeviceBasicInformation.NodeLabel is limited to 32 bytes.
const NODE_LABEL_MAX_BYTES = 32;
const DEFAULT_RESET_MS = 1000;

export class SwitchBotIRMatterPlatform {
  constructor(log, config, api, { apiFactory } = {}) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.cached = new Map();
    this.buttons = new Map(); // uuid -> { deviceId, button, name, busy, resetTimer }
    this.resetMs = Number.isFinite(this.config.resetMs) ? Math.max(200, this.config.resetMs) : DEFAULT_RESET_MS;
    this.apiFactory = apiFactory
      || (() => new SwitchBotApi(loadCredentials(this.config.credentialsFile || DEFAULT_CREDENTIALS_PATH),
        // apiBase is for testing against a local fake API; not in the schema.
        this.config.apiBase ? { base: String(this.config.apiBase) } : {}));

    api.on('didFinishLaunching', () => {
      this.start().catch((e) => this.log.error(`startup failed: ${e.message}`));
    });
    api.on('shutdown', () => {
      for (const b of this.buttons.values()) clearTimeout(b.resetTimer);
    });
  }

  // No HAP accessories, but Homebridge only treats a platform as dynamic (and
  // only then hands it its cached Matter accessories) if this method exists.
  // Without it, cached buttons are removed as orphans on every restart.
  configureAccessory() {}

  configureMatterAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  async start() {
    const matter = typeof this.api.isMatterEnabled === 'function' && this.api.isMatterEnabled() ? this.api.matter : undefined;
    if (!matter) {
      this.log.error('Matter is not enabled for this bridge — enable Matter on this plugin\'s child bridge.');
      return;
    }
    try {
      this.client = this.apiFactory();
    } catch (e) {
      this.log.error(e.message);
      return;
    }

    const accessories = [];
    for (const entry of Array.isArray(this.config.buttons) ? this.config.buttons : []) {
      const deviceId = String(entry?.deviceId || '').trim();
      const button = String(entry?.button || '').trim();
      if (!deviceId || !button) {
        this.log.warn('Ignoring a button entry without "deviceId" and "button".');
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${deviceId}:${button}`);
      if (this.buttons.has(uuid)) {
        this.log.warn(`Ignoring duplicate button "${button}" for ${deviceId}.`);
        continue;
      }
      const name = nodeLabel(String(entry.name || button).trim(), this.log);
      this.buttons.set(uuid, { deviceId, button, name, busy: false, resetTimer: undefined });
      accessories.push({
        UUID: uuid,
        displayName: name,
        deviceType: matter.deviceTypes.OnOffOutlet,
        manufacturer: 'SwitchBot',
        model: 'IR button',
        // Matter caps SerialNumber at 32 bytes; the UUID without dashes is exactly 32.
        serialNumber: uuid.replace(/-/g, ''),
        context: {},
        clusters: { onOff: { onOff: false } },
        handlers: {
          onOff: {
            on: () => this.press(uuid),
            // Off is the resting state of a momentary button: nothing to send.
            off: async () => {},
            // matter.js resolves Toggle into on()/off(); sending here would double it.
            toggle: async () => {},
          },
        },
      });
    }

    const stale = [...this.cached.values()].filter((a) => !this.buttons.has(a.UUID));
    if (stale.length) {
      matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
        .then(() => this.log.info(`Removed ${stale.length} stale button(s).`))
        .catch((e) => this.log.warn(`could not remove stale buttons: ${e.message}`));
    }
    if (!accessories.length) {
      this.log.warn('No buttons configured.');
      return;
    }
    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    this.log.info(`Published ${accessories.length} button(s): ${accessories.map((a) => `"${a.displayName}"`).join(', ')}.`);
    // A cache-restored endpoint may have been saved while on; start from off.
    for (const uuid of this.buttons.keys()) this.setOnOff(uuid, false);
  }

  // Matter "on": send the button once. Throwing makes Matter report a failure
  // to the controller and keep the state off.
  async press(uuid) {
    const b = this.buttons.get(uuid);
    if (b.busy) {
      // A second request while the first is still in flight would fire twice.
      throw new this.api.matter.status.Busy(`"${b.name}" is already being sent`);
    }
    b.busy = true;
    const started = Date.now();
    try {
      await this.client.pressButton(b.deviceId, b.button);
      this.log.info(`Sent "${b.button}" (${b.name}): accepted in ${Date.now() - started} ms.`);
      this.setReachable(uuid, true);
    } catch (e) {
      this.log.warn(`Sending "${b.button}" (${b.name}) failed after ${Date.now() - started} ms: ${e.message} (not retried)`);
      if (e.offline) this.setReachable(uuid, false);
      throw e;
    } finally {
      b.busy = false;
      // Always (re)arm the fall-back to off: after a success Matter commits on,
      // and a failure must not leave an earlier success's "on" showing.
      clearTimeout(b.resetTimer);
      b.resetTimer = setTimeout(() => this.setOnOff(uuid, false), this.resetMs);
    }
  }

  setOnOff(uuid, onOff) {
    this.api.matter.updateAccessoryState(uuid, this.api.matter.clusterNames.OnOff, { onOff })
      .catch((e) => this.log.debug(`onOff update failed: ${e.message}`));
  }

  setReachable(uuid, reachable) {
    const m = this.api.matter;
    m.getAccessoryState(uuid, m.clusterNames.BridgedDeviceBasicInformation)
      .then((info) => {
        if (info && info.reachable !== reachable) {
          return m.updateAccessoryState(uuid, m.clusterNames.BridgedDeviceBasicInformation, { reachable });
        }
        return undefined;
      })
      .catch((e) => this.log.debug(`reachable update failed: ${e.message}`));
  }
}

function nodeLabel(name, log) {
  if (Buffer.byteLength(name, 'utf8') <= NODE_LABEL_MAX_BYTES) return name;
  let out = name;
  while (Buffer.byteLength(out, 'utf8') > NODE_LABEL_MAX_BYTES) out = Array.from(out).slice(0, -1).join('');
  log.warn(`Button name "${name}" exceeds ${NODE_LABEL_MAX_BYTES} bytes — using "${out}".`);
  return out;
}
