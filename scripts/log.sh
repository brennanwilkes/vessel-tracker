#!/usr/bin/env bash
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/worker" || exit 1
npx wrangler tail --format pretty 2>&1 | grep -v '^GET https://'
