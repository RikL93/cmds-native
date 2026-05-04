/**
 * locationQueue.ts
 *
 * AsyncStorage-backed ring-buffer voor locatie-payloads die niet direct
 * gepost konden worden (netwerkverlies, tijdelijke server-fout).
 *
 * Ontwerpkeuzes:
 * - Max 200 entries; de oudste valt eraf als de queue vol is (FIFO drop).
 * - AsyncStorage zodat de queue overleeft bij achtergrond-task restarts.
 * - drainQueue() neemt een postFn-parameter om circulaire imports te vermijden.
 * - Een module-level lock (_draining) voorkomt gelijktijdige drain-runs in
 *   dezelfde JS-context. Aparte achtergrond-task contexten starten elk
 *   met _draining = false — dat is correct gedrag.
 * - queue-retry posts tellen mee als "onLocationPosted" bridge event.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import { emitBridgeEvent } from "./bridgeEvents";

export const QUEUE_STORAGE_KEY = "cmds_location_queue";
const MAX_QUEUE_SIZE = 200;

export type QueuedItem = {
  payload: Record<string, unknown>;
  accessToken: string;
  enqueuedAt: number;
  retries: number;
};

export type PostFn = (
  payload: Record<string, unknown>,
  accessToken: string,
  source: string,
) => Promise<number | null>;

let _draining = false;

// Cross-context drain-lock: voorkomt dat meerdere achtergrond-task instances
// (elk met hun eigen _draining = false) tegelijk de queue leegdraineren en
// duplicaten sturen. TTL van 30s voorkomt een permanente lock bij crash.
const DRAIN_LOCK_KEY = "cmds_gps_drain_lock";
const DRAIN_LOCK_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Interne helpers
// ---------------------------------------------------------------------------

async function loadQueue(): Promise<QueuedItem[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedItem[];
  } catch {
    return [];
  }
}

async function saveQueue(items: QueuedItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Non-critical: verlies van queue-state bij schrijffout is acceptabel.
  }
}

// ---------------------------------------------------------------------------
// Publieke API
// ---------------------------------------------------------------------------

/**
 * Voegt een gefaalde payload toe aan de persistente queue en vuurt
 * onLocationPostError af zodat het ingest-diagnose panel dit logt.
 * Als de queue vol is (200 entries) wordt de oudste entry verwijderd.
 */
export async function enqueueLocation(
  payload: Record<string, unknown>,
  accessToken: string,
  source?: string,
): Promise<void> {
  const items = await loadQueue();
  if (items.length >= MAX_QUEUE_SIZE) items.shift(); // FIFO drop
  items.push({ payload, accessToken, enqueuedAt: Date.now(), retries: 0 });
  await saveQueue(items);
  emitBridgeEvent("onLocationPostError", {
    status: null,
    message: "network",
    willRetry: true,
    queueSize: items.length,
    source: source ?? "unknown",
  });
}

/**
 * Leest het huidige aantal items in de queue (zonder de queue te laden).
 * Gebruikt AsyncStorage-leeslag — alleen aanroepen als je het echt nodig hebt.
 */
export async function getQueueSize(): Promise<number> {
  const items = await loadQueue();
  return items.length;
}

/**
 * Probeert alle ge-queuede items te posten via postFn.
 *
 * - Bij HTTP 2xx: item verwijderd, brug event "onLocationPosted" gevuurd.
 * - Bij HTTP 401/403: item verwijderd (auth-fout, user moet opnieuw inloggen).
 * - Bij netwerkverlies of 5xx: stop met draineren, item blijft in queue.
 *
 * @param postFn   De functie die een locatie POST uitvoert.
 * @param freshToken Huidig geldig access token (overschrijft het token dat
 *                   bij enqueueing was opgeslagen, dat inmiddels verlopen
 *                   kan zijn).
 */
export async function drainQueue(
  postFn: PostFn,
  freshToken: string,
): Promise<void> {
  if (_draining) return;

  // Cross-context lock: lees huidige lock-timestamp uit AsyncStorage.
  // Als een andere background-task instance al aan het draineren is (lock < 30s
  // oud), skip dan. TTL van 30s voorkomt permanente deadlock bij crash.
  try {
    const lockRaw = await AsyncStorage.getItem(DRAIN_LOCK_KEY);
    if (lockRaw) {
      const age = Date.now() - Number(lockRaw);
      if (age >= 0 && age < DRAIN_LOCK_TTL_MS) return;
    }
    await AsyncStorage.setItem(DRAIN_LOCK_KEY, String(Date.now()));
  } catch {
    // AsyncStorage fout → toch doorgaan (best-effort)
  }

  _draining = true;
  try {
    const items = await loadQueue();
    if (items.length === 0) return;

    const remaining: QueuedItem[] = [];
    for (const item of items) {
      const tokenToUse =
        freshToken.length > 0 ? freshToken : item.accessToken;
      const status = await postFn(
        item.payload,
        tokenToUse,
        "queue-retry",
      );

      if (status !== null && status >= 200 && status < 300) {
        // Succes — item uit queue, event naar WebView
        emitBridgeEvent("onLocationPosted", {
          status,
          queueSize: remaining.length,
          source: "queue-drain",
          lat: item.payload.latitude,
          lng: item.payload.longitude,
        });
      } else if (status === 401 || status === 403) {
        // Auth-fout — item droppen; gebruiker moet opnieuw inloggen
      } else {
        // Netwerkverlies of 5xx — bewaar de rest en stop
        remaining.push({ ...item, retries: item.retries + 1 });
        // Voeg resterende items toe die we nog niet behandeld hebben
        const idx = items.indexOf(item);
        remaining.push(...items.slice(idx + 1));
        break;
      }
    }
    await saveQueue(remaining);
  } finally {
    _draining = false;
    // Geef de cross-context lock vrij zodat de volgende drain kan starten.
    AsyncStorage.removeItem(DRAIN_LOCK_KEY).catch(() => undefined);
  }
}
