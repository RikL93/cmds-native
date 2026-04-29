import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

export const LOCATION_TASK_NAME = "cmds-background-location-task";
export const LOCATION_ENDPOINT = "https://cmdsevent.nl/api/location";

type BackgroundTaskBody = {
  data?: { locations?: Location.LocationObject[] };
  error?: TaskManager.TaskManagerError | null;
};

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
        source: "cmds-mobile-app",
      };

      try {
        await fetch(LOCATION_ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
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
      notificationBody: "GPS wordt op de achtergrond gedeeld met cmds.nl.",
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
