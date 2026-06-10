const subscribers = new Set();
let highlightedMmsi = null;

export function subscribe(fn) {
  subscribers.add(fn);
  fn(highlightedMmsi);
  return () => subscribers.delete(fn);
}

export function setHighlight(mmsi, pan = true) {
  highlightedMmsi = mmsi;
  for (const fn of subscribers) fn(mmsi, pan);
}

export function clearHighlight() {
  setHighlight(null);
}

export function getHighlight() {
  return highlightedMmsi;
}
