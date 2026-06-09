import { JSON_CT } from './constants';
import { corsHeaders } from './cors';
import type { Env } from './types';

export function json(req: Request, env: Env, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  const headers = new Headers(corsHeaders(req, env));
  headers.set('Content-Type', JSON_CT);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorJson(req: Request, env: Env, status: number, message: string): Response {
  return json(req, env, status, { error: message });
}
