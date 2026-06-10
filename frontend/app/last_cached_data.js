import { readFileSync } from 'fs';
const raw = readFileSync('/tmp/vessel-369970257.json', 'utf-8');
const parsed = JSON.parse(raw);

export const LAST_CACHED_DATA = parsed;
