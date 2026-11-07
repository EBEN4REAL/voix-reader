"""Tiny local text to speech server for Kokoro (ONNX version).

Mirrors the two DeepInfra Kokoro APIs so the backend can switch between
local and DeepInfra by changing only the base URL:

  POST /v1/openai/audio/speech            OpenAI-compatible, returns audio bytes
  POST /v1/audio/speech                   same, shorter alias
  GET  /v1/audio/speech?input=...         same, for browsers / Swagger's audio player
  POST /v1/inference/hexgrad/Kokoro-82M   DeepInfra native, returns JSON (base64 audio)

Run:  venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8880

Env: API_KEY    require "Authorization: Bearer <key>" (or ?api_key= on GET) when set
     MAX_CHARS  input limit per request (default 10000)
     VOIX_PRODUCTION=1  public deployment: no /docs, no GET speech endpoint (text in URLs gets logged)
     ONNX_PROVIDER  force a provider, e.g. CUDAExecutionProvider
"""
import base64
import io
import logging
import os
import secrets
import time
import uuid
from pathlib import Path
from typing import Literal

import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from kokoro_onnx import Kokoro
from pydantic import BaseModel

MODELS_DIR = Path(__file__).parent / "models"
MODEL_ID = "hexgrad/Kokoro-82M"
API_KEY = os.environ.get("API_KEY")
PRODUCTION = os.environ.get("VOIX_PRODUCTION") == "1"
MAX_CHARS = int(os.environ.get("MAX_CHARS", "10000"))  # kokoro-onnx chunks long text internally
LANGS = {"en-us", "en-gb", "es", "fr-fr", "hi", "it", "pt-br", "ja", "cmn"}
# Kokoro voice prefix letter -> espeak language, so callers rarely need to pass lang.
VOICE_LANG = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi",
              "i": "it", "p": "pt-br", "j": "ja", "z": "cmn"}

AudioFormat = Literal["mp3", "opus", "flac", "wav", "pcm"]
# format -> (media type, soundfile format, soundfile subtype)
FORMATS = {
    "mp3": ("audio/mpeg", "MP3", "MPEG_LAYER_III"),
    "opus": ("audio/ogg", "OGG", "OPUS"),
    "flac": ("audio/flac", "FLAC", "PCM_16"),
    "wav": ("audio/wav", "WAV", "PCM_16"),
    "pcm": ("audio/pcm", None, None),  # raw 16-bit little-endian mono, 24 kHz
}

kokoro = Kokoro(str(MODELS_DIR / "kokoro-v1.0.onnx"), str(MODELS_DIR / "voices-v1.0.bin"))
VOICES = set(kokoro.get_voices())
PROVIDERS = kokoro.sess.get_providers()
logging.getLogger("uvicorn.error").info("Kokoro running on %s; auth %s",
                                        PROVIDERS, "on" if API_KEY else "off")

bearer = HTTPBearer(auto_error=False)


def require_key(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(bearer)):
    if not API_KEY or request.url.path == "/health":
        return
    given = creds.credentials if creds else request.query_params.get("api_key", "")
    if not secrets.compare_digest(given.encode(), API_KEY.encode()):
        raise HTTPException(401, "invalid or missing API key")


docs = {"docs_url": None, "redoc_url": None, "openapi_url": None} if PRODUCTION else {}
app = FastAPI(title="Kokoro TTS", dependencies=[Depends(require_key)], **docs)


class SpeechRequest(BaseModel):
    """OpenAI / DeepInfra-OpenAI shape."""
    input: str
    model: str = MODEL_ID  # accepted for compatibility, ignored
    voice: str = "af_heart"
    response_format: AudioFormat = "mp3"
    speed: float = 1.0
    lang: str | None = None  # local extra; inferred from voice if omitted


class InferenceRequest(BaseModel):
    """DeepInfra native shape."""
    text: str
    preset_voice: list[str] | str | None = None
    voice: str | None = None
    output_format: AudioFormat = "wav"
    speed: float = 1.0
    lang: str | None = None


def synthesize(text: str, voice: str, speed: float, lang: str | None) -> tuple[np.ndarray, int]:
    if not text.strip():
        raise HTTPException(400, "input is empty")
    if len(text) > MAX_CHARS:
        raise HTTPException(400, f"input too long (max {MAX_CHARS} characters)")
    if voice not in VOICES:
        raise HTTPException(400, f"unknown voice: {voice}")
    lang = lang or VOICE_LANG.get(voice[0], "en-us")
    if lang not in LANGS:
        raise HTTPException(400, f"unknown lang: {lang}")
    if not 0.5 <= speed <= 2.0:
        raise HTTPException(400, "speed must be between 0.5 and 2.0")
    return kokoro.create(text, voice=voice, speed=speed, lang=lang)


def encode(samples: np.ndarray, rate: int, fmt: str) -> bytes:
    _, sf_format, subtype = FORMATS[fmt]
    if sf_format is None:
        return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format=sf_format, subtype=subtype)
    return buf.getvalue()


@app.get("/health")
def health():
    return {"status": "ok", "providers": PROVIDERS, "gpu": PROVIDERS[0] != "CPUExecutionProvider"}


@app.get("/voices")
@app.get("/v1/audio/voices")
def voices():
    return {"voices": sorted(VOICES), "langs": sorted(LANGS), "formats": list(FORMATS)}


@app.post("/v1/audio/speech")
@app.post("/v1/openai/audio/speech")
def speech(req: SpeechRequest):
    samples, rate = synthesize(req.input, req.voice, req.speed, req.lang)
    media_type = FORMATS[req.response_format][0]
    return Response(
        content=encode(samples, rate, req.response_format),
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="speech.{req.response_format}"'},
    )


def speech_get(
    input: str,
    voice: str = "af_heart",
    response_format: AudioFormat = "mp3",
    speed: float = 1.0,
    lang: str | None = None,
):
    """Browser-friendly variant: Swagger's audio player and plain <audio src>
    re-fetch the URL with GET, so POST-only endpoints can't play there."""
    return speech(SpeechRequest(input=input, voice=voice, response_format=response_format,
                                speed=speed, lang=lang))


if not PRODUCTION:
    app.get("/v1/audio/speech")(speech_get)


@app.post(f"/v1/inference/{MODEL_ID}")
def inference(req: InferenceRequest):
    voice = req.voice or (
        req.preset_voice[0] if isinstance(req.preset_voice, list) and req.preset_voice
        else req.preset_voice
    ) or "af_heart"
    started = time.perf_counter()
    samples, rate = synthesize(req.text, voice, req.speed, req.lang)
    audio = encode(samples, rate, req.output_format)
    runtime_ms = int((time.perf_counter() - started) * 1000)
    media_type = FORMATS[req.output_format][0]
    return {
        "audio": f"data:{media_type};base64,{base64.b64encode(audio).decode()}",
        "input_character_length": len(req.text),
        "output_format": req.output_format,
        "words": [],  # kokoro-onnx does not expose word timestamps
        "request_id": str(uuid.uuid4()),
        "inference_status": {
            "status": "succeeded",
            "runtime_ms": runtime_ms,
            "cost": 0.0,
            "tokens_generated": 0,
            "tokens_input": 0,
            "output_length": round(len(samples) / rate, 3),
        },
    }
