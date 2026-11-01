# Kokoro TTS server.
#
# GPU (default, needs an NVIDIA GPU + nvidia-container-toolkit on the host):
#   docker buildx build --platform linux/amd64 -t voix-tts:gpu .
#   docker run --gpus all -p 8880:8880 -e API_KEY=change-me voix-tts:gpu
#
# CPU (for local testing, e.g. on a Mac):
#   docker build --build-arg BASE=ubuntu:24.04 --build-arg ORT=onnxruntime -t voix-tts:cpu .
#   docker run -p 8880:8880 voix-tts:cpu

# CUDA 12 + cuDNN 9 is what current onnxruntime-gpu wheels are built against.
ARG BASE=nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04
FROM ${BASE}
ARG ORT=onnxruntime-gpu

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv

# kokoro-onnx depends on the CPU "onnxruntime"; it shares a module name with
# onnxruntime-gpu, so swap it out or the GPU build is silently shadowed.
RUN pip install --no-cache-dir kokoro-onnx soundfile fastapi uvicorn \
 && pip uninstall -y onnxruntime \
 && pip install --no-cache-dir --force-reinstall --no-deps "${ORT}"

WORKDIR /app
ADD https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx models/
ADD https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin models/
COPY server.py .

RUN chmod -R a+r /app
USER 1000
EXPOSE 8880
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8880"]
