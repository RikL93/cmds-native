import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

export const LOCATION_TASK_NAME = "cmds-background-location-task";
export const LOCATION_ENDPOINT =
  "https://txauyjkivyzgxetmadkj.supabase.co/functions/v1/ingest-location";

export const SUPABASE_TOKEN_STORAGE_KEY = "cmds.supabase.access_token";
export const DIAGNOSTICS_STORAGE_KEY = "cmds.diagnostics";

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
  postSuccessCount: number;
  postFailureCount: number;
  lastTokenSeenAt: string | null;
  lastTokenLength: number;
};

const DEFAULT_DIAGNOSTICS: Diagnostics = {
  lastBackgroundFixAt: null,
  lastBackgroundLat: null,
  lastBackgroundLng: null,
  lastPostAt: null,
  lastPostStatus: null,
  lastPostError: null,
  lastPostBody: null,
  postSuccessCount: 0,
  postFailureCount: 0,
  lastTokenSeenAt: null,
  lastTokenLength: 0,
};

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

export async function setSupabaseAccessToken(
  token: string | null,
): Promise<void> {
  if (token && token.length > 0) {
    await AsyncStorage.setItem(SUPABASE_TOKEN_STORAGE_KEY, token);
    await patchDiagnostics({
      lastTokenSeenAt: new Date().toISOString(),
      lastTokenLength: token.length,
    });
  } else {
    await AsyncStorage.removeItem(SUPABASE_TOKEN_STORAGE_KEY);
    await patchDiagnostics({ lastTokenLength: 0 });
  }
}

export async function getSupabaseAccessToken(): Promise<string | null> {
  return AsyncStorage.getItem(SUPABASE_TOKEN_STORAGE_KEY);
}

async function postLocation(
  payload: Record<string, unknown>,
  accessToken: string,
): Promise<void> {
  try {
    const response = await fetch(LOCATION_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = "";
    }
    const current = await getDiagnostics();
    if (response.ok) {
      await patchDiagnostics({
        lastPostAt: new Date().toISOString(),
        lastPostStatus: response.status,
        lastPostError: null,
        lastPostBody: bodyText.slice(0, 500),
        postSuccessCount: current.postSuccessCount + 1,
      });
    } else {
      await patchDiagnostics({
        lastPostAt: new Date().toISOString(),
        lastPostStatus: response.status,
        lastPostError: `HTTP ${response.status}`,
        lastPostBody: bodyText.slice(0, 500),
        postFailureCount: current.postFailureCount + 1,
      });
    }
  } catch (e) {
    const current = await getDiagnostics();
    await patchDiagnostics({
      lastPostAt: new Date().toISOString(),
      lastPostStatus: null,
      lastPostError: e instanceof Error ? e.message : String(e),
      lastPostBody: null,
      postFailureCount: current.postFailureCount + 1,
    });
  }
}

if (Platform.OS !== "web" && !TaskManager.isTaskDefined(LOCATION_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_TASK_NAME, async (body) => {
    const { data, error } = body as BackgroundTaskBody;

    if (error) {
      await patchDiagnostics({
        lastPostError: `task error: ${error.message ?? "unknown"}`,
      });
      return;
    }

    const locations = data?.locations;
    if (!locations || locations.length === 0) {
      return;
    }

    const lastLocation = locations[locations.length - 1];
    if (lastLocation) {
      await patchDiagnostics({
        lastBackgroundFixAt: new Date(lastLocation.timestamp).toISOString(),
        lastBackgroundLat: lastLocation.coords.latitude,
        lastBackgroundLng: lastLocation.coords.longitude,
      });
    }

    const accessToken = await getSupabaseAccessToken();
    if (!accessToken) {
      await patchDiagnostics({
        lastPostError: "no access token in storage — log in to the website",
      });
      return;
    }

    for (const location of locations) {
      const payload = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracy: location.coords.accuracy,
        altitude: location.coords.altitude,
        altitudeAccuracy: location.coords.altitudeAccuracy,
        speed: location.coords.speed,
        heading: location.coords.heading,
        timestamp: location.timestamp,
        recorded_at: new Date(location.timestamp).toISOString(),
        source: "cmds-mobile-app",
      };
      await postLocation(payload, accessToken);
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
    accuracy: Location.Accuracy.Balanced,
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

export async function sendTestPing(): Promise<{
  ok: boolean;
  status: number | null;
  body: string;
  error: string | null;
}> {
  if (Platform.OS === "web") {
    return { ok: false, status: null, body: "", error: "web not supported" };
  }

  const accessToken = await getSupabaseAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      status: null,
      body: "",
      error: "no access token in storage — log in to the website first",
    };
  }

  let coords: Location.LocationObject;
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
    };
  }

  const payload = {
    latitude: coords.coords.latitude,
    longitude: coords.coords.longitude,
    accuracy: coords.coords.accuracy,
    altitude: coords.coords.altitude,
    altitudeAccuracy: coords.coords.altitudeAccuracy,
    speed: coords.coords.speed,
    heading: coords.coords.heading,
    timestamp: coords.timestamp,
    recorded_at: new Date(coords.timestamp).toISOString(),
    source: "cmds-mobile-app-test",
  };

  try {
    const response = await fetch(LOCATION_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    await postLocation(payload, accessToken);
    return {
      ok: response.ok,
      status: response.status,
      body: body.slice(0, 500),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      body: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
