# Deploying Voix TTS on a GPU

The extension is not hosted anywhere: it runs in each user's Chrome. What gets
deployed is the TTS server (`server.py` + Kokoro model), packaged by the
`Dockerfile`. The extension is then pointed at the server's public HTTPS URL.

```
Chrome extension (Voix)  --HTTPS + API key-->  GPU server (Docker: server.py + Kokoro)
```

## 1. Build and push the GPU image

GPU servers are x86_64 (amd64), so build for that platform even on an Apple
Silicon Mac. Use Docker Hub (free) or any registry.

```bash
cd ~/Documents/projects/kokoro-local
docker login                                   # Docker Hub account
docker buildx build --platform linux/amd64 -t <dockerhub-user>/voix-tts:gpu --push .
```

The image is several GB (CUDA + cuDNN), so the first push takes a while.

Pick a long random API key and keep it; every request must send it:

```bash
openssl rand -hex 24
```

## 2. Run it on a GPU host

### Option A: RunPod (simplest, good for the PoC)

1. Create an account at https://www.runpod.io and add credit.
2. **Pods → Deploy**, pick a small GPU (any card with 8 GB+ VRAM is plenty for an 82M model).
3. Edit the template:
   - Container image: `docker.io/<dockerhub-user>/voix-tts:gpu`
   - Expose HTTP ports: `8880`
   - Environment variables: `API_KEY=<your key>`
   - Container disk: 20 GB
4. Deploy. Your URL is `https://<pod-id>-8880.proxy.runpod.net`.

Pods bill per hour while running; stop the pod when you are not testing.

### Option B: Google Cloud Run with GPU (scales to zero, good for production)

Pay only while requests are being served; the first request after idle has a
cold start (image pull + model load).

```bash
gcloud artifacts repositories create voix --repository-format=docker --location=us-central1
docker buildx build --platform linux/amd64 \
  -t us-central1-docker.pkg.dev/<project>/voix/voix-tts:gpu --push .
gcloud run deploy voix-tts \
  --image us-central1-docker.pkg.dev/<project>/voix/voix-tts:gpu \
  --region us-central1 --port 8880 \
  --gpu 1 --gpu-type nvidia-l4 --cpu 4 --memory 16Gi --no-cpu-throttling \
  --max-instances 1 --allow-unauthenticated \
  --set-env-vars API_KEY=<your key>
```

`--allow-unauthenticated` only skips Google's login; the server still requires
your API key. GPU quota may need to be requested first; check the Cloud Run
GPU docs for current regions and flags.

### Option C: Any GPU VM (AWS, GCP, Azure, Lambda, Hetzner...)

On an Ubuntu VM with an NVIDIA GPU, install the NVIDIA driver, Docker and the
NVIDIA Container Toolkit, then:

```bash
docker run -d --name voix --restart unless-stopped --gpus all \
  -p 127.0.0.1:8880:8880 -e API_KEY=<your key> <dockerhub-user>/voix-tts:gpu
```

Put an HTTPS reverse proxy in front, e.g. Caddy with a domain pointing at the VM:
`caddy reverse-proxy --from tts.example.com --to 127.0.0.1:8880`.

## 3. Check it is on the GPU

```bash
curl https://<your-url>/health
# {"status":"ok","providers":["CUDAExecutionProvider","CPUExecutionProvider"],"gpu":true}
```

If `gpu` is `false`, the container can't see the GPU: on a VM check
`docker run --gpus all ...` and `nvidia-smi`; elsewhere check that a GPU was
actually attached. The server still works on CPU, just slower.

Then test speech:

```bash
curl -X POST https://<your-url>/v1/openai/audio/speech \
  -H "Authorization: Bearer <your key>" -H "Content-Type: application/json" \
  -d '{"input":"Hello from the GPU.","voice":"af_heart"}' --output gpu.mp3
```

In Postman, set the collection variables `baseUrl` to your URL and `apiKey` to your key.

## 4. Point the extension at it

Open the Voix side panel → **Settings** → Server URL `https://<your-url>`,
API key `<your key>` → **Save**. The dot turns green when connected.

## Before real users

- The API key in the extension is visible to anyone who installs it. For a
  public release put your own backend in front (user login, per-user rate
  limits, caching) and keep the Kokoro server private behind it.
- Narrow `host_permissions` in `manifest.json` from `<all_urls>` to what you need.
- Kokoro 82M is small: one GPU serves many concurrent readers. A CPU server
  also works (about 7x real-time on an M-series Mac) if traffic is low.

## Hostinger VPS (CPU, Ubuntu) with Docker Compose and automatic HTTPS

`deploy/` runs Voix behind [Caddy](https://caddyserver.com), which gets and renews the HTTPS
certificate. Voix's port is never exposed; `VOIX_PRODUCTION=1` turns off `/docs` and the GET
speech endpoint (text in URLs ends up in logs).

1. **DNS:** in your domain's DNS settings add an **A record**: name `tts` (or `@` for the bare
   domain) pointing to the VPS IP. Wait until `ping tts.yourdomain.com` shows that IP.
2. **Firewall:** allow ports 22 (SSH), 80 and 443 (hPanel → VPS → Firewall, or `ufw`).
3. **Copy the server files** from your Mac:
   ```bash
   cd ~/Documents/projects/kokoro-local
   ssh root@<VPS_IP> "mkdir -p /opt/voix"
   scp -r Dockerfile .dockerignore server.py deploy root@<VPS_IP>:/opt/voix/
   ```
4. **Configure and start** on the VPS:
   ```bash
   ssh root@<VPS_IP>
   cd /opt/voix/deploy
   cp .env.example .env && chmod 600 .env
   nano .env        # VOIX_DOMAIN=tts.yourdomain.com, API_KEY=$(openssl rand -hex 24)
   docker compose up -d --build
   ```
5. **Check:** `curl https://tts.yourdomain.com/health` → `{"status":"ok",...}`.

Updating the server later: copy the changed files again, then `docker compose up -d --build`.
