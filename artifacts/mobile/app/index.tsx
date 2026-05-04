import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  Linking,
  Modal,
  PermissionsAndroid,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isIgnoringBatteryOptimizationsGranted,
  markBatteryOptGranted,
  openAppDetailsSettings,
  requestIgnoreBatteryOptimizations,
} from "@/lib/batteryOptimization";
import { onBridgeEvent } from "@/lib/bridgeEvents";
import { CmdsLocation } from "cmds-location";
import {
  clearDiagnostics,
  diagnosticsPatchFromLinkedStatus,
  getDiagnostics,
  getSupabaseAccessToken,
  isBackgroundLocationActive,
  postForegroundLocation,
  sendTestPing,
  setSupabaseAccessToken,
  startBackgroundLocation,
  stopBackgroundLocation,
  updateAccessToken,
  updateLastKnownLocation,
  type Diagnostics,
} from "@/lib/backgroundLocation";
import {
  fetchLinkedUnitStatus,
  getCachedLinkedUnitStatus,
  invalidateLinkedUnitCache,
  type LinkedUnitStatus,
} from "@/lib/linkedUnit";
import {
  clearIngestLog,
  getIngestLog,
  logIngest,
  type IngestLogEntry,
} from "@/lib/ingestLog";

const BATTERY_PROMPT_FLAG_KEY = "cmds.askedBatteryOptimization";

const TARGET_URL = "https://cmdsevent.nl";
const SUPABASE_PROJECT_REF = "txauyjkivyzgxetmadkj";
const FOREGROUND_LINKED_POLL_MS = 15_000;

const WebView: typeof import("react-native-webview").WebView | null =
  Platform.OS === "web"
    ? null
    : (require("react-native-webview")
        .WebView as typeof import("react-native-webview").WebView);

type WebViewNavigation = import("react-native-webview").WebViewNavigation;
type WebViewMessageEvent = import("react-native-webview").WebViewMessageEvent;

type PermissionState = "checking" | "granted" | "denied" | "background-denied";

const NATIVE_PLATFORM = Platform.OS === "ios" ? "ios" : "android";

const INJECTED_BRIDGE = `
(function() {
  if (window.CMDS_NATIVE) return true;
  var SUPABASE_TOKEN_KEY = 'sb-${SUPABASE_PROJECT_REF}-auth-token';
  var lastToken = null;

  function send(msg) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    } catch (e) {}
  }

  function readSupabaseToken() {
    try {
      var raw = window.localStorage.getItem(SUPABASE_TOKEN_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.access_token) return parsed.access_token;
      if (Array.isArray(parsed) && parsed[0]) return parsed[0];
      return null;
    } catch (e) {
      return null;
    }
  }

  function syncToken() {
    var token = readSupabaseToken();
    if (token !== lastToken) {
      lastToken = token;
      send({ type: 'supabase_token', token: token });
    }
  }

  window.CMDS_NATIVE = {
    isNativeApp: true,
    platform: '${NATIVE_PLATFORM}',
    startBackgroundGPS: function() { send({ type: 'start_gps' }); },
    stopBackgroundGPS: function() { send({ type: 'stop_gps' }); },
    syncSupabaseToken: syncToken,
    lastLocation: undefined,

    // Backwards-compatible object-payload variant (older Lovable builds).
    onSupabaseTokenRefreshed: function(payload) {
      try {
        if (!payload || !payload.accessToken) return;
        lastToken = payload.accessToken;
        send({ type: 'token_refreshed', payload: {
          accessToken: payload.accessToken,
          refreshToken: payload.refreshToken || null,
          expiresAt: payload.expiresAt || null,
          userId: payload.userId || null,
        }});
      } catch (e) {}
    },

    // Lovable bridge contract: positional args
    // onAuthChanged(accessToken, refreshToken, userId)
    onAuthChanged: function(accessToken, refreshToken, userId) {
      try {
        if (!accessToken) return;
        lastToken = accessToken;
        console.log('[CMDS-BRIDGE] onAuthChanged userId=' + (userId || '-'));
        send({ type: 'token_refreshed', payload: {
          accessToken: accessToken,
          refreshToken: refreshToken || null,
          expiresAt: null,
          userId: userId || null,
        }});
      } catch (e) {}
    },

    // Called when the user logs out.
    onAuthCleared: function() {
      try {
        lastToken = null;
        console.log('[CMDS-BRIDGE] onAuthCleared');
        send({ type: 'auth_cleared' });
      } catch (e) {}
    },

    // DUAL SIGNATURE: Lovable's cmdsNative.ts kan beide aanroepen:
    //   object-vorm:    onUnitLinked({unitId, callSign, eventId, organizationId})
    //   positional-vorm: onUnitLinked(unitId, callSign, eventId, organizationId)
    // We ondersteunen BEIDE zodat zowel oude als nieuwe builds werken.
    onUnitLinked: function(unitIdOrPayload, callSign, eventId, organizationId) {
      try {
        var unitId, cs, eid, orgId;
        if (unitIdOrPayload && typeof unitIdOrPayload === 'object') {
          // Object-vorm: {unitId, callSign, eventId, organizationId}
          unitId = unitIdOrPayload.unitId;
          cs = unitIdOrPayload.callSign;
          eid = unitIdOrPayload.eventId;
          orgId = unitIdOrPayload.organizationId;
        } else {
          // Positional-vorm
          unitId = unitIdOrPayload;
          cs = callSign;
          eid = eventId;
          orgId = organizationId;
        }
        if (!unitId) {
          console.log('[CMDS-BRIDGE] onUnitLinked: unitId ontbreekt — genegeerd');
          return;
        }
        console.log('[CMDS-BRIDGE] onUnitLinked unitId=' + unitId + ' callSign=' + (cs || '-'));
        send({ type: 'unit_linked', unitId: unitId, callSign: cs || null, eventId: eid || null, organizationId: orgId || null });
      } catch (e) {}
    },

    // Called by the Lovable webapp when the user unlinks from a unit.
    onUnitUnlinked: function() {
      try {
        console.log('[CMDS-BRIDGE] onUnitUnlinked');
        send({ type: 'unit_unlinked' });
      } catch (e) {}
    },

    // Returns a JSON string with current native status (called by diagnose page).
    getNativeStatus: function() {
      try {
        return JSON.stringify({
          platform: '${NATIVE_PLATFORM}',
          isNativeApp: true,
          hasBridge: true,
          hasToken: lastToken !== null,
          lastLocation: window.CMDS_NATIVE.lastLocation || null,
          ts: new Date().toISOString(),
        });
      } catch(e) { return '{"error":"failed"}'; }
    },
  };

  // Alias: Lovable may call window.CMDSNative (Capacitor convention) OR
  // window.CMDS_NATIVE (our convention). Support both.
  window.CMDSNative = window.CMDS_NATIVE;

  syncToken();
  setInterval(syncToken, 5000);
  window.addEventListener('storage', syncToken);

  // Op page-load: vraag de webview de actieve eenheid opnieuw te sturen.
  // Lovable luistert op 'cmds-native-request-unit-sync' en roept dan
  // opnieuw onUnitLinked aan als er een actieve unit geselecteerd is.
  function dispatchUnitResync() {
    try {
      window.dispatchEvent(new Event('cmds-native-request-unit-sync'));
      console.log('[CMDS-BRIDGE] cmds-native-request-unit-sync dispatched');
    } catch(e) {}
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', dispatchUnitResync);
  } else {
    // Pagina al geladen — direct dispatchen (ook bij elke injectedJavaScript heruitvoering)
    dispatchUnitResync();
  }

  window.CMDS_NATIVE._receiveLocation = function(coords) {
    try {
      var evt = new CustomEvent('cmds-native-location', { detail: coords });
      window.dispatchEvent(evt);
    } catch (e) {}
    window.CMDS_NATIVE.lastLocation = coords;
  };

  send({ type: 'ready', url: window.location.href });
  true;
})();
`;

function formatTimeAgo(iso: string | null): string {
  if (!iso) return "nooit";
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s geleden`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s geleden`;
  const hr = Math.floor(min / 60);
  return `${hr}u ${min % 60}m geleden`;
}

function linkedStatusLabel(d: Diagnostics | null): {
  text: string;
  good: boolean | null;
} {
  if (!d || !d.lastLinkedStatus) {
    return { text: "nog niet gecontroleerd", good: null };
  }
  switch (d.lastLinkedStatus) {
    case "linked":
      return {
        text: `Ja — ${d.lastLinkedCallSign ?? "(onbekend)"}`,
        good: true,
      };
    case "no_unit":
      return {
        text: "Nee — kies een call sign in CMDS (UnitView)",
        good: false,
      };
    case "token_invalid":
      return { text: "Token verlopen — login op website", good: false };
    case "error":
      return { text: d.lastLinkedError ?? "fout", good: false };
    default:
      return { text: d.lastLinkedStatus, good: null };
  }
}

export default function Index() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<InstanceType<NonNullable<typeof WebView>>>(null);
  const [permissionState, setPermissionState] =
    useState<PermissionState>("checking");
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [, setCanGoBack] = useState(false);

  // Diagnostics state
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [serviceActive, setServiceActive] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [appActive, setAppActive] = useState(true);
  const [bridgeUnitId, setBridgeUnitId] = useState<string | null>(null);
  const [bridgeCallSign, setBridgeCallSign] = useState<string | null>(null);

  // Unit linking diagnostics state
  const [showUnitDiag, setShowUnitDiag] = useState(false);
  const [unitDiagRunning, setUnitDiagRunning] = useState(false);
  const [unitDiagResult, setUnitDiagResult] = useState<string | null>(null);
  const [unitLinkedAt, setUnitLinkedAt] = useState<string | null>(null);
  const [unitUnlinkedAt, setUnitUnlinkedAt] = useState<string | null>(null);
  const [unitEventId, setUnitEventId] = useState<string | null>(null);
  const [unitOrgId, setUnitOrgId] = useState<string | null>(null);
  const [tokenUserId, setTokenUserId] = useState<string | null>(null);
  const [tokenExpiresAt, setTokenExpiresAt] = useState<number | null>(null);
  const [locationPermStatus, setLocationPermStatus] = useState<string>("onbekend");
  const [bgPermStatus, setBgPermStatus] = useState<string>("onbekend");
  const [cachedLinkedStatus, setCachedLinkedStatus] =
    useState<LinkedUnitStatus | null>(null);

  // Ingest diagnose log state
  const [showIngestDiag, setShowIngestDiag] = useState(false);
  const [ingestLogEntries, setIngestLogEntries] = useState<IngestLogEntry[]>([]);

  // Battery optimalisatie: bijhouden of de gebruiker de flow heeft doorlopen.
  // Wordt gebruikt voor de waarschuwingsbanner als unit gekoppeld is.
  const [batteryOptGranted, setBatteryOptGranted] = useState(true);

  const refreshDiagnostics = useCallback(async () => {
    // Op Android: beschouw de service als actief als de Expo task OF de Kotlin service draait.
    const activePromise =
      Platform.OS === "android"
        ? Promise.all([
            isBackgroundLocationActive(),
            CmdsLocation.isServiceRunning(),
          ]).then(([expoActive, kotlinActive]) => expoActive || kotlinActive)
        : isBackgroundLocationActive();
    const [d, active, uid, cs] = await Promise.all([
      getDiagnostics(),
      activePromise,
      AsyncStorage.getItem("cmds_active_unit_id"),
      AsyncStorage.getItem("cmds_active_unit_call_sign"),
    ]);
    setDiagnostics(d);
    setServiceActive(active);
    setBridgeUnitId(uid);
    setBridgeCallSign(cs);
  }, []);

  const refreshUnitDiag = useCallback(async () => {
    const [uid, cs, eid, orgId, userId, expiresAtRaw, lat, ulat, cached] =
      await Promise.all([
        AsyncStorage.getItem("cmds_active_unit_id"),
        AsyncStorage.getItem("cmds_active_unit_call_sign"),
        AsyncStorage.getItem("cmds_active_unit_event_id"),
        AsyncStorage.getItem("cmds_active_organization_id"),
        AsyncStorage.getItem("cmds_supabase_user_id"),
        AsyncStorage.getItem("cmds.supabaseTokenExpiresAt"),
        AsyncStorage.getItem("cmds_unit_linked_at"),
        AsyncStorage.getItem("cmds_unit_unlinked_at"),
        getCachedLinkedUnitStatus(),
      ]);
    setBridgeUnitId(uid);
    setBridgeCallSign(cs);
    setUnitEventId(eid);
    setUnitOrgId(orgId);
    setTokenUserId(userId);
    setTokenExpiresAt(expiresAtRaw ? Number(expiresAtRaw) : null);
    setUnitLinkedAt(lat);
    setUnitUnlinkedAt(ulat);
    setCachedLinkedStatus(cached);

    // Check permissions
    if (Platform.OS !== "web") {
      try {
        const fg = await Location.getForegroundPermissionsAsync();
        setLocationPermStatus(fg.status === "granted" ? "GRANTED" : "DENIED");
        const bg = await Location.getBackgroundPermissionsAsync();
        setBgPermStatus(bg.status === "granted" ? "GRANTED" : "DENIED");
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    if (!showUnitDiag) return;
    refreshUnitDiag();
    const handle = setInterval(refreshUnitDiag, 2000);
    return () => clearInterval(handle);
  }, [showUnitDiag, refreshUnitDiag]);

  const runWhoamiTest = useCallback(async () => {
    setUnitDiagRunning(true);
    setUnitDiagResult(null);
    try {
      const token = await getSupabaseAccessToken();
      if (!token) {
        setUnitDiagResult("✗ Geen token — log in op de website");
        return;
      }
      const result = await fetchLinkedUnitStatus(token);
      setCachedLinkedStatus(result);
      if (result.tokenInvalid) {
        setUnitDiagResult("✗ 401 Token verlopen");
      } else if (result.linked) {
        setUnitDiagResult(
          `✓ Linked — ${result.unit?.call_sign ?? "?"} (HTTP ${result.httpStatus})`,
        );
      } else {
        setUnitDiagResult(
          `✗ Niet gekoppeld (HTTP ${result.httpStatus ?? "-"}) ${result.error ?? ""}`,
        );
      }
    } catch (e) {
      setUnitDiagResult(
        `✗ Fout: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setUnitDiagRunning(false);
    }
  }, []);

  const clearBridgeUnit = useCallback(async () => {
    await AsyncStorage.multiRemove([
      "cmds_active_unit_id",
      "cmds_active_unit_call_sign",
      "cmds_active_unit_event_id",
      "cmds_active_organization_id",
    ]);
    await AsyncStorage.setItem(
      "cmds_unit_unlinked_at",
      new Date().toISOString(),
    );
    setBridgeUnitId(null);
    setBridgeCallSign(null);
    setUnitOrgId(null);
    setUnitDiagResult("Bridge eenheid gewist.");
    await stopBackgroundLocation();
    await refreshUnitDiag();
  }, [refreshUnitDiag]);

  const forcePushGps = useCallback(async () => {
    setUnitDiagRunning(true);
    setUnitDiagResult(null);
    try {
      const result = await sendTestPing();
      if (result.skipped) {
        setUnitDiagResult(
          `↷ Overgeslagen — ${result.skipReason ?? result.error ?? "onbekend"}`,
        );
      } else if (result.ok) {
        setUnitDiagResult(
          `✓ GPS Push OK (HTTP ${result.status})\n${result.body?.slice(0, 200) ?? ""}`,
        );
      } else {
        setUnitDiagResult(
          `✗ GPS Push mislukt (HTTP ${result.status ?? "?"})\n${result.body?.slice(0, 200) ?? result.error ?? ""}`,
        );
      }
      await refreshUnitDiag();
    } finally {
      setUnitDiagRunning(false);
    }
  }, [refreshUnitDiag]);

  const copyDiagToClipboard = useCallback(async () => {
    const expiresInMin =
      tokenExpiresAt != null
        ? Math.round((tokenExpiresAt * 1000 - Date.now()) / 60_000)
        : null;
    const lines = [
      "=== UNIT LINK DIAGNOSE ===",
      "",
      "[BRIDGE STATUS]",
      `WebView geladen:           ${hasLoadedOnce ? "Ja" : "Nee"}`,
      `CMDSNative bridge actief:  Ja`,
      `onUnitLinked ontvangen:    ${unitLinkedAt ? formatTimeAgo(unitLinkedAt) : "Nooit"}`,
      "",
      "[ACTIEVE KOPPELING]",
      `cmds_active_unit_id:           ${bridgeUnitId ?? "leeg"}`,
      `cmds_active_call_sign:         ${bridgeCallSign ?? "leeg"}`,
      `cmds_active_event_id:          ${unitEventId ?? "leeg"}`,
      `cmds_active_organization_id:   ${unitOrgId ?? "leeg"}`,
      `Laatste onUnitLinked:          ${unitLinkedAt ?? "leeg"}`,
      `Laatste onUnitUnlinked:        ${unitUnlinkedAt ?? "leeg"}`,
      "",
      "[AUTH STATUS]",
      `access_token aanwezig:     ${diagnostics && diagnostics.lastTokenLength > 0 ? "Ja" : "Nee"}`,
      `token verloopt over:       ${expiresInMin != null ? `${expiresInMin} minuten` : "onbekend"}`,
      `user_id:                   ${tokenUserId ?? "leeg"}`,
      "",
      "[FOREGROUND SERVICE]",
      `Service draait:            ${serviceActive ? "Ja" : "Nee"}`,
      `Locatie permissie:         ${locationPermStatus}`,
      `Background permissie:      ${bgPermStatus}`,
      "",
      `[GEGENEREERD: ${new Date().toISOString()}]`,
    ];
    const text = lines.join("\n");
    await Share.share({ message: text, title: "CMDS Unit Link Diagnose" });
  }, [
    hasLoadedOnce,
    unitLinkedAt,
    bridgeUnitId,
    bridgeCallSign,
    unitEventId,
    unitOrgId,
    unitUnlinkedAt,
    diagnostics,
    tokenExpiresAt,
    tokenUserId,
    serviceActive,
    locationPermStatus,
    bgPermStatus,
  ]);

  const requestWebViewResync = useCallback(() => {
    const js = `
      try {
        window.CMDSNative_requestResync && window.CMDSNative_requestResync();
      } catch(e) {}
      true;
    `;
    webViewRef.current?.injectJavaScript(js);
    setUnitDiagResult("Re-sync verzoek verstuurd naar WebView.");
  }, []);

  const refreshIngestLog = useCallback(async () => {
    const entries = await getIngestLog();
    setIngestLogEntries(entries);
  }, []);

  const clearIngestLogCb = useCallback(async () => {
    await clearIngestLog();
    setIngestLogEntries([]);
  }, []);

  const copyIngestLog = useCallback(async () => {
    const text = JSON.stringify(ingestLogEntries, null, 2);
    await Share.share({ message: text, title: "CMDS Ingest Log" });
  }, [ingestLogEntries]);

  useEffect(() => {
    if (!showIngestDiag) return;
    void refreshIngestLog();
    const handle = setInterval(() => void refreshIngestLog(), 2000);
    return () => clearInterval(handle);
  }, [showIngestDiag, refreshIngestLog]);

  useEffect(() => {
    if (!showDiagnostics) return;
    refreshDiagnostics();
    const handle = setInterval(refreshDiagnostics, 2000);
    return () => clearInterval(handle);
  }, [showDiagnostics, refreshDiagnostics]);

  // Track foreground/background to throttle the linked-unit poll loop.
  // Bij elke wake (active) ook het native token naar de WebView pushen zodat
  // de WebView-sessie nooit met een verlopen JWT werkt na Doze-periode.
  useEffect(() => {
    const sub = AppState.addEventListener(
      "change",
      (next: AppStateStatus) => {
        setAppActive(next === "active");
        if (next === "active" && Platform.OS === "android") {
          // pushCurrentTokenToWebView() doet getValidToken() (refresht indien
          // nodig) en triggert daarna de onSupabaseTokenRefreshed handler die
          // de WebView bijwerkt via window.CMDS_NATIVE.onSupabaseTokenRefreshed.
          CmdsLocation.pushCurrentTokenToWebView().catch(() => undefined);
        }
      },
    );
    return () => sub.remove();
  }, []);

  // Auto-herstart GPS-service zodra de app naar de voorgrond komt en de
  // service niet meer actief is. Dekt het geval waarbij Doze of een OEM-skin
  // de foreground service heeft gekilled terwijl het scherm uit was.
  useEffect(() => {
    if (!appActive || permissionState !== "granted") return;

    if (Platform.OS === "android") {
      // Op Android: check BEIDE services. Herstart wat er niet draait.
      // - Expo TaskManager task: primaire GPS-bron in achtergrond
      // - Kotlin LocationTrackingService: token-management + backup GPS
      Promise.all([
        isBackgroundLocationActive(),
        CmdsLocation.isServiceRunning(),
      ])
        .then(async ([expoRunning, kotlinRunning]) => {
          const cs = bridgeCallSign ?? undefined;
          const bothRunning = expoRunning && kotlinRunning;
          if (bothRunning) return;

          // Haal opgeslagen config op (nodig voor Kotlin service herstart)
          const [[, accessToken], [, refreshToken], [, expiresAtRaw], [, unitId], [, storedCs]] =
            await AsyncStorage.multiGet([
              "cmds.supabase.access_token",
              "cmds.supabaseRefreshToken",
              "cmds.supabaseTokenExpiresAt",
              "cmds_active_unit_id",
              "cmds_active_unit_call_sign",
            ]);
          const callSign = cs ?? storedCs ?? "Eenheid";

          if (!expoRunning && unitId) {
            void logIngest("service_state", {
              serviceRunning: false,
              source: "foreground_check_dead_android_expo",
            });
            // Herstart de Expo background task (primaire achtergrond-GPS)
            void startBackgroundLocation(callSign);
          }

          if (!kotlinRunning && accessToken && refreshToken && unitId) {
            void logIngest("service_state", {
              serviceRunning: false,
              source: "foreground_check_dead_android_kotlin",
            });
            // Herstart de Kotlin service (token-management + backup GPS)
            void CmdsLocation.startService({
              callSign,
              unitId,
              eventId: null,
              organizationId: null,
              accessToken,
              refreshToken,
              expiresAt: expiresAtRaw ? Number(expiresAtRaw) : 0,
            });
          }
        })
        .catch(() => undefined);
      return;
    }

    // iOS: check de Expo TaskManager background task
    isBackgroundLocationActive()
      .then((running) => {
        if (running) return;
        const cs = bridgeCallSign ?? undefined;
        void logIngest("service_state", {
          serviceRunning: false,
          source: "foreground_check_dead",
        });
        void startBackgroundLocation(cs);
      })
      .catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appActive, permissionState]);

  // Foreground polling of whoami-unit so the diagnostics screen and the
  // background task always have a fresh "linked" answer cached.
  useEffect(() => {
    if (permissionState !== "granted" || !appActive) return;
    let cancelled = false;

    const poll = async () => {
      const token = await getSupabaseAccessToken();
      if (!token) return;
      const status = await fetchLinkedUnitStatus(token);
      if (cancelled) return;
      // Persist into diagnostics so the screen reflects it without a manual
      // refresh and the background task reuses the cache.
      const patch = diagnosticsPatchFromLinkedStatus(status);
      const current = await getDiagnostics();
      const merged = { ...current, ...patch };
      // Use private write through getDiagnostics + AsyncStorage indirectly
      // by re-using the linked-unit module's writeCachedStatus side-effect
      // is enough; here we just trigger a UI refresh.
      setDiagnostics(merged);
    };

    poll();
    const handle = setInterval(poll, FOREGROUND_LINKED_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [permissionState, appActive]);

  const requestPermissions = useCallback(async () => {
    setPermissionState("checking");

    try {
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (foreground.status !== "granted") {
        setPermissionState("denied");
        return;
      }

      if (Platform.OS !== "web") {
        const background = await Location.requestBackgroundPermissionsAsync();
        if (background.status !== "granted") {
          setPermissionState("background-denied");
          return;
        }
      }

      // Android 13+ (API 33): notificatietoestemming nodig voor zichtbare
      // foreground service notificatie. Zonder dit is de notificatie onzichtbaar
      // en kan Android de service als achtergrondproces behandelen → Doze-mode.
      if (Platform.OS === "android" && Platform.Version >= 33) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
      }

      setPermissionState("granted");
    } catch {
      setPermissionState("denied");
    }
  }, []);

  useEffect(() => {
    requestPermissions();
  }, [requestPermissions]);

  // Start background GPS as soon as permissions are granted.
  useEffect(() => {
    if (permissionState !== "granted") return;
    startBackgroundLocation().catch(() => undefined);
  }, [permissionState]);

  // Check battery optimisation state on mount and whenever permissions change.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    isIgnoringBatteryOptimizationsGranted()
      .then((granted) => setBatteryOptGranted(granted))
      .catch(() => undefined);
  }, [permissionState]);

  // ── Bridge events: native → WebView ─────────────────────────────────────
  // Subscribet op bridge-events (onLocationPosted, onLocationPostError,
  // onSupabaseTokenRefreshed, onAuthExpired) en injecteert ze als
  // CustomEvents in de WebView zodat de Lovable webapp ze kan verwerken.
  // Werkt alleen als de WebView geladen is en de app in de voorgrond staat.
  useEffect(() => {
    const inject = (js: string) => {
      webViewRef.current?.injectJavaScript(js + "\ntrue;");
    };

    const unsubs = [
      onBridgeEvent("onLocationPosted", (payload) => {
        inject(
          `window.dispatchEvent(new CustomEvent('onLocationPosted',{detail:${JSON.stringify(payload)}}));`,
        );
      }),
      onBridgeEvent("onLocationPostError", (payload) => {
        inject(
          `window.dispatchEvent(new CustomEvent('onLocationPostError',{detail:${JSON.stringify(payload)}}));`,
        );
      }),
      onBridgeEvent("onSupabaseTokenRefreshed", (payload) => {
        inject(
          `window.dispatchEvent(new CustomEvent('onSupabaseTokenRefreshed',{detail:${JSON.stringify(payload)}}));`,
        );
      }),
      onBridgeEvent("onAuthExpired", () => {
        inject(
          `try{if(window.CMDS_NATIVE&&typeof window.CMDS_NATIVE.onAuthExpired==='function')window.CMDS_NATIVE.onAuthExpired();}catch(e){}` +
            `window.dispatchEvent(new CustomEvent('onAuthExpired',{detail:{}}));`,
        );
      }),
    ];

    return () => unsubs.forEach((fn) => fn());
  }, []);

  // ── Native Kotlin GPS-service events → WebView ────────────────────────────
  // Subscribet op events van de native CmdsLocation module en stuurt ze als
  // CustomEvents naar de WebView. Dit is een aanvulling op de TS bridge-events
  // (lib/bridgeEvents.ts): de native module loopt altijd, ook als de JS
  // background task gestopt is.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const inject = (js: string) => {
      webViewRef.current?.injectJavaScript(js + "\ntrue;");
    };
    const subs = [
      CmdsLocation.addListener("onLocationPosted", (payload) => {
        inject(
          `window.dispatchEvent(new CustomEvent('onLocationPosted',{detail:${JSON.stringify(payload)}}));`,
        );
      }),
      CmdsLocation.addListener("onLocationPostError", (payload) => {
        inject(
          `window.dispatchEvent(new CustomEvent('onLocationPostError',{detail:${JSON.stringify(payload)}}));`,
        );
      }),
      CmdsLocation.addListener("onServiceStateChanged", (payload) => {
        inject(
          `window.dispatchEvent(new CustomEvent('onServiceStateChanged',{detail:${JSON.stringify(payload)}}));`,
        );
      }),
      CmdsLocation.addListener("onSupabaseTokenRefreshed", (payload) => {
        // Schrijf de verse tokens naar AsyncStorage zodat de JS GPS-laag
        // (backgroundLocation.ts) direct met het nieuwe token werkt.
        const p = payload as {
          accessToken?: string;
          refreshToken?: string;
          expiresAt?: number;
        };
        if (p.accessToken && p.refreshToken && p.expiresAt) {
          AsyncStorage.multiSet([
            ["cmds.supabase.access_token", p.accessToken],
            ["cmds.supabaseRefreshToken", p.refreshToken],
            ["cmds.supabaseTokenExpiresAt", String(p.expiresAt)],
          ]).catch(() => undefined);
        }
        // Injecteer setSession() in de WebView zodat de Supabase JS-client
        // het nieuwe token overneemt en NIET zelf opnieuw gaat refreshen —
        // dit is de fix voor de refresh-token race (reproductie #2).
        const safeAt = JSON.stringify(p.accessToken ?? "");
        const safeRt = JSON.stringify(p.refreshToken ?? "");
        const safeExp = Number(p.expiresAt ?? 0);
        inject(
          `(async function(){try{` +
            // 1. window.CMDS_NATIVE.onSupabaseTokenRefreshed — primaire hook
            //    die de webapp (src/lib/cmdsNative.ts) al heeft klaarstaan.
            //    Roept intern supabase.auth.setSession() aan en werkt de UI bij.
            `try{` +
            `  window.CMDS_NATIVE?.onSupabaseTokenRefreshed?.({` +
            `    accessToken:${safeAt},` +
            `    refreshToken:${safeRt},` +
            `    expiresAt:${safeExp},` +
            `    userId:null` +
            `  });` +
            `}catch(e){}` +
            // 2. Belt-and-suspenders: setSession rechtstreeks voor het geval
            //    de webapp de hook niet registreerde of anders heet.
            `var c=window.__supabase??window.supabase??null;` +
            `if(c&&c.auth&&typeof c.auth.setSession==='function'){` +
            `  try{await c.auth.setSession({access_token:${safeAt},refresh_token:${safeRt}});}catch(e){}` +
            `}` +
            `}catch(e){}` +
            `window.dispatchEvent(new CustomEvent('onSupabaseTokenRefreshed',{detail:${JSON.stringify(payload)}}));` +
            `})();`,
        );
      }),
      CmdsLocation.addListener("onAuthExpired", () => {
        inject(
          `try{if(window.CMDS_NATIVE&&typeof window.CMDS_NATIVE.onAuthExpired==='function')window.CMDS_NATIVE.onAuthExpired();}catch(e){}` +
            `window.dispatchEvent(new CustomEvent('onAuthExpired',{detail:{}}));`,
        );
      }),
    ].filter(Boolean);
    return () => subs.forEach((sub) => sub?.remove());
  }, []);

  // After permissions are granted, ask the user to disable battery optimisation
  // so OEM battery killers (Xiaomi/Samsung/Huawei/OnePlus) don't kill the
  // foreground location service with screen off.
  // Key change: "Later" no longer permanently marks as asked — the user will
  // be re-prompted on next app start. Only "Instellen" marks it as completed.
  useEffect(() => {
    if (permissionState !== "granted" || Platform.OS !== "android") return;
    let cancelled = false;
    (async () => {
      const alreadyGranted = await isIgnoringBatteryOptimizationsGranted();
      if (alreadyGranted || cancelled) return;
      Alert.alert(
        "Houd CMDS draaien",
        "GPS met scherm uit werkt alleen als CMDS uitgesloten is van batterijoptimalisatie.\n\n" +
          "Tik 'Instellen' en vervolgens 'Toestaan' (of ga naar Batterij → Geen beperkingen) " +
          "zodat GPS ook met vergrendeld scherm blijft werken.",
        [
          {
            text: "Later",
            style: "cancel",
            // Bewust geen flag zetten — bij volgende start opnieuw vragen.
          },
          {
            text: "Instellen",
            onPress: async () => {
              // Alleen als er daadwerkelijk een scherm geopend is, markeren we
              // de flow als voltooid. Als alle intents mislukken (bijv. bij een
              // onbekende OEM) krijgt de gebruiker bij de volgende start opnieuw
              // de prompt — zodat we nooit stil mislukken.
              const opened = await requestIgnoreBatteryOptimizations();
              if (opened) {
                await markBatteryOptGranted();
                setBatteryOptGranted(true);
              }
            },
          },
        ],
        { cancelable: false },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [permissionState]);

  // Foreground GPS watcher: continuously push fresh coordinates into the
  // WebView and throttle-POST to /ingest-location every ~10s.
  // The setInterval(10s) ticker has been removed — the watcher callback
  // drives both the WebView injection and the POST to avoid double-triggers.
  useEffect(() => {
    if (permissionState !== "granted" || !appActive || Platform.OS === "web")
      return;

    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    (async () => {
      try {
        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 5_000,
            distanceInterval: 0,
          },
          (location) => {
            if (cancelled) return;

            // Keep the shared module-level cache fresh for the background task.
            updateLastKnownLocation(location);

            // Throttled POST (≈every 10s) — replaces the old setInterval tick.
            postForegroundLocation(location).catch((e) =>
              console.log(`[CMDS-GPS] foreground watcher POST error: ${e}`),
            );

            // Inject coordinates into the WebView so cmdsevent.nl can read them.
            const coords = {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
              accuracy: location.coords.accuracy,
              altitude: location.coords.altitude,
              altitudeAccuracy: location.coords.altitudeAccuracy,
              speed: location.coords.speed,
              heading: location.coords.heading,
              timestamp: location.timestamp,
            };
            const js = `
              if (window.CMDS_NATIVE && window.CMDS_NATIVE._receiveLocation) {
                window.CMDS_NATIVE._receiveLocation(${JSON.stringify(coords)});
              }
              true;
            `;
            webViewRef.current?.injectJavaScript(js);
          },
        );
      } catch {
        // Ignore — the background task will still keep posting updates.
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [permissionState, appActive]);

  const handleNavigationStateChange = useCallback(
    (navState: WebViewNavigation) => {
      setCanGoBack(navState.canGoBack);
    },
    [],
  );

  const handleWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      if (!message || typeof message !== "object") return;

      if (message.type === "unit_linked") {
        const unitId =
          typeof message.unitId === "string" && message.unitId.length > 0
            ? message.unitId
            : null;
        if (!unitId) return;
        void logIngest("bridge_event", {
          bridgeEvent: "onUnitLinked",
          unitId,
          source: message.callSign ?? null,
        });
        // Re-check battery optimalisatie bij elke unit-koppeling.
        // Als niet granted → banner verschijnt automatisch in de UI.
        isIgnoringBatteryOptimizationsGranted()
          .then((granted) => setBatteryOptGranted(granted))
          .catch(() => undefined);
        const now = new Date().toISOString();
        const pairs: [string, string][] = [
          ["cmds_active_unit_id", unitId],
          ["cmds_unit_linked_at", now],
        ];
        if (typeof message.callSign === "string")
          pairs.push(["cmds_active_unit_call_sign", message.callSign]);
        if (typeof message.eventId === "string")
          pairs.push(["cmds_active_unit_event_id", message.eventId]);
        if (typeof message.organizationId === "string")
          pairs.push(["cmds_active_organization_id", message.organizationId]);
        // Synchrone state-updates: kunnen direct, blokkeren niets.
        invalidateLinkedUnitCache();
        setBridgeUnitId(unitId);
        setBridgeCallSign(
          typeof message.callSign === "string" ? message.callSign : null,
        );
        setUnitOrgId(
          typeof message.organizationId === "string"
            ? message.organizationId
            : null,
        );
        console.log(
          `[CMDS-BRIDGE] unit_linked → unitId=${unitId} callSign=${message.callSign ?? "-"} eventId=${message.eventId ?? "-"} orgId=${message.organizationId ?? "-"}`,
        );
        // KRITIEK: await de AsyncStorage-write vóór locatiediensten starten.
        // Zonder await kan de foreground GPS-watcher (5s) of het background
        // task een POST doen terwijl cmds_active_unit_id nog null is →
        // bridge path wordt gemist → whoami-unit fallback → "geen gekoppelde
        // eenheid" skip. Door te wachten garanderen we dat de allereerste POST
        // al via de bridge path gaat (direct POST met unit_id, geen whoami).
        ;(async () => {
          await AsyncStorage.multiSet(pairs);

          // Start locatiediensten PAS na de write — beide services lezen
          // cmds_active_unit_id uit AsyncStorage bij hun eerste POST.
          startBackgroundLocation(
            typeof message.callSign === "string" && message.callSign.length > 0
              ? message.callSign
              : undefined,
          ).catch(() => undefined);

          // Start de native Kotlin GPS-service die onafhankelijk van de
          // JS-runtime draait — primaire fix voor "stilte met scherm aan".
          const [[, accessToken], [, refreshToken], [, expiresAtRaw]] =
            await AsyncStorage.multiGet([
              "cmds.supabase.access_token",
              "cmds.supabaseRefreshToken",
              "cmds.supabaseTokenExpiresAt",
            ]);
          if (!accessToken || !refreshToken) return;
          await CmdsLocation.startService({
            callSign:
              typeof message.callSign === "string" && message.callSign.length > 0
                ? message.callSign
                : "Eenheid",
            unitId,
            eventId:
              typeof message.eventId === "string" ? message.eventId : null,
            organizationId:
              typeof message.organizationId === "string"
                ? message.organizationId
                : null,
            accessToken,
            refreshToken,
            expiresAt: expiresAtRaw ? Number(expiresAtRaw) : 0,
          });
        })().catch(() => undefined);
      } else if (message.type === "unit_unlinked") {
        void logIngest("bridge_event", { bridgeEvent: "onUnitUnlinked" });
        const now = new Date().toISOString();
        AsyncStorage.multiRemove([
          "cmds_active_unit_id",
          "cmds_active_unit_call_sign",
          "cmds_active_unit_event_id",
          "cmds_active_organization_id",
        ]).catch(() => undefined);
        AsyncStorage.setItem("cmds_unit_unlinked_at", now).catch(
          () => undefined,
        );
        setBridgeUnitId(null);
        setBridgeCallSign(null);
        setUnitOrgId(null);
        console.log("[CMDS-BRIDGE] unit_unlinked → GPS gestopt");
        stopBackgroundLocation().catch(() => undefined);
        CmdsLocation.stopService().catch(() => undefined);
      } else if (message.type === "auth_cleared") {
        void logIngest("bridge_event", { bridgeEvent: "onAuthCleared" });
        AsyncStorage.multiRemove([
          "cmds.supabase.access_token",
          "cmds.supabaseRefreshToken",
          "cmds.supabaseTokenExpiresAt",
          "cmds_supabase_user_id",
        ]).catch(() => undefined);
        updateAccessToken(null);
        console.log("[CMDS-BRIDGE] auth_cleared → tokens gewist");
      } else if (message.type === "start_gps") {
        startBackgroundLocation().catch(() => undefined);
      } else if (message.type === "stop_gps") {
        stopBackgroundLocation().catch(() => undefined);
      } else if (message.type === "supabase_token") {
        const token =
          typeof message.token === "string" && message.token.length > 0
            ? message.token
            : null;

        // token=null = web logout. Lovable has no onAuthCleared call, so we
        // must clean up native state here: stop GPS + clear unit/token keys.
        if (!token) {
          void logIngest("bridge_event", { bridgeEvent: "supabase_token_cleared" });
          AsyncStorage.multiRemove([
            "cmds_active_unit_id",
            "cmds_active_unit_call_sign",
            "cmds_active_unit_event_id",
            "cmds_active_organization_id",
            "cmds.supabase.access_token",
            "cmds.supabaseRefreshToken",
            "cmds.supabaseTokenExpiresAt",
            "cmds_supabase_user_id",
          ]).catch(() => undefined);
          updateAccessToken(null);
          setBridgeUnitId(null);
          setBridgeCallSign(null);
          setUnitOrgId(null);
          setTokenUserId(null);
          setTokenExpiresAt(null);
          stopBackgroundLocation().catch(() => undefined);
          CmdsLocation.stopService().catch(() => undefined);
          return;
        }

        // Token aanwezig → opslaan en linked-status herchecken zodat de
        // background task direct met het verse antwoord verder kan.
        setSupabaseAccessToken(token)
          .then(async () => {
            const status = await fetchLinkedUnitStatus(token);
            const patch = diagnosticsPatchFromLinkedStatus(status);
            const current = await getDiagnostics();
            setDiagnostics({ ...current, ...patch });
          })
          .catch(() => undefined);
      } else if (message.type === "token_refreshed") {
        // Fired by window.CMDS_NATIVE.onSupabaseTokenRefreshed() — Lovable
        // webapp pushes the fresh token the moment Supabase auto-refreshes,
        // so the native POST loop gets the new token without waiting for the
        // next syncToken polling tick.
        void logIngest("token_refresh", {
          bridgeEvent: "onSupabaseTokenRefreshed",
          tokenExpiresIn:
            (message.payload as { expiresAt?: number } | null)?.expiresAt !=
            null
              ? Math.round(
                  ((message.payload as { expiresAt: number }).expiresAt *
                    1000 -
                    Date.now()) /
                    1000,
                )
              : undefined,
        });
        const payload = message.payload as {
          accessToken?: string;
          refreshToken?: string | null;
          expiresAt?: number | null;
        } | null;
        const freshToken =
          typeof payload?.accessToken === "string" &&
          payload.accessToken.length > 0
            ? payload.accessToken
            : null;
        if (!freshToken) return;

        // Update in-memory cache immediately — no AsyncStorage round-trip
        // needed before the next POST tick.
        updateAccessToken(freshToken);
        // Sync naar native Kotlin token-manager zodat de GPS-service
        // niet op een verlopen token blijft draaien.
        if (
          typeof payload?.refreshToken === "string" &&
          payload.expiresAt != null
        ) {
          CmdsLocation.updateTokens(
            freshToken,
            payload.refreshToken,
            payload.expiresAt,
          ).catch(() => undefined);
        }

        // Persist everything to AsyncStorage in the background.
        (async () => {
          await setSupabaseAccessToken(freshToken);
          if (typeof payload?.refreshToken === "string") {
            await AsyncStorage.setItem(
              "cmds.supabaseRefreshToken",
              payload.refreshToken,
            );
          }
          if (payload?.expiresAt != null) {
            await AsyncStorage.setItem(
              "cmds.supabaseTokenExpiresAt",
              String(payload.expiresAt),
            );
          }
          if (typeof (payload as { userId?: string })?.userId === "string") {
            await AsyncStorage.setItem(
              "cmds_supabase_user_id",
              (payload as { userId: string }).userId,
            );
          }
          // Re-check linked unit so the new token is validated immediately.
          const status = await fetchLinkedUnitStatus(freshToken);
          const patch = diagnosticsPatchFromLinkedStatus(status);
          const current = await getDiagnostics();
          setDiagnostics({ ...current, ...patch });
        })().catch(() => undefined);
      }
    } catch {
      // Ignore malformed messages.
    }
  }, []);

  const openSettings = useCallback(() => {
    Linking.openSettings().catch(() => undefined);
  }, []);

  const runTestPing = useCallback(async () => {
    setTestRunning(true);
    setTestResult(null);
    try {
      const result = await sendTestPing();
      if (result.skipped) {
        setTestResult(
          `↷ Overgeslagen — ${result.error ?? result.skipReason ?? "onbekend"}`,
        );
      } else if (result.ok) {
        setTestResult(
          `✓ OK (HTTP ${result.status}) — eenheid: ${result.linkedCallSign ?? "?"}\n${result.body || ""}`,
        );
      } else {
        setTestResult(
          `✗ Mislukt — ${result.error ?? "onbekende fout"}\n${result.body || ""}`,
        );
      }
      await refreshDiagnostics();
    } finally {
      setTestRunning(false);
    }
  }, [refreshDiagnostics]);

  const handleClearDiagnostics = useCallback(async () => {
    await clearDiagnostics();
    setTestResult(null);
    await refreshDiagnostics();
  }, [refreshDiagnostics]);

  const handleRequestBatteryOptimization = useCallback(async () => {
    await requestIgnoreBatteryOptimizations();
    await markBatteryOptGranted();
    setBatteryOptGranted(true);
  }, []);

  const handleOpenAppSettings = useCallback(async () => {
    await openAppDetailsSettings();
  }, []);

  const showPinInstructions = useCallback(() => {
    Alert.alert(
      "CMDS vastpinnen",
      "Zo blijft CMDS draaien wanneer je 'alle apps sluiten' veegt:\n\n" +
        "1. Open je multitasking-overzicht (de knop met de drie streepjes / vierkant, of veeg vanaf onder en houd vast).\n" +
        "2. Tik op het CMDS-icoon bovenaan de kaart.\n" +
        "3. Kies 'Vastzetten' of 'Pin'.\n\n" +
        "Mocht je deze optie niet zien, sta hem dan eerst aan in:\n" +
        "Instellingen → Beveiliging → App vastzetten.",
      [{ text: "Begrepen" }],
    );
  }, []);

  if (permissionState === "checking") {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Locatietoegang voorbereiden...</Text>
      </View>
    );
  }

  if (permissionState === "denied" || permissionState === "background-denied") {
    return (
      <View
        style={[
          styles.center,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <Text style={styles.title}>Locatietoegang vereist</Text>
        <Text style={styles.body}>
          {permissionState === "background-denied"
            ? 'Sta locatie "Altijd toestaan" toe zodat de app op de achtergrond GPS kan delen met cmdsevent.nl.'
            : "Deze app heeft locatietoegang nodig om correct te werken met cmdsevent.nl."}
        </Text>

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={requestPermissions}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryButtonText}>Opnieuw proberen</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={openSettings}
          activeOpacity={0.85}
        >
          <Text style={styles.secondaryButtonText}>Open instellingen</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (Platform.OS === "web" || !WebView) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* @ts-ignore iframe is web-only */}
        <iframe
          src={TARGET_URL}
          style={{
            flex: 1,
            border: "none",
            width: "100%",
            height: "100%",
            backgroundColor: "#ffffff",
          }}
          title="cmds.nl"
        />
      </View>
    );
  }

  const linkedLabel = linkedStatusLabel(diagnostics);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <WebView
        ref={webViewRef}
        source={{ uri: TARGET_URL }}
        style={styles.webview}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        geolocationEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction={false}
        injectedJavaScript={INJECTED_BRIDGE}
        injectedJavaScriptBeforeContentLoaded={INJECTED_BRIDGE}
        onMessage={handleWebViewMessage}
        onLoadEnd={() => setHasLoadedOnce(true)}
        onLoadProgress={({ nativeEvent }) => {
          if (nativeEvent.progress >= 0.7) setHasLoadedOnce(true);
        }}
        onNavigationStateChange={handleNavigationStateChange}
        onShouldStartLoadWithRequest={() => true}
      />

      {!hasLoadedOnce && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#3b82f6" />
        </View>
      )}

      {/* ── Battery opt-out waarschuwingsbanner ────────────────────── */}
      {Platform.OS === "android" &&
        bridgeUnitId !== null &&
        !batteryOptGranted && (
          <TouchableOpacity
            style={[
              styles.batteryBanner,
              { top: insets.top + 4 },
            ]}
            onPress={handleRequestBatteryOptimization}
            activeOpacity={0.85}
          >
            <Text style={styles.batteryBannerText}>
              ⚠️ GPS stopt met scherm uit — tik om batterijoptimalisatie uit te schakelen
            </Text>
          </TouchableOpacity>
        )}

      {/* Ingest diagnose knop */}
      <TouchableOpacity
        style={[styles.diagButton, { bottom: insets.bottom + 12, right: 160 }]}
        onPress={() => setShowIngestDiag(true)}
        activeOpacity={0.8}
      >
        <Text style={styles.diagButtonText}>LOG</Text>
      </TouchableOpacity>

      {/* Unit linking diagnose knop */}
      <TouchableOpacity
        style={[styles.diagButton, { bottom: insets.bottom + 12, right: 80 }]}
        onPress={() => setShowUnitDiag(true)}
        activeOpacity={0.8}
      >
        <Text style={styles.diagButtonText}>UNIT</Text>
      </TouchableOpacity>

      {/* GPS diagnose knop */}
      <TouchableOpacity
        style={[styles.diagButton, { bottom: insets.bottom + 12 }]}
        onPress={() => setShowDiagnostics(true)}
        activeOpacity={0.8}
      >
        <Text style={styles.diagButtonText}>GPS</Text>
      </TouchableOpacity>

      {/* ── Ingest Diagnose modal ───────────────────────────────────── */}
      <Modal
        visible={showIngestDiag}
        animationType="slide"
        onRequestClose={() => setShowIngestDiag(false)}
      >
        <View
          style={[
            styles.modalContainer,
            { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 },
          ]}
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Ingest Diagnose</Text>
            <TouchableOpacity
              onPress={() => setShowIngestDiag(false)}
              style={styles.modalClose}
            >
              <Text style={styles.modalCloseText}>Sluiten</Text>
            </TouchableOpacity>
          </View>

          {/* Status summary */}
          <View style={styles.ingestStatusBar}>
            <Text style={styles.ingestStatusText}>
              Unit: {bridgeUnitId ? `${bridgeUnitId.slice(0, 8)}…` : "—"}
            </Text>
            <Text style={styles.ingestStatusText}>
              Token:{" "}
              {tokenExpiresAt
                ? `${Math.max(0, Math.round((tokenExpiresAt * 1000 - Date.now()) / 1000))}s`
                : "ontbreekt"}
            </Text>
            <Text style={styles.ingestStatusText}>
              Service: {serviceActive ? "running ✓" : "stopped ✗"}
            </Text>
          </View>

          {/* Actie-knoppen */}
          <View style={styles.ingestButtonRow}>
            <TouchableOpacity
              style={styles.ingestActionButton}
              onPress={() => void refreshIngestLog()}
            >
              <Text style={styles.ingestActionText}>Refresh</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.ingestActionButton}
              onPress={() => void clearIngestLogCb()}
            >
              <Text style={styles.ingestActionText}>Wis log</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.ingestActionButton}
              onPress={() => void copyIngestLog()}
            >
              <Text style={styles.ingestActionText}>Kopieer</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.ingestCount}>
            {ingestLogEntries.length} entries (nieuwste eerst)
          </Text>

          <ScrollView>
            {[...ingestLogEntries].reverse().map((entry, i) => {
              const isSuccess =
                entry.phase === "post_response" &&
                entry.detail.httpStatus != null &&
                entry.detail.httpStatus < 400;
              const isError =
                entry.phase === "post_response" &&
                (entry.detail.error != null ||
                  (entry.detail.httpStatus != null &&
                    entry.detail.httpStatus >= 400));
              const isSkip = entry.phase === "skip";
              const textColor = isSuccess
                ? "#22c55e"
                : isError
                  ? "#ef4444"
                  : isSkip
                    ? "#eab308"
                    : "#64748b";
              const lines: string[] = [
                `[${entry.ts.slice(11, 23)}] ${entry.phase.toUpperCase()}` +
                  (entry.detail.httpStatus != null
                    ? ` HTTP ${entry.detail.httpStatus}`
                    : "") +
                  (entry.detail.skipReason
                    ? ` — ${entry.detail.skipReason}`
                    : "") +
                  (entry.detail.bridgeEvent
                    ? ` — ${entry.detail.bridgeEvent}`
                    : "") +
                  (entry.detail.error ? ` ERR: ${entry.detail.error}` : "") +
                  (entry.detail.serviceRunning != null
                    ? ` running=${entry.detail.serviceRunning}`
                    : "") +
                  (entry.detail.unitId !== undefined
                    ? ` uid=${entry.detail.unitId ? entry.detail.unitId.slice(0, 8) : "null"}`
                    : "") +
                  (entry.detail.source ? ` src=${entry.detail.source}` : ""),
              ];
              if (entry.detail.responseBody) {
                lines.push(entry.detail.responseBody.slice(0, 120));
              }
              return (
                <View key={i} style={styles.ingestEntry}>
                  <Text style={[styles.ingestEntryText, { color: textColor }]}>
                    {lines.join("\n")}
                  </Text>
                </View>
              );
            })}
          </ScrollView>
        </View>
      </Modal>

      {/* ── Unit linking diagnose modal ─────────────────────────────── */}
      <Modal
        visible={showUnitDiag}
        animationType="slide"
        onRequestClose={() => setShowUnitDiag(false)}
      >
        <View
          style={[
            styles.modalContainer,
            { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 },
          ]}
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Unit koppeling</Text>
            <TouchableOpacity
              onPress={() => setShowUnitDiag(false)}
              style={styles.modalClose}
            >
              <Text style={styles.modalCloseText}>Sluiten</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalScroll}>
            {/* Bridge status */}
            <Text style={styles.diagSectionHeader}>Bridge status</Text>
            <DiagRow
              label="WebView geladen"
              value={hasLoadedOnce ? "Ja" : "Nee"}
              good={hasLoadedOnce}
            />
            <DiagRow
              label="CMDSNative bridge actief"
              value="Ja"
              good={true}
            />
            <DiagRow
              label="onUnitLinked ontvangen"
              value={unitLinkedAt ? formatTimeAgo(unitLinkedAt) : "Nooit"}
              good={!!unitLinkedAt}
            />
            <DiagRow
              label="onUnitUnlinked ontvangen"
              value={formatTimeAgo(unitUnlinkedAt)}
            />

            {/* Actieve koppeling */}
            <Text style={styles.diagSectionHeader}>Actieve koppeling</Text>
            <DiagRow
              label="cmds_active_unit_id"
              value={
                bridgeUnitId
                  ? `${bridgeUnitId.slice(0, 8)}…${bridgeUnitId.slice(-4)}`
                  : "leeg"
              }
              good={!!bridgeUnitId}
            />
            <DiagRow
              label="cmds_active_call_sign"
              value={bridgeCallSign ?? "leeg"}
              good={!!bridgeCallSign}
            />
            <DiagRow
              label="cmds_active_event_id"
              value={unitEventId ? `${unitEventId.slice(0, 8)}…` : "leeg"}
            />
            <DiagRow
              label="cmds_active_organization_id"
              value={unitOrgId ? `${unitOrgId.slice(0, 8)}…` : "leeg"}
            />
            <DiagRow
              label="Laatste onUnitLinked"
              value={unitLinkedAt ?? "leeg"}
            />
            <DiagRow
              label="Laatste onUnitUnlinked"
              value={unitUnlinkedAt ?? "leeg"}
            />

            {/* Auth status */}
            <Text style={styles.diagSectionHeader}>Auth status</Text>
            <DiagRow
              label="access_token aanwezig"
              value={
                diagnostics && diagnostics.lastTokenLength > 0
                  ? `Ja (${diagnostics.lastTokenLength} tekens)`
                  : "Nee — log in op de website"
              }
              good={!!diagnostics && diagnostics.lastTokenLength > 0}
            />
            <DiagRow
              label="token verloopt over"
              value={
                tokenExpiresAt != null
                  ? (() => {
                      const min = Math.round(
                        (tokenExpiresAt * 1000 - Date.now()) / 60_000,
                      );
                      return min > 0 ? `${min} minuten` : "verlopen";
                    })()
                  : "onbekend"
              }
              good={
                tokenExpiresAt != null
                  ? tokenExpiresAt * 1000 > Date.now()
                  : null
              }
            />
            <DiagRow
              label="user_id"
              value={
                tokenUserId
                  ? `${tokenUserId.slice(0, 8)}…${tokenUserId.slice(-4)}`
                  : "leeg"
              }
            />

            {/* Server sectie */}
            <Text style={styles.diagSectionHeader}>Server (whoami-unit)</Text>
            <DiagRow
              label="Server status"
              value={
                !cachedLinkedStatus
                  ? "Nog niet gecontroleerd"
                  : cachedLinkedStatus.tokenInvalid
                    ? "Token verlopen"
                    : cachedLinkedStatus.linked
                      ? `Gekoppeld — ${cachedLinkedStatus.unit?.call_sign ?? "?"}`
                      : `Niet gekoppeld${cachedLinkedStatus.error ? ` (${cachedLinkedStatus.error.slice(0, 60)})` : ""}`
              }
              good={
                !cachedLinkedStatus
                  ? null
                  : cachedLinkedStatus.linked
                    ? true
                    : false
              }
            />
            <DiagRow
              label="Gecontroleerd"
              value={formatTimeAgo(cachedLinkedStatus?.checkedAt ?? null)}
            />
            <DiagRow
              label="HTTP status"
              value={
                cachedLinkedStatus?.httpStatus
                  ? `${cachedLinkedStatus.httpStatus}`
                  : "—"
              }
              good={
                cachedLinkedStatus?.httpStatus
                  ? cachedLinkedStatus.httpStatus >= 200 &&
                    cachedLinkedStatus.httpStatus < 300
                  : null
              }
            />

            {/* Foreground service */}
            <Text style={styles.diagSectionHeader}>Foreground service</Text>
            <DiagRow
              label="Service draait"
              value={serviceActive ? "Ja ✓" : "Nee ✗"}
              good={serviceActive}
            />
            <DiagRow
              label="Locatie permissie"
              value={locationPermStatus}
              good={locationPermStatus === "GRANTED"}
            />
            <DiagRow
              label="Background permissie"
              value={bgPermStatus}
              good={bgPermStatus === "GRANTED"}
            />

            {/* Knoppen */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={forcePushGps}
                disabled={unitDiagRunning}
                activeOpacity={0.8}
              >
                {unitDiagRunning ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    Forceer GPS Push nu
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={runWhoamiTest}
                disabled={unitDiagRunning}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryButtonText}>
                  Test whoami-unit
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={refreshUnitDiag}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryButtonText}>Vernieuwen</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={copyDiagToClipboard}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryButtonText}>
                  Kopieer naar klembord
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={requestWebViewResync}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryButtonText}>
                  Vraag webview om re-sync
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryButton, { borderColor: "#ef4444" }]}
                onPress={clearBridgeUnit}
                activeOpacity={0.8}
              >
                <Text style={[styles.secondaryButtonText, { color: "#ef4444" }]}>
                  Wis lokale unit-link
                </Text>
              </TouchableOpacity>
            </View>

            {unitDiagResult != null && (
              <View style={styles.testResultBox}>
                <Text style={styles.testResultText}>{unitDiagResult}</Text>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* ── GPS diagnose modal ───────────────────────────────────────── */}
      <Modal
        visible={showDiagnostics}
        animationType="slide"
        onRequestClose={() => setShowDiagnostics(false)}
      >
        <View
          style={[
            styles.modalContainer,
            { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 },
          ]}
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>GPS diagnose</Text>
            <TouchableOpacity
              onPress={() => setShowDiagnostics(false)}
              style={styles.modalClose}
            >
              <Text style={styles.modalCloseText}>Sluiten</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalScroll}>
            <DiagRow
              label="Service draait"
              value={serviceActive ? "Ja ✓" : "Nee ✗"}
              good={serviceActive}
            />
            <DiagRow
              label="Token aanwezig"
              value={
                diagnostics && diagnostics.lastTokenLength > 0
                  ? `Ja (${diagnostics.lastTokenLength} tekens)`
                  : "Nee — log in op de website"
              }
              good={
                !!diagnostics && diagnostics.lastTokenLength > 0
              }
            />
            <DiagRow
              label="Token laatst gezien"
              value={formatTimeAgo(diagnostics?.lastTokenSeenAt ?? null)}
            />
            <DiagRow
              label="Bridge eenheid (app)"
              value={
                bridgeUnitId
                  ? `${bridgeCallSign ?? "?"} — ${bridgeUnitId.slice(0, 8)}…`
                  : "Niet ingesteld — open CMDS en kies een eenheid"
              }
              good={!!bridgeUnitId}
            />
            <DiagRow
              label="Eenheid gekoppeld (server)"
              value={linkedLabel.text}
              good={linkedLabel.good}
            />
            <DiagRow
              label="Eenheid laatst gecontroleerd"
              value={formatTimeAgo(diagnostics?.lastLinkedCheckAt ?? null)}
            />
            <DiagRow
              label="Laatste GPS fix"
              value={formatTimeAgo(
                diagnostics?.lastBackgroundFixAt ?? null,
              )}
            />
            {diagnostics?.lastBackgroundLat != null &&
              diagnostics?.lastBackgroundLng != null && (
                <DiagRow
                  label="Laatste coördinaten"
                  value={`${diagnostics.lastBackgroundLat.toFixed(5)}, ${diagnostics.lastBackgroundLng.toFixed(5)}`}
                />
              )}
            <DiagRow
              label="Laatste POST"
              value={formatTimeAgo(diagnostics?.lastPostAt ?? null)}
            />
            <DiagRow
              label="Laatste status"
              value={
                diagnostics?.lastPostStatus
                  ? `HTTP ${diagnostics.lastPostStatus}`
                  : diagnostics?.lastPostError ?? "—"
              }
              good={
                diagnostics?.lastPostStatus
                  ? diagnostics.lastPostStatus >= 200 &&
                    diagnostics.lastPostStatus < 300
                  : null
              }
            />
            <DiagRow
              label="POSTs OK / fout / overgeslagen"
              value={`${diagnostics?.postSuccessCount ?? 0} / ${diagnostics?.postFailureCount ?? 0} / ${diagnostics?.postSkippedCount ?? 0}`}
            />
            {diagnostics?.lastSkipReason && (
              <DiagRow
                label="Reden laatste skip"
                value={diagnostics.lastSkipReason}
                multiline
              />
            )}
            {diagnostics?.lastPostError && (
              <DiagRow
                label="Laatste fout"
                value={diagnostics.lastPostError}
                good={false}
                multiline
              />
            )}
            {diagnostics?.lastPostBody && (
              <DiagRow
                label="Server antwoord"
                value={diagnostics.lastPostBody}
                multiline
              />
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={runTestPing}
                disabled={testRunning}
                activeOpacity={0.8}
              >
                {testRunning ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    Test nu een POST
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={refreshDiagnostics}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryButtonText}>Vernieuwen</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={handleClearDiagnostics}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryButtonText}>
                  Diagnose wissen
                </Text>
              </TouchableOpacity>
            </View>

            {Platform.OS === "android" && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>App actief houden</Text>
                <Text style={styles.sectionBody}>
                  Android sluit de app standaard na een tijdje om batterij te
                  besparen. Schakel onderstaande opties in zodat CMDS blijft
                  draaien zolang jij hem niet zelf afsluit.
                </Text>

                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={handleRequestBatteryOptimization}
                  activeOpacity={0.8}
                >
                  <Text style={styles.primaryButtonText}>
                    Negeer batterij­optimalisatie
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={handleOpenAppSettings}
                  activeOpacity={0.8}
                >
                  <Text style={styles.secondaryButtonText}>
                    Open app-instellingen
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={showPinInstructions}
                  activeOpacity={0.8}
                >
                  <Text style={styles.secondaryButtonText}>
                    Hoe pin ik de app vast?
                  </Text>
                </TouchableOpacity>

                <Text style={styles.sectionHint}>
                  Tip: gebruik "App vastpinnen" als je voorkomt dat per ongeluk
                  swipen op "alle apps sluiten" CMDS afsluit.
                </Text>
              </View>
            )}

            {testResult != null && (
              <View style={styles.testResultBox}>
                <Text style={styles.testResultText}>{testResult}</Text>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function DiagRow({
  label,
  value,
  good,
  multiline,
}: {
  label: string;
  value: string;
  good?: boolean | null;
  multiline?: boolean;
}) {
  const valueColor =
    good === true ? "#22c55e" : good === false ? "#ef4444" : "#e5e7eb";
  return (
    <View style={styles.diagRow}>
      <Text style={styles.diagLabel}>{label}</Text>
      <Text
        style={[
          multiline ? styles.diagValueMulti : styles.diagValue,
          { color: valueColor },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b1d3a",
  },
  webview: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.85)",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    backgroundColor: "#0b1d3a",
  },
  loadingText: {
    marginTop: 16,
    fontSize: 15,
    color: "#cbd5f5",
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#ffffff",
    marginBottom: 12,
    textAlign: "center",
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: "#cbd5f5",
    textAlign: "center",
    marginBottom: 28,
  },
  primaryButton: {
    backgroundColor: "#3b82f6",
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
    minWidth: 220,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    marginTop: 12,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
    minWidth: 220,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#334e8a",
  },
  secondaryButtonText: {
    color: "#cbd5f5",
    fontSize: 15,
    fontWeight: "500",
  },
  diagButton: {
    position: "absolute",
    right: 12,
    backgroundColor: "rgba(11, 29, 58, 0.85)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#3b82f6",
  },
  diagButtonText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: "#0b1d3a",
    paddingHorizontal: 20,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  modalTitle: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "700",
  },
  modalClose: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#334e8a",
  },
  modalCloseText: {
    color: "#cbd5f5",
    fontSize: 14,
    fontWeight: "500",
  },
  modalScroll: {
    paddingBottom: 24,
  },
  diagRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#1e3a6e",
  },
  diagLabel: {
    color: "#94a3b8",
    fontSize: 12,
    textTransform: "uppercase",
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  diagValue: {
    color: "#e5e7eb",
    fontSize: 15,
    fontWeight: "500",
  },
  diagValueMulti: {
    color: "#e5e7eb",
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  modalActions: {
    marginTop: 24,
    alignItems: "center",
  },
  section: {
    marginTop: 32,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: "#1e3a6e",
    alignItems: "center",
  },
  sectionTitle: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 8,
  },
  sectionBody: {
    color: "#cbd5f5",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 16,
  },
  sectionHint: {
    marginTop: 14,
    color: "#94a3b8",
    fontSize: 12,
    fontStyle: "italic",
    textAlign: "center",
    lineHeight: 18,
  },
  testResultBox: {
    marginTop: 20,
    padding: 14,
    backgroundColor: "#082043",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#1e3a6e",
  },
  testResultText: {
    color: "#e5e7eb",
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  diagSectionHeader: {
    color: "#3b82f6",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 20,
    marginBottom: 4,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#1e3a6e",
  },
  ingestStatusBar: {
    backgroundColor: "#0f172a",
    padding: 12,
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    flexWrap: "wrap" as const,
    marginBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: "#1e3a6e",
  },
  ingestStatusText: {
    color: "#94a3b8",
    fontSize: 11,
  },
  ingestButtonRow: {
    flexDirection: "row" as const,
    padding: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#1e3a6e",
  },
  ingestActionButton: {
    flex: 1,
    backgroundColor: "#1e293b",
    padding: 8,
    borderRadius: 6,
    alignItems: "center" as const,
  },
  ingestActionText: {
    color: "#e2e8f0",
    fontSize: 12,
  },
  ingestCount: {
    color: "#64748b",
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  ingestEntry: {
    padding: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1e293b",
  },
  ingestEntryText: {
    fontSize: 10,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  batteryBanner: {
    position: "absolute",
    left: 12,
    right: 12,
    backgroundColor: "#92400e",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    zIndex: 100,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 6,
  },
  batteryBannerText: {
    color: "#fef3c7",
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
});
