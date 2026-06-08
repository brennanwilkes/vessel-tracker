import type { Env } from './types';
import { handleOptions } from './cors';
import { json, errorJson } from './http';
import { readFreshVessels, getVesselRow, getVesselSightings } from './storage';
import { runLiveIngest, runEnrichment } from './ingest';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return handleOptions(req, env);
    if (req.method !== 'GET') return errorJson(req, env, 405, 'Method not allowed');

    if (url.pathname === '/vessels') {
      const vessels = await readFreshVessels(env);
      console.log(`[fetch] GET /vessels → ${vessels.length} fresh vessels`);
      return json(req, env, 200, { vessels });
    }

    const vesselMatch = url.pathname.match(/^\/vessel\/(\d+)$/);
    if (vesselMatch !== null) {
      const mmsi = parseInt(vesselMatch[1], 10);
      const [row, sightings] = await Promise.all([
        getVesselRow(env, mmsi),
        getVesselSightings(env, mmsi),
      ]);
      if (row === null) {
        console.warn(`[fetch] GET /vessel/${mmsi} → 404`);
        return errorJson(req, env, 404, 'Vessel not found');
      }
      console.log(`[fetch] GET /vessel/${mmsi} → ${sightings.length} sightings`);
      return json(req, env, 200, { vessel: row, sightings });
    }

    return errorJson(req, env, 404, 'Not found');
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[scheduled] cron fired: ${event.cron}`);

    if (event.cron === '*/1 * * * *') {
      ctx.waitUntil(
        runLiveIngest(env).catch(err => console.error('[scheduled] live ingest failed:', err))
      );
    } else if (event.cron === '0 0 * * 1') {
      ctx.waitUntil(
        runEnrichment(env).catch(err => console.error('[scheduled] enrichment failed:', err))
      );
    } else {
      console.warn(`[scheduled] unrecognised cron: ${event.cron}`);
    }
  },
};
