import { JSON_CT } from './constants';
import { corsHeaders } from './cors';
import type { Env } from './types';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export function json(req: Request, env: Env, status: number, body: JsonValue): Response {
  const headers = new Headers(corsHeaders(req, env));
  headers.set('Content-Type', JSON_CT);
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorJson(req: Request, env: Env, status: number, message: string): Response {
  return json(req, env, status, { error: message });
}
