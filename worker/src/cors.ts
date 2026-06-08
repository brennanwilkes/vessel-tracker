import type { Env } from './types';

export function corsHeaders(req: Request, env: Env): HeadersInit {
  const origin = req.headers.get('Origin');
  if (env.ALLOWED_ORIGIN !== '*' && origin !== env.ALLOWED_ORIGIN) return {};
  const allow = env.ALLOWED_ORIGIN === '*' ? '*' : origin!;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Cache-Control',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function handleOptions(req: Request, env: Env): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req, env) });
}
