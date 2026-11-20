# Voix voice server: Kokoro, plus Piper for German, Dutch, Polish and the other languages
# Kokoro lacks.
#
# GPU (default, needs an NVIDIA GPU + nvidia-container-toolkit on the host):
#   docker buildx build --platform linux/amd64 -t voix-tts:gpu .
#   docker run --gpus all -p 8880:8880 -e API_KEY=change-me voix-tts:gpu
#
# CPU (for local testing, e.g. on a Mac):
#   docker build --build-arg BASE=ubuntu:24.04 --build-arg ORT=onnxruntime -t voix-tts:cpu .
#   docker run -p 8880:8880 voix-tts:cpu

# CUDA 12 + cuDNN 9 is what current onnxruntime-gpu wheels are built against.
#
# Japanese and Mandarin (optional, off by default): --build-arg CJK=1 installs misaki's
# phonemizers. Without them the server reports ja/cmn as unavailable (see /health) and
# the registry serves those languages disabled, rather than producing garbled audio.
# Spanish, French, Italian, Portuguese and Hindi use the espeak-ng data bundled with kokoro-onnx.
#
# Piper voices (about 3.2 GB for every language in voices.json) are downloaded at build time.
# Choose languages with --build-arg PIPER_LANGS="de nl pl" (registry codes), or "none" to
# leave Piper out; its languages are then served disabled.

ARG BASE=nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04
FROM ${BASE}
ARG ORT=onnxruntime-gpu
ARG CJK=0
ARG PIPER_LANGS=all

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv

# kokoro-onnx and piper-tts depend on the CPU "onnxruntime"; it shares a module name with
# onnxruntime-gpu, so swap it out or the GPU build is silently shadowed. Install everything
# that pulls in onnxruntime before the swap.
RUN pip install --no-cache-dir kokoro-onnx soundfile fastapi uvicorn "piper-tts==1.8.0" \
 && pip uninstall -y onnxruntime \
 && pip install --no-cache-dir --force-reinstall --no-deps "${ORT}"

# pyopenjtalk (Japanese) builds from source, so it needs a compiler and cmake.
RUN if [ "$CJK" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends build-essential cmake python3-dev \
      && pip install --no-cache-dir "misaki[ja,zh]" \
      && python -m unidic download \
      && apt-get purge -y build-essential cmake && apt-get autoremove -y \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
ADD https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx models/
ADD https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin models/
COPY voices.json ./
COPY scripts/download_piper_voices.py scripts/
# Checked against Piper's published checksums; each voice's MODEL_CARD (licence) is kept with it.
RUN if [ "$PIPER_LANGS" = "all" ]; then python scripts/download_piper_voices.py; \
    elif [ "$PIPER_LANGS" != "none" ]; then python scripts/download_piper_voices.py --lang $PIPER_LANGS; fi
# Last, so a code change doesn't download the voices again.
COPY server.py ./

RUN chmod -R a+r /app
USER 1000
EXPOSE 8880
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8880"]
