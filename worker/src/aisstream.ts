import type { Vessel, StaticUpdate } from './types';
import { parsePositionReport, parseShipStaticData, toCompleteVessels, toStaticOnlyUpdates, type AisMessage } from './ais';

export type BoundingBox = [[number, number], [number, number]];

export interface DrainOptions {
  apiKey: string;
  boundingBox: BoundingBox;
  /** Restrict to specific MMSIs. Omit to receive all vessels in the bounding box. */
  mmsis?: number[];
  /** Wall-clock time to collect messages before closing (ms). */
  drainMs: number;
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

  console.log(`[aisstream] connecting — box ${JSON.stringify(opts.boundingBox)}, drain ${opts.drainMs}ms, mmsis: ${opts.mmsis?.length ?? 'all'}`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    const closeAndResolve = (): void => { ws.close(); resolve(); };
    const timer = setTimeout(closeAndResolve, opts.drainMs);

    ws.addEventListener('open', () => {
      console.log('[aisstream] connected, subscribing');
      const frame: Record<string, unknown> = {
        APIKey: opts.apiKey,
        BoundingBoxes: [opts.boundingBox],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      };
      if (opts.mmsis && opts.mmsis.length > 0) {
        frame['FiltersShipMMSI'] = opts.mmsis.map(String);
      }
      ws.send(JSON.stringify(frame));
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        // aisstream sends binary frames — decode ArrayBuffer to string before parsing
        const text = event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : event.data as string;
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
    `[aisstream] drain complete — pos:${nPosition} static:${nStatic} msgs` +
    ` | ${partials.size} unique MMSIs, ${vessels.length} with position, ${staticOnly.length} static-only`
  );
  return { vessels, staticOnly };
}
