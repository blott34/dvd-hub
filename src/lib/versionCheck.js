// Polls /version.json every 5 minutes and reloads the tab if the deployed
// version has changed since this tab loaded. Payload is ~30 bytes, so
// polling 288×/day/client adds ~8 KB/day of egress — negligible vs. the
// repricer listings traffic.

const VERSION_URL = '/version.json';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

let LOADED_VERSION = null;
let timer = null;

async function fetchCurrentVersion() {
  const res = await fetch(VERSION_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`version fetch failed: ${res.status}`);
  const body = await res.json();
  return body.version;
}

async function check() {
  try {
    const current = await fetchCurrentVersion();
    console.log('[version-check] loaded:', LOADED_VERSION, 'current:', current);
    if (LOADED_VERSION && current && current !== LOADED_VERSION) {
      window.location.reload();
    }
  } catch (e) {
    console.warn('[version-check] check failed:', e.message);
  }
}

// Idempotent — safe to call from multiple dashboard mounts; only one timer runs.
export async function startVersionCheck() {
  if (timer) return;
  try {
    LOADED_VERSION = await fetchCurrentVersion();
    console.log('[version-check] initial version:', LOADED_VERSION);
  } catch (e) {
    console.warn('[version-check] initial load failed:', e.message);
  }
  timer = setInterval(check, CHECK_INTERVAL_MS);
}
