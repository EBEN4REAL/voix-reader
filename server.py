"""Tiny local text to speech server: Kokoro (ONNX), plus Piper for the languages Kokoro lacks.

Voix contract (what the browser extension uses):

  GET  /v1/voices                         voice registry (voices.json); languages the engine
                                          can't run here are served with enabled: false
  POST /v1/speak                          {text, voice, lang} -> audio, validated against the registry

Mirrors the two DeepInfra Kokoro APIs so the backend can switch between
local and DeepInfra by changing only the base URL:

  POST /v1/openai/audio/speech            OpenAI-compatible, returns audio bytes
  POST /v1/audio/speech                   same, shorter alias
  GET  /v1/audio/speech?input=...         same, for browsers / Swagger's audio player
  POST /v1/inference/hexgrad/Kokoro-82M   DeepInfra native, returns JSON (base64 audio)

Run:  venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8880

Env: API_KEY    require "Authorization: Bearer <key>" (or ?api_key= on GET) when set
     MAX_CHARS  input limit per request on the OpenAI/DeepInfra endpoints (default 10000)
     VOIX_PRODUCTION=1  public deployment: no /docs, no GET speech endpoint (text in URLs gets logged)
     ONNX_PROVIDER  force a provider, e.g. CUDAExecutionProvider
     SYNTH_TIMEOUT  seconds before /v1/speak gives up with 503 engine_unavailable (default 15)
     CACHE_MB   memory for cached /v1/speak audio (default 64)

Japanese and Mandarin need misaki's phonemizers (pip install "misaki[ja,zh]"); without
them those languages are reported as unavailable instead of producing garbled audio.

Piper (pip install piper-tts) reads German, Dutch, Polish and the other languages whose voices
voices.json marks "engine": "piper". Get the voice files with scripts/download_piper_voices.py;
a language whose voices are missing is served disabled.
"""
import asyncio
import base64
import hashlib
import importlib
import importlib.metadata
import io
import json
import logging
import os
import re
import secrets
import threading
import time
import unicodedata
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Literal

import espeakng_loader
import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from kokoro_onnx import Kokoro
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

try:
    from piper import PiperConfig, PiperVoice, SynthesisConfig
except ImportError:  # Piper is optional: without it, its languages are served disabled
    PiperConfig = PiperVoice = SynthesisConfig = None

ROOT = Path(__file__).parent
MODELS_DIR = ROOT / "models"
REGISTRY_PATH = Path(os.environ.get("VOIX_REGISTRY", ROOT / "voices.json"))
MODEL_ID = "hexgrad/Kokoro-82M"
API_KEY = os.environ.get("API_KEY")
PRODUCTION = os.environ.get("VOIX_PRODUCTION") == "1"
MAX_CHARS = int(os.environ.get("MAX_CHARS", "10000"))  # kokoro-onnx chunks long text internally
SPEAK_MAX_CHARS = 1000  # /v1/speak: the extension sends one sentence (at most 800 characters) per request
SYNTH_TIMEOUT = float(os.environ.get("SYNTH_TIMEOUT", "15"))
CACHE_BYTES = int(os.environ.get("CACHE_MB", "64")) * 1024 * 1024
PIPER_DIR = Path(os.environ.get("PIPER_VOICES", MODELS_DIR / "piper"))
PIPER_MAX_LOADED = int(os.environ.get("PIPER_MAX_LOADED", "8"))  # voice models kept in memory


def _version(package: str) -> str:
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return "none"


# Part of the audio cache key: the same text from another engine version is different audio.
ENGINE_VERSIONS = {"kokoro": f"kokoro-onnx {_version('kokoro-onnx')}/kokoro-v1.0",
                   "piper": f"piper-tts {_version('piper-tts')}"}

# Kokoro voice prefix letter -> Kokoro language, so callers rarely need to pass lang.
VOICE_LANG = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi",
              "i": "it", "p": "pt-br", "j": "ja", "z": "cmn"}
# Languages espeak-ng phonemizes for Kokoro, and the dictionary each one needs.
ESPEAK_DICTS = {"en-us": "en", "en-gb": "en", "es": "es", "fr-fr": "fr", "hi": "hi", "it": "it", "pt-br": "pt"}
# espeak-ng has Japanese and Mandarin dictionaries too, but its output is unusable for Kokoro
# (kanji come out as the English words "Chinese letter", Mandarin loses its tones), so these
# languages go through misaki's phonemizers, the ones Kokoro was trained with.
G2P_MODULES = {"ja": ("misaki.ja", "JAG2P", "こんにちは。"), "cmn": ("misaki.zh", "ZHG2P", "你好。")}

log = logging.getLogger("uvicorn.error")

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
# kokoro-onnx reads each voice from the voices zip on every request. Concurrent requests (the extension
# prefetches) then hit a thread-safety bug in older Python 3.12 zipfile releases: "BadZipFile: Overlapped
# entries". Read them all once instead (about 27 MB).
kokoro.voices = {name: kokoro.voices[name] for name in kokoro.voices.keys()}
VOICES = set(kokoro.get_voices())
PROVIDERS = kokoro.sess.get_providers()


def load_g2p() -> dict:
    """Phonemizers for the languages espeak-ng can't handle, if their packages are installed."""
    out = {}
    for lang, (module, cls, sample) in G2P_MODULES.items():
        try:
            g2p = getattr(importlib.import_module(module), cls)()
            phonemes, _ = g2p(sample)
            if not phonemes.strip():
                raise ValueError("no phonemes for a test sentence")
            out[lang] = g2p
        except Exception as e:  # missing package, missing dictionary data...
            log.info("Language %s unavailable: %s", lang, e)
    return out


G2P = load_g2p()
_g2p_lock = threading.Lock()  # misaki's phonemizers are not documented as thread-safe
_espeak_data = Path(espeakng_loader.get_data_path())
# Kokoro languages this server can actually speak. Also the allow list for every endpoint.
LANGS = {lang for lang, d in ESPEAK_DICTS.items() if (_espeak_data / f"{d}_dict").exists()} | set(G2P)


class PiperVoices:
    """Piper voice models from a directory, loaded on first use; the least recently used are
    unloaded beyond max_loaded (each takes 60 to 120 MB of memory)."""

    def __init__(self, directory: Path, max_loaded: int):
        self.directory, self.max_loaded = directory, max_loaded
        self.loaded: OrderedDict[str, "PiperVoice"] = OrderedDict()
        # Piper phonemizes with its own copy of espeak-ng, which keeps process-global state.
        self.lock = threading.Lock()

    def available(self, model: str) -> bool:
        """The voice's files are here and this Piper can read them (newer voices may need a newer Piper)."""
        onnx, config = self.directory / f"{model}.onnx", self.directory / f"{model}.onnx.json"
        if PiperVoice is None or not (onnx.is_file() and config.is_file()):
            return False
        try:
            PiperConfig.from_dict(json.loads(config.read_text(encoding="utf-8")))
        except Exception as e:  # e.g. a phoneme type added in a later Piper release
            log.warning("Piper voice %s unavailable: %s", model, e)
            return False
        return True

    def _voice(self, model: str) -> "PiperVoice":
        voice = self.loaded.get(model)
        if voice is None:
            voice = PiperVoice.load(self.directory / f"{model}.onnx")
            self.loaded[model] = voice
            while len(self.loaded) > self.max_loaded:
                self.loaded.popitem(last=False)
        self.loaded.move_to_end(model)
        return voice

    def create(self, text: str, model: str, speed: float, speaker: int | None) -> tuple[np.ndarray, int]:
        with self.lock:
            voice = self._voice(model)
            config = SynthesisConfig(speaker_id=speaker, length_scale=1 / speed)
            audio = [c.audio_float_array for c in voice.synthesize(text, syn_config=config)]
        if not audio:
            raise ValueError("Piper produced no audio")  # nothing pronounceable
        return np.concatenate(audio), voice.config.sample_rate


piper_voices = PiperVoices(PIPER_DIR, PIPER_MAX_LOADED)


def engine_of(voice: dict) -> str:
    return voice.get("engine", "kokoro")


def load_registry(path: Path = REGISTRY_PATH) -> dict:
    """voices.json, checked so a voice can only ever be sent with its own language."""
    reg = json.loads(path.read_text(encoding="utf-8"))
    owner: dict[str, str] = {}
    for entry in reg["languages"]:
        for v in entry["voices"]:
            engine = engine_of(v)
            if engine == "kokoro":
                kokoro_lang = v.get("kokoroLang", entry.get("kokoroLang"))
                if VOICE_LANG.get(v["id"][:1]) != kokoro_lang:
                    raise ValueError(f"{path.name}: voice {v['id']} can't speak {kokoro_lang}")
            elif engine == "piper":
                # Piper model names start with their language: de_DE-thorsten-medium.
                model_lang = v.get("model", v["id"]).split("-")[0].split("_")[0]
                if model_lang != entry["code"]:
                    raise ValueError(f"{path.name}: voice {v['id']} is a {model_lang} voice, not {entry['code']}")
            else:
                raise ValueError(f"{path.name}: voice {v['id']} has an unknown engine {engine!r}")
            if v["id"] in owner:
                raise ValueError(f"{path.name}: voice {v['id']} is listed under {owner[v['id']]} and {entry['code']}")
            owner[v["id"]] = entry["code"]
    return reg


def runnable(voice: dict, entry: dict) -> bool:
    """This server has everything the voice needs: its engine, model files and language support."""
    if engine_of(voice) == "piper":
        return piper_voices.available(voice.get("model", voice["id"]))
    return voice["id"] in VOICES and voice.get("kokoroLang", entry.get("kokoroLang")) in LANGS


def serve_registry(reg: dict) -> dict:
    """The registry as clients see it: only voices this server can run; a language without any is disabled."""
    languages = []
    for entry in reg["languages"]:
        voices = [v for v in entry["voices"] if runnable(v, entry)]
        languages.append({**entry, "voices": voices, "enabled": bool(entry.get("enabled")) and bool(voices)})
    return {**reg, "languages": languages}


RAW_REGISTRY = load_registry()
REGISTRY = serve_registry(RAW_REGISTRY)
LANGUAGES = {entry["code"]: entry for entry in REGISTRY["languages"]}
# Every Piper voice the server can run, enabled or not (the listening check needs disabled ones).
PIPER_VOICES = {v["id"]: v for entry in RAW_REGISTRY["languages"] for v in entry["voices"]
                if engine_of(v) == "piper" and runnable(v, entry)}

log.info("Kokoro running on %s; auth %s; Kokoro languages %s; Piper voices %d%s", PROVIDERS,
         "on" if API_KEY else "off", ", ".join(sorted(LANGS)), len(PIPER_VOICES),
         "" if PiperVoice else " (piper-tts not installed)")

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


class SpeakRequest(BaseModel):
    """Voix shape. lang is the registry code ("pt"); the server maps it to the engine's own ("pt-br")."""
    text: str = ""
    voice: str = ""
    lang: str = ""
    engine: str | None = None  # optional; must be the voice's engine when given
    response_format: AudioFormat = "mp3"
    source: str | None = None  # how the extension chose the language; logged only


def create_audio(text: str, voice: str, speed: float, lang: str) -> tuple[np.ndarray, int]:
    """Kokoro: lang is Kokoro's language code."""
    g2p = G2P.get(lang)
    if g2p is None:
        return kokoro.create(text, voice=voice, speed=speed, lang=lang)
    with _g2p_lock:
        phonemes, _ = g2p(text)
    return kokoro.create(phonemes, voice=voice, speed=speed, lang=lang, is_phonemes=True)


def create_voice_audio(text: str, voice: dict, entry: dict, speed: float = 1.0) -> tuple[np.ndarray, int]:
    """Audio for a registry voice, from whichever engine it belongs to."""
    if engine_of(voice) == "piper":
        return piper_voices.create(text, voice.get("model", voice["id"]), speed, voice.get("speaker"))
    return create_audio(text, voice["id"], speed, voice.get("kokoroLang", entry.get("kokoroLang")))


def synthesize(text: str, voice: str, speed: float, lang: str | None) -> tuple[np.ndarray, int]:
    if not text.strip():
        raise HTTPException(400, "input is empty")
    if len(text) > MAX_CHARS:
        raise HTTPException(400, f"input too long (max {MAX_CHARS} characters)")
    if voice in PIPER_VOICES:  # a Piper voice reads its own language; lang doesn't apply
        if not 0.5 <= speed <= 2.0:
            raise HTTPException(400, "speed must be between 0.5 and 2.0")
        try:
            return create_voice_audio(text, PIPER_VOICES[voice], {}, speed)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
    if voice not in VOICES:
        raise HTTPException(400, f"unknown voice: {voice}")
    lang = lang or VOICE_LANG.get(voice[0], "en-us")
    if lang not in LANGS:
        raise HTTPException(400, f"language not available: {lang}")
    if not 0.5 <= speed <= 2.0:
        raise HTTPException(400, "speed must be between 0.5 and 2.0")
    return create_audio(text, voice, speed, lang)


def encode(samples: np.ndarray, rate: int, fmt: str) -> bytes:
    _, sf_format, subtype = FORMATS[fmt]
    if sf_format is None:
        return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format=sf_format, subtype=subtype)
    return buf.getvalue()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "providers": PROVIDERS,
        "gpu": PROVIDERS[0] != "CPUExecutionProvider",
        "languages": sorted(LANGS),  # Kokoro language codes this server can speak
        "piper": sorted(PIPER_VOICES) if PiperVoice else None,  # Piper voices with their files present
        "enabled": [e["code"] for e in REGISTRY["languages"] if e["enabled"]],
    }


@app.get("/voices")
@app.get("/v1/audio/voices")
def voices():
    return {"voices": sorted(VOICES | set(PIPER_VOICES)), "langs": sorted(LANGS), "formats": list(FORMATS)}


@app.get("/v1/voices")
def voice_registry():
    return REGISTRY


# ---------- POST /v1/speak ----------

class SpeakError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@app.exception_handler(SpeakError)
async def speak_error(_request: Request, e: SpeakError):
    return JSONResponse({"code": e.code, "message": e.message}, status_code=e.status)


class AudioCache:
    """Least-recently-used audio, bounded by total bytes. Only touched from the event loop."""

    def __init__(self, max_bytes: int):
        self.max_bytes, self.size = max_bytes, 0
        self.items: OrderedDict[str, bytes] = OrderedDict()

    def get(self, key: str) -> bytes | None:
        audio = self.items.get(key)
        if audio is not None:
            self.items.move_to_end(key)
        return audio

    def put(self, key: str, audio: bytes) -> None:
        if len(audio) > self.max_bytes or key in self.items:
            return
        self.items[key] = audio
        self.size += len(audio)
        while self.size > self.max_bytes:
            self.size -= len(self.items.popitem(last=False)[1])


cache = AudioCache(CACHE_BYTES)
_SAFE = re.compile(r"^[\w-]{1,32}$")


def normalise(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).split())


def cache_key(engine: str, lang: str, voice: str, text: str, fmt: str) -> str:
    # Language is part of the key: the same text read under two languages is two different files.
    return hashlib.sha256("|".join([ENGINE_VERSIONS[engine], lang, voice, text]).encode()).hexdigest() + "." + fmt


async def speak_audio(req: SpeakRequest) -> tuple[bytes, bool]:
    """Audio for a validated request, and whether it came from the cache."""
    text = normalise(req.text)
    if not text or len(text) > SPEAK_MAX_CHARS:
        raise SpeakError(400, "text_empty_or_too_long", f"text must be 1 to {SPEAK_MAX_CHARS} characters")
    entry = LANGUAGES.get(req.lang)
    if not entry or not entry["enabled"]:
        raise SpeakError(400, "language_not_supported", f"language not supported: {req.lang}")
    voice = next((v for v in entry["voices"] if v["id"] == req.voice), None)
    if not voice or (req.engine and req.engine != engine_of(voice)):
        # The guard against reading with the wrong language code: never call an engine.
        raise SpeakError(400, "voice_language_mismatch", f"voice {req.voice} does not belong to {req.lang}")

    engine = engine_of(voice)
    key = cache_key(engine, entry["code"], voice["id"], text, req.response_format)
    audio = cache.get(key)
    if audio is not None:
        return audio, True
    try:
        samples, rate = await asyncio.wait_for(
            run_in_threadpool(create_voice_audio, text, voice, entry), SYNTH_TIMEOUT)
    except asyncio.TimeoutError:
        raise SpeakError(503, "engine_unavailable", "the voice engine timed out") from None
    except ValueError:  # e.g. only symbols: Kokoro found nothing to pronounce
        raise SpeakError(400, "text_empty_or_too_long", "nothing to read in this text") from None
    except Exception:
        log.exception("speak failed lang=%s voice=%s", entry["code"], voice["id"])
        raise SpeakError(503, "engine_unavailable", "the voice engine failed") from None
    audio = encode(samples, rate, req.response_format)
    cache.put(key, audio)
    return audio, False


@app.post("/v1/speak")
async def speak(req: SpeakRequest):
    started = time.perf_counter()
    result = "error"
    try:
        audio, cached = await speak_audio(req)
        result = "cache" if cached else "ok"
        return Response(content=audio, media_type=FORMATS[req.response_format][0],
                        headers={"X-Cache": "hit" if cached else "miss"})
    except SpeakError as e:
        result = e.code
        raise
    finally:
        # Never the text itself. Client-supplied values are logged only when they look like codes.
        safe = lambda v: v if v and _SAFE.match(v) else "-"  # noqa: E731
        log.info("speak lang=%s voice=%s engine=%s source=%s chars=%d result=%s ms=%d", safe(req.lang),
                 safe(req.voice), safe(req.engine), safe(req.source), len(req.text), result,
                 (time.perf_counter() - started) * 1000)


# ---------- OpenAI / DeepInfra compatible ----------

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
