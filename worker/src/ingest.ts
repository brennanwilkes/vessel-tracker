import type { Env } from './types';
import { LOCAL_BOUNDING_BOX, GLOBAL_BOUNDING_BOX, DRAIN_WINDOW_MS, ENRICHMENT_DRAIN_MS } from './constants';
import { drainAisStream } from './aisstream';
import { writeSnapshot, upsertVessels, insertPings, getAllKnownMmsis } from './storage';

export async function runLiveIngest(env: Env): Promise<void> {
  console.log('[ingest] live ingest starting');
  const start = Date.now();

  const vessels = await drainAisStream({
    apiKey: env.AISSTREAM_API_KEY,
    boundingBox: LOCAL_BOUNDING_BOX,
    drainMs: DRAIN_WINDOW_MS,
  });

  if (vessels.length === 0) {
    console.warn('[ingest] live drain returned 0 vessels — check API key and bounding box');
  }

  await Promise.all([
    writeSnapshot(env, vessels),
    upsertVessels(env, vessels),
    insertPings(env, vessels, 'live'),
  ]);

  console.log(`[ingest] live ingest done — ${vessels.length} vessels written in ${Date.now() - start}ms`);
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

  await insertPings(env, vessels, 'enrichment');
  console.log(`[ingest] enrichment done — ${vessels.length} vessels heard in ${Date.now() - start}ms`);
}
