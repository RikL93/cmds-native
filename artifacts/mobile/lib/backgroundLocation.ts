import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import {
  fetchLinkedUnitStatus,
  getOrRefreshLinkedUnitStatus,
  invalidateLinkedUnitCache,
  type LinkedUnitStatus,
} from "./linkedUnit";
import {
  ACCESS_TOKEN_KEY,
  getCachedAccessToken,
  getTokenExpiresAt,
  invalidateExpiresAtCache,
  refreshSupabaseTokenNative,
  updateAccessToken as _updateAccessToken,
} from "./supabaseRefresh";

// Re-export updateAccessToken so app/index.tsx can keep importing it from here.
export { updateAccessToken } from "./supabaseRefresh";

export const LOCATION_TASK_NAME = "cmds-background-location-task";
export const LOCATION_ENDPOINT =
  "https://txauyjkivyzgxetmadkj.supabase.co/functions/v1/ingest-location";

// Keep the old export name for any external references.
export { ACCESS_TOKEN_KEY as SUPABASE_TOKEN_STORAGE_KEY } from "./supabaseRefresh";
export const DIAGNOSTICS_STORAGE_KEY = "cmds.diagnostics";

const BACKGROUND_LINKED_CHECK_TTL_MS = 30_000;
const FOREGROUND_LINKED_CHECK_TTL_MS = 60_000; // cache whoami 60s — saves ~6 req/min/device

type BackgroundTaskBody = {
  data?: { locations?: Location.LocationObject[] };
  error?: TaskManager.TaskManagerError | null;
};

export type Diagnostics = {
  lastBackgroundFixAt: string | null;
  lastBackgroundLat: number | null;
  lastBackgroundLng: number | null;
  lastPostAt: string | null;
  lastPostStatus: number | null;
  lastPostError: string | null;
  lastPostBody: string | null;
  lastPostSource: string | null;
  postSuccessCount: number;
  postFailureCount: number;
  postSkippedCount: number;
  lastSkipReason: string | null;
  lastTokenSeenAt: string | null;
  lastTokenLength: number;
  lastLinkedCheckAt: string | null;
  lastLinkedStatus: "linked" | "no_unit" | "token_invalid" | "error" | null;
  lastLinkedCallSign: string | null;
  lastLinkedError: string | null;
};

const DEFAULT_DIAGNOSTICS: Diagnostics = {
  lastBackgroundFixAt: null,
  lastBackgroundLat: null,
  lastBackgroundLng: null,
  lastPostAt: null,
  lastPostStatus: null,
  lastPostError: null,
  lastPostBody: null,
  lastPostSource: null,
  postSuccessCount: 0,
  postFailureCount: 0,
  postSkippedCount: 0,
  lastSkipReason: null,
  lastTokenSeenAt: null,
  lastTokenLength: 0,
  lastLinkedCheckAt: null,
  lastLinkedStatus: null,
  lastLinkedCallSign: null,
  lastLinkedError: null,
};

// ---------------------------------------------------------------------------
// FIX 1: Module-level last-known-location cache.
// The watchPositionAsync watcher in app/index.tsx calls updateLastKnownLocation
// on every fix. postForegroundLocation() reads from here instead of calling
// getCurrentPositionAsync(), which can hang for 30-60s without a satellite fix.
// ---------------------------------------------------------------------------
let _lastKnownLocation: Location.LocationObject | null = null;

// Throttle: postForegroundLocation() is now called directly from the watcher
// callback (every ~5s). We only actually POST every 10s so the backend sees
// roughly the same rate as before without a separate setInterval.
let _lastForegroundPostTime = 0;
const FOREGROUND_POST_THROTTLE_MS = 10_000;

export function updateLastKnownLocation(loc: Location.LocationObject): void {
  _lastKnownLocation = loc;
}

export function getLastKnownLocation(): Location.LocationObject | null {
  return _lastKnownLocation;
}

export async function getDiagnostics(): Promise<Diagnostics> {
  try {
    const raw = await AsyncStorage.getItem(DIAGNOSTICS_STORAGE_KEY);
    if (!raw) return DEFAULT_DIAGNOSTICS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_DIAGNOSTICS, ...parsed };
  } catch {
    return DEFAULT_DIAGNOSTICS;
  }
}

async function patchDiagnostics(patch: Partial<Diagnostics>): Promise<void> {
  try {
    const current = await getDiagnostics();
    const next = { ...current, ...patch };
    await AsyncStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Diagnostics storage failures are non-critical.
  }
}

export async function clearDiagnostics(): Promise<void> {
  await AsyncStorage.removeItem(DIAGNOSTICS_STORAGE_KEY);
}

export function diagnosticsPatchFromLinkedStatus(
  status: LinkedUnitStatus,
): Partial<Diagnostics> {
  let label: Diagnostics["lastLinkedStatus"];
  if (status.tokenInvalid) {
    label = "token_invalid";
  } else if (status.error) {
    label = "error";
  } else if (status.linked) {
    label = "linked";
  } else {
    label = "no_unit";
  }
  return {
    lastLinkedCheckAt: status.checkedAt,
    lastLinkedStatus: label,
    lastLinkedCallSign: status.unit?.call_sign ?? null,
    lastLinkedError: status.error,
  };
}

export async function setSupabaseAccessToken(
  token: string | null,
): Promise<void> {
  _updateAccessToken(token); // keeps in-memory cache in sync immediately
  if (token && token.length > 0) {
    await AsyncStorage.setItem(ACCESS_TOKEN_KEY, token);
    await patchDiagnostics({
      lastTokenSeenAt: new Date().toISOString(),
      lastTokenLength: token.length,
    });
  } else {
    await AsyncStorage.removeItem(ACCESS_TOKEN_KEY);
    await patchDiagnostics({ lastTokenLength: 0 });
  }
}

export async function getSupabaseAccessToken(): Promise<string | null> {
  // Prefer in-memory cache (updated synchronously by bridge events and native refresh).
  const cached = getCachedAccessToken();
  if (cached !== null) return cached;
  // Cold start: prime the cache from AsyncStorage.
  const stored = await AsyncStorage.getItem(ACCESS_TOKEN_KEY);
  _updateAccessToken(stored);
  return stored;
}

export const ACTIVE_UNIT_ID_KEY = "cmds_active_unit_id";

/**
 * Build the exact JSON body that the ingest-location edge function expects.
 * Snake_case as documented by the Lovable backend.
 * unit_id is included when available so the Edge Function targets the correct
 * unit regardless of which Supabase account the native shell is logged in as.
 */
function buildPayload(
  location: Location.LocationObject,
  source: string,
  unitId: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: location.coords.accuracy,
    altitude: location.coords.altitude,
    altitude_accuracy: location.coords.altitudeAccuracy,
    speed: location.coords.speed,
    heading: location.coords.heading,
    recorded_at: new Date(location.timestamp).toISOString(),
    source,
  };
  if (unitId) body.unit_id = unitId;
  return body;
}

/**
 * Low-level POST. Returns the HTTP status (or null on network error).
 */
async function postLocation(
  payload: Record<string, unknown>,
  accessToken: string,
  source: string,
): Promise<number | null> {
  const startedAt = Date.now();
  console.log(
    `[CMDS-GPS] before-fetch ingest-location lat=${payload.latitude} lng=${payload.longitude} source=${source} tokenLen=${accessToken.length}`,
  );
  try {
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(LOCATION_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(abortTimer);
    }
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = "";
    }
    const took = Date.now() - startedAt;
    console.log(
      `[CMDS-GPS] after-fetch ingest-location status=${response.status} ms=${took} body=${bodyText.slice(0, 120)} source=${source}`,
    );
    const current = await getDiagnostics();
    if (response.ok) {
      await patchDiagnostics({
        lastPostAt: new Date().toISOString(),
        lastPostStatus: response.status,
        lastPostError: null,
        lastPostBody: bodyText.slice(0, 500),
        lastPostSource: source,
        postSuccessCount: current.postSuccessCount + 1,
      });
    } else {
      await patchDiagnostics({
        lastPostAt: new Date().toISOString(),
        lastPostStatus: response.status,
        lastPostError: `HTTP ${response.status}: ${bodyText.slice(0, 120)}`,
        lastPostBody: bodyText.slice(0, 500),
        lastPostSource: source,
        postFailureCount: current.postFailureCount + 1,
      });
    }
    return response.status;
  } catch (e) {
    const took = Date.now() - startedAt;
    const errMsg = e instanceof Error ? e.message : String(e);
    console.log(
      `[CMDS-GPS] POST /ingest-location → NETWORK ERROR ${errMsg}, took=${took}ms (source=${source})`,
    );
    const current = await getDiagnostics();
    await patchDiagnostics({
      lastPostAt: new Date().toISOString(),
      lastPostStatus: null,
      lastPostError: errMsg,
      lastPostBody: null,
      lastPostSource: source,
      postFailureCount: current.postFailureCount + 1,
    });
    return null;
  }
}

async function recordSkip(reason: string, source: string): Promise<void> {
  const current = await getDiagnostics();
  console.log(`[CMDS-GPS] SKIP /ingest-location → ${reason} (source=${source})`);
  await patchDiagnostics({
    postSkippedCount: current.postSkippedCount + 1,
    lastSkipReason: reason,
    lastPostSource: source,
  });
}

/**
 * Posts a single location fix via /ingest-location after passing the
 * linked-unit gate.
 *
 * FIX 2: 401 retry with fresh token.
 * If the edge function returns 401 (token expired), we immediately re-read
 * the token from AsyncStorage — the website's autoRefreshToken may have
 * updated it already — and retry once with the new token.
 */
export async function postLocationIfLinked(
  location: Location.LocationObject,
  source: string,
  linkedTtlMs: number,
): Promise<void> {
  console.log(`[CMDS-GPS] postLocationIfLinked called (source=${source})`);
  let accessToken = await getSupabaseAccessToken();
  if (!accessToken) {
    console.log("POST ingest-location SKIP: no token", { source });
    await recordSkip("geen token — log in op de website", source);
    return;
  }

  // ── Proactieve refresh ──────────────────────────────────────────────────
  // Als het token binnen 120s verloopt, refresh het NU — vóór de POST — zodat
  // de GPS-loop blijft werken ook al is de WebView al >1 uur gepauzeerd.
  const expiresAt = await getTokenExpiresAt();
  const nowSec = Math.floor(Date.now() / 1000);
  if (expiresAt !== null && expiresAt - nowSec < 120) {
    console.log(
      `[CMDS-GPS] token verloopt over ${expiresAt - nowSec}s — proactieve refresh`,
    );
    const refreshed = await refreshSupabaseTokenNative();
    if (refreshed) {
      accessToken = refreshed.accessToken;
      invalidateLinkedUnitCache(); // whoami opnieuw checken met nieuw token
      invalidateExpiresAtCache();
    }
  }

  const linkedStatus = await getOrRefreshLinkedUnitStatus(
    accessToken,
    linkedTtlMs,
  );
  await patchDiagnostics(diagnosticsPatchFromLinkedStatus(linkedStatus));

  if (linkedStatus.tokenInvalid) {
    await recordSkip("token verlopen — sync token via website", source);
    return;
  }
  if (!linkedStatus.linked) {
    await recordSkip(
      "geen gekoppelde eenheid — kies een call sign in CMDS",
      source,
    );
    return;
  }

  const unitId = await AsyncStorage.getItem(ACTIVE_UNIT_ID_KEY);
  console.log(`[CMDS-GPS] unit_id=${unitId ?? "-"} (source=${source})`);
  const payload = buildPayload(location, source, unitId);
  let status = await postLocation(payload, accessToken, source);

  // ── Reactieve 401-retry ─────────────────────────────────────────────────
  // Volgorde: 1) native refresh proberen, 2) fallback op storage re-read.
  if (status === 401) {
    console.log(
      "[CMDS-GPS] 401 ontvangen — native token refresh proberen",
    );

    // Stap a: probeer te refreshen via het Supabase auth-endpoint.
    const refreshed = await refreshSupabaseTokenNative();
    if (refreshed) {
      accessToken = refreshed.accessToken;
      invalidateLinkedUnitCache();
      status = await postLocation(payload, accessToken, source);
      console.log(
        `[CMDS-GPS] retry na native refresh → status=${status}`,
      );
    } else {
      // Stap b: fallback — misschien heeft de WebView het token al ververst
      // in AsyncStorage terwijl de native refresh faalde (bv. offline).
      const storedToken = await AsyncStorage.getItem(ACCESS_TOKEN_KEY);
      if (storedToken && storedToken !== accessToken) {
        accessToken = storedToken;
        _updateAccessToken(storedToken);
        invalidateLinkedUnitCache();
        status = await postLocation(payload, accessToken, source);
        console.log(
          `[CMDS-GPS] retry na storage re-read → status=${status}`,
        );
      } else {
        console.log(
          "[CMDS-GPS] retry overgeslagen — geen nieuwer token beschikbaar",
        );
      }
    }

    if (status === 401) {
      console.log("[CMDS-GPS] AUTH FAILED — refresh exhausted");
    }
  }
}

if (Platform.OS !== "web" && !TaskManager.isTaskDefined(LOCATION_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_TASK_NAME, async (body) => {
    const { data, error } = body as BackgroundTaskBody;
    console.log(
      `[CMDS-GPS] background task fired (locations=${data?.locations?.length ?? 0}, error=${error?.message ?? "none"})`,
    );

    if (error) {
      console.log(`[CMDS-GPS] background task error: ${error.message}`);
      await patchDiagnostics({
        lastPostError: `task error: ${error.message ?? "unknown"}`,
      });
      return;
    }

    const locations = data?.locations;
    if (!locations || locations.length === 0) {
      console.log("[CMDS-GPS] background task fired but no locations in payload");
      return;
    }

    const lastLocation = locations[locations.length - 1];
    if (lastLocation) {
      // Update the shared cache so the foreground POST loop always has a
      // fresh location even when watchPositionAsync hasn't fired yet.
      updateLastKnownLocation(lastLocation);
      await patchDiagnostics({
        lastBackgroundFixAt: new Date(lastLocation.timestamp).toISOString(),
        lastBackgroundLat: lastLocation.coords.latitude,
        lastBackgroundLng: lastLocation.coords.longitude,
      });
    }

    for (const location of locations) {
      await postLocationIfLinked(
        location,
        "expo-bg",
        BACKGROUND_LINKED_CHECK_TTL_MS,
      );
    }
  });
}

export async function startBackgroundLocation(): Promise<void> {
  if (Platform.OS === "web") return;

  const alreadyStarted =
    await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (alreadyStarted) {
    return;
  }

  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
    accuracy: Location.Accuracy.High,
    timeInterval: 30_000,
    distanceInterval: 0,
    deferredUpdatesInterval: 30_000,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: "CMDS deelt je locatie",
      notificationBody:
        "GPS wordt op de achtergrond gedeeld met cmdsevent.nl.",
      notificationColor: "#0b1d3a",
    },
  });
}

export async function stopBackgroundLocation(): Promise<void> {
  if (Platform.OS === "web") return;

  const isStarted =
    await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (isStarted) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }
}

export async function isBackgroundLocationActive(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
}

/**
 * FIX 3: Called directly from the watchPositionAsync callback (every ~5s).
 * Throttles to one POST per FOREGROUND_POST_THROTTLE_MS so the backend
 * receives ≈1 update per 10s — identical to the old setInterval approach
 * but without a second concurrent ticker causing duplicate triggers.
 *
 * Uses the location passed in directly (already the freshest fix) instead
 * of reading from _lastKnownLocation, so there is no staleness window.
 */
export async function postForegroundLocation(
  location: Location.LocationObject,
): Promise<void> {
  if (Platform.OS === "web") return;

  const now = Date.now();
  if (now - _lastForegroundPostTime < FOREGROUND_POST_THROTTLE_MS) {
    return; // throttled — watcher fires faster than our desired POST rate
  }
  _lastForegroundPostTime = now;

  await postLocationIfLinked(location, "expo-fg", FOREGROUND_LINKED_CHECK_TTL_MS);
}

export type TestPingResult = {
  ok: boolean;
  status: number | null;
  body: string;
  error: string | null;
  skipped: boolean;
  skipReason: string | null;
  linkedCallSign: string | null;
};

export async function sendTestPing(): Promise<TestPingResult> {
  if (Platform.OS === "web") {
    return {
      ok: false,
      status: null,
      body: "",
      error: "web not supported",
      skipped: false,
      skipReason: null,
      linkedCallSign: null,
    };
  }

  const accessToken = await getSupabaseAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      status: null,
      body: "",
      error: "no access token in storage — log in to the website first",
      skipped: false,
      skipReason: null,
      linkedCallSign: null,
    };
  }

  const linkedStatus = await fetchLinkedUnitStatus(accessToken);
  await patchDiagnostics(diagnosticsPatchFromLinkedStatus(linkedStatus));

  if (linkedStatus.tokenInvalid) {
    return {
      ok: false,
      status: 401,
      body: "",
      error: "token verlopen — sync token via de website",
      skipped: true,
      skipReason: "token_invalid",
      linkedCallSign: null,
    };
  }
  if (!linkedStatus.linked) {
    return {
      ok: false,
      status: linkedStatus.httpStatus,
      body: "",
      error:
        linkedStatus.error ??
        "geen gekoppelde eenheid — kies een call sign in CMDS",
      skipped: true,
      skipReason: "no_linked_unit",
      linkedCallSign: null,
    };
  }

  // For manual test, prefer cached location; fall back to fresh GPS fix.
  let coords = _lastKnownLocation;
  if (!coords) {
    try {
      coords = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
    } catch (e) {
      return {
        ok: false,
        status: null,
        body: "",
        error: e instanceof Error ? e.message : String(e),
        skipped: false,
        skipReason: null,
        linkedCallSign: linkedStatus.unit?.call_sign ?? null,
      };
    }
  }

  const unitId = await AsyncStorage.getItem(ACTIVE_UNIT_ID_KEY);
  await postLocation(
    buildPayload(coords, "manual-test", unitId),
    accessToken,
    "manual-test",
  );
  const updated = await getDiagnostics();
  return {
    ok: updated.lastPostStatus
      ? updated.lastPostStatus >= 200 && updated.lastPostStatus < 300
      : false,
    status: updated.lastPostStatus,
    body: updated.lastPostBody ?? "",
    error: updated.lastPostError,
    skipped: false,
    skipReason: null,
    linkedCallSign: linkedStatus.unit?.call_sign ?? null,
  };
}
