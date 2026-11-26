"""Check that every voice really speaks its language.

Each voice reads a sentence in its own language; then Whisper (speech recognition) listens
WITHOUT being told the language, says which language it hears, and writes down the words.

  A voice PASSES when Whisper hears the voice's own language.
  CER (character error rate) of the transcript against the sentence shows how understandable
  it is: under 0.25 good, under 0.5 rough, above that poor.

Two deliberate mismatches prove the test can fail: German selected but English text (what a user
heard after picking German for an English article), and German text read by an English voice
(a request sent to the wrong voice). Neither may be heard as German.

  # speech recognition runs in its own environment, not the server's:
  uv venv /tmp/voix-asr && uv pip install --python /tmp/voix-asr/bin/python faster-whisper
  /tmp/voix-asr/bin/python scripts/validate_languages.py --server http://127.0.0.1:8880 \\
      --model large-v3                                  # or a local model folder
  (API_KEY=... when the server sets one; --only de nl to test some languages)

Writes <out>/<language>/<voice>.wav and <out>/report.json. Exit code 1 when a voice fails.
"""
import argparse
import json
import os
import sys
import time
import unicodedata
import urllib.request
import wave
from pathlib import Path

# Short, everyday, number-free sentences (Whisper may write numbers as digits, which isn't an error).
SENTENCES = {
    "en": "Good morning. Today we are going to talk about the weather and the news of the day.",
    "es": "Buenos días. Hoy vamos a hablar del tiempo y de las noticias del día.",
    "fr": "Bonjour. Aujourd'hui, nous allons parler de la météo et des nouvelles du jour.",
    "it": "Buongiorno. Oggi parleremo del tempo e delle notizie del giorno.",
    "pt": "Bom dia. Hoje vamos falar sobre o tempo e as notícias do dia.",
    "hi": "नमस्ते। आज हम मौसम और दिन की खबरों के बारे में बात करेंगे।",
    "ja": "おはようございます。今日は天気とその日のニュースについて話します。",
    "zh": "早上好。今天我们来谈谈天气和当天的新闻。",
    "bg": "Добро утро. Днес ще говорим за времето и новините на деня.",
    "bn": "সুপ্রভাত। আজ আমরা আবহাওয়া এবং দিনের খবর নিয়ে কথা বলব।",
    "ca": "Bon dia. Avui parlarem del temps i de les notícies del dia.",
    "cs": "Dobré ráno. Dnes budeme mluvit o počasí a o zprávách dne.",
    "cy": "Bore da. Heddiw byddwn ni'n siarad am y tywydd a newyddion y dydd.",
    "da": "Godmorgen. I dag taler vi om vejret og dagens nyheder.",
    "de": "Guten Morgen. Heute sprechen wir über das Wetter und die Nachrichten des Tages.",
    "el": "Καλημέρα. Σήμερα θα μιλήσουμε για τον καιρό και τα νέα της ημέρας.",
    "et": "Tere hommikust. Täna räägime ilmast ja päeva uudistest.",
    "eu": "Egun on. Gaur eguraldiari eta eguneko berriei buruz hitz egingo dugu.",
    "fa": "صبح بخیر. امروز درباره هوا و اخبار روز صحبت می‌کنیم.",
    "fi": "Hyvää huomenta. Tänään puhumme säästä ja päivän uutisista.",
    "hu": "Jó reggelt. Ma az időjárásról és a nap híreiről beszélünk.",
    "kk": "Қайырлы таң. Бүгін біз ауа райы мен күн жаңалықтары туралы сөйлесеміз.",
    "lv": "Labrīt. Šodien mēs runāsim par laikapstākļiem un dienas ziņām.",
    "mr": "सुप्रभात. आज आपण हवामान आणि दिवसाच्या बातम्यांबद्दल बोलू.",
    "ne": "शुभ प्रभात। आज हामी मौसम र दिनको समाचारबारे कुरा गर्नेछौं।",
    "nl": "Goedemorgen. Vandaag praten we over het weer en het nieuws van de dag.",
    "no": "God morgen. I dag snakker vi om været og dagens nyheter.",
    "pl": "Dzień dobry. Dzisiaj porozmawiamy o pogodzie i wiadomościach dnia.",
    "ro": "Bună dimineața. Astăzi vorbim despre vreme și despre știrile zilei.",
    "ru": "Доброе утро. Сегодня мы поговорим о погоде и новостях дня.",
    "sk": "Dobré ráno. Dnes sa budeme rozprávať o počasí a správach dňa.",
    "sl": "Dobro jutro. Danes bomo govorili o vremenu in novicah dneva.",
    "sq": "Mirëmëngjes. Sot do të flasim për motin dhe lajmet e ditës.",
    "sv": "God morgon. I dag pratar vi om vädret och dagens nyheter.",
    "te": "శుభోదయం. ఈ రోజు మనం వాతావరణం మరియు రోజు వార్తల గురించి మాట్లాడుకుందాం.",
    "uk": "Доброго ранку. Сьогодні ми поговоримо про погоду та новини дня.",
    "ur": "صبح بخیر۔ آج ہم موسم اور دن کی خبروں کے بارے میں بات کریں گے۔",
    "vi": "Chào buổi sáng. Hôm nay chúng ta sẽ nói về thời tiết và tin tức trong ngày.",
}
# Registry code -> Whisper's code, where they differ.
WHISPER_CODE = {}
# (text language, voice, language the user selected): audio that must NOT be heard as the selection.
CONTROLS = [
    ("en", "de_DE-kerstin-medium", "de"),  # German picked for an English article
    ("de", "af_heart", "de"),              # German article sent to an English voice
]


def normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    kept = "".join(c if not unicodedata.category(c).startswith(("P", "S")) else " " for c in text)
    return " ".join(kept.split())


def cer(reference: str, hypothesis: str) -> float:
    ref, hyp = normalise(reference), normalise(hypothesis)
    if not ref:
        return 0.0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1] / len(ref)


def load_audio(path: Path):
    """16 kHz mono float32, as Whisper expects, from the server's 16-bit WAV (24 or 22.05 kHz)."""
    import numpy as np
    with wave.open(str(path)) as w:
        rate, channels = w.getframerate(), w.getnchannels()
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        audio = np.convolve(audio, np.ones(3) / 3, mode="same")  # soften before downsampling
        old = np.arange(len(audio)) / rate
        audio = np.interp(np.arange(int(len(audio) * 16000 / rate)) / 16000, old, audio)
    return audio.astype(np.float32)


def request(server: str, path: str, body: dict | None = None) -> bytes:
    headers = {"Content-Type": "application/json"}
    if os.environ.get("API_KEY"):
        headers["Authorization"] = f"Bearer {os.environ['API_KEY']}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(server + path, data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def synthesize(server: str, text: str, voice: dict, kokoro_lang: str | None, dest: Path) -> None:
    body = {"input": text, "voice": voice["id"], "response_format": "wav"}
    if voice.get("engine", "kokoro") == "kokoro":
        body["lang"] = kokoro_lang
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(request(server, "/v1/audio/speech", body))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--server", default=os.environ.get("VOIX_SERVER", "http://127.0.0.1:8880"))
    parser.add_argument("--model", default="large-v3", help="Whisper model name or local folder")
    parser.add_argument("--out", type=Path, default=Path("language-check"))
    parser.add_argument("--only", nargs="*", help="registry language codes")
    args = parser.parse_args()
    server = args.server.rstrip("/")

    from faster_whisper import WhisperModel  # imported late so --help works without it
    print(f"Loading Whisper {args.model}…", flush=True)
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)

    def listen(path: Path) -> dict:
        segments, info = model.transcribe(load_audio(path), beam_size=5, condition_on_previous_text=False)
        text = "".join(s.text for s in segments).strip()
        top = [(lang, round(p, 3)) for lang, p in (info.all_language_probs or [])[:3]]
        return {"heard": info.language, "probability": round(info.language_probability, 3), "top3": top, "transcript": text}

    registry = json.loads(request(server, "/v1/voices"))  # only voices this server can run
    rows, failures, skipped = [], 0, []
    for lang in registry["languages"]:
        code = lang["code"]
        if args.only and code not in args.only:
            continue
        if not lang["voices"] or code not in SENTENCES:
            skipped.append(f"{lang['name']}: {'no voices on this server' if not lang['voices'] else 'no test sentence'}")
            continue
        for voice in lang["voices"]:
            wav = args.out / code / f"{voice['id']}.wav"
            started = time.perf_counter()
            synthesize(server, SENTENCES[code], voice, voice.get("kokoroLang", lang.get("kokoroLang")), wav)
            heard = listen(wav)
            expected = WHISPER_CODE.get(code, code)
            ok = heard["heard"] == expected
            failures += not ok
            row = {"language": code, "name": lang["name"], "enabled": lang["enabled"], "voice": voice["id"],
                   "engine": voice.get("engine", "kokoro"), "expected": expected, "pass": ok,
                   "cer": round(cer(SENTENCES[code], heard["transcript"]), 3), **heard}
            rows.append(row)
            quality = "good" if row["cer"] < 0.25 else "rough" if row["cer"] < 0.5 else "poor"
            print(f"{'PASS' if ok else 'FAIL'}  {lang['name']:11} {voice['id']:28} heard {heard['heard']} "
                  f"({heard['probability']:.2f})  CER {row['cer']:.2f} {quality:5}  "
                  f"[{time.perf_counter() - started:.1f}s]  {heard['transcript'][:70]}", flush=True)

    print("\nMismatch controls (text in one language, voice of another):")
    controls = []
    all_voices = {v["id"]: (lang, v) for lang in registry["languages"] for v in lang["voices"]}
    for text_lang, voice_id, selected in CONTROLS:
        if voice_id not in all_voices:
            continue
        lang, voice = all_voices[voice_id]
        wav = args.out / "controls" / f"{text_lang}-text_{voice_id}.wav"
        synthesize(server, SENTENCES[text_lang], voice, voice.get("kokoroLang", lang.get("kokoroLang")), wav)
        heard = listen(wav)
        flagged = heard["heard"] != selected  # the selected language wasn't heard: the test fails it
        controls.append({"text": text_lang, "voice": voice_id, "selected": selected, "flagged": flagged, **heard})
        print(f"{'caught' if flagged else 'MISSED'}  {selected} selected, {text_lang} text, voice {voice_id}: "
              f"heard {heard['heard']} ({heard['probability']:.2f})  {heard['transcript'][:70]}", flush=True)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "report.json").write_text(json.dumps({"voices": rows, "controls": controls, "skipped": skipped},
                                                     ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{len(rows) - failures} of {len(rows)} voices heard in their own language; "
          f"{sum(c['flagged'] for c in controls)} of {len(controls)} mismatches caught.")
    if skipped:
        print("Skipped: " + "; ".join(skipped))
    print(f"Audio and report.json in {args.out}/")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
