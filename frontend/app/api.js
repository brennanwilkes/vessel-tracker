import { WORKER_URL } from '../config.js';

// The worker answers quota exhaustion (and every other backend failure) with
// CORS'd JSON rather than crashing, so a non-OK response is readable here.
// Non-quota failures keep the old generic `HTTP n` error.
async function request(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    if (body !== null && body.error === 'd1_quota') {
      const err = new Error('Daily map-data allowance reached — new data resumes at 00:00 UTC');
      err.kind = 'd1_quota';
      err.detail = body.message ?? null;
      throw err;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchVessels() {
  const body = await request(`${WORKER_URL}/current`);
  return body.vessels;
}

export async function fetchVessel(mmsi) {
  return request(`${WORKER_URL}/vessel/${mmsi}`);
}

export async function fetchTrack(mmsi, tiers) {
  const qs = tiers.length > 0 ? `?tier=${tiers.join(',')}` : '';
  const body = await request(`${WORKER_URL}/vessel/${mmsi}/track${qs}`);
  return body.points;
}
