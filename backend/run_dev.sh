#!/usr/bin/env bash
# Starts the API with settings from ../.env and serves the website at http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f ../.env ]; then echo "Copy .env.example to .env and fill it in first."; exit 1; fi
set -a; source ../.env; set +a
exec uvicorn app.asgi:app --reload --host 127.0.0.1 --port 8000
