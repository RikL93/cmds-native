#!/usr/bin/env node
/**
 * Test script — simuleert wat de native CMDS-app doet:
 *   1. whoami-unit aanroepen om te checken of het device gekoppeld is
 *   2. ingest-location posten met nep-coördinaten
 *
 * Gebruik:
 *   node scripts/test-gps-post.mjs <SUPABASE_ACCESS_TOKEN>
 *
 * Token ophalen:
 *   Browser → cmdsevent.nl → DevTools → Application →
 *   Local Storage → sb-txauyjkivyzgxetmadkj-auth-token → access_token
 */

const SUPABASE_PROJECT_REF = "txauyjkivyzgxetmadkj";
const WHOAMI_URL = `https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/whoami-unit`;
const INGEST_URL = `https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/ingest-location`;

const FAKE_LOCATION = {
  latitude: 52.3731,
  longitude: 4.8922,
  accuracy: 12.5,
  altitude: 2.1,
  altitude_accuracy: 3.0,
  speed: 0,
  heading: 0,
  recorded_at: new Date().toISOString(),
  source: "test-script",
};

const token = process.argv[2];

if (!token || token.length < 20) {
  console.error(`
Gebruik: node scripts/test-gps-post.mjs <SUPABASE_ACCESS_TOKEN>

Hoe kom je aan het token?
  1. Open cmdsevent.nl in de browser en log in
  2. Open DevTools (F12) → Application → Local Storage
  3. Zoek de sleutel:  sb-txauyjkivyzgxetmadkj-auth-token
  4. Kopieer de waarde van "access_token" uit de JSON
`);
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

function fmt(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function fetchWithTimeout(url, options, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text().catch(() => "");
    return { status: res.status, body: text, ms: Date.now() - t0 };
  } catch (e) {
    return {
      status: null,
      body: e.name === "AbortError" ? "TIMEOUT (>15s)" : e.message,
      ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

console.log("=".repeat(60));
console.log("CMDS GPS edge-functie test");
console.log("=".repeat(60));
console.log(`Token: ${token.slice(0, 20)}...${token.slice(-8)} (${token.length} tekens)\n`);

// ── Stap 1: whoami-unit ──────────────────────────────────────────
console.log("► Stap 1: whoami-unit");
const whoami = await fetchWithTimeout(WHOAMI_URL, { method: "GET", headers });
console.log(`  status : ${whoami.status ?? "—"} (${fmt(whoami.ms)})`);

let linked = false;
let callSign = null;
try {
  const parsed = JSON.parse(whoami.body);
  linked = !!parsed.linked;
  callSign = parsed.unit?.call_sign ?? null;
  console.log(`  linked : ${linked}`);
  if (callSign) console.log(`  eenheid: ${callSign}`);
  if (!linked) console.log(`  body   : ${whoami.body.slice(0, 300)}`);
} catch {
  console.log(`  body   : ${whoami.body.slice(0, 300)}`);
}

if (whoami.status === 401) {
  console.error("\n✗ Token is verlopen of ongeldig. Haal een nieuw token op.");
  process.exit(1);
}

if (!linked) {
  console.warn(
    "\n⚠ Geen gekoppelde eenheid gevonden. Kies een call sign in CMDS (UnitView).",
  );
  console.warn("  De ingest-location POST wordt toch uitgevoerd als smoke-test.\n");
}

// ── Stap 2: ingest-location ──────────────────────────────────────
console.log("\n► Stap 2: ingest-location POST");
console.log(`  payload: lat=${FAKE_LOCATION.latitude} lng=${FAKE_LOCATION.longitude} source=${FAKE_LOCATION.source}`);

const ingest = await fetchWithTimeout(INGEST_URL, {
  method: "POST",
  headers,
  body: JSON.stringify(FAKE_LOCATION),
});

console.log(`  status : ${ingest.status ?? "—"} (${fmt(ingest.ms)})`);
console.log(`  body   : ${ingest.body.slice(0, 400)}`);

// ── Resultaat ────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
const ok =
  ingest.status !== null && ingest.status >= 200 && ingest.status < 300;
if (ok) {
  console.log(`✓ GESLAAGD — edge functie reageert correct (HTTP ${ingest.status})`);
  if (callSign) {
    console.log(`  Locatie gepost voor eenheid: ${callSign}`);
  }
} else if (ingest.status === 401) {
  console.error("✗ 401 — token verlopen. Haal een nieuw access token op.");
} else if (ingest.status === null) {
  console.error(`✗ NETWERK FOUT — ${ingest.body}`);
} else {
  console.error(`✗ HTTP ${ingest.status} — ${ingest.body.slice(0, 200)}`);
}
console.log("=".repeat(60));
