import type { Vessel, StaticUpdate, Env } from './types';
import { parsePositionReport, parseShipStaticData, toCompleteVessels, toStaticOnlyUpdates, type AisMessage } from './ais';
import { acquireAisLock, releaseAisLock } from './storage';
import { AIS_LOCK_TTL_BUFFER_MS } from './constants';

export type BoundingBox = [[number, number], [number, number]];

export interface DrainOptions {
  apiKey: string;
  /** Single bounding box. Ignored if `boundingBoxes` is given. */
  boundingBox?: BoundingBox;
  /** Multiple bounding boxes in ONE subscription (aisstream `BoundingBoxes` is an array).
   *  Used by the rotating foreign scan to drain several distant port boxes per connection. */
  boundingBoxes?: BoundingBox[];
  /** Restrict to specific MMSIs. Omit to receive all vessels in the bounding box(es). */
  mmsis?: number[];
  /** Wall-clock time to collect messages before closing (ms). */
  drainMs: number;
  /** When set, acquire the single-key AIS connection lock before opening the socket and
   *  release it after (so concurrent scans interleave instead of colliding — see
   *  constants.ts "AIS connection lock"). If the lock can't be had within `maxWaitMs`,
   *  this drain is SKIPPED and an empty result returned.
   *  `release` defaults to true; set false for a single-drain scan to skip the release
   *  write and let the lock expire via TTL (halves lock writes — see constants.ts). */
  lock?: { env: Env; holder: string; maxWaitMs: number; release?: boolean };
}

export interface DrainResult {
  vessels: Vessel[];
  staticOnly: StaticUpdate[];
}

/**
 * Opens an aisstream WebSocket, subscribes, drains messages for `drainMs`,
 * then closes and returns vessels (those with position) and static-only updates
 * (ShipStaticData received for MMSIs with no PositionReport in this window).
 */
export async function drainAisStream(opts: DrainOptions): Promise<DrainResult> {
  const partials = new Map<number, Partial<Vessel>>();
  const nowMs = Date.now();
  let nPosition = 0;
  let nStatic = 0;
  let nOther = 0;

  const boxes = opts.boundingBoxes ?? (opts.boundingBox ? [opts.boundingBox] : []);
  if (boxes.length === 0) throw new Error('drainAisStream: no bounding box(es) given');

  // A missing/blank key is INDISTINGUISHABLE from a healthy drain over an empty ocean:
  // aisstream authenticates in the subscribe frame, not the handshake, so the socket
  // still opens and simply never sends anything. Fail loudly instead.
  if (typeof opts.apiKey !== 'string' || opts.apiKey.trim() === '') {
    throw new Error('drainAisStream: AISSTREAM_API_KEY is missing or empty');
  }

  let lockToken: number | null = null;
  if (opts.lock) {
    lockToken = await acquireAisLock(opts.lock.env, opts.drainMs + AIS_LOCK_TTL_BUFFER_MS, opts.lock.maxWaitMs, opts.lock.holder);
    if (lockToken === null) return { vessels: [], staticOnly: [] }; // socket busy → skip this drain
  }

  // Safe fingerprint — enough to spot a truncated/rotated/wrong secret without leaking it.
  const keyFp = `len=${opts.apiKey.length} ${opts.apiKey.slice(0, 2)}…${opts.apiKey.slice(-2)}`;
  console.log(`[aisstream] connecting — ${boxes.length} box(es), drain ${opts.drainMs}ms, mmsis: ${opts.mmsis?.length ?? 'all'}, key ${keyFp}`);

  try {
  const openedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    const closeAndResolve = (): void => { ws.close(); resolve(); };
    const timer = setTimeout(closeAndResolve, opts.drainMs);

    ws.addEventListener('open', () => {
      console.log('[aisstream] connected, subscribing');
      const frame: Record<string, unknown> = {
        APIKey: opts.apiKey,
        BoundingBoxes: boxes,
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      };
      if (opts.mmsis && opts.mmsis.length > 0) {
        frame['FiltersShipMMSI'] = opts.mmsis.map(String);
      }
      // Log the EXACT subscribe payload (key redacted). aisstream rejects a malformed
      // subscription silently — no error frame, no close — so the only way to tell a
      // bad payload from a dead feed is to see what we actually sent.
      console.log('[aisstream] subscribe frame:',
        JSON.stringify({ ...frame, APIKey: `<${keyFp}>` }).slice(0, 500));
      ws.send(JSON.stringify(frame));
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        // aisstream sends binary frames — decode ArrayBuffer to string before parsing
        const text = event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : event.data as string;
        if (nPosition + nStatic + nOther === 0) {
          console.log(`[aisstream] first frame after ${Date.now() - openedAt}ms:`, text.slice(0, 200));
        }
        const msg: AisMessage = JSON.parse(text);
        if (msg.MessageType === 'PositionReport') {
          nPosition++;
          const update = parsePositionReport(msg, nowMs);
          if (update.mmsi === undefined) return;
          partials.set(update.mmsi, { ...partials.get(update.mmsi), ...update });
        } else if (msg.MessageType === 'ShipStaticData') {
          nStatic++;
          const update = parseShipStaticData(msg);
          if (update.mmsi === undefined) return;
          partials.set(update.mmsi, { ...partials.get(update.mmsi), ...update });
        } else {
          // aisstream reports a rejected subscription (bad/revoked key, quota, malformed
          // filter) as an ordinary frame with no MessageType. Without this branch it
          // parses fine and is silently dropped, so the drain looks like "connected, heard
          // nothing" — indistinguishable from an empty ocean. Cost us a 12 h outage.
          nOther++;
          if (nOther <= 3) console.error('[aisstream] non-AIS frame:', text.slice(0, 300));
        }
      } catch (err) {
        const raw = event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data).slice(0, 200)
          : String(event.data).slice(0, 200);
        console.warn('[aisstream] failed to parse message:', err, 'raw:', raw);
      }
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      clearTimeout(timer);
      console.log(`[aisstream] closed — code ${event.code}, reason: ${event.reason || 'none'}`);
      resolve();
    });

    ws.addEventListener('error', (err: Event) => {
      clearTimeout(timer);
      const msg = `aisstream WebSocket error: ${String(err)}`;
      console.error('[aisstream]', msg);
      reject(new Error(msg));
    });
  });

  const vessels = toCompleteVessels(partials);
  const staticOnly = toStaticOnlyUpdates(partials);
  console.log(
    `[aisstream] drain complete — pos:${nPosition} static:${nStatic} other:${nOther} msgs` +
    ` | ${partials.size} unique MMSIs, ${vessels.length} with position, ${staticOnly.length} static-only`
  );
  // A drain that hears NOTHING at all is never normal — even one box over quiet water
  // sees traffic within 45 s. Surface it with the context needed to tell a rejected
  // subscription from a dead feed.
  if (nPosition === 0 && nStatic === 0 && nOther === 0) {
    console.error(
      `[aisstream] ZERO frames in ${opts.drainMs}ms — key ${keyFp}, ${boxes.length} box(es): ` +
      JSON.stringify(boxes.slice(0, 2)) + (boxes.length > 2 ? ' …' : '')
    );
  }
  return { vessels, staticOnly };
  } finally {
    if (lockToken !== null && opts.lock && opts.lock.release !== false) await releaseAisLock(opts.lock.env, lockToken);
  }
}
