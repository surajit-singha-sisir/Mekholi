/**
 * The Markdown renderer: enough for a README, and safe by construction.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders headings, paragraphs, lists and inline marks', () => {
    const el = renderMarkdown(
      '# Title\n\nA paragraph with **bold**, *italic* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n---\n\n> a quote'
    )
    expect(el.querySelector('h3')?.textContent).toBe('Title')
    expect(el.querySelector('strong')?.textContent).toBe('bold')
    expect(el.querySelector('em')?.textContent).toBe('italic')
    expect(el.querySelector('code')?.textContent).toBe('code')
    expect([...el.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['one', 'two'])
    expect([...el.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual(['first', 'second'])
    expect(el.querySelector('hr')).toBeTruthy()
    expect(el.querySelector('blockquote')?.textContent).toBe('a quote')
  })

  it('renders links that open elsewhere and never run script', () => {
    const el = renderMarkdown('See [the docs](https://example.com) and <script>alert(1)</script>.')
    const a = el.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.getAttribute('rel')).toContain('noopener')
    // The script tag is text on the page, not an element in the DOM.
    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toContain('<script>alert(1)</script>')
  })

  it('keeps Bangla text intact', () => {
    const el = renderMarkdown('## বাকির খাতা\n\nবাকি লেখা থাকে **খাতায়**।')
    expect(el.textContent).toContain('বাকির খাতা')
    expect(el.querySelector('strong')?.textContent).toBe('খাতায়')
  })
})
