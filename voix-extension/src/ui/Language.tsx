import { forwardRef, useEffect, useRef, type KeyboardEvent } from "react";
import type { ReaderController, ReaderState } from "../controller/types";
import { CheckIcon, CloseIcon, GlobeIcon, InfoIcon } from "./Icons";

interface Props {
  state: ReaderState;
  controller: ReaderController;
}

/** The reading language beside the voice picker; a question mark when Voix isn't sure. */
export const LanguageChip = forwardRef<HTMLButtonElement, Props>(function LanguageChip({ state, controller }, ref) {
  const { language, languagePickerOpen } = state;
  if (!language) return null;
  const unsure = language.needsConfirm ? ", not confirmed" : "";
  const mixed = language.mixed ? ", mixed language" : "";
  const translated = language.translatedFrom ? `, translated from ${language.translatedFrom.name}` : "";
  return (
    <button
      ref={ref}
      type="button"
      className="voix-lang-chip"
      aria-label={`Reading language: ${language.name}${translated}${unsure}${mixed}. Change`}
      aria-expanded={languagePickerOpen}
      onClick={() => (languagePickerOpen ? controller.closeLanguagePicker() : controller.openLanguagePicker())}
    >
      <GlobeIcon />
      <span>{language.name}{language.needsConfirm ? "?" : ""}</span>
      {language.translatedFrom && <span className="voix-lang-mixed">from {language.translatedFrom.name}</span>}
      {language.mixed && !language.translatedFrom && <span className="voix-lang-mixed">Mixed language</span>}
    </button>
  );
});

/** Languages Voix can read, each written in its own language, the current one ticked. */
export function LanguagePicker({ state, controller, onDone }: Props & { onDone(): void }) {
  const { languages, language } = state;
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    (list?.querySelector<HTMLButtonElement>("[aria-current='true']") ?? list?.querySelector("button"))?.focus();
  }, []);

  const close = () => {
    onDone();
    controller.closeLanguagePicker();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation(); // close the list, don't minimise the widget
    close();
  };

  return (
    <div className="voix-picker" role="group" aria-labelledby="voix-picker-title" onKeyDown={onKeyDown}>
      <div className="voix-picker-head">
        <strong id="voix-picker-title">{language?.needsConfirm ? "Which language is this?" : "Reading language"}</strong>
        <button type="button" className="voix-icon-btn voix-icon-btn-sm" aria-label="Close language list" onClick={close}>
          <CloseIcon />
        </button>
      </div>
      {language?.needsConfirm && (
        <p className="voix-picker-hint">Voix isn't sure which language this is. Choose one to start reading.</p>
      )}
      <ul className="voix-picker-list" ref={listRef}>
        {languages.map((l) => {
          const current = l.code === language?.code;
          return (
            <li key={l.code}>
              <button
                type="button"
                className="voix-picker-option"
                aria-current={current ? "true" : undefined}
                onClick={() => {
                  onDone();
                  controller.setLanguage(l.code);
                }}
              >
                <span lang={l.code} dir="auto">{l.nativeName}</span>
                {l.beta && <span className="voix-beta">Beta</span>}
                <span className="voix-spacer" />
                {current && <CheckIcon />}
              </button>
            </li>
          );
        })}
      </ul>
      {language?.savedForSite && (
        <p className="voix-picker-hint voix-picker-saved">
          Remembered for this site.
          <button type="button" className="voix-btn voix-btn-link" onClick={() => {
            onDone();
            controller.resetSiteLanguage();
          }}>Reset</button>
        </p>
      )}
    </div>
  );
}

/** The picked language isn't the text's: Voix doesn't translate, so it asks before reading it that way. */
export function LanguageConflict({ state, controller, onDone }: Props & { onDone(): void }) {
  const conflict = state.languageConflict;
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => keepRef.current?.focus(), []);
  if (!conflict) return null;
  const done = (fn: () => void) => () => {
    onDone();
    fn();
  };
  return (
    <div className="voix-picker" role="alertdialog" aria-labelledby="voix-conflict-title" aria-describedby="voix-conflict-body"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        done(() => controller.cancelLanguageChoice())();
      }}>
      <strong id="voix-conflict-title">This text is in {conflict.textName}</strong>
      <p id="voix-conflict-body" className="voix-picker-hint">
        {conflict.reason === "no-translator"
          ? `Chrome's built-in translator isn't available here, so Voix can't translate it into ${conflict.name}. `
          : `Chrome can't translate ${conflict.textName} into ${conflict.name} automatically. `}
        To listen in {conflict.name}, right-click the page, choose <strong>Translate to {conflict.name}</strong>, then
        press Listen. Without translation, a {conflict.name} voice would read the {conflict.textName} words with an accent.
      </p>
      <div className="voix-notice-actions voix-notice-stack">
        <button ref={keepRef} type="button" className="voix-btn voix-btn-primary" onClick={done(() => controller.cancelLanguageChoice())}>
          Keep {conflict.textName}
        </button>
        <button type="button" className="voix-btn voix-btn-outline" onClick={done(() => controller.confirmLanguageChoice())}>
          Use {conflict.name} anyway
        </button>
      </div>
    </div>
  );
}

/**
 * Voix has no natural voice for the detected language: offer the picker and the device voice.
 * Screen readers hear it through the widget's live region.
 */
export function UnsupportedNotice({ state, controller, onChooseLanguage }: Props & { onChooseLanguage(): void }) {
  const { language, usingFallbackVoice, deviceVoiceAvailable, translateOffer } = state;
  if (!language || language.supported) return null;
  if (usingFallbackVoice) {
    return (
      <div className="voix-notice">
        <div className="voix-notice-text">
          <InfoIcon />
          <div>
            <strong>Reading {language.name} with your device's voice</strong>
            <p>Voix has no natural {language.name} voice yet.</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="voix-notice">
      <div className="voix-notice-text">
        <InfoIcon />
        <div>
          <strong>Voix cannot read {language.name} yet</strong>
          <p>{translateOffer
            ? `Voix can translate it and read it to you in ${translateOffer.name}.`
            : deviceVoiceAvailable
              ? `Choose another language, or listen with your device's own ${language.name} voice.`
              : "Choose another language to listen."}</p>
        </div>
      </div>
      <div className="voix-notice-actions voix-notice-stack">
        {translateOffer && (
          <button type="button" className="voix-btn voix-btn-primary" onClick={() => controller.setLanguage(translateOffer.code)}>
            Listen in {translateOffer.name} (translated)
          </button>
        )}
        <button type="button" className="voix-btn voix-btn-outline" onClick={onChooseLanguage}>
          Choose another language
        </button>
        {deviceVoiceAvailable && (
          <button type="button" className="voix-btn voix-btn-outline" onClick={() => controller.useDeviceVoice()}>
            Use my device voice
          </button>
        )}
      </div>
    </div>
  );
}
