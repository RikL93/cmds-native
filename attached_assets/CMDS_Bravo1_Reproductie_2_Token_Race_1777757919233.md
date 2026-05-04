# CMDS — Reproductie #2: Token-refresh race → forced re-login

**Eenheid:** BRAVO 1
**Datum reproductie:** 2 mei 2026, ~22:00 lokaal (20:00 UTC)
**Symptoom gebruiker:** Na ~30 min rijden (mix foreground / background / scherm op slot) wordt de gebruiker geforceerd uitgelogd in de webapp en moet opnieuw inloggen.

---

## 1. Timeline (uit Supabase auth + edge logs)

| Tijd (UTC) | Gebeurtenis | Bron |
|---|---|---|
| 20:01:54 | Laatste succesvolle `ingest-location` POST (acc. ~12 m) | edge logs |
| 20:01:54 → 20:13:29 | **GPS-gat van ~11½ min** — geen POSTs (Doze / dozing WebView) | edge logs |
| 20:13:29 | Native shell probeert `POST /auth/v1/token?grant_type=refresh_token` → **HTTP 400** `error_code: refresh_token_already_used` | auth logs |
| 20:13:29 | Supabase markeert dit als **"Possible abuse attempt"** → **HTTP 430** → sessie revoked | auth logs |
| 20:13:35 | Gebruiker krijgt loginscherm in WebView, logt handmatig opnieuw in | auth logs |
| 20:13:36+ | Nieuwe sessie actief, GPS-stream herstart | edge logs |

## 2. Root cause

**Refresh-token race tussen WebView en native shell.**

1. WebView (Supabase JS-client, `autoRefreshToken: true`) en native shell delen dezelfde Supabase-sessie.
2. Tijdens het GPS-gat verloopt het access_token (1u TTL).
3. Native shell **én** WebView proberen ongeveer gelijktijdig te refreshen met **hetzelfde** `refresh_token`.
4. Wie als eerste binnen is wint; de tweede call krijgt `refresh_token_already_used`.
5. Supabase interpreteert dat als token-diefstal → **revoke van de hele sessie** → forced logout.

Dit is exact het scenario dat **Sectie 6 (SupabaseTokenManager)** en **Sectie 7 (Watchdog)** in de hoofdprompt moeten voorkomen, maar dat in de huidige native build nog **niet** geïmplementeerd is.

## 3. Wat ontbreekt in de native shell

### a) Proactieve refresh (Sectie 6)
- Geen timer die het access_token vernieuwt **vóór** expiry (richtlijn: elke 25 min).
- Gevolg: token verloopt tijdens een Doze-periode en moet reactief refreshen op het moment dat de WebView óók wakker wordt → race.

### b) Singleton refresh-lock (Sectie 6)
- Geen mutex / "in-flight refresh" guard tussen native shell en WebView.
- Gevolg: dubbele refresh-calls met dezelfde `refresh_token`.
- Vereist: native shell moet **de enige** zijn die refresht zodra hij actief is, en het verse token via `onSupabaseTokenRefreshed({ accessToken, refreshToken, expiresAt, userId })` naar de WebView pushen. De WebView moet dan **niet zelf** ook nog refreshen.

### c) Stream-watchdog (Sectie 7)
- Geen herstart van de FusedLocationProvider-stream als laatste POST > 90s geleden is.
- Gevolg: het GPS-gat van 11½ min hierboven — de stream was de facto dood, alleen de notificatie bleef hangen.

## 4. Verificatie in database

```
SELECT created_at, accuracy
FROM unit_locations
WHERE unit_id = '<bravo1-id>'
ORDER BY created_at DESC LIMIT 5;
```
Bevestigt: gat tussen 20:01:54 en 20:13:36 UTC, daarna weer normale 10s-cadans.

## 5. Actie voor Replit

> Implementeer **Sectie 6 (SupabaseTokenManager)** en **Sectie 7 (Watchdog)** uit `CMDS_Replit_Native_Fix_Prompt.md` met de volgende harde eisen, gemotiveerd door bovenstaande reproductie:
>
> - [ ] Native shell refresht het access_token **proactief** op `expires_at - 25 min`.
> - [ ] Native shell houdt een **singleton refresh-lock**; tijdens een refresh wachten andere POSTs max 10s op het nieuwe token i.p.v. zelf te refreshen.
> - [ ] Direct na een geslaagde refresh: bridge-event `onSupabaseTokenRefreshed({ accessToken, refreshToken, expiresAt, userId })` zodat de WebView het nieuwe token overneemt en **zelf niet meer** probeert te refreshen.
> - [ ] WatchManager-job (elke 5 min): als laatste succesvolle `ingest-location` > 90s geleden → `requestLocationUpdates()` opnieuw starten in de bestaande foreground-service.
> - [ ] Bij `refresh_token_already_used` of HTTP 430: **niet** direct uitloggen — eerst 1× backoff (5s), dan opnieuw `getValidToken()`. Pas bij twee opeenvolgende failures `onAuthExpired()` dispatchen.
>
> **Acceptance test (verplicht vóór oplevering):**
> BRAVO 1 koppelen → 90 min rijden met scherm op slot → geen forced logout, geen GPS-gat > 30s, geen `refresh_token_already_used` in auth logs.

---

*Deze notitie is een aanvulling op `CMDS_Replit_Native_Fix_Prompt.md` — niet ter vervanging. Stuur beide bestanden mee.*
