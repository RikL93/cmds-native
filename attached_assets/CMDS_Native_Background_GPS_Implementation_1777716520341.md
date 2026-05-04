# CMDS Native Shell — Background GPS Hardening
**Doel:** GPS-posts blijven elke 30–60s binnenkomen, óók als het scherm uit is en de telefoon in de broekzak/tas zit.

**Probleem geverifieerd op 2026-05-02:**
- App in voorgrond → fixes elke ~5s ✅
- App in achtergrond, scherm AAN → fixes elke ~30–60s ✅
- App in achtergrond, **scherm UIT** → posts stoppen volledig binnen 60s ❌
  - Oorzaak: Android **Doze-mode** + **App Standby** blokkeren netwerk + GPS-callbacks
  - Bonus-bug: Supabase JWT verloopt en wordt niet ververst zolang scherm uit is → eerste post na ontwaken faalt met `JWT has expired`

---

## Vereiste 1 — Foreground Service met persistente notificatie

Android staat **alleen** ononderbroken background-werk toe als de app een zichtbare notificatie toont. Dit is hoe Strava, Komoot, Google Maps navigatie het doen.

### `AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
<uses-permission android:name="android.permission.INTERNET" />

<application ...>
  <service
    android:name=".CmdsLocationService"
    android:foregroundServiceType="location"
    android:exported="false" />
</application>
```

### Service starten (in TypeScript / React Native of Capacitor plugin)

```typescript
// Bij koppelen aan unit
await NativeModules.CmdsLocationService.start({
  unitId: 'a2caf6fd-21c7-40c0-b2e0-a72005478d16',
  callSign: 'DELTA 1',
  notificationTitle: 'CMDS volgt locatie',
  notificationText: 'DELTA 1 is gekoppeld — locatie wordt doorgestuurd',
});

// Bij ontkoppelen
await NativeModules.CmdsLocationService.stop();
```

De notificatie moet **non-dismissible** zijn (`setOngoing(true)`) zodat Android de service niet kill't.

---

## Vereiste 2 — Battery Optimization opt-out flow

**Dit is wat de gebruiker expliciet wil:** een knop bij eerste app-start, naast de locatie-popup.

### Eerste-keer-flow (volgorde belangrijk!)

```
1. Locatie toestaan (foreground)        → ACCESS_FINE_LOCATION
2. Locatie altijd toestaan (background) → ACCESS_BACKGROUND_LOCATION
3. Notificaties toestaan                → POST_NOTIFICATIONS  (Android 13+)
4. ⭐ Batterijoptimalisatie uitzetten   → REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
```

### Native code voor stap 4 (Kotlin)

```kotlin
class BatteryOptimizationModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        val pm = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
        promise.resolve(pm.isIgnoringBatteryOptimizations(reactContext.packageName))
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        val pm = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(reactContext.packageName)) {
            promise.resolve(true)
            return
        }
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${reactContext.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactContext.startActivity(intent)
        promise.resolve(false) // user moet bevestigen, check daarna opnieuw
    }
}
```

### TypeScript onboarding-component

```typescript
import { NativeModules, Alert, Linking } from 'react-native';

async function runOnboarding() {
  // Stap 1+2: locatie
  const fg = await Permissions.request('android.permission.ACCESS_FINE_LOCATION');
  if (fg !== 'granted') return Alert.alert('Locatie nodig om CMDS te gebruiken');

  const bg = await Permissions.request('android.permission.ACCESS_BACKGROUND_LOCATION');
  if (bg !== 'granted') Alert.alert('Tip', 'Voor tracking met scherm uit moet "Altijd toestaan" aan staan');

  // Stap 3: notificaties (Android 13+)
  if (Platform.Version >= 33) {
    await Permissions.request('android.permission.POST_NOTIFICATIONS');
  }

  // Stap 4: ⭐ Batterijoptimalisatie
  const ignoring = await NativeModules.BatteryOptimizationModule.isIgnoringBatteryOptimizations();
  if (!ignoring) {
    Alert.alert(
      'Batterijbesparing uitzetten',
      'CMDS moet 24/7 GPS kunnen versturen, ook als je telefoon vergrendeld is.\n\n' +
      'Op het volgende scherm kies je "Toestaan" om de batterijbesparing voor CMDS uit te schakelen.',
      [
        { text: 'Later', style: 'cancel' },
        {
          text: 'Nu uitzetten',
          onPress: () => NativeModules.BatteryOptimizationModule.requestIgnoreBatteryOptimizations(),
        },
      ],
    );
  }
}
```

### Re-check bij elke unit-koppeling

Bij elke keer dat een unit wordt gekoppeld, opnieuw `isIgnoringBatteryOptimizations()` aanroepen. Als false → toon banner bovenin de app: *"⚠️ Batterijoptimalisatie staat aan — GPS kan stoppen met scherm uit. Tik om te fixen."*

---

## Vereiste 3 — JWT proactief verversen

De webview Supabase-client refresht het token alleen als hij draait. Met scherm uit gebeurt dat niet → JWT verloopt na 1 uur → eerste post na ontwaken faalt.

**Fix in de native shell:** elke 30 minuten in de Foreground Service:

```kotlin
// In CmdsLocationService, naast de GPS-callback:
private fun scheduleTokenRefresh() {
    handler.postDelayed({
        // Roep Supabase REST refresh-endpoint aan met de huidige refresh_token
        val refreshToken = sharedPrefs.getString("supabase_refresh_token", null) ?: return@postDelayed
        OkHttpClient().newCall(
            Request.Builder()
                .url("$SUPABASE_URL/auth/v1/token?grant_type=refresh_token")
                .addHeader("apikey", SUPABASE_ANON_KEY)
                .post(JSONObject(mapOf("refresh_token" to refreshToken)).toString().toRequestBody())
                .build()
        ).execute().use { response ->
            if (response.isSuccessful) {
                val body = JSONObject(response.body!!.string())
                sharedPrefs.edit()
                    .putString("supabase_access_token", body.getString("access_token"))
                    .putString("supabase_refresh_token", body.getString("refresh_token"))
                    .putLong("supabase_expires_at", System.currentTimeMillis() + body.getLong("expires_in") * 1000)
                    .apply()
            }
        }
        scheduleTokenRefresh() // herhaal
    }, 30 * 60 * 1000) // 30 min
}
```

---

## Vereiste 4 — GPS interval forceren

In `LocationRequest`:

```kotlin
val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 30_000L)
    .setMinUpdateIntervalMillis(15_000L)
    .setMaxUpdateDelayMillis(60_000L) // forceer levering binnen 60s
    .build()
```

---

## Verificatie-checklist na implementatie

Na deploy van een nieuwe native build:

1. ☐ Open app → 4 popups verschijnen in volgorde (locatie / background / notif / battery)
2. ☐ Koppel DELTA 1 → persistente notificatie verschijnt: *"CMDS volgt locatie — DELTA 1"*
3. ☐ Lock telefoon, leg in tas, wacht **5 minuten**
4. ☐ Check `unit_locations.updated_at` — moet **<60s oud** zijn
5. ☐ Wacht **1u 5min** met scherm uit → eerste post daarna moet nog steeds HTTP 200 zijn (geen JWT-fout)
6. ☐ Check ingest-log: `src=expo-bg` posts blijven binnenkomen ook na 1+ uur scherm uit

---

## Optionele extra: per-fabrikant battery savers

Sommige fabrikanten (Xiaomi, Huawei, OnePlus, Samsung) hebben **bovenop** de standaard Doze nog hun eigen aggressieve killers. Voor productie-ready apps is de bibliotheek **`dontkillmyapp`** zinvol om de gebruiker direct naar de juiste instellingen-pagina te sturen.

Zie: https://dontkillmyapp.com/

