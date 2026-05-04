const { withAndroidManifest } = require("@expo/config-plugins");

/**
 * Config plugin: voegt de LocationTrackingService en RECEIVE_BOOT_COMPLETED
 * toe aan AndroidManifest.xml tijdens expo prebuild / EAS build.
 *
 * @param {import('@expo/config-plugins').ExpoConfig} config
 */
module.exports = function withCmdsLocation(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = manifest.manifest.application?.[0];
    if (!app) return cfg;

    if (!app.service) app.service = [];

    const serviceExists = app.service.some(
      (s) =>
        s.$?.["android:name"] === "nl.cmds.location.LocationTrackingService"
    );
    if (!serviceExists) {
      app.service.push({
        $: {
          "android:name": "nl.cmds.location.LocationTrackingService",
          "android:enabled": "true",
          "android:exported": "false",
          "android:foregroundServiceType": "location",
        },
      });
    }

    if (!manifest.manifest["uses-permission"]) {
      manifest.manifest["uses-permission"] = [];
    }
    const addPerm = (name) => {
      const exists = manifest.manifest["uses-permission"].some(
        (p) => p.$?.["android:name"] === name
      );
      if (!exists) {
        manifest.manifest["uses-permission"].push({ $: { "android:name": name } });
      }
    };
    addPerm("android.permission.RECEIVE_BOOT_COMPLETED");
    addPerm("android.permission.WAKE_LOCK");
    // Vereist voor android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS intent:
    // zonder deze permissie in het manifest gooit Android een SecurityException
    // waardoor het dialoogvenster nooit verschijnt.
    addPerm("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS");

    return cfg;
  });
};
