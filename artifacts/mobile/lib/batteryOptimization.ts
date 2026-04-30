import Constants from "expo-constants";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";

/**
 * Returns the Android package id for this build (e.g. "nl.cmds.app").
 * Falls back to null on iOS or when unknown.
 */
function getAndroidPackage(): string | null {
  if (Platform.OS !== "android") return null;
  const fromExpo =
    Constants.expoConfig?.android?.package ??
    (Constants.manifest2 as { extra?: { expoClient?: { android?: { package?: string } } } } | null)
      ?.extra?.expoClient?.android?.package;
  return fromExpo ?? "nl.cmds.app";
}

/**
 * Opens the Android system dialog that asks the user to exempt this app from
 * battery optimisation. After "Toestaan" the OS will no longer kill the
 * background location service to save battery.
 *
 * Returns true if the dialog was launched, false on iOS or when no Android
 * package id is available.
 */
export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const pkg = getAndroidPackage();
  if (!pkg) return false;
  try {
    await IntentLauncher.startActivityAsync(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      { data: `package:${pkg}` },
    );
    return true;
  } catch {
    // Fallback: open the global battery optimisation list so the user can
    // toggle it manually for CMDS.
    try {
      await IntentLauncher.startActivityAsync(
        "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS",
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Opens this app's detailed system info screen. From there the user can
 * disable any per-OEM "battery saver" rule (Xiaomi MIUI, Samsung One UI,
 * Huawei EMUI, OnePlus, etc.) that would otherwise kill background services.
 */
export async function openAppDetailsSettings(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const pkg = getAndroidPackage();
  if (!pkg) return false;
  try {
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
      { data: `package:${pkg}` },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the system "auto-start" / "background apps" management screen on
 * Android — the exact intent depends on OEM. We try a few in order.
 */
export async function openOemAutoStartSettings(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  // Falls back to app details which exists on every Android version.
  return openAppDetailsSettings();
}
