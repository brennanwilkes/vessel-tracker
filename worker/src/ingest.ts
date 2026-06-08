import type { Env } from './types';
import { LOCAL_BOUNDING_BOX, GLOBAL_BOUNDING_BOX, DRAIN_WINDOW_MS, ENRICHMENT_DRAIN_MS } from './constants';
import { drainAisStream } from './aisstream';
import { readSnapshot, mergeSnapshot, upsertVessels, insertSightings, updateEnrichmentPositions, getAllKnownMmsis } from './storage';

export async function runLiveIngest(env: Env): Promise<void> {
  console.log('[ingest] live ingest starting');
  const start = Date.now();

  // Read current KV snapshot in parallel with the AIS drain.
  // The existing snapshot tells us which MMSIs are already known — no D1 write needed for those.
  const [existing, vessels] = await Promise.all([
    readSnapshot(env),
    drainAisStream({ apiKey: env.AISSTREAM_API_KEY, boundingBox: LOCAL_BOUNDING_BOX, drainMs: DRAIN_WINDOW_MS }),
  ]);
  const tDrain = Date.now() - start;

  if (vessels.length === 0) {
    console.warn('[ingest] live drain returned 0 vessels — check API key and bounding box');
  }

  const existingMmsis = new Set(existing.map(v => v.mmsi));
  const newArrivals = vessels.filter(v => !existingMmsis.has(v.mmsi));

  const tWrite = Date.now();

  // KV merge always runs to keep positions fresh.
  // D1 only written when vessels appear that weren't already in the snapshot.
  await mergeSnapshot(env, existing, vessels);

  if (newArrivals.length > 0) {
    console.log(`[ingest] ${newArrivals.length} new arrivals — writing to D1`);
    await upsertVessels(env, newArrivals);
    await insertSightings(env, newArrivals);
  }

  console.log(
    `[ingest] done — ${vessels.length} vessels (${newArrivals.length} new) | drain ${tDrain}ms | write ${Date.now() - tWrite}ms | total ${Date.now() - start}ms`
  );
}

export async function runEnrichment(env: Env): Promise<void> {
  console.log('[ingest] enrichment starting');
  const start = Date.now();

  const mmsis = await getAllKnownMmsis(env);
  console.log(`[ingest] enrichment — querying ${mmsis.length} known MMSIs`);

  if (mmsis.length === 0) {
    console.log('[ingest] enrichment skipped — no known MMSIs yet');
    return;
  }

  const vessels = await drainAisStream({
    apiKey: env.AISSTREAM_API_KEY,
    boundingBox: GLOBAL_BOUNDING_BOX,
    mmsis,
    drainMs: ENRICHMENT_DRAIN_MS,
  });

  await updateEnrichmentPositions(env, vessels);
  console.log(`[ingest] enrichment done — ${vessels.length} vessels heard in ${Date.now() - start}ms`);
}
