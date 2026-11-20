# Chrome Web Store submission: copy-paste fields

Images in this folder: `screenshot-1-reading.png`, `screenshot-2-prompt.png`,
`screenshot-3-minimised.png` (1280×800) and `promo-tile-440x280.png`.
Regenerate them with `npm run store:assets` after UI changes.

---

## Store listing tab

**Name:** Voix

**Summary** (max 132 characters):

> Listen to any article, PDF or Google Doc in a natural voice, in 35 languages, with each sentence highlighted as it's read.

**Category:** Accessibility (alternative: Productivity › Tools)

**Language:** English

**Description:**

> Voix reads the web to you in a natural, human-sounding voice. Open an article, press Listen, and keep doing what you were doing: walking, cooking, commuting or resting your eyes.
>
> NEW: 35 LANGUAGES (BETA)
> Voix reads each article in its own language with a matching voice: German in German, Polish in Polish, Urdu in Urdu.
> • Voix detects the language from the article's own text, not just from what the website declares.
> • The language is shown next to the voice. Tap it to choose another; Voix remembers your choice for that website.
> • If Voix isn't sure of the language, it asks before reading. If it can't read a language yet, it says so and offers your device's own voice instead.
> • Prefer to keep every article in English? Turn off "Detect each article's language" in Voix settings (right-click the Voix icon, then Options).
> • Languages: Albanian, Basque, Bengali, Bulgarian, Catalan, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Kazakh, Latvian, Marathi, Nepali, Norwegian, Persian, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Telugu, Ukrainian, Urdu, Vietnamese and Welsh.
>
> WHAT VOIX CAN READ
> • Articles and web pages: Voix finds the article itself and skips menus, banners and adverts.
> • PDFs: opened in Chrome, embedded in a page, or saved on your computer. Scanned PDFs in English are read too, using text recognition.
> • Google Docs, Slides and Sheets.
> • Plain-text files, and documents shown inside online viewers.
> • Anything else on screen: "Read the whole page" recognises text that is drawn as an image.
>
> FOLLOW ALONG
> • The sentence being read is highlighted on the page and in Voix's own list, and the page scrolls with it.
> • Click any sentence to jump straight to it.
>
> MADE FOR LISTENING
> • 23 natural English voices with US and UK accents, plus 54 voices for 34 more languages (beta).
> • Speed from 0.5× to 3×, without changing the pitch.
> • Skip back or forward a sentence, pause and resume, or minimise Voix to a small bar while it keeps reading.
> • Keyboard shortcut: Alt+Shift+V opens or closes Voix (change it at chrome://extensions/shortcuts).
> • If natural voices are unavailable, Voix switches to your device's own voice for that language, so reading keeps going.
>
> PRIVACY
> • Voix only sends text when you ask it to read: the sentences being read, and their language, go to the Voix voice service to be turned into speech, and are not stored.
> • The article's language is detected on your computer.
> • Pages such as email and online banking are never sent.
> • PDF reading and text recognition happen on your computer. Your settings, including the language you choose for a website, stay in your browser.
> • No ads, no tracking, no account needed.
>
> VOICE CREDITS
> Voices are made with Kokoro and Piper. Some Piper voices are trained on these datasets, used under Creative Commons licences:
> • Basque: Maider and Antton (itzune), CC BY 4.0
> • Bengali, Marathi and Nepali: Google crowdsourced speech data (OpenSLR 37, 64 and 43), CC BY-SA 4.0
> • Catalan: UPC Festcat (Ona), CC BY-SA 3.0
> • Czech: Kasandra (ondrazarici), CC BY 4.0
> • Estonian: Speech corpus of Estonian news sentences (University of Tartu), CC BY
> • Kazakh: Kazakh TTS (ISSAI), CC BY 4.0
> • Slovenian: Artur (ppisljar), CC BY 4.0
> • Swedish: Alma (yeagersthlm), CC BY 4.0
> • Telugu: IndicVoices-R (AI4Bharat), CC BY 4.0
> • Vietnamese: VAIS-1000, CC BY 4.0
> • Welsh: Bu TTS (Techiaith, Bangor University), CC BY

---

## Privacy tab

**Single purpose:**

> Voix reads web pages and documents aloud: it extracts the text of the page or document the user chooses and plays it as natural-sounding speech, highlighting each sentence as it is read.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings in their browser: voice, speed, highlight and auto-scroll switches, the reader's position on screen, sites where the user turned off the "Listen to this article?" offer, the reading language chosen for a site, and a copy of the voice list. |
| `offscreen` | Plays the speech audio and runs PDF text extraction and text recognition in an offscreen document, so reading continues smoothly and heavy work stays off the web page. |
| `scripting` | Starts the reader in tabs that were already open before installation, and reads documents shown inside frames (for example online document viewers) when the user asks Voix to read the page. |
| `activeTab` | Acts on the tab the user is viewing when they click the Voix icon or use the keyboard shortcut, including capturing the visible part of the tab to recognise text drawn as images when the user chooses "Read the whole page". |
| Host permission (`<all_urls>`) | The reader must work on whatever page the user chooses to listen to: it detects articles to offer reading, extracts their text, downloads PDFs the user opens so their text can be read, reads documents inside frames, and sends the text being read to the Voix voice service. |

**Are you using remote code?** No. All code, including PDF.js and the Tesseract text-recognition engine, is included in the package.

**Data usage:** tick **Website content** only (the text being read is sent to the Voix voice service to generate audio). Leave all other categories unticked.

Tick all three certifications (not sold to third parties; not used or transferred for purposes unrelated to the item's single purpose; not used to determine creditworthiness or for lending).

**Privacy policy URL:** the public address where you publish `privacy-policy.html` (see below).

---

## Distribution tab

- **Payments:** Free.
- **Visibility:** start with **Private** (only the trusted testers listed in Settings can install) or **Unlisted** (anyone with the link). Switch to **Public** after testing.
- **Regions:** All regions.
