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
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  openAppDetailsSettings,
  requestIgnoreBatteryOptimizations,
} from "@/lib/batteryOptimization";
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
  invalidateLinkedUnitCache,
} from "@/lib/linkedUnit";

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

    // Called by the Lovable webapp whenever Supabase refreshes the session.
    // payload: { accessToken, refreshToken, expiresAt (unix epoch s), userId }
    // Backwards compatible: old syncSupabaseToken() keeps working as fallback.
    onSupabaseTokenRefreshed: function(payload) {
      try {
        if (!payload || !payload.accessToken) return;
        lastToken = payload.accessToken; // suppress duplicate syncToken event
        send({ type: 'token_refreshed', payload: {
          accessToken: payload.accessToken,
          refreshToken: payload.refreshToken || null,
          expiresAt: payload.expiresAt || null,
          userId: payload.userId || null,
        }});
      } catch (e) {}
    },

    // Called by the Lovable webapp when the user links to a unit.
    // payload: { unitId: string, callSign?: string, eventId?: string }
    onUnitLinked: function(payload) {
      try {
        if (!payload || !payload.unitId) return;
        send({ type: 'unit_linked', unitId: payload.unitId, callSign: payload.callSign || null, eventId: payload.eventId || null });
      } catch (e) {}
    },

    // Called by the Lovable webapp when the user unlinks from a unit.
    onUnitUnlinked: function() {
      try {
        send({ type: 'unit_unlinked' });
      } catch (e) {}
    },
  };

  syncToken();
  setInterval(syncToken, 5000);
  window.addEventListener('storage', syncToken);

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

  const refreshDiagnostics = useCallback(async () => {
    const [d, active, uid, cs] = await Promise.all([
      getDiagnostics(),
      isBackgroundLocationActive(),
      AsyncStorage.getItem("cmds_active_unit_id"),
      AsyncStorage.getItem("cmds_active_unit_call_sign"),
    ]);
    setDiagnostics(d);
    setServiceActive(active);
    setBridgeUnitId(uid);
    setBridgeCallSign(cs);
  }, []);

  useEffect(() => {
    if (!showDiagnostics) return;
    refreshDiagnostics();
    const handle = setInterval(refreshDiagnostics, 2000);
    return () => clearInterval(handle);
  }, [showDiagnostics, refreshDiagnostics]);

  // Track foreground/background to throttle the linked-unit poll loop.
  useEffect(() => {
    const sub = AppState.addEventListener(
      "change",
      (next: AppStateStatus) => {
        setAppActive(next === "active");
      },
    );
    return () => sub.remove();
  }, []);

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

  // After permissions are granted, ask the user (once) to disable battery
  // optimisation so OEM battery killers (Xiaomi/Samsung/Huawei) don't shut
  // down the foreground service.
  useEffect(() => {
    if (permissionState !== "granted" || Platform.OS !== "android") return;
    let cancelled = false;
    (async () => {
      const asked = await AsyncStorage.getItem(BATTERY_PROMPT_FLAG_KEY);
      if (asked === "1" || cancelled) return;
      Alert.alert(
        "Houd CMDS draaien",
        "Voor betrouwbare GPS-deling moet CMDS uitgesloten worden van batterij­optimalisatie. Tik 'Toestaan' in het volgende scherm.",
        [
          {
            text: "Later",
            style: "cancel",
            onPress: () => {
              AsyncStorage.setItem(BATTERY_PROMPT_FLAG_KEY, "1").catch(
                () => undefined,
              );
            },
          },
          {
            text: "Instellen",
            onPress: async () => {
              await requestIgnoreBatteryOptimizations();
              await AsyncStorage.setItem(BATTERY_PROMPT_FLAG_KEY, "1");
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
        // Idempotent: overschrijf altijd, start GPS alleen als nog niet actief.
        AsyncStorage.setItem("cmds_active_unit_id", unitId).catch(
          () => undefined,
        );
        if (typeof message.callSign === "string") {
          AsyncStorage.setItem(
            "cmds_active_unit_call_sign",
            message.callSign,
          ).catch(() => undefined);
        }
        // Cache legen zodat de eerstvolgende whoami-unit direct een verse
        // linked:true terugkrijgt i.p.v. de oude linked:false te hergebruiken.
        invalidateLinkedUnitCache();
        console.log(
          `[CMDS] unit_linked → unitId=${unitId} callSign=${message.callSign ?? "-"} eventId=${message.eventId ?? "-"}`,
        );
        startBackgroundLocation().catch(() => undefined);
      } else if (message.type === "unit_unlinked") {
        AsyncStorage.multiRemove([
          "cmds_active_unit_id",
          "cmds_active_unit_call_sign",
        ]).catch(() => undefined);
        console.log("[CMDS] unit_unlinked → GPS gestopt");
        stopBackgroundLocation().catch(() => undefined);
      } else if (message.type === "start_gps") {
        startBackgroundLocation().catch(() => undefined);
      } else if (message.type === "stop_gps") {
        stopBackgroundLocation().catch(() => undefined);
      } else if (message.type === "supabase_token") {
        const token =
          typeof message.token === "string" && message.token.length > 0
            ? message.token
            : null;
        // Save token, then immediately re-check linked unit so background
        // task picks up the freshest answer without waiting for next poll.
        setSupabaseAccessToken(token)
          .then(async () => {
            if (!token) return;
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
    await AsyncStorage.setItem(BATTERY_PROMPT_FLAG_KEY, "1");
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

      {/* Diagnostics floating button */}
      <TouchableOpacity
        style={[styles.diagButton, { bottom: insets.bottom + 12 }]}
        onPress={() => setShowDiagnostics(true)}
        activeOpacity={0.8}
      >
        <Text style={styles.diagButtonText}>GPS</Text>
      </TouchableOpacity>

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
});
