import * as Location from "expo-location";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  setSupabaseAccessToken,
  startBackgroundLocation,
  stopBackgroundLocation,
} from "@/lib/backgroundLocation";

const TARGET_URL = "https://cmdsevent.nl";
const SUPABASE_PROJECT_REF = "txauyjkivyzgxetmadkj";

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

export default function Index() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<InstanceType<NonNullable<typeof WebView>>>(null);
  const [permissionState, setPermissionState] =
    useState<PermissionState>("checking");
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [, setCanGoBack] = useState(false);

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

  // Foreground GPS watcher: continuously push fresh coordinates into the
  // WebView so the website always has up-to-date location data while open.
  useEffect(() => {
    if (permissionState !== "granted" || Platform.OS === "web") return;

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
  }, [permissionState]);

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

      if (message.type === "start_gps") {
        startBackgroundLocation().catch(() => undefined);
      } else if (message.type === "stop_gps") {
        stopBackgroundLocation().catch(() => undefined);
      } else if (message.type === "supabase_token") {
        const token =
          typeof message.token === "string" && message.token.length > 0
            ? message.token
            : null;
        setSupabaseAccessToken(token).catch(() => undefined);
      }
    } catch {
      // Ignore malformed messages.
    }
  }, []);

  const openSettings = useCallback(() => {
    Linking.openSettings().catch(() => undefined);
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
            ? 'Sta locatie "Altijd toestaan" toe zodat de app op de achtergrond GPS kan delen met cmds.nl.'
            : "Deze app heeft locatietoegang nodig om correct te werken met cmds.nl."}
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
});
