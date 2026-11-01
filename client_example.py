"""DeepInfra's OpenAI-client example, pointed at the local server.

To use DeepInfra instead: base_url="https://api.deepinfra.com/v1/openai",
api_key=os.environ["DEEPINFRA_API_KEY"].
Needs: uv pip install --python venv/bin/python openai
"""
from pathlib import Path

from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8880/v1/openai", api_key="local")

speech_file_path = Path(__file__).parent / "speech.mp3"
with client.audio.speech.with_streaming_response.create(
    model="hexgrad/Kokoro-82M",
    voice="af_bella",
    input="The quick brown fox jumped over the lazy dog.",
    response_format="mp3",
) as response:
    response.stream_to_file(speech_file_path)
print("saved", speech_file_path)
