# homebridge-switchbot-ir-matter

Publishes customized buttons of SwitchBot virtual IR remotes ("Others" / DIY) as **Matter On/Off Plug-in Units**, so Matter controllers such as Alexa can press them — for example in routines — without going through SwitchBot scenes.

Each configured button becomes one outlet. Turning it **on sends that button once** through the SwitchBot OpenAPI (`POST /v1.1/devices/{deviceId}/commands`, `commandType: "customize"`); after the cloud accepts it, the outlet falls back to **off** by itself.

## Scope and support

- This is a reference implementation built for one setup. It is shared as is, with no support; issues and pull requests may go unanswered.
- It is not affiliated with SwitchBot. Use it only with your own SwitchBot account and devices.
- Infrared gives no feedback: neither the plugin nor the controller can tell whether the device acted. Do not use it for safety- or security-relevant devices.

## Why not the official plugin?

As of `@switchbot/homebridge-switchbot` 5.0.3, IR "Others" remotes fall back to a generic device that sends `commandType: "command"` and derives its Matter clusters from device status, which virtual IR remotes do not have. The 4.x `customOn`/`customOff` options were HAP-only and limited to two buttons.

## Behavior

- **One press per turn-on, never retried.** An IR command that arrives late and is retried can fire twice. A second request for a button whose first request is still in flight is refused with Matter `Busy`; other buttons are independent.
- **Success means "accepted by the SwitchBot cloud"** (`statusCode 100`), not "the device moved": IR has no feedback. Any other result is returned to the controller as a failure and the outlet stays off.
- **No state is invented.** The on/off state never represents the device's position or power, so pressing "down" twice sends "down" twice.
- **Reachability.** `statusCode 161`/`171` (device/hub offline) marks the outlet unreachable until the next accepted command.
- **No polling.** The API is called only when a button is pressed (the OpenAPI allows 10,000 calls per day).
- **Stable IDs** derived from `deviceId` and button name; cached buttons that are no longer configured are removed.

## Setup

1. Get the OpenAPI token and secret in the SwitchBot app (Profile → Preferences → tap *App Version* 10 times → Developer Options) and store them in a file only you can read — not in `config.json`:

   ```bash
   mkdir -p ~/.config/switchbot-ir && chmod 700 ~/.config/switchbot-ir
   (umask 077; ${EDITOR:-nano} ~/.config/switchbot-ir/credentials.json)   # {"token": "...", "secret": "..."}
   ```

2. Find the remote's `deviceId` and try a button (one request, no retry; `--observe` records when you press Enter as the device moves):

   ```bash
   node tools/switchbot-probe.mjs list
   node tools/switchbot-probe.mjs send --device <deviceId> --button "<name>" --observe
   ```

   The `list` output contains your device IDs and device names (often room names), so redact it before sharing.

3. Configure the platform on its own child bridge with Matter enabled:

   ```json
   {
     "platform": "SwitchBotIRMatter",
     "name": "SwitchBot IR",
     "buttons": [
       { "deviceId": "02-XXXXXXXXXXXX-XXXXXXXX", "button": "Down", "name": "Screen Down" },
       { "deviceId": "02-XXXXXXXXXXXX-XXXXXXXX", "button": "Up",   "name": "Screen Up" },
       { "deviceId": "02-XXXXXXXXXXXX-XXXXXXXX", "button": "Stop", "name": "Screen Stop" }
     ],
     "_bridge": { "username": "…", "port": 51234, "matter": { "port": 5540 } }
   }
   ```

   `button` must match the name registered in the SwitchBot app exactly. `name` is what the controller shows (max 32 bytes). Optional: `credentialsFile` (default `~/.config/switchbot-ir/credentials.json`), `resetMs` (default 1000).

## Development

No runtime dependencies. `npm test` runs the platform and the real API client against a fake `fetch` and an in-memory stand-in for `api.matter` (Node.js 22/24, Homebridge 2.x).

## License

MIT
