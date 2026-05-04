# CMDS — Addendum op `CMDS_Replit_Native_Fix_Prompt.md`
## Onderwerp: Token-refresh tijdens Doze + WebView-resume

**Status:** kritisch. Reproductie bevestigd in productie op **BRAVO 1**:
- Telefoon ~30 min in screen-lock → bij wake toont webview "Eenheid gekoppeld: **nee**".
- Edge function log `whoami-unit` toont op exact dat moment:
  ```
  Error: JWT has expired
    at auth.getClaims (whoami-unit/index.ts:55)
  ```
- Zodra de gebruiker handmatig "Test nu een POST" indrukt → token wordt alsnog ververst → UI springt naar groen + BRAVO 1.

**Conclusie:** background-GPS draait (native), maar de **WebView-sessie loopt op een verlopen JWT** omdat:
1. `supabase-js` `autoRefreshToken` staat stil tijdens Doze (timer pauzeert in achtergrond-WebView).
2. De native `SupabaseTokenManager` (Sectie 6) ververst óf niet proactief, óf pusht het verse token niet naar de WebView.
3. De WebView weet bij resume niet dat hij zijn in-memory token moet vervangen.

---

## Wat er **verplicht** moet draaien (acceptance criteria)

### A. Native `SupabaseTokenManager` — proactief refresh
- Eigen native timer (NIET via WebView `setInterval`), elke **25 min**.
- Bovendien: bij elke `getValidToken()` call → als `expires_at - now < 5 min` → refresh-on-demand vóór return.
- Refresh endpoint:
  ```
  POST https://txauyjkivyzgxetmadkj.supabase.co/auth/v1/token?grant_type=refresh_token
  Headers:
    apikey: <SUPABASE_ANON_KEY>
    Content-Type: application/json
  Body: { "refresh_token": "<stored_refresh_token>" }
  ```
- Response opslaan in `EncryptedSharedPreferences`: `access_token`, `refresh_token`, `expires_at` (Unix-seconden).

### B. Native → WebView push na elke refresh
De webapp heeft deze hook al klaarstaan in `src/lib/cmdsNative.ts`:
```ts
window.CMDS_NATIVE.onSupabaseTokenRefreshed?.({
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number | null,   // Unix seconds
  userId: string | null,
})
```
**Verplicht aanroepen:**
1. Direct na elke succesvolle native refresh.
2. Direct bij **elke WebView-resume** (lifecycle `onResume` van de Activity / `webView.onResume()`), zelfs als er niet net ververst is — stuur dan de huidige geldige token mee. Dit dwingt de webapp zijn `supabase.auth.setSession()` te updaten zodat `whoami-unit` niet met de oude in-memory token wordt aangeroepen.

### C. WebView-resume hook
In de native Activity:
```kotlin
override fun onResume() {
  super.onResume()
  val token = SupabaseTokenManager.getValidToken()  // refresht indien nodig
  webView.evaluateJavascript(
    "window.CMDS_NATIVE?.onSupabaseTokenRefreshed?.(${tokenPayloadJson})",
    null
  )
}
```
Dit MOET vóór elke andere webview-call gebeuren bij wake.

### D. Native `whoami-unit`-pre-warm bij resume (aanbevolen)
Voordat de webview iets doet, kan de native shell zelf één `whoami-unit` GET doen met de verse token. Resultaat → bridge-event `onUnitLinked` (al bestaand). Hierdoor staat de UI direct op "gekoppeld: ja" zonder af te wachten of de webview zelf op tijd refresht.

### E. Ingest-POST gebruikt **altijd** `getValidToken()`
Niet de cached token uit `linkUnit({ accessToken })` payload. Die is na 1u verlopen.
- Bij 401 op `ingest-location` → forceer refresh → retry POST één keer.
- Bij refresh-failure (refresh_token expired, 400/401 van `/auth/v1/token`) → bridge `onAuthExpired()` → webapp toont relogin.

---

## Test-checklist (verplicht groen vóór oplevering)

- [ ] Eenheid gekoppeld → telefoon 30 min in lock → bij wake toont webview **direct** "gekoppeld: ja" (max 2s na unlock).
- [ ] Edge-function log `whoami-unit` toont **geen** "JWT has expired" meer in dat tijdvenster.
- [ ] `ingest-location` heeft geen 401-gaten rond minuut 55-65 (token-refresh moment).
- [ ] Telefoon 2 uur lock → token is minstens 1× ververst native → GPS-stream onafgebroken groen.
- [ ] Webapp ontvangt `onSupabaseTokenRefreshed` event minimaal:
  - 1× bij elke wake
  - 1× elke 25 min in achtergrond
- [ ] Bij geforceerde airplane-mode 2 min tijdens refresh → na reconnect één retry → succes, geen logout.

---

## Diagnose-bewijs voor Replit

Edge function log (productie, BRAVO 1):
```
timestamp: 1777790049 (ms→s)
function: whoami-unit
error: "JWT has expired"
stack: auth-js.mjs:19 → whoami-unit/index.ts:55 (auth.getClaims)
```
Dit bewijst dat de WebView een verlopen `Authorization: Bearer` header meestuurt op het wake-moment. De fix moet dus **op token-laag** plaatsvinden, niet op GPS-laag.

---

## Migratie-instructie
Als `SupabaseTokenManager` al bestaat: voeg toe:
1. `onResume` hook in MainActivity die `evaluateJavascript` doet met verse token.
2. Verwijder elk gebruik van de "linkUnit-cached" accessToken in POSTs — vervang door `getValidToken()`.
3. Implementeer 401-retry in `LocationPoster`.
4. Voeg pre-warm `whoami-unit` GET toe in `onResume` (optioneel maar sterk aanbevolen).

Geen wijzigingen nodig in de webapp — alle bridge-hooks staan al klaar in `src/lib/cmdsNative.ts`.
