"""Download the Piper voices listed in voices.json into models/piper/.

  venv/bin/python scripts/download_piper_voices.py                 # every Piper voice in the registry
  venv/bin/python scripts/download_piper_voices.py --lang de nl    # only these languages
  venv/bin/python scripts/download_piper_voices.py --voice de_DE-thorsten-high   # any voice in Piper's catalog

Files come from the rhasspy/piper-voices repository at a pinned revision and are checked
against the MD5 sums in its catalog; files already present and matching are skipped. Each
voice's MODEL_CARD (dataset and licence) is saved next to it: CC-BY voices must be credited.
"""
import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

REVISION = "42301ec547bc2939386cf0ae9f9050ca05b1d3af"  # rhasspy/piper-voices, 2026-11-19
BASE = f"https://huggingface.co/rhasspy/piper-voices/resolve/{REVISION}"
ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "voices.json"


def fetch(url: str, dest: Path) -> None:
    part = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=60) as res, open(part, "wb") as out:
        while chunk := res.read(1 << 20):
            out.write(chunk)
    part.replace(dest)


def md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def registry_voices(langs: set[str] | None) -> list[str]:
    reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
    return [v["id"] for lang in reg["languages"] if not langs or lang["code"] in langs
            for v in lang["voices"] if v.get("engine") == "piper"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--lang", nargs="*", help="registry language codes (default: all)")
    parser.add_argument("--voice", nargs="*", help="Piper voice keys, e.g. de_DE-thorsten-medium")
    parser.add_argument("--dir", type=Path, default=ROOT / "models" / "piper")
    args = parser.parse_args()

    args.dir.mkdir(parents=True, exist_ok=True)
    catalog_path = args.dir / "catalog.json"
    if not catalog_path.exists():
        fetch(f"{BASE}/voices.json", catalog_path)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))

    keys = args.voice or registry_voices(set(args.lang) if args.lang else None)
    missing = [k for k in keys if k not in catalog]
    if missing:
        print(f"Not in Piper's catalog: {', '.join(missing)}", file=sys.stderr)
        return 1

    for key in keys:
        for remote, info in catalog[key]["files"].items():
            name = Path(remote).name
            if name == "MODEL_CARD":
                name = f"{key}.MODEL_CARD.md"
            elif not name.endswith((".onnx", ".onnx.json")):
                continue
            dest = args.dir / name
            if dest.exists() and md5(dest) == info["md5_digest"]:
                continue
            print(f"↓ {name} ({info['size_bytes'] / 1e6:.0f} MB)", flush=True)
            fetch(f"{BASE}/{remote}", dest)
            if md5(dest) != info["md5_digest"]:
                dest.unlink()
                print(f"✗ {name}: checksum mismatch, deleted", file=sys.stderr)
                return 1
    print(f"{len(keys)} voices ready in {args.dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
