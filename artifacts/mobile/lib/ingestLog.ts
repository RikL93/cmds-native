/**
 * ingestLog.ts
 *
 * Ring-buffer van de laatste MAX_LOG_ENTRIES ingest-acties, opgeslagen in
 * AsyncStorage. Wordt gebruikt door het Ingest Diagnose scherm in app/index.tsx.
 * Logging is non-blocking: fouten worden genegeerd zodat de GPS-loop nooit
 * vertraagd wordt door AsyncStorage-operaties.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

export const INGEST_LOG_KEY = "cmds_ingest_log";
const MAX_LOG_ENTRIES = 200;

export type IngestPhase =
  | "tick"
  | "post_attempt"
  | "post_response"
  | "skip"
  | "bridge_event"
  | "token_refresh"
  | "service_state";

export type IngestLogDetail = {
  unitId?: string | null;
  hasToken?: boolean;
  tokenExpiresIn?: number;
  url?: string;
  httpStatus?: number;
  responseBody?: string;
  skipReason?: string;
  bridgeEvent?: string;
  serviceRunning?: boolean;
  error?: string;
  source?: string;
  lat?: number;
  lng?: number;
};

export type IngestLogEntry = {
  ts: string;
  phase: IngestPhase;
  detail: IngestLogDetail;
};

let _logBuffer: IngestLogEntry[] | null = null;
let _dirty = false;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(async () => {
    _flushTimer = null;
    if (!_dirty || !_logBuffer) return;
    _dirty = false;
    try {
      await AsyncStorage.setItem(INGEST_LOG_KEY, JSON.stringify(_logBuffer));
    } catch {
      // non-critical
    }
  }, 400);
}

export async function logIngest(
  phase: IngestPhase,
  detail: IngestLogDetail,
): Promise<void> {
  try {
    if (_logBuffer === null) {
      const raw = await AsyncStorage.getItem(INGEST_LOG_KEY);
      _logBuffer = raw ? (JSON.parse(raw) as IngestLogEntry[]) : [];
    }
    _logBuffer.push({ ts: new Date().toISOString(), phase, detail });
    if (_logBuffer.length > MAX_LOG_ENTRIES) {
      _logBuffer = _logBuffer.slice(-MAX_LOG_ENTRIES);
    }
    _dirty = true;
    scheduleFlush();
  } catch {
    // non-critical
  }
}

export async function getIngestLog(): Promise<IngestLogEntry[]> {
  try {
    if (_logBuffer !== null) return [..._logBuffer];
    const raw = await AsyncStorage.getItem(INGEST_LOG_KEY);
    return raw ? (JSON.parse(raw) as IngestLogEntry[]) : [];
  } catch {
    return [];
  }
}

export async function clearIngestLog(): Promise<void> {
  _logBuffer = [];
  _dirty = false;
  try {
    await AsyncStorage.removeItem(INGEST_LOG_KEY);
  } catch {
    // non-critical
  }
}
