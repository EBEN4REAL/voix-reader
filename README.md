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
| GET    | `/health`                            | `{"status":"ok"}`                    |
| GET    | `/voices`                            | voices, languages, formats           |
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
uv pip install --python venv/bin/python kokoro-onnx soundfile fastapi uvicorn openai
mkdir -p models
curl -L -o models/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o models/voices-v1.0.bin  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
venv/bin/python test.py   # writes test.wav without the server
```

Licence: Kokoro weights are Apache 2.0. espeak-ng (bundled by kokoro-onnx) is GPL.

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
