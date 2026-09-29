/**
 * Approximate Latin → Bengali phonetic transliteration.
 *
 * The product is Bengali-first (docs/01, docs/16): a shopkeeper should never
 * be shown a Latin word. The curated dictionary in `dictionary.ts` handles the
 * vocabulary the app actually uses; this is the last resort for a word nobody
 * translated — a plugin's label, a made-up brand, a typo. It renders the word
 * in the Bengali alphabet by sound rather than leaving it in English.
 *
 * It is deliberately spelling-based and best-effort. It does not know that
 * "label" is said "lay-bel"; it maps the letters. That is acceptable: the rule
 * the user set is "if you don't know the meaning, put the same word in Bengali
 * letters", and a rough phonetic rendering satisfies exactly that.
 */

/** Digraphs and trigraphs first, so `sh` is not read as `s` + `h`. */
const CONSONANT_DIGRAPHS: ReadonlyArray<readonly [string, string]> = [
  ['tch', 'চ'],
  ['sch', 'শ'],
  ['chh', 'ছ'],
  ['ch', 'চ'],
  ['sh', 'শ'],
  ['th', 'থ'],
  ['ph', 'ফ'],
  ['kh', 'খ'],
  ['gh', 'ঘ'],
  ['dh', 'ধ'],
  ['bh', 'ভ'],
  ['jh', 'ঝ'],
  ['zh', 'জ'],
  ['ng', 'ং'],
  ['ck', 'ক'],
  ['qu', 'ক'],
  ['wh', 'ও'],
]

const CONSONANT_SINGLE: Readonly<Record<string, string>> = {
  b: 'ব',
  c: 'ক',
  d: 'ড',
  f: 'ফ',
  g: 'গ',
  h: 'হ',
  j: 'জ',
  k: 'ক',
  l: 'ল',
  m: 'ম',
  n: 'ন',
  p: 'প',
  q: 'ক',
  r: 'র',
  s: 'স',
  t: 'ট',
  v: 'ভ',
  w: 'ও',
  x: 'ক্স',
  y: 'য়',
  z: 'জ',
}

/** Independent vowels — used at the start of a word or after another vowel. */
const VOWEL_INDEP: Readonly<Record<string, string>> = {
  aa: 'আ',
  ai: 'আই',
  au: 'আউ',
  ee: 'ঈ',
  oo: 'উ',
  oi: 'ওই',
  ou: 'আউ',
  a: 'আ',
  e: 'এ',
  i: 'ই',
  o: 'ও',
  u: 'উ',
}

/** Dependent vowel signs (matra) — attached to the preceding consonant. */
const VOWEL_MATRA: Readonly<Record<string, string>> = {
  aa: 'া',
  ai: 'ৈ',
  au: 'ৌ',
  ee: 'ী',
  oo: 'ূ',
  oi: 'ৈ',
  ou: 'ৌ',
  a: 'া',
  e: 'ে',
  i: 'ি',
  o: 'ো',
  u: 'ু',
}

const VOWEL_KEYS_LONG = ['aa', 'ai', 'au', 'ee', 'oo', 'oi', 'ou'] as const
const VOWEL_KEYS_SHORT = ['a', 'e', 'i', 'o', 'u'] as const
const VOWEL_LETTERS = new Set(['a', 'e', 'i', 'o', 'u'])

interface Piece {
  ben: string
  len: number
}

/** Match a vowel (longest first) at `i`, or null. */
function matchVowel(w: string, i: number): { key: string; len: number } | null {
  for (const key of VOWEL_KEYS_LONG) {
    if (w.startsWith(key, i)) return { key, len: 2 }
  }
  for (const key of VOWEL_KEYS_SHORT) {
    if (w.startsWith(key, i)) return { key, len: 1 }
  }
  return null
}

/** Match a consonant cluster (digraph, doubled letter, or single) at `i`. */
function matchConsonant(w: string, i: number): Piece | null {
  for (const [seq, ben] of CONSONANT_DIGRAPHS) {
    if (w.startsWith(seq, i)) return { ben, len: seq.length }
  }
  const ch = w[i]
  if (ch === undefined || !(ch in CONSONANT_SINGLE)) return null

  // Collapse a doubled consonant ("ss", "ll") to a single sound.
  const len = w[i + 1] === ch ? 2 : 1

  // Soft `c`/`g` before a front vowel: "city" → স, "page" → জ.
  const next = w[i + len]
  if (ch === 'c' && next !== undefined && 'eiy'.includes(next)) return { ben: 'স', len }
  if (ch === 'g' && next !== undefined && 'eiy'.includes(next)) return { ben: 'জ', len }

  return { ben: CONSONANT_SINGLE[ch] ?? ch, len }
}

/**
 * Render a single all-letters word in the Bengali alphabet by sound.
 *
 * Non-letters are the caller's responsibility — this expects a pure `[a-z]`
 * word and returns the original untouched if it cannot make progress.
 */
export function transliterateWord(word: string): string {
  const w = word.toLowerCase()
  if (w.length === 0) return word

  let out = ''
  let i = 0
  while (i < w.length) {
    const cons = matchConsonant(w, i)
    if (cons) {
      const vowel = matchVowel(w, i + cons.len)
      if (vowel) {
        out += cons.ben + (VOWEL_MATRA[vowel.key] ?? '')
        i += cons.len + vowel.len
        continue
      }
      // No vowel follows. Join to a following consonant with a hasant so the
      // cluster reads as one; keep the inherent vowel at a word's end.
      const followsConsonant =
        i + cons.len < w.length && !VOWEL_LETTERS.has(w[i + cons.len] ?? '')
      out += followsConsonant ? cons.ben + '\u09CD' : cons.ben
      i += cons.len
      continue
    }

    const vowel = matchVowel(w, i)
    if (vowel) {
      out += VOWEL_INDEP[vowel.key] ?? ''
      i += vowel.len
      continue
    }

    // Anything else (should not occur for a pure-letter word) passes through.
    out += w[i] ?? ''
    i += 1
  }

  return out.length > 0 ? out : word
}

const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'] as const

/** Latin digits → Bengali digits, leaving separators and symbols in place. */
export function bengaliDigits(value: string): string {
  return value.replace(/[0-9]/g, (d) => BENGALI_DIGITS[Number(d)] ?? d)
}
