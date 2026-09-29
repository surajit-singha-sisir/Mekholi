// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from './index'
import { resetI18nForTests } from './index'
import { translateText, refreshAutoTranslate, onLocaleForAutoTranslate } from './auto-translate'
import { transliterateWord } from './transliterate'

afterEach(() => {
  onLocaleForAutoTranslate('en')
  resetI18nForTests()
})

const hasLatinLetters = (s: string): boolean => /[A-Za-z]/.test(s)

describe('the translator engine — string translation', () => {
  it('renders a curated phrase naturally', () => {
    expect(translateText('Point of Sale')).toBe('পয়েন্ট অব সেল')
    expect(translateText('Stock')).toBe('স্টক')
    expect(translateText('Due ledger')).toBe('বাকির খাতা')
    expect(translateText('Purchases')).toBe('ক্রয়')
  })

  it('keeps trailing sentence punctuation around a phrase', () => {
    expect(translateText('No results found.')).toBe('কোনো ফলাফল পাওয়া যায়নি.')
    expect(translateText('Search…')).toBe('খুঁজুন…')
  })

  it('translates word by word when no phrase matches', () => {
    const out = translateText('Add product')
    expect(hasLatinLetters(out)).toBe(false)
    expect(out).toContain('পণ্য')
  })

  it('never rewrites numbers — they are functional values', () => {
    expect(translateText('5 items')).toBe('5 পণ্য')
    expect(translateText('1,250')).toBe('1,250')
  })

  it('leaves functional identifiers completely untouched', () => {
    expect(translateText('ABC123')).toBe('ABC123')
    expect(translateText('v6.5.2')).toBe('v6.5.2')
    expect(translateText('SKU')).toBe('SKU')
    expect(translateText('INV-2024')).toBe('INV-2024')
    // Internal keys / paths are not UI copy.
    expect(translateText('dashboard.view')).toBe('dashboard.view')
    expect(translateText('created_at')).toBe('created_at')
  })

  it('skips the identifier but translates the words around it', () => {
    const out = translateText('Invoice INV-0007 paid')
    expect(out).toContain('INV-0007')
    expect(out).toContain('চালান')
    expect(out).toContain('পরিশোধিত')
    expect(out).not.toMatch(/\bInvoice\b/)
  })

  it('transliterates an unknown word so no English remains', () => {
    const out = translateText('Zorbington')
    expect(hasLatinLetters(out)).toBe(false)
    expect(out.length).toBeGreaterThan(0)
  })

  it('is idempotent — re-running over Bengali output changes nothing', () => {
    const once = translateText('Complete sale')
    expect(translateText(once)).toBe(once)
  })

  it('transliterates a bare word into Bengali script', () => {
    expect(hasLatinLetters(transliterateWord('menu'))).toBe(false)
  })
})

describe('the translator engine — the live DOM', () => {
  it('rewrites text and placeholders but never icons or typed input', () => {
    setLocale('bn')
    document.body.innerHTML = `
      <div id="scope">
        <span class="material-symbols-rounded">point_of_sale</span>
        <h1>Products</h1>
        <button>Save</button>
        <input placeholder="Search" value="Coca Cola" />
        <code>const x = 1</code>
      </div>
    `
    refreshAutoTranslate()

    const scope = document.getElementById('scope')!
    // Icon ligature is left intact, or the glyph breaks.
    expect(scope.querySelector('.material-symbols-rounded')?.textContent).toBe('point_of_sale')
    // Visible copy is Bengali.
    expect(scope.querySelector('h1')?.textContent).toBe('পণ্য')
    expect(scope.querySelector('button')?.textContent).toBe('সংরক্ষণ')
    // Placeholder is translated; the user's typed value is not.
    const input = scope.querySelector('input')!
    expect(input.getAttribute('placeholder')).toBe('খুঁজুন')
    expect(input.value).toBe('Coca Cola')
    // Code is untouched.
    expect(scope.querySelector('code')?.textContent).toBe('const x = 1')
  })
})
