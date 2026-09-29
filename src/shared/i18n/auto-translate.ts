/**
 * The runtime translator engine.
 *
 * The `t()` catalogue (`strings.ts`) covers the nav, the shell and Settings
 * with hand-written Bengali. Every other screen — POS, products, stock,
 * reports, the plugin screens — is built from hard-coded English literals, and
 * wrapping each of the hundreds of them in `t()` by hand would still leave gaps.
 *
 * This layer closes those gaps. When the shop is in Bengali it walks the live
 * DOM and rewrites every visible English string — text nodes, and the
 * `placeholder` / `title` / `aria-label` / `alt` attributes — into Bengali,
 * using the curated dictionary first and a phonetic transliteration as a last
 * resort so *no* English is ever left on screen. A `MutationObserver` keeps
 * doing it as new views render, so a screen the catalogue never heard of still
 * comes up in Bengali.
 *
 * What it deliberately leaves alone: icon ligatures (Material Symbols / Font
 * Awesome), `<script>`/`<style>`/`<code>`, the text a user has typed into an
 * input, and code-shaped tokens (SKUs, emails, URLs, versions). Translating
 * those would break the app, not localise it.
 */

import { locale } from './index'
import { PHRASES, WORDS, KEEP } from './dictionary'
import { transliterateWord, bengaliDigits } from './transliterate'

// ── String translation ──────────────────────────────────────────────────────

const memo = new Map<string, string>()

/** Does this token look like a code rather than a word? (SKU, email, URL, version) */
function neighbourIsCodeLike(ch: string): boolean {
  return ch !== '' && /[0-9_@/]/.test(ch)
}

function translateWordToken(word: string): string {
  const lower = word.toLowerCase()
  if (KEEP.has(lower)) return word
  if (Object.prototype.hasOwnProperty.call(WORDS, lower)) return WORDS[lower] ?? ''
  return transliterateWord(lower)
}

/** Try to match the whole string (minus surrounding space/punctuation) as a phrase. */
function matchPhrase(input: string): string | null {
  const leadLen = input.length - input.trimStart().length
  const lead = input.slice(0, leadLen)
  const trail = input.slice(input.trimEnd().length)
  const core = input.trim()
  if (core === '') return null

  const direct = PHRASES[core.toLowerCase()]
  if (direct !== undefined) return lead + direct + trail

  // Allow trailing sentence punctuation: "No results found." → the phrase +  "."
  const punct = core.match(/^(.*[^\s.:!?…])([\s.:!?…]+)$/)
  if (punct) {
    const hit = PHRASES[(punct[1] ?? '').toLowerCase()]
    if (hit !== undefined) return lead + hit + (punct[2] ?? '') + trail
  }
  return null
}

/**
 * Translate one string. Idempotent: a string with no Latin letters (already
 * Bengali, or pure symbols) comes back unchanged apart from digit conversion,
 * so re-running the engine over its own output is a no-op.
 */
export function translateText(input: string): string {
  if (input === '') return input

  const cached = memo.get(input)
  if (cached !== undefined) return cached

  let out: string

  if (!/[A-Za-z]/.test(input)) {
    // No English words. Still render standalone numbers in Bengali digits.
    out = convertStandaloneDigits(input)
  } else {
    const phrase = matchPhrase(input)
    if (phrase !== null) {
      out = phrase
    } else {
      // Word by word, protecting code-shaped tokens and converting numbers.
      out = input.replace(/[A-Za-z]+/g, (word, offset: number) => {
        const before = input[offset - 1] ?? ''
        const after = input[offset + word.length] ?? ''
        if (neighbourIsCodeLike(before) || neighbourIsCodeLike(after)) return word
        return translateWordToken(word)
      })
      out = convertStandaloneDigits(out)
      // "the পণ্য" → "পণ্য": empty-string function words leave gaps.
      out = out.replace(/ {2,}/g, ' ').replace(/ +([:।,.!?…])/g, '$1')
    }
  }

  memo.set(input, out)
  return out
}

/** Latin → Bengali digits for number tokens only (never inside a code). */
function convertStandaloneDigits(input: string): string {
  return input.replace(/\d+/g, (num, offset: number) => {
    const before = input[offset - 1] ?? ''
    const after = input[offset + num.length] ?? ''
    if (/[A-Za-z_@/.]/.test(before) || /[A-Za-z_@/.]/.test(after)) return num
    return bengaliDigits(num)
  })
}

// ── DOM walking ──────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'TEXTAREA',
  'SVG',
])

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const

function isIconElement(el: Element): boolean {
  const cls = el.getAttribute('class') ?? ''
  return (
    cls.includes('material-symbols') ||
    cls.includes('material-icons') ||
    /(^|\s)fa[srlbd]?(\s|-)/.test(cls)
  )
}

function isSkipped(el: Element): boolean {
  return (
    SKIP_TAGS.has(el.tagName) ||
    el.getAttribute('translate') === 'no' ||
    el.hasAttribute('data-no-i18n') ||
    isIconElement(el)
  )
}

function inSkippedSubtree(node: Node): boolean {
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  while (el) {
    if (isSkipped(el)) return true
    el = el.parentElement
  }
  return false
}

function translateTextNode(node: Text): void {
  const value = node.nodeValue ?? ''
  if (!/[A-Za-z0-9]/.test(value)) return
  if (inSkippedSubtree(node)) return
  const next = translateText(value)
  if (next !== value) node.nodeValue = next
}

function translateAttributes(el: Element): void {
  if (inSkippedSubtree(el)) return
  for (const attr of ATTRS) {
    const value = el.getAttribute(attr)
    if (value === null || !/[A-Za-z]/.test(value)) continue
    const next = translateText(value)
    if (next !== value) el.setAttribute(attr, next)
  }
}

/** Translate a whole subtree: its text nodes and localisable attributes. */
function translateSubtree(root: Element | Document): void {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  let current = walker.nextNode()
  while (current) {
    texts.push(current as Text)
    current = walker.nextNode()
  }
  for (const text of texts) translateTextNode(text)

  const scope = root instanceof Document ? root.body : root
  if (!scope) return
  if (scope instanceof Element) translateAttributes(scope)
  for (const el of scope.querySelectorAll('*')) translateAttributes(el)
}

// ── Observation & lifecycle ──────────────────────────────────────────────────

let observer: MutationObserver | null = null
let scheduled = false
const pending = new Set<Node>()

function connect(): void {
  const body = globalThis.document?.body
  if (!observer || !body) return
  observer.observe(body, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  })
}

function flush(): void {
  scheduled = false
  if (locale() !== 'bn') {
    pending.clear()
    return
  }
  const nodes = [...pending]
  pending.clear()
  // Detach while we write, so our own edits do not re-trigger the observer.
  observer?.disconnect()
  try {
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text)
      else if (node.nodeType === Node.ELEMENT_NODE) translateSubtree(node as Element)
    }
  } finally {
    connect()
  }
}

function schedule(node: Node): void {
  pending.add(node)
  if (scheduled) return
  scheduled = true
  const raf = globalThis.requestAnimationFrame
  if (typeof raf === 'function') raf(() => flush())
  else queueMicrotask(() => flush())
}

function onMutations(records: MutationRecord[]): void {
  if (locale() !== 'bn') return
  for (const record of records) {
    if (record.type === 'characterData') schedule(record.target)
    else if (record.type === 'attributes') schedule(record.target)
    else {
      for (const added of record.addedNodes) {
        if (added.nodeType === Node.ELEMENT_NODE || added.nodeType === Node.TEXT_NODE) {
          schedule(added)
        }
      }
    }
  }
}

/**
 * Install the engine. Safe to call once at startup: it wires the observer and,
 * if the shop is already in Bengali, translates whatever is on screen now.
 */
export function installAutoTranslate(): void {
  if (typeof globalThis.document === 'undefined') return
  if (!observer) observer = new MutationObserver(onMutations)
  if (locale() === 'bn') refreshAutoTranslate()
}

/** Re-translate the whole document — call after a full re-render. */
export function refreshAutoTranslate(): void {
  const doc = globalThis.document
  if (!doc?.body) return
  if (locale() !== 'bn') return
  observer?.disconnect()
  try {
    translateSubtree(doc)
  } finally {
    connect()
  }
}

/** Language changed: translate now if Bengali, otherwise stand down. */
export function onLocaleForAutoTranslate(next: string): void {
  if (next === 'bn') {
    // The shell re-render that accompanies a language change produces English
    // DOM; sweep it once, then let the observer maintain it.
    refreshAutoTranslate()
  } else {
    observer?.disconnect()
    pending.clear()
    memo.clear()
  }
}
