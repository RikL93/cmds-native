import AsyncStorage from "@react-native-async-storage/async-storage";

export const WHOAMI_ENDPOINT =
  "https://txauyjkivyzgxetmadkj.supabase.co/functions/v1/whoami-unit";

const STATUS_STORAGE_KEY = "cmds.linkedUnit";

export type LinkedUnit = {
  id: string;
  call_sign: string;
  event_id: string | null;
  status: string | null;
};

export type LinkedUnitStatus = {
  linked: boolean;
  unit: LinkedUnit | null;
  tokenInvalid: boolean;
  checkedAt: string;
  httpStatus: number | null;
  error: string | null;
};

const EMPTY_STATUS: LinkedUnitStatus = {
  linked: false,
  unit: null,
  tokenInvalid: false,
  checkedAt: "",
  httpStatus: null,
  error: null,
};

// In-memory flag: set by invalidateLinkedUnitCache() to force a fresh fetch
// on the next getOrRefreshLinkedUnitStatus() call regardless of TTL.
let _forceNextRefresh = false;

/**
 * Forces the next getOrRefreshLinkedUnitStatus() call to bypass the cache and
 * hit the server. Used after a 401 retry to ensure the new token is validated.
 */
export function invalidateLinkedUnitCache(): void {
  _forceNextRefresh = true;
}

export async function getCachedLinkedUnitStatus(): Promise<LinkedUnitStatus | null> {
  try {
    const raw = await AsyncStorage.getItem(STATUS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { ...EMPTY_STATUS, ...parsed };
  } catch {
    return null;
  }
}

async function writeCachedStatus(status: LinkedUnitStatus): Promise<void> {
  try {
    await AsyncStorage.setItem(STATUS_STORAGE_KEY, JSON.stringify(status));
  } catch {
    // Cache write failures are non-critical.
  }
}

export async function clearLinkedUnitCache(): Promise<void> {
  await AsyncStorage.removeItem(STATUS_STORAGE_KEY);
}

export async function fetchLinkedUnitStatus(
  token: string,
): Promise<LinkedUnitStatus> {
  const checkedAt = new Date().toISOString();
  try {
    console.log("[CMDS-GPS] before-fetch whoami-unit");
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(WHOAMI_ENDPOINT, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(abortTimer);
    }
    console.log(`[CMDS-GPS] after-fetch whoami-unit status=${response.status}`);

    if (response.status === 401) {
      const status: LinkedUnitStatus = {
        linked: false,
        unit: null,
        tokenInvalid: true,
        checkedAt,
        httpStatus: 401,
        error: "Unauthorized — token verlopen",
      };
      await writeCachedStatus(status);
      return status;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const status: LinkedUnitStatus = {
        linked: false,
        unit: null,
        tokenInvalid: false,
        checkedAt,
        httpStatus: response.status,
        error: `HTTP ${response.status} ${bodyText.slice(0, 120)}`,
      };
      await writeCachedStatus(status);
      return status;
    }

    const body = (await response.json()) as {
      linked?: boolean;
      unit?: LinkedUnit | null;
    };

    const status: LinkedUnitStatus = {
      linked: !!body.linked,
      unit: body.unit ?? null,
      tokenInvalid: false,
      checkedAt,
      httpStatus: response.status,
      error: null,
    };
    console.log(
      `[CMDS-GPS] whoami-unit → linked=${status.linked} call_sign=${status.unit?.call_sign ?? "-"}`,
    );
    await writeCachedStatus(status);
    return status;
  } catch (e) {
    const status: LinkedUnitStatus = {
      linked: false,
      unit: null,
      tokenInvalid: false,
      checkedAt,
      httpStatus: null,
      error: e instanceof Error ? e.message : String(e),
    };
    await writeCachedStatus(status);
    return status;
  }
}

/**
 * Returns a cached status if it's fresher than `maxAgeMs`, otherwise refreshes.
 */
export async function getOrRefreshLinkedUnitStatus(
  token: string,
  maxAgeMs: number,
): Promise<LinkedUnitStatus> {
  if (!_forceNextRefresh) {
    const cached = await getCachedLinkedUnitStatus();
    if (cached && cached.checkedAt) {
      const age = Date.now() - new Date(cached.checkedAt).getTime();
      if (age >= 0 && age < maxAgeMs && !cached.tokenInvalid) {
        return cached;
      }
    }
  }
  _forceNextRefresh = false;
  return fetchLinkedUnitStatus(token);
}
