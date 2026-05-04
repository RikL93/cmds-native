/**
 * bridgeEvents.ts
 *
 * Module-level pub/sub voor native → WebView bridge events.
 * Emitters (backgroundLocation, supabaseRefresh) roepen emitBridgeEvent() aan.
 * index.tsx subscribet via onBridgeEvent() en injecteert de events in de WebView.
 *
 * Werkt alleen vanuit de hoofd-RN-context (foreground). Achtergrond-taken
 * draaien in een eigen JS-context: emitBridgeEvent() doet daar niets (geen
 * listeners) maar gooit geen fouten.
 */

export type BridgeEventName =
  | "onLocationPosted"
  | "onLocationPostError"
  | "onSupabaseTokenRefreshed"
  | "onAuthExpired"
  | "onServiceStateChanged";

export type BridgeEventPayload = Record<string, unknown>;

type Listener = (payload: BridgeEventPayload) => void;

const _listeners = new Map<BridgeEventName, Set<Listener>>();

/**
 * Subscribet op een bridge event. Geeft een unsubscribe-functie terug.
 * Veilig om meerdere keren aan te roepen (elke aanroep voegt een eigen
 * listener toe).
 */
export function onBridgeEvent(
  event: BridgeEventName,
  listener: Listener,
): () => void {
  if (!_listeners.has(event)) _listeners.set(event, new Set());
  _listeners.get(event)!.add(listener);
  return () => _listeners.get(event)?.delete(listener);
}

/**
 * Vuurt een bridge event af naar alle geregistreerde listeners.
 * Fouten in een listener worden stil geslikt zodat andere listeners
 * nog steeds worden aangeroepen.
 */
export function emitBridgeEvent(
  event: BridgeEventName,
  payload: BridgeEventPayload = {},
): void {
  const set = _listeners.get(event);
  if (!set) return;
  set.forEach((fn) => {
    try {
      fn(payload);
    } catch {
      // silent — andere listeners moeten ook draaien
    }
  });
}
