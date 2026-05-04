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
  SUPABASE_ANON_KEY,
  updateAccessToken as _updateAccessToken,
} from "./supabaseRefresh";
import { logIngest } from "./ingestLog";
import { emitBridgeEvent } from "./bridgeEvents";
import { drainQueue, enqueueLocation } from "./locationQueue";
import { CmdsLocation } from "../modules/cmds-location";

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

// Sleutel voor cross-context post-throttle (AsyncStorage → werkt ook tussen
// afzonderlijke Expo background task instances die Doze tegelijk loslaat).
const GLOBAL_LAST_POST_STARTED_KEY = "cmds_gps_last_post_started";
// Maximaal 1 GPS-post per 8 seconden, ongeacht bron. Voorkomt de burst van
// 4-5 gelijktijdige expo-bg posts die Android vrijlaat na een Doze-periode.
const GLOBAL_POST_THROTTLE_MS = 8_000;

// In-memory guard: verhindert gelijktijdige post-pogingen BINNEN dezelfde
// JS-context (bijv. foreground watcher + background task die tegelijk starten).
// Aparte background-task instanties starten elk met _postInFlight = false;
// voor cross-context throttling gebruikt postLocationIfLinked AsyncStorage.
let _postInFlight = false;

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

// Bewaar het actieve callSign zodat startBackgroundLocation() weet of de
// foreground-service notificatie bijgewerkt moet worden.
// In-memory: wordt bij JS-runtime-kill gereset naar null. Persisted via
// AsyncStorage zodat we na een achtergrond-kill niet onnodig stop+herstart.
let _activeCallSign: string | null = null;
const ACTIVE_CALL_SIGN_KEY = "cmds_active_call_sign_service";

// Mutex: voorkomt gelijktijdige startBackgroundLocation() aanroepen die
// elk een stop+herstart triggeren (race condition bij AppState+onUnitLinked).
let _startLocationInProgress = false;

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
  const isoTime = new Date(location.timestamp).toISOString();
  const body: Record<string, unknown> = {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: location.coords.accuracy,
    altitude: location.coords.altitude,
    altitude_accuracy: location.coords.altitudeAccuracy,
    speed: location.coords.speed,
    heading: location.coords.heading,
    recorded_at: isoTime,
    // CRITICAL FIX: edge function verwacht timestamp als number (ms), niet als ISO string.
    // Fout was: {"error":"Invalid body","details":{"timestamp":["Expected number, received string"]}}
    timestamp: location.timestamp, // number (ms epoch)
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
  void logIngest("post_attempt", {
    url: LOCATION_ENDPOINT,
    hasToken: true,
    unitId: typeof payload.unit_id === "string" ? payload.unit_id : null,
    lat: payload.latitude as number,
    lng: payload.longitude as number,
    source,
  });
  try {
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(LOCATION_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
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
    void logIngest("post_response", {
      httpStatus: response.status,
      responseBody: bodyText.slice(0, 500),
      source,
    });
    if (response.ok) {
      await patchDiagnostics({
        lastPostAt: new Date().toISOString(),
        lastPostStatus: response.status,
        lastPostError: null,
        lastPostBody: bodyText.slice(0, 500),
        lastPostSource: source,
        postSuccessCount: current.postSuccessCount + 1,
      });
      // Bridge event → WebView (ingest-diagnose panel / map status indicator).
      // Werkt alleen vanuit foreground context; achtergrond-tasks negeren dit.
      emitBridgeEvent("onLocationPosted", {
        status: response.status,
        source,
        lat: payload.latitude,
        lng: payload.longitude,
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
      // Niet-netwerk fout (bijv. 400, 500) — willRetry=false, niet enqueueable
      if (source !== "queue-retry") {
        emitBridgeEvent("onLocationPostError", {
          status: response.status,
          message: `HTTP ${response.status}`,
          willRetry: false,
          source,
        });
      }
    }
    return response.status;
  } catch (e) {
    const took = Date.now() - startedAt;
    const errMsg = e instanceof Error ? e.message : String(e);
    console.log(
      `[CMDS-GPS] POST /ingest-location → NETWORK ERROR ${errMsg}, took=${took}ms (source=${source})`,
    );
    void logIngest("post_response", { error: errMsg, source });
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
  void logIngest("skip", { skipReason: reason, source });
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
/**
 * skipTokenRefresh: als true worden ALLE token-refresh pogingen overgeslagen
 * (zowel proactief als reactief op 401). Gebruik dit op Android in de Expo
 * background task om token-conflicts met de Kotlin SupabaseTokenManager te
 * voorkomen: de Kotlin service beheert tokens via SharedPreferences; als de
 * Expo task ook probeert te refreshen met een (mogelijk verouderd) refresh_token
 * uit AsyncStorage, roteren beide gelijktijdig → "refresh_token_already_used"
 * → Supabase revoceert de sessie → gedwongen logout.
 *
 * Met skipTokenRefresh=true POST de Expo task gewoon met het huidige token.
 * Bij 401 slaat hij over (de Kotlin service zorgt voor een vers token).
 */
export async function postLocationIfLinked(
  location: Location.LocationObject,
  source: string,
  linkedTtlMs: number,
  options: { skipTokenRefresh?: boolean } = {},
): Promise<void> {
  // ── In-memory guard (binnen dezelfde JS-context) ─────────────────────────
  // Verhindert dat de foreground watcher en de background task gelijktijdig
  // een POST starten in dezelfde JS-runtime. Aparte background-task instances
  // starten elk met _postInFlight = false; die worden door de AsyncStorage-
  // throttle hieronder beperkt.
  if (_postInFlight) {
    console.log(`[CMDS-GPS] in-memory guard: al een post in-flight — skip (source=${source})`);
    return;
  }
  _postInFlight = true;
  try {
    await _postLocationIfLinkedInner(location, source, linkedTtlMs, options);
  } finally {
    _postInFlight = false;
  }
}

async function _postLocationIfLinkedInner(
  location: Location.LocationObject,
  source: string,
  linkedTtlMs: number,
  options: { skipTokenRefresh?: boolean } = {},
): Promise<void> {
  const skipTokenRefresh = options.skipTokenRefresh ?? false;
  console.log(`[CMDS-GPS] postLocationIfLinked called (source=${source} skipRefresh=${skipTokenRefresh})`);
  let accessToken = await getSupabaseAccessToken();

  // ── Native token fallback (Android met skipTokenRefresh=true) ────────────
  // De Kotlin SupabaseTokenManager slaat tokens op in SharedPreferences.
  // Wanneer het scherm uit is, verwerkt de JS-laag de onSupabaseTokenRefreshed
  // events niet → AsyncStorage token wordt stale/null terwijl de Kotlin service
  // een geldig token heeft. In dat geval lezen we het token direct uit de
  // native SharedPreferences via CmdsLocation.getAccessToken().
  if (!accessToken && skipTokenRefresh && Platform.OS === "android") {
    console.log("[CMDS-GPS] AsyncStorage token null — probeer native token fallback");
    const nativeToken = await CmdsLocation.getAccessToken().catch(() => null);
    if (nativeToken) {
      console.log(`[CMDS-GPS] native token fallback gelukt (len=${nativeToken.length})`);
      accessToken = nativeToken;
      // Sync terug naar AsyncStorage zodat toekomstige calls geen fallback nodig hebben
      _updateAccessToken(nativeToken);
      await AsyncStorage.setItem(ACCESS_TOKEN_KEY, nativeToken);
    }
  }

  if (!accessToken) {
    console.log("POST ingest-location SKIP: no token", { source });
    await recordSkip("geen token — log in op de website", source);
    return;
  }

  // ── Globale cross-context post-throttle ─────────────────────────────────
  // Doze mode stelt Expo background task-uitvoeringen op en laat ze tegelijk
  // los bij de eerste maintenance window (scherm aan / netwerk beschikbaar).
  // AsyncStorage werkt cross-context (elke background task instance leest
  // dezelfde waarde) en beperkt zo de burst tot max 1 post per 8 seconden.
  const lastStartedRaw = await AsyncStorage.getItem(GLOBAL_LAST_POST_STARTED_KEY);
  if (lastStartedRaw) {
    const age = Date.now() - Number(lastStartedRaw);
    if (age >= 0 && age < GLOBAL_POST_THROTTLE_MS) {
      console.log(
        `[CMDS-GPS] global throttle: ${Math.round(age / 1000)}s since last post — skip (source=${source})`,
      );
      return;
    }
  }
  // Schrijf de timestamp VOOR de POST zodat concurrente calls deze zien.
  await AsyncStorage.setItem(GLOBAL_LAST_POST_STARTED_KEY, String(Date.now()));

  // ── Proactieve refresh ──────────────────────────────────────────────────
  // Op Android (expo-bg) overgeslagen: de Kotlin SupabaseTokenManager beheert
  // token-rotatie via SharedPreferences. Dubbele refresh → token-conflict.
  if (!skipTokenRefresh) {
    const expiresAt = await getTokenExpiresAt();
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiresAt !== null && expiresAt - nowSec < 2400) {
      console.log(
        `[CMDS-GPS] token verloopt over ${expiresAt - nowSec}s — proactieve refresh (drempel 2400s)`,
      );
      const refreshed = await refreshSupabaseTokenNative();
      if (refreshed) {
        accessToken = refreshed.accessToken;
        invalidateLinkedUnitCache();
        invalidateExpiresAtCache();
      }
    }
  }

  // ── Bridge unit_id pad ───────────────────────────────────────────────────
  // Als de WebView via onUnitLinked een unit_id heeft doorgegeven, vertrouwen
  // we dat volledig en slaan whoami-unit over. De Edge Function valideert de
  // combinatie van token + unit_id zelf. Dit lost het account-mismatch probleem
  // op waarbij de native shell als een ander account ingelogd is dan de WebView.
  const unitId = await AsyncStorage.getItem(ACTIVE_UNIT_ID_KEY);
  if (unitId) {
    console.log(
      `[CMDS-GPS] bridge unit_id=${unitId} — whoami-unit overgeslagen, direct POST`,
    );
    const payload = buildPayload(location, source, unitId);
    let status = await postLocation(payload, accessToken, source);

    if (status === 401 && !skipTokenRefresh) {
      console.log("[CMDS-GPS] 401 — native token refresh proberen (bridge pad)");
      const refreshed = await refreshSupabaseTokenNative();
      if (refreshed) {
        accessToken = refreshed.accessToken;
        status = await postLocation(payload, accessToken, source);
        console.log(`[CMDS-GPS] retry na native refresh → status=${status}`);
      } else {
        const storedToken = await AsyncStorage.getItem(ACCESS_TOKEN_KEY);
        if (storedToken && storedToken !== accessToken) {
          accessToken = storedToken;
          _updateAccessToken(storedToken);
          status = await postLocation(payload, accessToken, source);
          console.log(`[CMDS-GPS] retry na storage re-read → status=${status}`);
        }
      }
      if (status === 401) {
        console.log("[CMDS-GPS] AUTH FAILED — refresh exhausted (bridge pad)");
      }
    } else if (status === 401 && skipTokenRefresh) {
      console.log("[CMDS-GPS] 401 ontvangen maar skipTokenRefresh=true — skip (Kotlin service verversst token)");
    }

    // ── Queue/drain na bridge pad ────────────────────────────────────────
    if (status === null) {
      // Netwerkverlies — bewaar voor later
      await enqueueLocation(payload, accessToken, source);
    } else if (status >= 200 && status < 300) {
      // POST gelukt → update diagnostics zodat "Eenheid gekoppeld" en
      // "Eenheid laatst gecontroleerd" actueel blijven. Zonder dit worden
      // beide velden nooit bijgewerkt op de bridge-pad (whoami wordt
      // overgeslagen), waardoor de diagnostics bevroren blijven op de
      // laatste whoami-check (mogelijk uren of dagen geleden).
      const storedCallSign = await AsyncStorage.getItem(
        "cmds_active_unit_call_sign",
      );
      await patchDiagnostics({
        lastLinkedCheckAt: new Date().toISOString(),
        lastLinkedStatus: "linked",
        lastLinkedCallSign: storedCallSign,
        lastLinkedError: null,
      });
      if (source !== "queue-retry") {
        // POST gelukt → spoel pending queue door (non-blocking)
        void drainQueue((p, t, s) => postLocation(p, t, s), accessToken);
      }
    }
    return;
  }

  // ── Fallback: whoami-unit pad (geen bridge unit_id) ──────────────────────
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

  console.log(`[CMDS-GPS] whoami unit_id=${linkedStatus.unit?.id ?? "-"} (source=${source})`);
  const payload = buildPayload(location, source, linkedStatus.unit?.id ?? null);
  let status = await postLocation(payload, accessToken, source);

  // ── Reactieve 401-retry ─────────────────────────────────────────────────
  // Volgorde: 1) native refresh proberen, 2) fallback op storage re-read.
  // Op Android (skipTokenRefresh=true) overgeslagen: de Kotlin service zorgt
  // voor een vers token, de Expo task post de volgende keer met het nieuwe token.
  if (status === 401 && !skipTokenRefresh) {
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
  } else if (status === 401 && skipTokenRefresh) {
    console.log("[CMDS-GPS] 401 ontvangen maar skipTokenRefresh=true — skip (Kotlin service verversst token)");
  }

  // ── Queue/drain na whoami pad ────────────────────────────────────────────
  if (status === null) {
    // Netwerkverlies — bewaar voor later
    await enqueueLocation(payload, accessToken, source);
  } else if (status >= 200 && status < 300 && source !== "queue-retry") {
    // POST gelukt → spoel pending queue door (non-blocking)
    void drainQueue((p, t, s) => postLocation(p, t, s), accessToken);
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

    // Skip POST when Kotlin foreground service is the active poster (Android).
    // Avoids dual posters racing the unit_locations upsert (HTTP 500).
    if (Platform.OS === "android") {
      try {
        if (await CmdsLocation.isServiceRunning()) {
          await patchDiagnostics({
            lastSkipReason: "kotlin_primary_poster_running",
            postSkippedCount: (await getDiagnostics()).postSkippedCount + 1,
          });
          return;
        }
      } catch {
        // Module unavailable on older builds → fall through to JS POST.
      }
    }

    for (const location of locations) {
      await postLocationIfLinked(
        location,
        "expo-bg",
        BACKGROUND_LINKED_CHECK_TTL_MS,
        // Op Android beheert de Kotlin SupabaseTokenManager tokens via
        // SharedPreferences. De Expo task moet NOOIT zelf het token refreshen:
        // twee gelijktijdige refresh-pogingen → "refresh_token_already_used"
        // → Supabase revoceert de sessie → gedwongen logout.
        { skipTokenRefresh: Platform.OS === "android" },
      );
    }
  });
}

/**
 * Start (of herstart) de achtergrond-locatieservice.
 *
 * @param callSign  Optioneel: call sign van de gekoppelde eenheid, bijv.
 *                  "DELTA 1". Wordt getoond in de persistent notification
 *                  als titel "CMDS — DELTA 1 actief". Als de service al
 *                  draait met hetzelfde callSign, wordt hij NIET herstart.
 *                  Bij een nieuw callSign wordt de service kort gestopt en
 *                  opnieuw gestart zodat de notificatietitel bijgewerkt wordt.
 */
export async function startBackgroundLocation(
  callSign?: string,
): Promise<void> {
  if (Platform.OS === "web") return;

  // ── Mutex: voorkomt gelijktijdige aanroepen ──────────────────────────────
  // Probleem: AppState-useEffect en onUnitLinked-handler roepen beiden
  // startBackgroundLocation() aan na app-naar-voorgrond. Beide zien
  // _activeCallSign=null (JS-runtime kill reset het) → beide triggeren
  // een stop+herstart → twee GPS-gaten direct na voorgrond-terugkeer.
  // Oplossing: zodra een aanroep begint, blokkeren we de rest.
  if (_startLocationInProgress) {
    console.log("[CMDS-GPS] startBackgroundLocation: al bezig — skip");
    return;
  }
  _startLocationInProgress = true;

  try {
    // ── Herstel _activeCallSign uit AsyncStorage na JS-runtime-kill ─────────
    // Wanneer Android de JS-runtime killt (bijv. Doze, OEM battery manager)
    // wordt _activeCallSign gereset naar null. Bij de eerstvolgende aanroep
    // lezen we de opgeslagen waarde zodat we niet onnodig stop+herstart doen
    // als het callSign onveranderd is.
    if (_activeCallSign === null) {
      try {
        const stored = await AsyncStorage.getItem(ACTIVE_CALL_SIGN_KEY);
        if (stored) _activeCallSign = stored;
      } catch {
        // Non-critical — proceed with null
      }
    }

    const alreadyStarted =
      await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);

    if (alreadyStarted) {
      // Geen callSign-wijziging — niets te doen
      if (!callSign || callSign === _activeCallSign) return;
      // Nieuw callSign — stop de service om de notificatietitel bij te werken.
      // KRITIEK: zet _activeCallSign VÓÓR de await zodat gelijktijdige aanroepen
      // (die ondanks de mutex toch doorglipten via _startLocationInProgress=false
      // op de vorige iteratie) de nieuwe waarde zien.
      _activeCallSign = callSign;
      try {
        await AsyncStorage.setItem(ACTIVE_CALL_SIGN_KEY, callSign);
      } catch { /* non-critical */ }
      void logIngest("service_state", {
        serviceRunning: false,
        source: "callSign_update",
      });
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    } else {
      // Service was niet actief — sla callSign op vóór de start
      _activeCallSign = callSign ?? null;
      if (callSign) {
        try {
          await AsyncStorage.setItem(ACTIVE_CALL_SIGN_KEY, callSign);
        } catch { /* non-critical */ }
      }
    }

    const notifTitle = callSign ? `CMDS — ${callSign} actief` : "CMDS deelt je locatie";

    void logIngest("service_state", {
      serviceRunning: true,
      source: callSign ?? undefined,
    });
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.High,
      // KRITIEK: 10s interval — was 30s. Elke 10s een fix ook bij stilstand.
      timeInterval: 10_000,
      distanceInterval: 0,
      // deferredUpdatesInterval op 10s voorkomt dat Android updates batcht
      // en vertraagd aanlevert tijdens Doze-mode.
      deferredUpdatesInterval: 10_000,
      deferredUpdatesDistance: 0,
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: notifTitle,
        notificationBody: "Locatie wordt gedeeld met de meldkamer.",
        notificationColor: "#0b1d3a",
      },
    });
  } finally {
    _startLocationInProgress = false;
  }
}

export async function stopBackgroundLocation(): Promise<void> {
  if (Platform.OS === "web") return;

  _activeCallSign = null;
  try {
    await AsyncStorage.removeItem(ACTIVE_CALL_SIGN_KEY);
  } catch { /* non-critical */ }

  const isStarted =
    await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (isStarted) {
    void logIngest("service_state", { serviceRunning: false });
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
