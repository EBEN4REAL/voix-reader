"""Tests for the Voix contract in server.py (registry, /v1/speak validation, cache, timeouts).

Run:  venv/bin/python -m unittest test_server -v
Loads the real model once; most tests stub the engine so they also prove Kokoro is never called.
"""
import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

import server
from server import SpeakError, SpeakRequest

FAKE_AUDIO = (np.zeros(2400, dtype=np.float32), 24000)


def speak(**fields):
    return asyncio.run(server.speak_audio(SpeakRequest(**fields)))


class SpeakValidation(unittest.TestCase):
    def setUp(self):
        server.cache = server.AudioCache(server.CACHE_BYTES)
        patcher = mock.patch.object(server, "create_audio", return_value=FAKE_AUDIO)
        self.engine = patcher.start()
        self.addCleanup(patcher.stop)

    def assertRejected(self, code, **fields):
        with self.assertRaises(SpeakError) as ctx:
            speak(**fields)
        self.assertEqual(ctx.exception.code, code)
        self.engine.assert_not_called()
        return ctx.exception

    def test_voice_from_another_language_is_rejected_without_calling_kokoro(self):
        e = self.assertRejected("voice_language_mismatch", text="Bonjour à tous.", voice="ef_dora", lang="fr")
        self.assertEqual(e.status, 400)

    def test_unknown_voice_is_a_mismatch(self):
        self.assertRejected("voice_language_mismatch", text="Hola.", voice="xx_nobody", lang="es")

    def test_language_missing_from_registry(self):
        self.assertRejected("language_not_supported", text="Merhaba.", voice="af_heart", lang="tr")

    def test_disabled_language_is_not_supported(self):
        self.assertFalse(server.LANGUAGES["hi"]["enabled"])  # waits for the listening check
        self.assertRejected("language_not_supported", text="नमस्ते", voice="hf_alpha", lang="hi")

    def test_kokoro_code_is_not_accepted_as_lang(self):
        # Clients send the registry code ("pt"), never Kokoro's ("pt-br").
        self.assertRejected("language_not_supported", text="Bom dia.", voice="pf_dora", lang="pt-br")

    def test_text_length_limits(self):
        self.assertRejected("text_empty_or_too_long", text="   ", voice="ef_dora", lang="es")
        self.assertRejected("text_empty_or_too_long", text="a" * 1001, voice="ef_dora", lang="es")
        speak(text="a" * 1000, voice="ef_dora", lang="es")

    def test_forwards_kokoro_language_code_from_the_registry(self):
        speak(text="Bom dia a todos.", voice="pf_dora", lang="pt")
        speak(text="Good morning.", voice="bf_emma", lang="en")
        speak(text="Good morning.", voice="af_heart", lang="en")
        langs = [c.args[3] for c in self.engine.call_args_list]
        self.assertEqual(langs, ["pt-br", "en-gb", "en-us"])
        self.assertTrue(all(c.args[2] == 1.0 for c in self.engine.call_args_list))  # speed stays in the browser

    def test_second_identical_request_comes_from_cache(self):
        _, cached = speak(text="Buenos días.", voice="ef_dora", lang="es")
        self.assertFalse(cached)
        _, cached = speak(text="Buenos  días.\n", voice="ef_dora", lang="es")  # same text once normalised
        self.assertTrue(cached)
        self.assertEqual(self.engine.call_count, 1)

    def test_cache_key_includes_language(self):
        self.assertNotEqual(server.cache_key("kokoro", "es", "v", "Alex", "mp3"),
                            server.cache_key("kokoro", "pt", "v", "Alex", "mp3"))
        self.assertNotEqual(server.cache_key("kokoro", "de", "v", "Alex", "mp3"),
                            server.cache_key("piper", "de", "v", "Alex", "mp3"))
        speak(text="Alex", voice="em_alex", lang="es")
        speak(text="Alex", voice="pm_alex", lang="pt")
        self.assertEqual(self.engine.call_count, 2)

    def test_timeout_is_engine_unavailable(self):
        self.engine.side_effect = lambda *a: time.sleep(0.5) or FAKE_AUDIO
        with mock.patch.object(server, "SYNTH_TIMEOUT", 0.05), self.assertRaises(SpeakError) as ctx:
            speak(text="Hola.", voice="ef_dora", lang="es")
        self.assertEqual((ctx.exception.status, ctx.exception.code), (503, "engine_unavailable"))

    def test_engine_failure_is_engine_unavailable(self):
        self.engine.side_effect = RuntimeError("onnx exploded")
        with self.assertRaises(SpeakError) as ctx, self.assertLogs("uvicorn.error", "ERROR"):
            speak(text="Hola.", voice="ef_dora", lang="es")
        self.assertEqual((ctx.exception.status, ctx.exception.code), (503, "engine_unavailable"))


class Registry(unittest.TestCase):
    def test_kokoro_voices_are_in_memory_not_read_from_the_zip_per_request(self):
        self.assertIsInstance(server.kokoro.voices, dict)
        self.assertEqual(server.kokoro.get_voice_style("af_heart").shape[-1], 256)

    def test_every_kokoro_voice_exists_in_the_model(self):
        raw = server.load_registry()
        for entry in raw["languages"]:
            for v in entry["voices"]:
                if server.engine_of(v) == "kokoro":
                    self.assertIn(v["id"], server.VOICES, v["id"])

    @unittest.skipUnless(server.PiperVoice, "piper-tts isn't installed")
    def test_every_downloaded_piper_voice_loads(self):
        # Files present but unreadable by this Piper (e.g. a newer phoneme type) must not be served.
        for entry in server.REGISTRY["languages"]:
            for v in entry["voices"]:
                if server.engine_of(v) == "piper":
                    self.assertIn(v["id"], server.PIPER_VOICES)

    def test_served_registry_shape(self):
        reg = server.voice_registry()
        codes = {e["code"]: e for e in reg["languages"]}
        self.assertLessEqual({"en", "es", "fr", "it", "pt", "hi", "ja", "zh", "de", "nl", "pl"}, set(codes))
        for code in ["en", "es", "fr", "it", "pt"]:
            self.assertTrue(codes[code]["enabled"], code)
        es = codes["es"]
        self.assertEqual((es["nativeName"], es["kokoroLang"], es["beta"]), ("Español", "es", True))
        self.assertEqual([v["id"] for v in es["voices"]], ["ef_dora", "em_alex", "em_santa"])

    def test_japanese_and_mandarin_need_their_phonemizers(self):
        for code, kokoro_lang in [("ja", "ja"), ("zh", "cmn")]:
            if kokoro_lang not in server.G2P:
                self.assertNotIn(kokoro_lang, server.LANGS)
                self.assertFalse(server.LANGUAGES[code]["enabled"])

    def test_language_the_server_cant_run_is_served_disabled(self):
        raw = server.load_registry()
        with mock.patch.object(server, "LANGS", server.LANGS - {"fr-fr"}):
            served = {e["code"]: e for e in server.serve_registry(raw)["languages"]}
        self.assertFalse(served["fr"]["enabled"])
        self.assertTrue(served["es"]["enabled"])

    def test_rejects_a_voice_listed_under_the_wrong_language(self):
        raw = json.loads(server.REGISTRY_PATH.read_text(encoding="utf-8"))
        spanish = next(e for e in raw["languages"] if e["code"] == "es")
        spanish["voices"].append({"id": "ff_siwis", "gender": "female", "label": "Siwis"})
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "voices.json"
            path.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "ff_siwis"):
                server.load_registry(path)

    def test_health_lists_loaded_languages(self):
        h = server.health()
        for lang in ["en-us", "en-gb", "es", "fr-fr", "it", "pt-br", "hi"]:
            self.assertIn(lang, h["languages"])
        self.assertIn("es", h["enabled"])

    def test_legacy_endpoint_refuses_languages_it_cant_pronounce(self):
        if "ja" in server.G2P:
            self.skipTest("Japanese phonemizer installed")
        with self.assertRaises(server.HTTPException):
            server.synthesize("こんにちは", "jf_alpha", 1.0, None)


PIPER_DE = "de_DE-thorsten-medium"
needs_piper_de = unittest.skipUnless(PIPER_DE in server.PIPER_VOICES, "Piper or its German voice isn't installed")


class Piper(unittest.TestCase):
    def setUp(self):
        server.cache = server.AudioCache(server.CACHE_BYTES)
        patcher = mock.patch.object(server.piper_voices, "create", return_value=FAKE_AUDIO)
        self.piper = patcher.start()
        self.addCleanup(patcher.stop)
        kokoro = mock.patch.object(server, "create_audio", return_value=FAKE_AUDIO)
        self.kokoro = kokoro.start()
        self.addCleanup(kokoro.stop)

    @needs_piper_de
    def test_german_goes_to_piper(self):
        speak(text="Guten Morgen.", voice=PIPER_DE, lang="de", engine="piper")
        self.piper.assert_called_once_with("Guten Morgen.", PIPER_DE, 1.0, None)
        self.kokoro.assert_not_called()

    @needs_piper_de
    def test_engine_is_optional_but_must_match(self):
        speak(text="Guten Morgen.", voice=PIPER_DE, lang="de")
        with self.assertRaises(SpeakError) as ctx:
            speak(text="Guten Morgen.", voice=PIPER_DE, lang="de", engine="kokoro")
        self.assertEqual(ctx.exception.code, "voice_language_mismatch")

    @needs_piper_de
    def test_voices_never_cross_languages_or_engines(self):
        for voice, lang in [(PIPER_DE, "nl"), ("af_heart", "de"), (PIPER_DE, "en")]:
            with self.assertRaises(SpeakError) as ctx:
                speak(text="Hallo.", voice=voice, lang=lang)
            self.assertEqual(ctx.exception.code, "voice_language_mismatch", (voice, lang))
        self.piper.assert_not_called()
        self.kokoro.assert_not_called()

    def test_language_without_voice_files_is_served_disabled(self):
        with mock.patch.object(server.piper_voices, "available", return_value=False):
            served = {e["code"]: e for e in server.serve_registry(server.RAW_REGISTRY)["languages"]}
        self.assertFalse(served["de"]["enabled"])
        self.assertEqual(served["de"]["voices"], [])
        self.assertTrue(served["es"]["enabled"])  # Kokoro languages unaffected

    def test_every_piper_voice_is_licensed_for_commercial_use(self):
        allowed = {"CC0", "CC BY", "CC BY 4.0", "CC BY-SA 3.0", "CC BY-SA 4.0", "Apache-2.0", "MIT"}
        for entry in server.RAW_REGISTRY["languages"]:
            for v in entry["voices"]:
                if server.engine_of(v) == "piper":
                    self.assertIn(v.get("license"), allowed, v["id"])

    def test_registry_rejects_a_piper_voice_under_the_wrong_language(self):
        raw = json.loads(server.REGISTRY_PATH.read_text(encoding="utf-8"))
        dutch = next(e for e in raw["languages"] if e["code"] == "nl")
        dutch["voices"].append({"id": "de_DE-kerstin-x", "engine": "piper", "gender": "female", "label": "K"})
        bad_engine = next(e for e in raw["languages"] if e["code"] == "pl")
        for change, pattern in [(None, "de_DE-kerstin-x"), ("engine", "unknown engine")]:
            if change == "engine":
                dutch["voices"].pop()
                bad_engine["voices"][0] = {**bad_engine["voices"][0], "engine": "espeak"}
            with tempfile.TemporaryDirectory() as d:
                path = Path(d) / "voices.json"
                path.write_text(json.dumps(raw), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, pattern):
                    server.load_registry(path)


class RealSynthesis(unittest.TestCase):
    def test_spanish_sentence(self):
        server.cache = server.AudioCache(server.CACHE_BYTES)
        audio, cached = speak(text="Buenos días. Hoy vamos a hablar de la radio.", voice="ef_dora", lang="es")
        self.assertFalse(cached)
        self.assertGreater(len(audio), 4000)
        self.assertTrue(audio[:3] == b"ID3" or audio[0] == 0xFF)  # MP3

    @needs_piper_de
    def test_german_sentence_with_piper(self):
        server.cache = server.AudioCache(server.CACHE_BYTES)
        audio, cached = speak(text="Guten Morgen. Heute sprechen wir über das Wetter.", voice=PIPER_DE, lang="de")
        self.assertFalse(cached)
        self.assertGreater(len(audio), 4000)
        _, cached = speak(text="Guten Morgen. Heute sprechen wir über das Wetter.", voice=PIPER_DE, lang="de")
        self.assertTrue(cached)

    @needs_piper_de
    def test_legacy_endpoint_reads_piper_voices(self):
        samples, rate = server.synthesize("Guten Tag.", PIPER_DE, 1.0, None)
        self.assertEqual(rate, 22050)
        self.assertGreater(len(samples), rate // 4)


if __name__ == "__main__":
    unittest.main()
