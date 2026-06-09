import type { Env, Tier } from './types';
import { handleOptions } from './cors';
import { json, errorJson } from './http';
import { getCurrentVessels, getTrack } from './storage';
import { runDirectScan, runLocalScan, runGlobalScan } from './ingest';
import { LIVE_TTL_DIRECT_MS, LIVE_TTL_LOCAL_MS, LIVE_TTL_GLOBAL_MS } from './constants';

const TRACK_LIMIT = 500;
const VALID_TIERS = new Set<Tier>(['direct', 'local', 'global']);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return handleOptions(req, env);
    if (req.method !== 'GET') return errorJson(req, env, 405, 'Method not allowed');

    if (url.pathname === '/current') {
      const vessels = await getCurrentVessels(env, LIVE_TTL_DIRECT_MS, LIVE_TTL_LOCAL_MS, LIVE_TTL_GLOBAL_MS);
      return json(req, env, 200, { vessels }, { 'Cache-Control': 'no-store' });
    }

    const trackMatch = url.pathname.match(/^\/vessel\/(\d+)\/track$/);
    if (trackMatch !== null) {
      const mmsi = parseInt(trackMatch[1], 10);
      const tierParam = url.searchParams.get('tier');
      const tiers: Tier[] = tierParam
        ? tierParam.split(',').filter((t): t is Tier => VALID_TIERS.has(t as Tier))
        : [];

      const points = await getTrack(env, mmsi, tiers, TRACK_LIMIT);

      return json(
        req, env, 200,
        { points: points.map(p => ({ lat: p.lat, lon: p.lon, speed: p.speed, heading: p.heading, t: p.ts, tier: p.tier })) },
        { 'Cache-Control': 'public, max-age=60' }
      );
    }

    return errorJson(req, env, 404, 'Not found');
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[scheduled] cron fired: ${event.cron}`);

    if (event.cron === '* * * * *') {
      ctx.waitUntil(
        runDirectScan(env).catch(err => console.error('[scheduled] direct scan failed:', err))
      );
    } else if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(
        runLocalScan(env).catch(err => console.error('[scheduled] local scan failed:', err))
      );
    } else if (event.cron === '0 * * * *') {
      ctx.waitUntil(
        runGlobalScan(env).catch(err => console.error('[scheduled] global scan failed:', err))
      );
    } else {
      console.warn(`[scheduled] unrecognised cron: ${event.cron}`);
    }
  },
};
