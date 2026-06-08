import { WORKER_URL } from '../config.js';

export async function fetchVessels() {
  const res = await fetch(`${WORKER_URL}/vessels`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { vessels } = await res.json();
  return vessels;
}

export async function fetchVessel(mmsi) {
  const res = await fetch(`${WORKER_URL}/vessel/${mmsi}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
