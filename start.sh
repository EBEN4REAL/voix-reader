#!/usr/bin/env bash
# Start the local Kokoro TTS API on http://127.0.0.1:8880
cd "$(dirname "$0")"
exec venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port "${PORT:-8880}"
