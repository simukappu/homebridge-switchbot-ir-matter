import { PLATFORM_NAME, PLUGIN_NAME, SwitchBotIRMatterPlatform } from './src/platform.js';

export default (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SwitchBotIRMatterPlatform);
};
