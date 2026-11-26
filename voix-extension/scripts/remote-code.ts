// Chrome Web Store, Manifest V3: an extension must contain all of its code; no code may be
// loaded from the web. This finds anything in a built extension that could do that, so the
// build fails here instead of the store removing Voix ("remotely hosted code", Blue Argon).
//
//   node scripts/remote-code.ts .output-store/chrome-mv3     (also runs after every build)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Hosts that serve JavaScript or WebAssembly for loading at run time.
const CODE_HOSTS =
  /\b(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack\.dev|ga\.jspm\.io|jspm\.dev|rawgit\.com|raw\.githack\.com|cdn\.statically\.io|ajax\.googleapis\.com|code\.jquery\.com|tessdata\.projectnaptha\.com)\b/;
// Loading a script straight from the web, whatever the host.
const REMOTE_LOAD = /(?:importScripts|import)\s*\(\s*["'`]https?:|<script\b[^>]*\bsrc\s*=\s*["']https?:/i;
// Running code built from text (eval, new Function): reviewers can't see that code in the package.
const CODE_FROM_TEXT = /(?<![\w.$])eval\s*\(|\bnew\s+Function\s*\(/;
const TEXT_FILES = /\.(?:m?js|html|json)$/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (TEXT_FILES.test(name)) yield path;
  }
}

/** Every place in a built extension that refers to remotely hosted code, as "file: …context…". */
export function findRemoteCode(dir: string): string[] {
  const found: string[] = [];
  for (const path of files(dir)) {
    const text = readFileSync(path, "utf8");
    for (const pattern of [CODE_HOSTS, REMOTE_LOAD, CODE_FROM_TEXT]) {
      const match = pattern.exec(text);
      if (match) {
        const context = text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40).replace(/\s+/g, " ");
        found.push(`${relative(dir, path)}: …${context}…`);
      }
    }
  }
  return found;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? ".output/chrome-mv3";
  const found = findRemoteCode(dir);
  if (found.length) {
    console.error(`Remotely hosted code in ${dir} (the Chrome Web Store rejects this):\n  ${found.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`${dir}: no remotely hosted code`);
}
