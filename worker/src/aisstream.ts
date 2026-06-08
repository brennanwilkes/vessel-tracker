import type { Vessel } from './types';
import { parsePositionReport, parseShipStaticData, toCompleteVessels, type AisMessage } from './ais';

export type BoundingBox = [[number, number], [number, number]];

export interface DrainOptions {
  apiKey: string;
  boundingBox: BoundingBox;
  /** Restrict to specific MMSIs. Omit to receive all vessels in the bounding box. */
  mmsis?: number[];
  /** Wall-clock time to collect messages before closing (ms). */
  drainMs: number;
}

/**
 * Opens an aisstream WebSocket, subscribes, drains messages for `drainMs`,
 * then closes and returns the collected vessels.
 *
 * The returned vessels are deduplicated by MMSI — each entry holds the latest
 * position merged with the latest static data seen during the drain window.
 */
export async function drainAisStream(opts: DrainOptions): Promise<Vessel[]> {
  const partials = new Map<number, Partial<Vessel>>();
  const nowMs = Date.now();
  let messageCount = 0;

  console.log(`[aisstream] connecting — box ${JSON.stringify(opts.boundingBox)}, drain ${opts.drainMs}ms, mmsis: ${opts.mmsis?.length ?? 'all'}`);

  await new Promise<void>((resolve, reject) => {
    // @ts-expect-error — CF Workers WebSocket constructor
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
      messageCount++;
      try {
        // aisstream sends binary frames — decode ArrayBuffer to string before parsing
        const text = event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : event.data as string;
        const msg: AisMessage = JSON.parse(text);
        const update = msg.MessageType === 'PositionReport'
          ? parsePositionReport(msg, nowMs)
          : parseShipStaticData(msg);

        if (update.mmsi === undefined) return;
        partials.set(update.mmsi, { ...partials.get(update.mmsi), ...update });
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
  console.log(`[aisstream] drain complete — ${messageCount} messages, ${partials.size} unique MMSIs, ${vessels.length} vessels with position`);
  return vessels;
}
