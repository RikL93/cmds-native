import { Platform } from "react-native";

export type ServiceConfig = {
  callSign: string;
  unitId: string;
  eventId?: string | null;
  organizationId?: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

type Subscription = { remove: () => void };
type Listener = (event: Record<string, unknown>) => void;

type NativeMod = {
  startService(config: ServiceConfig): Promise<void>;
  stopService(): Promise<void>;
  isServiceRunning(): Promise<boolean>;
  updateTokens(
    accessToken: string,
    refreshToken: string,
    expiresAt: number
  ): Promise<void>;
  getQueueSize(): Promise<number>;
  getAccessToken(): Promise<string | null>;
  requestBatteryOptimizationExemption(): Promise<void>;
  pushCurrentTokenToWebView(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

type Emitter = { addListener(name: string, listener: Listener): Subscription };

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access */
const _mod: NativeMod | null = (() => {
  if (Platform.OS !== "android") return null;
  try {
    return (
      require("expo-modules-core") as {
        requireNativeModule: (name: string) => NativeMod;
      }
    ).requireNativeModule("CmdsLocation");
  } catch {
    return null;
  }
})();

const _emitter: Emitter | null = (() => {
  if (!_mod) return null;
  try {
    const core = require("expo-modules-core") as {
      EventEmitter: new (mod: NativeMod) => Emitter;
    };
    return new core.EventEmitter(_mod);
  } catch {
    return null;
  }
})();
/* eslint-enable */

export const CmdsLocation = {
  startService: (config: ServiceConfig): Promise<void> =>
    _mod?.startService(config) ?? Promise.resolve(),

  stopService: (): Promise<void> => _mod?.stopService() ?? Promise.resolve(),

  isServiceRunning: (): Promise<boolean> =>
    _mod?.isServiceRunning() ?? Promise.resolve(false),

  updateTokens: (
    accessToken: string,
    refreshToken: string,
    expiresAt: number
  ): Promise<void> =>
    _mod?.updateTokens(accessToken, refreshToken, expiresAt) ??
    Promise.resolve(),

  getQueueSize: (): Promise<number> =>
    _mod?.getQueueSize() ?? Promise.resolve(0),

  getAccessToken: (): Promise<string | null> =>
    _mod?.getAccessToken() ?? Promise.resolve(null),

  requestBatteryOptimizationExemption: (): Promise<void> =>
    _mod?.requestBatteryOptimizationExemption() ?? Promise.resolve(),

  pushCurrentTokenToWebView: (): Promise<void> =>
    _mod?.pushCurrentTokenToWebView() ?? Promise.resolve(),

  addListener: (
    eventName: string,
    listener: Listener
  ): Subscription | null =>
    _emitter?.addListener(eventName, listener) ?? null,
};
