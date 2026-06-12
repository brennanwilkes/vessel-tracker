import type { Env, Tier } from './types';
import { handleOptions } from './cors';
import { json, errorJson } from './http';
import { getCurrentVessels, getTrack, getInferredTrack, getZoneVisits } from './storage';
import { zoneMeta } from './zones';
import { runDirectScan, runLocalScan, runGlobalScan, runForeignScan } from './ingest';
import { LIVE_TTL_DIRECT_MS, LIVE_TTL_LOCAL_MS, LIVE_TTL_GLOBAL_MS, GITHUB_REPO, PRECOMPUTE_WORKFLOW_FILE, FOREIGN_SCAN_CRON } from './constants';

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

      const [points, inferred] = await Promise.all([
        getTrack(env, mmsi, tiers, TRACK_LIMIT),
        getInferredTrack(env, mmsi, tiers),
      ]);

      // Combined response: real fixes UNION precomputed inferred (A*-routed)
      // waypoints, annotated. Newest-first (the established /track contract); the
      // client re-splines the union with pure math (no coastline) and dashes the
      // `dashed` runs. Inferred points carry the tier of their bracketing reals
      // so the client's per-tier trail filter keeps/hides them together.
      const combined = [
        ...points.map(p => ({ lat: p.lat, lon: p.lon, speed: p.speed, heading: p.heading, t: p.ts, tier: p.tier, fake: false, dashed: 0 })),
        ...inferred.map(p => ({ lat: p.lat, lon: p.lon, speed: null, heading: null, t: p.t, tier: p.tier, fake: true, dashed: p.dashed })),
      ].sort((a, b) => b.t - a.t);

      return json(
        req, env, 200,
        { points: combined },
        { 'Cache-Control': 'public, max-age=60' }
      );
    }

    const zonesMatch = url.pathname.match(/^\/vessel\/(\d+)\/zones$/);
    if (zonesMatch !== null) {
      const mmsi = parseInt(zonesMatch[1], 10);
      const visits = await getZoneVisits(env, mmsi);
      const zones = visits.map(v => {
        const z = zoneMeta(v.zone_id);
        return { zone_id: v.zone_id, name: z?.name ?? v.zone_id, kind: z?.kind ?? 'port', lat: v.lat, lon: v.lon, first_t: v.first_ts, last_t: v.last_ts };
      });
      return json(req, env, 200, { zones }, { 'Cache-Control': 'public, max-age=300' });
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
        runGlobalScan(env)
          .catch(err => console.error('[scheduled] global scan failed:', err))
          .then(() => triggerPrecompute(env))
      );
    } else if (event.cron === FOREIGN_SCAN_CRON) {
      ctx.waitUntil(
        runForeignScan(env).catch(err => console.error('[scheduled] foreign scan failed:', err))
      );
    } else {
      console.warn(`[scheduled] unrecognised cron: ${event.cron}`);
    }
  },
};

// Fire the trail-precompute GitHub Action so it runs right after fresh global
// data lands. Best-effort: no token (local dev) or a failed call is logged and
// swallowed — the workflow's own hourly schedule is the fallback.
async function triggerPrecompute(env: Env): Promise<void> {
  if (!env.GITHUB_DISPATCH_TOKEN) return;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${PRECOMPUTE_WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'vessel-tracker-worker',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    if (!res.ok) console.error(`[scheduled] precompute dispatch failed: HTTP ${res.status}`);
  } catch (err) {
    console.error('[scheduled] precompute dispatch error:', err);
  }
}
