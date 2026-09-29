# 16 — Language (English / বাংলা)

The Language select in Settings used to write a column and change nothing on
screen. There was no translation layer behind it: choosing বাংলা stored `bn` in
`organizations.locale` and the UI carried on in English. This document
describes the layer that now sits behind that select.

## Shape

```
src/shared/i18n/strings.ts   the catalogue — English source + Bangla
src/shared/i18n/index.ts     t(), setLocale(), onLocaleChange(), Intl helpers
```

No dependency, no ICU, no async bundles. Two plain objects and a lookup. The
whole catalogue is a few kilobytes and ships in the main chunk, because a shop
switching language should not wait for a network request to read its own
sidebar.

```ts
t('nav.stock')                                  // "Stock" / "স্টক"
t('settings.partialFailure', { message })       // {placeholders} are filled
formatNumber(1250)                              // "1,250" / "১,২৫০"
```

## Rules

| Rule | Reason |
|---|---|
| English is the source; Bangla is a `Partial` of it | A missing translation falls back to English, never to `settings.taxRate`. A half-translated screen is usable; a screen of keys is not. |
| Lookups happen at **render** time, never at module load | A label captured in a constant is a label frozen in whatever language was active at import. |
| `setLocale()` persists, then announces | A listener redrawing the UI must never read the previous value back out of storage. |
| Core nav labels are translated by id, plugin labels are not | A plugin owns its own strings (spec §51). Core ids map to keys in `navigation.ts`; anything else passes through untouched. |
| `NavItem.label` stays English in the model | It is also the route title and the command-palette text. `navLabel(item)` is what the sidebar draws. |
| `<html lang>` follows the locale | Screen readers, `:lang()` and Android font selection all read it — Bangla under `lang="en"` picks the wrong font on several builds. |

## Switching is a redraw, not a reload

`onLocaleChange` is subscribed once, in `src/main.ts`. It rebuilds the shell and
calls `router.refresh()`, so the sidebar, section headers and the current screen
all come back in the new language with the URL unchanged and no sign-out.

The Settings select applies the change **on `change`**, before any save — waiting
for a database round trip to see your own language is most of what made the
control feel broken. Saving then makes it the shop's default: `load()` calls
`setLocale(settings.locale)`, so a borrowed tablet signing into the shop adopts
the shop's language, while a device that has chosen one keeps it in
`localStorage` under `mekholi.locale`.

## Coverage today

Translated by the hand-written catalogue (`t()`): the whole sidebar (items and
section headers), the shell's search, sign-out and empty-role message, the image
picker, and every string on the Settings screen including the tax dialog. This
is the high-quality tier — a human wrote each pair — and it is where a phrase
worth getting exactly right (a tax explanation, an error) belongs.

Translated by the runtime engine (see below): everything else. POS, Products,
Stock, Reports, the developer surfaces and the plugin screens are built from
hard-coded English literals; the engine renders them into Bengali at run time so
no screen is left in English while the catalogue catches up. Promoting a string
from the engine's tier to the catalogue's is still worthwhile for the phrases
that matter, and is mechanical — wrap the literal in `t()` and add the pair to
`strings.ts`.

## The runtime translator engine

```
src/shared/i18n/dictionary.ts      curated PHRASES + WORDS + a KEEP list
src/shared/i18n/transliterate.ts   Latin → Bengali phonetic fallback
src/shared/i18n/auto-translate.ts  DOM walker + MutationObserver + string engine
```

When the shop's language is `bn`, `installAutoTranslate()` (wired once in
`src/main.ts`) walks the live DOM and rewrites every visible English string —
text nodes and the `placeholder` / `title` / `aria-label` / `alt` attributes —
into Bengali, and a `MutationObserver` keeps doing it as new views render. The
rule the product sets is *no English is ever left on screen*, so the order of
resort is:

1. **Phrase** — the whole trimmed string, matched against `PHRASES`. Highest
   quality; a multi-word label reads naturally instead of being stitched.
2. **Word** — each word against `WORDS`. Loan nouns are written in the Bengali
   alphabet the way a shopkeeper says them (স্টক, রিপোর্ট, প্লাগইন, কাস্টমার);
   ordinary words are translated (বাকির খাতা, ক্রয়).
3. **Transliteration** — anything still unknown is rendered by sound, so a
   plugin's made-up label appears in Bengali letters rather than in English.

Standalone numbers become Bengali digits (১,২৫০). The engine deliberately does
**not** touch: icon ligatures (Material Symbols / Font Awesome), `<script>`,
`<style>`, `<code>`, `<pre>`, `<textarea>`, the text a user has typed into an
input, elements marked `data-no-i18n` or `translate="no"`, and code-shaped
tokens (SKUs, versions, ids) — translating those breaks the app rather than
localising it.

It is idempotent (translating Bengali returns Bengali) and composes with the
catalogue: `t()` produces Bengali the engine then leaves alone. Switching back
to English is a shell rebuild plus the engine standing down.

The test in `src/shared/i18n/i18n.test.ts` fails if a `nav.*`, `shell.*` or
`settings.*` key is added to English without a Bangla partner, so the
catalogue tier cannot quietly rot; `auto-translate.test.ts` covers the engine
tier — phrase, word, transliteration, digit and DOM behaviour.

Numbers inside `formatNumber`/`formatDate` follow the locale (Bengali numerals
under `bn-BD`). Money still formats through `shared/domain/money.ts` with its own
`en-BD` default — moving that onto the active locale is a separate change,
because receipts and CSV exports read the same formatter and a receipt's digits
are a decision a shop should make deliberately.

## Adding a language

1. Add the tag to `LOCALES`, `LOCALE_NAMES` and `LOCALE_TAGS` in `strings.ts`.
2. Add a dictionary object and register it in `DICTIONARIES`.
3. Add the option to the Settings select.

Nothing else knows the list.
