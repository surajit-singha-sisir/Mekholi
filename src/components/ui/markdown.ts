/**
 * A small, safe Markdown renderer.
 *
 * Plugin detail pages are written as `.md` files beside the plugin's own
 * code, and this renders them into real DOM — never `innerHTML` over raw
 * input, so a stray `<script>` in a description is text, not code.
 *
 * It speaks the Markdown a README actually uses and nothing more:
 * `#`–`###` headings, paragraphs, `-` and `1.` lists, **bold**, *italic*,
 * `code`, [links](…), `---` rules and `>` quotes. Anything fancier is a
 * sign the document should be a screen, not a file.
 */

import { h } from './h'

/** Inline marks: bold, italic, code, links — parsed left to right. */
function inline(text: string): (HTMLElement | Text)[] {
  const out: (HTMLElement | Text)[] = []
  let rest = text
  const RULES: [RegExp, (m: RegExpMatchArray) => HTMLElement][] = [
    [/^\*\*([^*]+)\*\*/, (m) => h('strong', { text: m[1] ?? '' })],
    [/^\*([^*]+)\*/, (m) => h('em', { text: m[1] ?? '' })],
    [/^`([^`]+)`/, (m) => h('code', { class: 'rounded bg-surface-muted px-1 py-0.5 text-[0.85em]', text: m[1] ?? '' })],
    [
      /^\[([^\]]+)\]\(([^)\s]+)\)/,
      (m) =>
        h('a', {
          href: m[2] ?? '#',
          target: '_blank',
          rel: 'noopener noreferrer',
          class: 'text-primary underline underline-offset-2',
          text: m[1] ?? '',
        }),
    ],
  ]

  while (rest.length > 0) {
    let matched = false
    for (const [pattern, build] of RULES) {
      const m = rest.match(pattern)
      if (m && m[0]) {
        out.push(build(m))
        rest = rest.slice(m[0].length)
        matched = true
        break
      }
    }
    if (matched) continue
    // Advance to the next possible mark, or the end.
    const next = rest.slice(1).search(/[*`[]/)
    const take = next === -1 ? rest.length : next + 1
    out.push(document.createTextNode(rest.slice(0, take)))
    rest = rest.slice(take)
  }
  return out
}

export function renderMarkdown(markdown: string): HTMLElement {
  const root = h('div', { class: 'space-y-3 text-sm leading-relaxed text-content' })
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')

  let list: HTMLElement | null = null
  let listOrdered = false

  const flushList = (): void => {
    if (list) root.append(list)
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      flushList()
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      flushList()
      const level = (heading[1] ?? '#').length
      const cls =
        level === 1
          ? 'text-lg font-semibold text-content'
          : level === 2
            ? 'pt-1 text-base font-semibold text-content'
            : 'pt-1 text-sm font-semibold text-content'
      root.append(h(level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5', { class: cls }, ...inline(heading[2] ?? '')))
      continue
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushList()
      root.append(h('hr', { class: 'border-border' }))
      continue
    }

    const quote = trimmed.match(/^>\s?(.*)$/)
    if (quote) {
      flushList()
      root.append(
        h('blockquote', { class: 'border-l-2 border-border pl-3 text-content-muted' }, ...inline(quote[1] ?? ''))
      )
      continue
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/)
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      if (!list || listOrdered !== ordered) {
        flushList()
        listOrdered = ordered
        list = h(ordered ? 'ol' : 'ul', {
          class: `${ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`,
        })
      }
      list.append(h('li', {}, ...inline((bullet?.[1] ?? numbered?.[1]) ?? '')))
      continue
    }

    flushList()
    root.append(h('p', {}, ...inline(trimmed)))
  }

  flushList()
  return root
}
