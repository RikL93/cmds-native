/**
 * supabaseRefresh.ts
 *
 * Native Supabase token-refresh fallback voor wanneer de WebView gepauzeerd
 * is (scherm uit > 1 uur) en het access_token verloopt.
 *
 * Bevat ook de gedeelde in-memory access-token cache zodat backgroundLocation
 * en supabaseRefresh geen circulaire import krijgen.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import { emitBridgeEvent } from "./bridgeEvents";

// ---------------------------------------------------------------------------
// Supabase anon key (public — veilig om in te hardcoden, net als de URL).
// Vind het via: Supabase dashboard → Project Settings → API → "anon public"
// Plak de volledige sleutel hieronder (begint met "eyJ...").
// ---------------------------------------------------------------------------
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4YXV5amtpdnl6Z3hldG1hZGtqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NTQ4MDQsImV4cCI6MjA4NzQzMDgwNH0.PEm8ItUT-9D1PJLwBXEydKYf-cPUQdQhQdLEnkWC-hk";

const SUPABASE_PROJECT_REF = "txauyjkivyzgxetmadkj";
const REFRESH_ENDPOINT = `https://${SUPABASE_PROJECT_REF}.supabase.co/auth/v1/token?grant_type=refresh_token`;

// AsyncStorage sleutels
export const ACCESS_TOKEN_KEY = "cmds.supabase.access_token";
export const REFRESH_TOKEN_KEY = "cmds.supabaseRefreshToken";
export const EXPIRES_AT_KEY = "cmds.supabaseTokenExpiresAt";

// ---------------------------------------------------------------------------
// In-memory access-token cache.
// Gedeeld tussen backgroundLocation.ts en supabaseRefresh.ts om circulaire
// imports te vermijden. Wordt bijgewerkt door updateAccessToken() — aangeroepen
// vanuit de bridge-event handler (app/index.tsx) én na een succesvolle refresh.
// ---------------------------------------------------------------------------
let _currentAccessToken: string | null = null;

export function updateAccessToken(token: string | null): void {
  _currentAccessToken = token;
}

export function getCachedAccessToken(): string | null {
  return _currentAccessToken;
}

// ---------------------------------------------------------------------------
// ExpiresAt cache (60s) om AsyncStorage-reads per tick te beperken.
// ---------------------------------------------------------------------------
let _cachedExpiresAt: number | null = null;
let _expiresAtReadAt = 0;
const EXPIRES_AT_CACHE_MS = 60_000;

export async function getTokenExpiresAt(): Promise<number | null> {
  const now = Date.now();
  if (now - _expiresAtReadAt < EXPIRES_AT_CACHE_MS) {
    return _cachedExpiresAt;
  }
  const raw = await AsyncStorage.getItem(EXPIRES_AT_KEY);
  _cachedExpiresAt = raw ? Number(raw) : null;
  _expiresAtReadAt = now;
  return _cachedExpiresAt;
}

export function invalidateExpiresAtCache(): void {
  _expiresAtReadAt = 0;
}

// ---------------------------------------------------------------------------
// refreshSupabaseTokenNative
// ---------------------------------------------------------------------------

export type RefreshResult = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
};

/**
 * Probeert het access_token te vernieuwen via het Supabase auth-endpoint.
 *
 * - Leest het refresh_token uit AsyncStorage.
 * - Roept POST .../auth/v1/token?grant_type=refresh_token aan (10s timeout).
 * - Bij 200: slaat nieuwe tokens op, werkt in-memory cache bij, return result.
 * - Bij 4xx: wist alle tokens (sessie ongeldig), return null.
 * - Bij netwerkfout / 5xx: laat tokens intact, return null (volgende tick
 *   probeert het opnieuw).
 *
 * CONCURRENCY LOCK: als er al een refresh in-flight is (bijv. doordat expo-location
 * na Doze-lift 25 locaties tegelijk aanlevert en elke callback onafhankelijk een
 * refresh triggert), wachten alle extra callers op dezelfde Promise. Zo wordt het
 * Supabase rotate-token nooit dubbel geconsumeerd.
 */
let _refreshInFlight: Promise<RefreshResult | null> | null = null;

export async function refreshSupabaseTokenNative(): Promise<RefreshResult | null> {
  if (_refreshInFlight !== null) {
    console.log("[CMDS-GPS] refresh-token: al in-flight, wacht op lopende refresh");
    return _refreshInFlight;
  }
  _refreshInFlight = _doRefresh();
  try {
    return await _refreshInFlight;
  } finally {
    _refreshInFlight = null;
  }
}

async function _doRefresh(): Promise<RefreshResult | null> {
  const refreshToken = await AsyncStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    console.log("[CMDS-GPS] refresh-token: geen refresh token in storage");
    return null;
  }

  const ctrl = new AbortController();
  const abortTimer = setTimeout(() => ctrl.abort(), 10_000);
  const startedAt = Date.now();

  console.log("[CMDS-GPS] before-fetch refresh-token");

  try {
    let response: Response;
    try {
      response = await fetch(REFRESH_ENDPOINT, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(abortTimer);
    }

    const ms = Date.now() - startedAt;
    console.log(
      `[CMDS-GPS] after-fetch refresh-token status=${response.status} ms=${ms}`,
    );

    if (response.ok) {
      const body = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
        user: { id: string };
      };

      // Sla op — refresh_token ROTEERT, vervang het oude exemplaar
      await AsyncStorage.setItem(ACCESS_TOKEN_KEY, body.access_token);
      await AsyncStorage.setItem(REFRESH_TOKEN_KEY, body.refresh_token);
      await AsyncStorage.setItem(EXPIRES_AT_KEY, String(body.expires_at));

      // Werk in-memory cache direct bij zodat de volgende POST-tick geen
      // AsyncStorage-leeslag meer nodig heeft.
      updateAccessToken(body.access_token);
      // Invalideer de expiresAt-cache zodat de nieuwe waarde wordt gelezen.
      invalidateExpiresAtCache();

      console.log(
        `[CMDS-GPS] refresh-token OK — nieuw token voor user=${body.user.id} expires=${body.expires_at}`,
      );
      // Bridge event → WebView zodat de webapp weet dat het token ververst is.
      // De webapp kan hierop reageren door bijv. de token-status indicator bij
      // te werken. Werkt alleen vanuit foreground context.
      emitBridgeEvent("onSupabaseTokenRefreshed", {
        expiresAt: body.expires_at,
        userId: body.user.id,
      });
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: body.expires_at,
        userId: body.user.id,
      };
    }

    if (response.status >= 400 && response.status < 500) {
      // Refresh token ongeldig of ingetrokken — sessie is dood.
      // Geen retry-loop: wis alles en stop.
      console.log("[CMDS-GPS] refresh-token rejected — clearing tokens");
      await AsyncStorage.multiRemove([
        ACCESS_TOKEN_KEY,
        REFRESH_TOKEN_KEY,
        EXPIRES_AT_KEY,
      ]);
      updateAccessToken(null);
      invalidateExpiresAtCache();
      // Bridge event → WebView: laat de webapp een relogin-scherm tonen.
      emitBridgeEvent("onAuthExpired", {});
      return null;
    }

    // 5xx — serverfout, laat tokens intact, volgende tick probeert het opnieuw
    console.log(
      `[CMDS-GPS] refresh-token server error ${response.status} — retry volgende tick`,
    );
    return null;
  } catch (e) {
    const ms = Date.now() - startedAt;
    const isTimeout = e instanceof Error && e.name === "AbortError";
    const msg = e instanceof Error ? e.message : String(e);
    console.log(
      `[CMDS-GPS] refresh-token network error${isTimeout ? " (timeout)" : ""}: ${msg} ms=${ms}`,
    );
    return null;
  }
}
