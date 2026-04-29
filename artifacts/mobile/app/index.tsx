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
  startBackgroundLocation,
  stopBackgroundLocation,
} from "@/lib/backgroundLocation";

const TARGET_URL = "https://cmdsevent.nl";

const WebView: typeof import("react-native-webview").WebView | null =
  Platform.OS === "web"
    ? null
    : (require("react-native-webview")
        .WebView as typeof import("react-native-webview").WebView);

type WebViewNavigation = import("react-native-webview").WebViewNavigation;
type WebViewMessageEvent = import("react-native-webview").WebViewMessageEvent;

type PermissionState = "checking" | "granted" | "denied" | "background-denied";

const INJECTED_BRIDGE = `
(function() {
  if (window.CMDS_NATIVE) return;
  function send(msg) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    } catch (e) {}
  }
  window.CMDS_NATIVE = {
    startBackgroundGPS: function() { send({ type: 'start_gps' }); },
    stopBackgroundGPS: function() { send({ type: 'stop_gps' }); },
    isNativeApp: true,
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
  const [webViewLoading, setWebViewLoading] = useState(true);
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
        {/* @ts-expect-error iframe is web-only */}
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
        onLoadStart={() => setWebViewLoading(true)}
        onLoadEnd={() => setWebViewLoading(false)}
        onNavigationStateChange={handleNavigationStateChange}
        onShouldStartLoadWithRequest={() => true}
      />

      {webViewLoading && (
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
