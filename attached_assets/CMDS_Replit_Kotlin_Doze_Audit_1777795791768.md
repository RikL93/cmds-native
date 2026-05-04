# CMDS — Audit-verzoek: Kotlin background GPS tijdens screen-off / Doze

## Status (door Lovable geverifieerd)
- Token-refresh werkt: geen JWT-expired bursts meer in edge-logs.
- `linked_device_id` blijft correct gevuld tijdens screen-off.
- `whoami-unit` + `ingest-location` werken end-to-end in foreground.
- **Probleem:** zodra het scherm uitgaat stoppen `ingest-location` POSTs volledig. In een sessie van 6 uur (BRAVO 1, scherm uit, in auto onderweg) kwam er **slechts één** `unit_locations`-upsert binnen (06:53:41Z). Daarna 0 calls in de edge-function-logs → het stopt **aan native-kant** (geen netwerk-call vertrekt).

We hebben de `cmds-native` repo bekeken. De Kotlin-source van `nl.cmds.location.LocationTrackingService` zit niet in de repo (alleen de Expo config-plugin die hem in het manifest registreert). Daarom hebben we jullie nodig om de onderstaande punten **letterlijk uit de Kotlin-code te citeren** en terug te sturen.

## Wat we van jullie nodig hebben (a.u.b. exact in deze volgorde)

### 1) `LocationRequest` configuratie
Plak het volledige `LocationRequest.Builder(...).build()` blok uit `LocationTrackingService.kt` (of waar jullie het bouwen). Wij willen specifiek bevestigd zien:

```kotlin
LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10_000L)
    .setMinUpdateIntervalMillis(5_000L)
    .setMaxUpdateDelayMillis(15_000L)   // ← KRITIEK tegen Doze-batching
    .setWaitForAccurateLocation(false)
    .build()
```

Als `setMaxUpdateDelayMillis` ontbreekt of > 15s staat: dat is bijna zeker de root cause. Android batcht dan locaties tot Doze 'm laat gaan (kan 15-30 min duren).

### 2) Foreground-service lifecycle
Plak de `onStartCommand()` of `startService()`-flow. Bevestig:
- `startForeground(notifId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)` wordt aangeroepen **binnen 5s** na `Context.startForegroundService(...)`.
- Op Android 14+ wordt `FOREGROUND_SERVICE_TYPE_LOCATION` expliciet meegegeven.
- De service heeft `android:foregroundServiceType="location"` in het manifest (✓ al bevestigd via plugin.js).
- De `LocationCallback` wordt geregistreerd **na** `startForeground()`, niet ervoor.

### 3) Battery-optimization whitelist
- Wordt `requestBatteryOptimizationExemption()` daadwerkelijk **automatisch** aangeroepen bij eerste service-start, of moet de gebruiker dit handmatig doen?
- Hoe verifiëren jullie dat de gebruiker de prompt heeft geaccepteerd? (logregel + opslag van de status graag)

### 4) Logcat-bewijs (15 minuten, scherm uit)
Draai op een testtoestel:
```
adb logcat -c
adb logcat -s LocationTrackingService:V CmdsLocation:V FusedLocationProviderClient:V > doze_test.log
```
Zet het scherm uit, wacht 15 minuten, beweeg het toestel ~50m. Stuur `doze_test.log` op. Wij kijken naar:
- Frequentie van `onLocationResult` calls tijdens screen-off
- Eventuele `Service stopped` / `ANR` / `Doze` meldingen
- Of `POST_ATTEMPT` regels worden gelogd elke 10s

### 5) Doze-status van het toestel
```
adb shell dumpsys deviceidle whitelist | grep -i cmds
adb shell dumpsys deviceidle | grep -i mState
```
Stuur de output. We willen zien dat het package in de whitelist staat én dat de device niet vastzit in `IDLE`/`IDLE_MAINTENANCE` zonder dat onze service nog vuurt.

### 6) Bron in repo
Graag de Kotlin-source (`*.kt` files van `modules/cmds-location`) **committen naar `cmds-native`**. Nu staat alleen de Expo config-plugin in de repo — de echte service is onzichtbaar voor externe review. Zonder die bron kunnen wij niet meekijken bij volgende issues.

## Verwachte output van jullie kant
1. Code-snippet van `LocationRequest`-builder (puntje 1)
2. Code-snippet van `onStartCommand` + `startForeground` (puntje 2)
3. Bevestiging + code van battery-optimization-flow (puntje 3)
4. `doze_test.log` als attachment (puntje 4)
5. Output van beide `adb shell dumpsys` commands (puntje 5)
6. Commit-hash waarin de `.kt` bronbestanden zijn toegevoegd (puntje 6)

## Hypothese vooraf
Wij vermoeden dat `setMaxUpdateDelayMillis` ontbreekt of te hoog staat. Dat verklaart 1-op-1 dat foreground perfect werkt (Doze inactief) maar background na schermuit volledig stilvalt tot een wake-event (bv. de "Test post"-knop) de WebView+service weer triggert.

Bedankt!
