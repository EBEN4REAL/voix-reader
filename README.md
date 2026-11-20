# Kokoro Local TTS (PoC)

Kokoro 82M (ONNX) behind a tiny FastAPI server that mirrors DeepInfra's Kokoro
APIs, so the backend can switch between local and DeepInfra by changing only
the base URL (and API key).

## Run

```bash
./start.sh            # serves http://127.0.0.1:8880  (PORT=8881 ./start.sh to change)
```

Wait for `Application startup complete`. Interactive docs: http://127.0.0.1:8880/docs

## Endpoints

| Method | Path                                 | Returns                              |
|--------|--------------------------------------|--------------------------------------|
| GET    | `/health`                            | `{"status":"ok", "languages": [...], "enabled": [...]}` |
| GET    | `/voices`                            | voices, languages, formats           |
| GET    | `/v1/voices`                         | the voice registry (`voices.json`), used by the Voix extension |
| POST   | `/v1/speak`                          | audio bytes for `{text, voice, lang}`, validated against the registry (Voix) |
| POST   | `/v1/openai/audio/speech`            | audio bytes (OpenAI / DeepInfra-OpenAI shape) |
| POST   | `/v1/audio/speech`                   | same as above (alias)                |
| GET    | `/v1/audio/speech?input=...&voice=...` | same, for browsers and Swagger's audio player |
| POST   | `/v1/inference/hexgrad/Kokoro-82M`   | JSON with base64 audio (DeepInfra native shape) |

OpenAI shape:

```json
{ "model": "hexgrad/Kokoro-82M", "input": "Hello there", "voice": "af_bella", "response_format": "mp3", "speed": 1.0 }
```

DeepInfra native shape:

```json
{ "text": "Hello there", "preset_voice": ["af_bella"], "output_format": "mp3" }
```

Response: `{"audio": "data:audio/mpeg;base64,...", "input_character_length": ..., "output_format": "mp3", "words": [], "request_id": ..., "inference_status": {...}}`

- Formats: `mp3` (default for OpenAI shape), `opus`, `flac`, `wav` (default for native), `pcm` (raw 16-bit LE mono, 24 kHz).
- Language is inferred from the voice prefix (`a` → en-us, `b` → en-gb, ...); pass `lang` to override.
- Limits: max 10000 chars (override with `MAX_CHARS=50000 ./start.sh`), speed 0.5–2.0. `model` and the bearer token are accepted but ignored.
- `words` is always empty locally: kokoro-onnx does not expose word timestamps.

### Languages and the Voix contract

`voices.json` is the voice registry: one entry per language, with its voices, Kokoro language code and an
`enabled` flag. The server serves it at `GET /v1/voices` (a language the server can't run is served with
`enabled: false`), and the extension bundles it as an offline fallback. Turning a language on or off is an edit
to this file and a server restart, no extension release.

`POST /v1/speak` is what the extension calls:

```json
{ "text": "Buenos días.", "voice": "ef_dora", "lang": "es", "engine": "kokoro" }
```

`lang` is the registry code (`pt`), never Kokoro's (`pt-br`); the server maps it. Errors are
`{"code": ..., "message": ...}`:

| Status | Code | When |
|---|---|---|
| 400 | `text_empty_or_too_long` | text empty or over 1,000 characters |
| 400 | `language_not_supported` | language missing or disabled in the registry |
| 400 | `voice_language_mismatch` | the voice isn't one of the language's voices (Kokoro is never called) |
| 503 | `engine_unavailable` | Kokoro failed or took longer than `SYNTH_TIMEOUT` (15 s) |

Audio is cached in memory (`CACHE_MB`, default 64) by engine version, language, voice and text; the `X-Cache`
header says `hit` or `miss`. Logs carry language, voice, detection source and result, never the text.

### Piper: German, Dutch, Polish and 27 more

Languages Kokoro doesn't have are read by [Piper](https://github.com/OHF-Voice/piper1-gpl), which runs on CPU in
the same server: Bengali, Bulgarian, Catalan, Czech, Danish, Dutch, Estonian, Basque, Finnish, German, Greek,
Hungarian, Kazakh, Latvian, Marathi, Nepali, Norwegian, Persian, Polish, Romanian, Russian, Slovak,
Slovenian, Albanian, Swedish, Telugu, Ukrainian, Urdu, Vietnamese and Welsh. Their voices in `voices.json` say
`"engine": "piper"`; `/v1/speak` sends each voice to its own engine, so the extension needs nothing special.

Only voices whose model card gives a licence that allows commercial use (CC0, CC BY, CC BY-SA, Apache-2.0, MIT)
are included. Left out: Turkish, Korean, Serbian, Thai, Luxembourgish and Kurdish (non-commercial licences only),
Arabic, Hebrew, Indonesian, Icelandic, Georgian, Swahili, Malayalam and Armenian (licence unclear or GPL:
review the dataset terms before adding them), and Lithuanian (its CC BY voice needs a Piper release newer than
1.8.0; voices the installed Piper can't load are served disabled).

`scripts/download_piper_voices.py` fetches the voices from a pinned revision of rhasspy/piper-voices and checks
their MD5 sums. A language whose voice files are missing is served disabled. Voices load on first use; at most
`PIPER_MAX_LOADED` (default 8) stay in memory, 60 to 120 MB each.

Spanish, French, Italian, Portuguese and Hindi use the espeak-ng data bundled with kokoro-onnx. Japanese and
Mandarin need misaki's phonemizers (`pip install "misaki[ja,zh]"`, or `--build-arg CJK=1` for Docker): espeak-ng's
output for them is unusable (kanji are read as the English words "Chinese letter"), so without misaki the server
reports them unavailable instead. Hindi, Japanese and Mandarin ship disabled until they pass the listening check:

```bash
node scripts/speak_all.ts --out listening-check    # one file per voice + ratings.csv for native speakers
venv/bin/python -m unittest test_server -v         # server tests
```

| Local                                          | DeepInfra                                        |
|------------------------------------------------|--------------------------------------------------|
| `http://127.0.0.1:8880/v1/openai/audio/speech` | `https://api.deepinfra.com/v1/openai/audio/speech` |
| `http://127.0.0.1:8880/v1/inference/hexgrad/Kokoro-82M` | `https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M` |

## Postman

Import `Kokoro-Local-TTS.postman_collection.json`. Speech requests show an
audio player in the response pane; use **Save Response → Save to a file** to
keep the audio. To hit DeepInfra, set the collection variables `baseUrl` to
`https://api.deepinfra.com` and `apiKey` to your DeepInfra key.

## Python client

`client_example.py` is DeepInfra's OpenAI-client example pointed at this server.

## Setup from scratch

```bash
uv venv --python 3.12 venv
uv pip install --python venv/bin/python kokoro-onnx soundfile fastapi uvicorn openai "piper-tts==1.8.0"
mkdir -p models
curl -L -o models/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o models/voices-v1.0.bin  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
venv/bin/python scripts/download_piper_voices.py   # Piper voices, ~3.2 GB (--lang de nl for fewer)
venv/bin/python test.py   # writes test.wav without the server
```

Licence: Kokoro weights are Apache 2.0. espeak-ng (bundled by kokoro-onnx and by Piper) and Piper itself
(`piper-tts`, from OHF-Voice/piper1-gpl) are GPL-3.0: fine for running the server, but distributing the Docker
image means offering their source. Each Piper voice has its own licence, recorded in `voices.json` and in the
`MODEL_CARD` saved next to it; CC BY and CC BY-SA voices must be credited (for example on the store listing).

## Chrome extension (`extension/`)

Side panel that reads the current page (or your selection) aloud through this
server, highlighting each sentence as it is spoken.

1. Start the server: `./start.sh`
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `extension/` folder.
3. Pin **Kokoro Reader** (puzzle icon → pin), open any article, click the icon to open the side panel.
4. Press **Read**. Select text first to read only that part.

Controls: pause/resume, stop, previous/next sentence, click any sentence in the
list to jump there, voice picker, speed slider (playback speed; audio is
generated at 1.0×). The server URL is under **Settings**.

How it works: `content.js` is injected on demand, extracts visible text from
the main `<article>`/`<main>` (skipping nav, sidebars, footers, code), splits it
into sentence chunks of up to 300 characters, and highlights the current one.
`sidepanel.js` requests each chunk from `/v1/audio/speech` as WAV, prefetching
two ahead so playback is gapless.

After editing extension files, click the reload icon on `chrome://extensions`.

## Deploying (Docker / GPU)

See [DEPLOY.md](DEPLOY.md). Set `API_KEY` to require `Authorization: Bearer <key>`
(`/health` and `/docs` stay open). `/health` reports whether the GPU is in use.
