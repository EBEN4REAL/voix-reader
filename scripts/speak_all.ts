// Listening check: one paragraph per voice in the registry, saved as MP3 for native speakers to rate.
//
//   node scripts/speak_all.ts [--server http://127.0.0.1:8880] [--out listening-check]
//   (API_KEY=... when the server sets one; Node 23.6+ runs TypeScript directly)
//
// Writes <out>/<language>/<voice>.mp3 and <out>/ratings.csv. A native speaker rates each file
// Good, Acceptable or Poor; any language with a Poor rating stays "enabled": false in voices.json.
//
// Uses /v1/audio/speech, not /v1/speak: that way languages that are still disabled in the registry
// can be checked before anyone turns them on. Kokoro voices get Kokoro's language code; Piper voices
// read their own language. Voices the server can't run (no misaki, Piper files not downloaded) are
// left out of /v1/voices, so their languages are listed as skipped at the end.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

interface Voice { id: string; label: string; gender: string; engine?: string; kokoroLang?: string }
interface Language { code: string; name: string; kokoroLang?: string; enabled: boolean; voices: Voice[] }

// Everyday news-style text with numbers, names and long words: what the voices will read.
const PARAGRAPHS: Record<string, string[]> = {
  en: ["Good morning. Today we look at how cities are preparing for hotter summers, from planting trees along busy streets to opening cool public spaces for older residents. In Lagos, 1,200 new trees were planted in March."],
  es: ["Buenos días. Hoy vemos cómo las ciudades se preparan para veranos más calurosos, desde plantar árboles en las calles más transitadas hasta abrir espacios públicos frescos para las personas mayores. En Sevilla se plantaron 1.200 árboles en marzo."],
  fr: ["Bonjour. Aujourd'hui, nous voyons comment les villes se préparent à des étés plus chauds, en plantant des arbres le long des rues animées et en ouvrant des espaces publics frais pour les personnes âgées. À Lyon, 1 200 arbres ont été plantés en mars."],
  it: ["Buongiorno. Oggi vediamo come le città si preparano a estati più calde, piantando alberi lungo le strade più trafficate e aprendo spazi pubblici freschi per le persone anziane. A Milano sono stati piantati 1.200 alberi a marzo."],
  pt: ["Bom dia. Hoje vemos como as cidades se preparam para verões mais quentes, plantando árvores ao longo das ruas movimentadas e abrindo espaços públicos frescos para os idosos. Em Lisboa foram plantadas 1.200 árvores em março."],
  hi: ["नमस्ते। आज हम देखेंगे कि शहर अधिक गर्म गर्मियों के लिए कैसे तैयारी कर रहे हैं, व्यस्त सड़कों के किनारे पेड़ लगाने से लेकर बुज़ुर्गों के लिए ठंडी सार्वजनिक जगहें खोलने तक। मार्च में दिल्ली में 1,200 नए पेड़ लगाए गए।"],
  ja: ["おはようございます。今日は、にぎやかな通りに木を植えたり、高齢者のために涼しい公共の場所を開いたりして、都市がより暑い夏にどう備えているかを見ていきます。三月に大阪で千二百本の木が植えられました。"],
  // Simplified, then Traditional script: the PRD asks for both to be checked.
  zh: [
    "早上好。今天我们来看看城市如何为更炎热的夏天做准备，从在繁忙的街道两旁种树，到为老年人开放凉爽的公共场所。三月，上海种下了一千二百棵树。",
    "早安。今天我們來看看城市如何為更炎熱的夏天做準備，從在繁忙的街道兩旁種樹，到為老年人開放涼爽的公共場所。",
  ],
  // Piper languages: a short greeting and the day's topics.
  bg: ["Добро утро. Днес ще говорим за времето и новините на деня."],
  bn: ["সুপ্রভাত। আজ আমরা আবহাওয়া এবং দিনের খবর নিয়ে কথা বলব।"],
  ca: ["Bon dia. Avui parlarem del temps i de les notícies del dia."],
  cs: ["Dobré ráno. Dnes budeme mluvit o počasí a o zprávách dne."],
  cy: ["Bore da. Heddiw byddwn ni'n siarad am y tywydd a newyddion y dydd."],
  da: ["Godmorgen. I dag taler vi om vejret og dagens nyheder."],
  de: ["Guten Morgen. Heute sprechen wir über das Wetter und die Nachrichten des Tages."],
  el: ["Καλημέρα. Σήμερα θα μιλήσουμε για τον καιρό και τα νέα της ημέρας."],
  et: ["Tere hommikust. Täna räägime ilmast ja päeva uudistest."],
  eu: ["Egun on. Gaur eguraldiari eta eguneko berriei buruz hitz egingo dugu."],
  fa: ["صبح بخیر. امروز درباره هوا و اخبار روز صحبت می‌کنیم."],
  fi: ["Hyvää huomenta. Tänään puhumme säästä ja päivän uutisista."],
  hu: ["Jó reggelt. Ma az időjárásról és a nap híreiről beszélünk."],
  kk: ["Қайырлы таң. Бүгін біз ауа райы мен күн жаңалықтары туралы сөйлесеміз."],
  lt: ["Labas rytas. Šiandien kalbėsime apie orą ir dienos naujienas."],
  lv: ["Labrīt. Šodien mēs runāsim par laikapstākļiem un dienas ziņām."],
  mr: ["सुप्रभात. आज आपण हवामान आणि दिवसाच्या बातम्यांबद्दल बोलू."],
  ne: ["शुभ प्रभात। आज हामी मौसम र दिनको समाचारबारे कुरा गर्नेछौं।"],
  nl: ["Goedemorgen. Vandaag praten we over het weer en het nieuws van de dag."],
  no: ["God morgen. I dag snakker vi om været og dagens nyheter."],
  pl: ["Dzień dobry. Dzisiaj porozmawiamy o pogodzie i wiadomościach dnia."],
  ro: ["Bună dimineața. Astăzi vorbim despre vreme și despre știrile zilei."],
  ru: ["Доброе утро. Сегодня мы поговорим о погоде и новостях дня."],
  sk: ["Dobré ráno. Dnes sa budeme rozprávať o počasí a správach dňa."],
  sl: ["Dobro jutro. Danes bomo govorili o vremenu in novicah dneva."],
  sq: ["Mirëmëngjes. Sot do të flasim për motin dhe lajmet e ditës."],
  sv: ["God morgon. I dag pratar vi om vädret och dagens nyheter."],
  te: ["శుభోదయం. ఈ రోజు మనం వాతావరణం మరియు రోజు వార్తల గురించి మాట్లాడుకుందాం."],
  uk: ["Доброго ранку. Сьогодні ми поговоримо про погоду та новини дня."],
  ur: ["صبح بخیر۔ آج ہم موسم اور دن کی خبروں کے بارے میں بات کریں گے۔"],
  vi: ["Chào buổi sáng. Hôm nay chúng ta sẽ nói về thời tiết và tin tức trong ngày."],
};

const { values } = parseArgs({
  options: {
    server: { type: "string", default: process.env.VOIX_SERVER ?? "http://127.0.0.1:8880" },
    out: { type: "string", default: "listening-check" },
  },
});
const server = values.server!.replace(/\/+$/, "");
const out = values.out!;
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.API_KEY) headers.Authorization = `Bearer ${process.env.API_KEY}`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(server + path, { headers });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const registry = await getJson<{ languages: Language[] }>("/v1/voices"); // only voices the server can run
const rows = [["language", "voice", "engine", "gender", "registry_enabled", "file", "rating (Good/Acceptable/Poor)", "notes"]];
const skipped: string[] = [];
let failures = 0;

for (const lang of registry.languages) {
  const paragraphs = PARAGRAPHS[lang.code];
  if (!paragraphs) {
    skipped.push(`${lang.name}: no sample paragraph in this script`);
    continue;
  }
  if (!lang.voices.length) {
    skipped.push(`${lang.name}: the server can't run any of its voices`);
    continue;
  }
  await mkdir(join(out, lang.code), { recursive: true });
  for (const voice of lang.voices) {
    const piper = voice.engine === "piper";
    const kokoroLang = piper ? undefined : voice.kokoroLang ?? lang.kokoroLang;
    for (const [i, input] of paragraphs.entries()) {
      const file = join(lang.code, `${voice.id}${i ? `-${i + 1}` : ""}.mp3`);
      const started = Date.now();
      const res = await fetch(`${server}/v1/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify({ input, voice: voice.id, lang: kokoroLang, response_format: "mp3" }),
      });
      if (!res.ok) {
        failures++;
        console.error(`✗ ${file}: HTTP ${res.status} ${await res.text()}`);
        continue;
      }
      await writeFile(join(out, file), Buffer.from(await res.arrayBuffer()));
      rows.push([lang.code, voice.id, voice.engine ?? "kokoro", voice.gender, String(lang.enabled), file, "", ""]);
      console.log(`✓ ${file} (${Date.now() - started} ms)`);
    }
  }
}

const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
await writeFile(join(out, "ratings.csv"), csv + "\n");
console.log(`\n${rows.length - 1} files in ${out}/, ratings sheet: ${join(out, "ratings.csv")}`);
if (skipped.length) console.log(`Skipped:\n  ${skipped.join("\n  ")}`);
if (failures) process.exitCode = 1;
