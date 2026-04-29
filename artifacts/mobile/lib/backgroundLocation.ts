import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

export const LOCATION_TASK_NAME = "cmds-background-location-task";
export const LOCATION_ENDPOINT =
  "https://txauyjkivyzgxetmadkj.supabase.co/functions/v1/ingest-location";

export const SUPABASE_TOKEN_STORAGE_KEY = "cmds.supabase.access_token";

type BackgroundTaskBody = {
  data?: { locations?: Location.LocationObject[] };
  error?: TaskManager.TaskManagerError | null;
};

export async function setSupabaseAccessToken(
  token: string | null,
): Promise<void> {
  if (token && token.length > 0) {
    await AsyncStorage.setItem(SUPABASE_TOKEN_STORAGE_KEY, token);
  } else {
    await AsyncStorage.removeItem(SUPABASE_TOKEN_STORAGE_KEY);
  }
}

export async function getSupabaseAccessToken(): Promise<string | null> {
  return AsyncStorage.getItem(SUPABASE_TOKEN_STORAGE_KEY);
}

if (Platform.OS !== "web" && !TaskManager.isTaskDefined(LOCATION_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_TASK_NAME, async (body) => {
    const { data, error } = body as BackgroundTaskBody;

    if (error) {
      return;
    }

    const locations = data?.locations;
    if (!locations || locations.length === 0) {
      return;
    }

    const accessToken = await getSupabaseAccessToken();
    if (!accessToken) {
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

      try {
        await fetch(LOCATION_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(payload),
        });
      } catch {
        // Network errors are expected occasionally — the next interval will retry.
      }
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
    timeInterval: 60_000,
    distanceInterval: 0,
    deferredUpdatesInterval: 60_000,
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
