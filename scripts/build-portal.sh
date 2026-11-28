#!/usr/bin/env bash
# Rebuilds the client portal into portal/dist, which the Flask app serves at /portal/.
# Run this after changing anything in portal/src or portal/.env.production, then commit portal/dist.
set -euo pipefail
cd "$(dirname "$0")/../portal"
npm ci --no-audit --no-fund
npm run build
echo "Built portal/dist — commit it to publish."
