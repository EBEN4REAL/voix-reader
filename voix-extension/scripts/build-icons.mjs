// Rasterise the Voix icon SVGs into the PNG sizes the manifest needs.
// Small sizes use the heavier-stroke variants so the V stays readable.
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const SOURCES = { 128: "voix-128.svg", 48: "voix-128.svg", 32: "voix-32.svg", 16: "voix-16.svg" };

for (const [size, file] of Object.entries(SOURCES)) {
  const svg = readFileSync(new URL(`../assets/icon/${file}`, import.meta.url), "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: Number(size) } }).render().asPng();
  writeFileSync(new URL(`../public/icon/${size}.png`, import.meta.url), png);
  console.log(`public/icon/${size}.png`);
}
