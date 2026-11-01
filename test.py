"""Quick sanity check without the server: writes test.wav."""
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

models = Path(__file__).parent / "models"
kokoro = Kokoro(str(models / "kokoro-v1.0.onnx"), str(models / "voices-v1.0.bin"))
samples, rate = kokoro.create(
    "Hello! This is Kokoro running on my own computer.",
    voice="af_heart",
    speed=1.0,
    lang="en-us",
)
sf.write("test.wav", samples, rate)
print(f"saved test.wav ({len(samples) / rate:.1f}s @ {rate} Hz)")
