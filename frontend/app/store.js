import { POLL_INTERVAL_MS } from '../config.js';
import { fetchVessels } from './api.js';

let vessels = [];
let lastError = null;
const subscribers = new Set();

function notify() {
  for (const fn of subscribers) fn(vessels, lastError);
}

export function subscribe(fn) {
  subscribers.add(fn);
  fn(vessels, lastError);
  return () => subscribers.delete(fn);
}

export function getVessels() {
  return vessels;
}

async function poll() {
  try {
    vessels = await fetchVessels();
    lastError = null;
  } catch (err) {
    lastError = err;
  }
  notify();
}

export function startPolling() {
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}
