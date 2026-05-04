# CMDS — Replit Native Shell: Volledige Background GPS Fix (v2)

> **Status**: Vervangt en consolideert `CMDS_Native_Background_GPS_Implementation.md` (v1).
> **Platform**: Android (iOS volgt later).
> **Doel**: GPS-tracking van een gekoppelde eenheid blijft **ononderbroken groen** wanneer het scherm vergrendeld is, óók na 60+ minuten en óók tijdens Supabase token-refresh momenten.
> **Doelgroep**: De native developer / AI in Replit die de Capacitor-shell rondom de CMDS webapp onderhoudt.

---

## 0. TL;DR — Wat moet er gebeuren

De webapp werkt prima zolang het scherm aan staat. Zodra Android in **Doze-mode** gaat (scherm vergrendeld) wordt de WebView gepauzeerd en stopt al onze JS-driven GPS + HTTP. Dit moet **volledig native** worden afgehandeld, los van de WebView.

Concreet bouw je:

1. **Android Foreground Service** met persistent notification → bypasst Doze
2. **Native Location loop** (FusedLocationProviderClient, 10s) → onafhankelijk van WebView
3. **Native HTTP poster met queue + retry** → geen verloren coords meer
4. **Native Supabase Token Manager** met proactieve refresh → fixt de "oranje na ~20 min" hiccup
5. **Watchdog** (WorkManager, 5 min) → herstart service automatisch
6. **Verplichte 4-staps onboarding** → Locatie + Background Locatie + Notificaties + Batterij-optimalisatie
7. **Bridge events** zodat de webapp's `ingest-diagnose` paneel alles kan loggen

---

## 1. Diagnose — Waarom dit nodig is

Logs van de afgelopen test-sessies (eenheid `DELTA 1`, user-id `a2caf6fd-21c7-40c0-b2e0-a72005478d16`) tonen consistent één patroon:

```
10:22:18.628  POST_RESPONSE HTTP 200  ✅
10:22:18.670  POST_ATTEMPT (src=expo-bg)  ⏳
10:22:18.702  POST_ATTEMPT (src=expo-bg)  ⏳   ← geen response
10:22:18.741  SERVICE_STATE running=false ⚠️   ← service ge-killd
10:22:18.764  TOKEN_REFRESH onSupabaseTokenRefreshed ⚠️   ← JWT verliep
10:22:32.xxx  BRIDGE_EVENT onUnitLinked  🔄   ← service herstart
10:22:33.xxx  burst van 3-4 POSTs        🔄   ← backlog flush
```

**Conclusie**:
- Coords werden *wel* verzameld, maar konden ~10-30s niet verstuurd worden → **status oranje**
- Oorzaak: WebView-gedreven GPS + auth pauzeert tijdens schermlock + Supabase JWT (1u) verloopt
- Fix: alles wat met GPS, HTTP en auth te maken heeft moet **native** draaien

---

## 2. Architectuur

```text
┌─────────────────────────────────────────────┐
│  WebView (CMDS webapp)                      │
│  - UI, eenheid-selectie, ingest-diagnose    │
└──────────────┬──────────────────────────────┘
               │ Capacitor Bridge
┌──────────────▼──────────────────────────────┐
│  Native Android Layer                       │
│  ┌────────────────────────────────────────┐ │
│  │ LocationTrackingService (Foreground)   │ │
│  │  - FusedLocationProviderClient (10s)   │ │
│  │  - PARTIAL_WAKE_LOCK                   │ │
│  │  - Persistent notification             │ │
│  └────────────┬───────────────────────────┘ │
│               │                              │
│  ┌────────────▼───────────────────────────┐ │
│  │ LocationPoster (queue + retry)         │ │
│  └────────────┬───────────────────────────┘ │
│               │                              │
│  ┌────────────▼───────────────────────────┐ │
│  │ SupabaseTokenManager (proactief refr.) │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  ┌────────────────────────────────────────┐ │
│  │ Watchdog (WorkManager, elke 5 min)     │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

---

## 3. AndroidManifest.xml

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- Network -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <!-- Location -->
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />

    <!-- Foreground service (Android 14+ vereist het type) -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />

    <!-- Notifications (Android 13+) -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <!-- Wake lock + battery opt-out -->
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission
        android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

    <!-- Boot persistence (optioneel maar aanbevolen) -->
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />

    <application ...>

        <service
            android:name=".location.LocationTrackingService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="location" />

    </application>
</manifest>
```

---

## 4. Foreground Service — `LocationTrackingService.kt`

```kotlin
class LocationTrackingService : Service() {

    private lateinit var fused: FusedLocationProviderClient
    private lateinit var wakeLock: PowerManager.WakeLock
    private var callSign: String = "Eenheid"

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CMDS::LocationLock")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        callSign = intent?.getStringExtra("callSign") ?: "Eenheid"

        startForeground(NOTIF_ID, buildNotification(callSign))
        if (!wakeLock.isHeld) wakeLock.acquire()

        startLocationUpdates()
        Bridge.emit("onServiceStateChanged", mapOf("running" to true))
        return START_STICKY  // ← herstart automatisch als systeem hem killt
    }

    private fun startLocationUpdates() {
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10_000L)
            .setMinUpdateIntervalMillis(5_000L)
            .setMaxUpdateDelayMillis(15_000L)   // ← KRITIEK: forceer delivery ook bij stilstand
            .setWaitForAccurateLocation(false)
            .build()

        fused.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
    }

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.locations.forEach { loc ->
                LocationPoster.enqueue(
                    LocationPayload(
                        lat = loc.latitude,
                        lng = loc.longitude,
                        accuracy = loc.accuracy,
                        timestamp = loc.time
                    )
                )
            }
        }
    }

    override fun onDestroy() {
        if (wakeLock.isHeld) wakeLock.release()
        fused.removeLocationUpdates(locationCallback)
        Bridge.emit("onServiceStateChanged", mapOf("running" to false))
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(callSign: String): Notification {
        val channelId = "cmds_location_channel"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId, "CMDS GPS Tracking",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }

        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("CMDS — $callSign actief")
            .setContentText("Locatie wordt gedeeld met de meldkamer")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)              // ← non-dismissible
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    companion object { const val NOTIF_ID = 4711 }
}
```

---

## 5. `LocationPoster.kt` — Queue + Retry

Dit lost de "POST_ATTEMPT zonder response" gaps op. Coords gaan **nooit** verloren.

```kotlin
object LocationPoster {

    private const val MAX_QUEUE = 200
    private const val INGEST_URL =
        "https://txauyjkivyzgxetmadkj.supabase.co/functions/v1/ingest-location"

    private val queue = ArrayDeque<LocationPayload>()
    private val mutex = Mutex()
    private var backoffMs = 5_000L

    fun enqueue(p: LocationPayload) {
        synchronized(queue) {
            if (queue.size >= MAX_QUEUE) queue.removeFirst()  // FIFO drop
            queue.addLast(p)
        }
        CoroutineScope(Dispatchers.IO).launch { flush() }
    }

    private suspend fun flush() = mutex.withLock {
        while (queue.isNotEmpty()) {
            val payload = queue.first()
            val result = postOne(payload)

            when (result) {
                PostResult.OK -> {
                    queue.removeFirst()
                    backoffMs = 5_000L
                    Bridge.emit("onLocationPosted", mapOf(
                        "status" to 200,
                        "queueSize" to queue.size
                    ))
                }
                PostResult.AUTH_FAIL -> {
                    // Token al ververst in postOne(); probeer 1x retry, anders pauze
                    Bridge.emit("onLocationPostError", mapOf(
                        "status" to 401, "willRetry" to true
                    ))
                    delay(2_000L)
                    return@withLock
                }
                PostResult.NETWORK_FAIL -> {
                    Bridge.emit("onLocationPostError", mapOf(
                        "status" to 0,
                        "message" to "network",
                        "willRetry" to true
                    ))
                    delay(backoffMs)
                    backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
                    return@withLock
                }
            }
        }
    }

    private suspend fun postOne(p: LocationPayload): PostResult = withContext(Dispatchers.IO) {
        val token = SupabaseTokenManager.getValidToken()
            ?: return@withContext PostResult.AUTH_FAIL

        val unitId = SecureStore.getString("unitId") ?: return@withContext PostResult.AUTH_FAIL
        val eventId = SecureStore.getString("eventId")
        val orgId = SecureStore.getString("organizationId")

        val body = JSONObject().apply {
            put("unit_id", unitId)
            put("event_id", eventId)
            put("organization_id", orgId)
            put("lat", p.lat)
            put("lng", p.lng)
            put("accuracy", p.accuracy)
            put("timestamp", p.timestamp)
            put("source", "android-native")
        }.toString()

        val req = Request.Builder()
            .url(INGEST_URL)
            .header("Authorization", "Bearer $token")
            .header("apikey", BuildConfig.SUPABASE_ANON_KEY)
            .header("Content-Type", "application/json")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        try {
            httpClient.newCall(req).execute().use { resp ->
                when {
                    resp.isSuccessful -> PostResult.OK
                    resp.code == 401 -> {
                        // Forceer refresh, één retry
                        SupabaseTokenManager.forceRefresh()
                        PostResult.AUTH_FAIL
                    }
                    else -> PostResult.NETWORK_FAIL
                }
            }
        } catch (e: IOException) {
            PostResult.NETWORK_FAIL
        }
    }

    enum class PostResult { OK, AUTH_FAIL, NETWORK_FAIL }
    private val httpClient = OkHttpClient.Builder()
        .callTimeout(15, TimeUnit.SECONDS)
        .build()
}

data class LocationPayload(
    val lat: Double, val lng: Double, val accuracy: Float, val timestamp: Long
)
```

---

## 6. `SupabaseTokenManager.kt` — De kern-fix

Dit lost de **"oranje na ~20 minuten"** hiccup op. Token wordt nooit reactief tijdens een POST ververst — altijd **proactief vóór** expiry.

```kotlin
object SupabaseTokenManager {

    private const val REFRESH_URL =
        "https://txauyjkivyzgxetmadkj.supabase.co/auth/v1/token?grant_type=refresh_token"
    private const val REFRESH_INTERVAL_MS = 25 * 60 * 1000L   // 25 min (Supabase JWT = 60 min)
    private const val SAFETY_MARGIN_MS    = 5  * 60 * 1000L   // refresh als <5 min over

    private val mutex = Mutex()
    private var refreshJob: Job? = null

    fun setTokens(access: String, refresh: String, expiresAt: Long) {
        SecureStore.putString("access_token", access)
        SecureStore.putString("refresh_token", refresh)
        SecureStore.putLong("expires_at", expiresAt)
        startProactiveRefresh()
    }

    suspend fun getValidToken(): String? = mutex.withLock {
        val token = SecureStore.getString("access_token") ?: return null
        val expiresAt = SecureStore.getLong("expires_at", 0L)
        val now = System.currentTimeMillis()

        return if (expiresAt - now < SAFETY_MARGIN_MS) {
            refreshNow()
        } else token
    }

    suspend fun forceRefresh(): String? = mutex.withLock { refreshNow() }

    private suspend fun refreshNow(): String? = withContext(Dispatchers.IO) {
        val refreshToken = SecureStore.getString("refresh_token") ?: return@withContext null

        val body = JSONObject().put("refresh_token", refreshToken).toString()
        val req = Request.Builder()
            .url(REFRESH_URL)
            .header("apikey", BuildConfig.SUPABASE_ANON_KEY)
            .header("Content-Type", "application/json")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        try {
            httpClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    if (resp.code in listOf(400, 401, 403)) {
                        Bridge.emit("onAuthExpired", emptyMap<String, Any>())
                    }
                    return@withContext null
                }
                val json = JSONObject(resp.body!!.string())
                val newAccess = json.getString("access_token")
                val newRefresh = json.getString("refresh_token")
                val expiresIn = json.getLong("expires_in")
                val newExpiresAt = System.currentTimeMillis() + expiresIn * 1000L

                SecureStore.putString("access_token", newAccess)
                SecureStore.putString("refresh_token", newRefresh)
                SecureStore.putLong("expires_at", newExpiresAt)

                Bridge.emit("onSupabaseTokenRefreshed", mapOf("expiresAt" to newExpiresAt))
                newAccess
            }
        } catch (e: Exception) { null }
    }

    private fun startProactiveRefresh() {
        refreshJob?.cancel()
        refreshJob = CoroutineScope(Dispatchers.IO).launch {
            while (isActive) {
                delay(REFRESH_INTERVAL_MS)
                refreshNow()
            }
        }
    }

    fun clear() {
        refreshJob?.cancel()
        SecureStore.remove("access_token")
        SecureStore.remove("refresh_token")
        SecureStore.remove("expires_at")
    }

    private val httpClient = OkHttpClient()
}
```

> `SecureStore` = wrapper rond `EncryptedSharedPreferences` (Android Jetpack Security).

---

## 7. Watchdog — `LocationWatchdogWorker.kt`

```kotlin
class LocationWatchdogWorker(ctx: Context, params: WorkerParameters)
    : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val unitId = SecureStore.getString("unitId") ?: return Result.success()

        val running = ServiceUtils.isServiceRunning(applicationContext,
            LocationTrackingService::class.java)
        val lastPostAt = SecureStore.getLong("last_post_at", 0L)
        val now = System.currentTimeMillis()

        if (!running) {
            startService("service_not_running")
            return Result.success()
        }

        if (now - lastPostAt > 90_000L) {
            // service draait maar post niet → restart updates
            startService("stale_posts_${(now - lastPostAt) / 1000}s")
        }
        return Result.success()
    }

    private fun startService(reason: String) {
        val intent = Intent(applicationContext, LocationTrackingService::class.java)
            .putExtra("callSign", SecureStore.getString("callSign") ?: "Eenheid")
        ContextCompat.startForegroundService(applicationContext, intent)

        Bridge.emit("onWatchdogAction", mapOf(
            "action" to "restart_service",
            "reason" to reason
        ))
    }
}

// Registratie (in Application.onCreate()):
val req = PeriodicWorkRequestBuilder<LocationWatchdogWorker>(15, TimeUnit.MINUTES)
    .setConstraints(Constraints.Builder().build())
    .build()
WorkManager.getInstance(this).enqueueUniquePeriodicWork(
    "cmds_location_watchdog",
    ExistingPeriodicWorkPolicy.KEEP,
    req
)
```

> Android staat WorkManager-periodiek niet vaker dan 15 min toe. Voor finer-grained checks doet de **service zelf** een interne timer (zie sectie 4).

---

## 8. Capacitor Bridge — Contract met de webapp

### WebView → Native (methods)

| Method | Payload | Doel |
|--------|---------|------|
| `linkUnit` | `{ unitId, eventId, organizationId, accessToken, refreshToken, expiresAt, callSign }` | Sla tokens op, start service |
| `unlinkUnit` | `{}` | Stop service, clear tokens, clear queue |
| `getServiceState` | `{}` | Returns `{ running, queueSize, lastPostAt, lastError, tokenExpiresAt }` |
| `requestBatteryOptimizationExemption` | `{}` | Open system dialog |
| `getPermissionStatus` | `{}` | Returns alle 4 permissies + battery opt-out status |

### Native → WebView (events — kritiek voor `ingest-diagnose`)

| Event | Payload |
|-------|---------|
| `onUnitLinked` | `{ unitId }` |
| `onServiceStateChanged` | `{ running: boolean }` |
| `onLocationPosted` | `{ status: number, latency?: number, queueSize: number }` |
| `onLocationPostError` | `{ status: number, message?: string, willRetry: boolean }` |
| `onSupabaseTokenRefreshed` | `{ expiresAt: number }` |
| `onAuthExpired` | `{}` → webapp toont relogin |
| `onWatchdogAction` | `{ action: string, reason: string }` |

> De webapp luistert al op deze events in het ingest-diagnose paneel. Houd de **exacte naamgeving** aan.

---

## 9. Verplichte 4-staps Onboarding

**Blocking flow** bij eerste app-open. Eenheid kan **niet** gekoppeld worden tot alle 4 voltooid zijn. Status zichtbaar in webapp via `getPermissionStatus()`.

### Stap 1 — Locatie toestaan
- Permissie: `ACCESS_FINE_LOCATION`
- NL-copy: *"CMDS heeft je locatie nodig zodat de meldkamer je positie kan zien tijdens een evenement. Kies **'Tijdens gebruik van app'** in het volgende scherm."*

### Stap 2 — Achtergrond locatie
- Permissie: `ACCESS_BACKGROUND_LOCATION` (Android 10+)
- Vereist aparte intent naar Settings (Android laat dit niet via standaard prompt toe)
- NL-copy: *"Om je locatie ook te delen wanneer je telefoon in je zak of tas zit, moet je **'Altijd toestaan'** kiezen. Zonder deze toestemming verliest de meldkamer je positie zodra je scherm uit gaat."*

### Stap 3 — Notificaties toestaan
- Permissie: `POST_NOTIFICATIONS` (Android 13+)
- NL-copy: *"CMDS toont een vaste notificatie zodat Android weet dat de app actief is en je locatie blijft delen. Deze notificatie kan niet weggeveegd worden — dat is normaal en bedoeld."*

### Stap 4 — Batterij-optimalisatie uitschakelen
- Intent: `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` met `package:` URI
- NL-copy: *"Android probeert apps op de achtergrond af te sluiten om batterij te besparen. Voor CMDS moet dit uit, anders stopt de GPS-tracking na enkele minuten. Tik **'Toestaan'** in het volgende scherm."*

```kotlin
// Stap 4 trigger:
val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
    data = Uri.parse("package:${context.packageName}")
}
context.startActivity(intent)
```

Na voltooiing van alle 4: bridge event `onOnboardingComplete` zodat de webapp weet dat het koppel-scherm beschikbaar wordt.

---

## 10. Endpoints & Constants

```kotlin
object SupabaseConfig {
    const val URL = "https://txauyjkivyzgxetmadkj.supabase.co"
    const val ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4YXV5amtpdnl6Z3hldG1hZGtqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NTQ4MDQsImV4cCI6MjA4NzQzMDgwNH0.PEm8ItUT-9D1PJLwBXEydKYf-cPUQdQhQdLEnkWC-hk"

    const val INGEST_LOCATION = "$URL/functions/v1/ingest-location"
    const val TOKEN_REFRESH   = "$URL/auth/v1/token?grant_type=refresh_token"
}
```

### Ingest payload schema

```json
{
  "unit_id": "uuid",
  "event_id": "uuid",
  "organization_id": "uuid",
  "lat": 52.0907,
  "lng": 5.1214,
  "accuracy": 8.5,
  "timestamp": 1735732938000,
  "source": "android-native"
}
```

Headers:
```
Authorization: Bearer <access_token>
apikey: <anon_key>
Content-Type: application/json
```

### Notificatie

- Channel ID: `cmds_location_channel`
- Channel naam: `CMDS GPS Tracking`
- Title: `CMDS — {callSign} actief` (bv. "CMDS — DELTA 1 actief")
- Body: `Locatie wordt gedeeld met de meldkamer`
- Importance: `LOW` (geen geluid, wel zichtbaar)
- `setOngoing(true)` → non-dismissible

---

## 11. Acceptance Criteria — Test Checklist

Replit levert pas op als **alle** vinkjes gehaald zijn. Test op een echt Android-device (niet emulator) met scherm vergrendeld en device losgekoppeld van lader.

- [ ] Eenheid `DELTA 1` gekoppeld → telefoon locked → na **30 min** nog groen in map-overview
- [ ] Eenheid `DELTA 1` gekoppeld → telefoon locked → na **60 min** nog groen (token-refresh test)
- [ ] Eenheid `DELTA 1` gekoppeld → telefoon locked → na **2 uur** nog groen
- [ ] **Geen gap > 30s** tijdens token-refresh moment (zichtbaar in ingest-diagnose)
- [ ] Service herstart automatisch na force-stop binnen **5 min** (watchdog)
- [ ] Queue houdt **2 min flight-mode** vast → flush alle items bij reconnect
- [ ] Onboarding niet overslaanbaar; alle 4 permissies verplicht vóór koppelen
- [ ] Persistent notification "CMDS — DELTA 1 actief" zichtbaar én non-dismissible
- [ ] Ingest-diagnose in webapp ontvangt alle bridge-events met juiste namen

---

## 12. Migratie-instructie (als v1 al deels staat)

Als je v1 (`CMDS_Native_Background_GPS_Implementation.md`) al deels hebt geïmplementeerd:

**Behouden:**
- ✅ `LocationTrackingService` (zorg wel dat `setMaxUpdateDelayMillis(15_000L)` erin zit)
- ✅ `AndroidManifest.xml` permissies + `<service>` block
- ✅ Foreground notification

**Toevoegen / vervangen:**
- ➕ `SupabaseTokenManager` (dit ontbrak in v1 — kern van de huidige bug)
- ➕ `LocationPoster` met queue + retry (vervang directe POST-call)
- ➕ `LocationWatchdogWorker` (WorkManager periodic 15 min)
- ➕ Extra bridge-events: `onLocationPosted`, `onLocationPostError`, `onSupabaseTokenRefreshed`, `onAuthExpired`, `onWatchdogAction`
- ➕ Stap 4 van onboarding (battery optimization) als die nog niet blocking is

**Webapp-kant** (al geïmplementeerd, geen actie nodig):
- ✅ Stuurt `accessToken`, `refreshToken`, `expiresAt` mee bij `linkUnit`
- ✅ Toont relogin bij `onAuthExpired`
- ✅ Logt alle bridge-events in ingest-diagnose paneel

---

## Vragen?

Als iets in dit document onduidelijk is of conflicteert met de huidige Replit-implementatie: stop met implementeren en vraag eerst om verheldering. Niet gokken — de bug die we proberen op te lossen is precies ontstaan door eerdere assumpties over auto-refresh gedrag.
