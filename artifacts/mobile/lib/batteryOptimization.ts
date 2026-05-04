import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";

import { CmdsLocation } from "../modules/cmds-location";

// Markeer dat de gebruiker de OEM-instructies heeft gezien. Voorkomt dat
// we de OEM-modal elke keer opnieuw tonen na de hard-gate.
const OEM_INSTRUCTIONS_DONE_KEY = "cmds.oemInstructionsDone";

/**
 * Echte roundtrip-check via Android PowerManager.isIgnoringBatteryOptimizations.
 * Dit is de bron-van-waarheid voor de hard-gate modal: alleen wanneer dit true
 * teruggeeft mag de modal verdwijnen. Op iOS altijd true (niet van toepassing).
 */
export async function isBatteryOptIgnoredNative(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  try {
    return await CmdsLocation.isBatteryOptimizationIgnored();
  } catch {
    return false;
  }
}

export async function hasSeenOemInstructions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const val = await AsyncStorage.getItem(OEM_INSTRUCTIONS_DONE_KEY);
  return val === "1";
}

export async function markOemInstructionsDone(): Promise<void> {
  await AsyncStorage.setItem(OEM_INSTRUCTIONS_DONE_KEY, "1");
}

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
 * Probeert het Android-systeemdialoogvenster te openen dat de gebruiker vraagt
 * om de app uit te sluiten van batterijoptimalisatie.
 *
 * Vereist android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS in het manifest
 * (toegevoegd via app.plugin.js). Zonder die permissie gooit Android een
 * SecurityException die stil wordt gevangen.
 *
 * Fallback-keten:
 *   1. REQUEST_IGNORE_BATTERY_OPTIMIZATIONS  — direct pop-up "Toestaan / Weigeren"
 *   2. IGNORE_BATTERY_OPTIMIZATION_SETTINGS  — lijst van alle apps; gebruiker scrolt naar CMDS
 *   3. APPLICATION_DETAILS_SETTINGS          — app-infopagina; gebruiker tikt Batterij → Onbeperkt
 *
 * Geeft true als minstens één scherm geopend is, false als alles mislukt.
 */
export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const pkg = getAndroidPackage();
  if (!pkg) return false;

  // Poging 1: directe systeem-popup (vereist REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permissie)
  try {
    await IntentLauncher.startActivityAsync(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      { data: `package:${pkg}` },
    );
    return true;
  } catch {
    // Permissie ontbreekt, of OEM blokkeert dit intent → volgende poging
  }

  // Poging 2: lijst van alle apps met batterijoptimalisatie-instellingen
  try {
    await IntentLauncher.startActivityAsync(
      "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS",
    );
    return true;
  } catch {
    // Sommige OEMs (MIUI, EMUI) ondersteunen dit scherm niet → volgende poging
  }

  // Poging 3: app-detailpagina → gebruiker tikt zelf op "Batterij" → "Geen beperkingen"
  return openAppDetailsSettings();
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
