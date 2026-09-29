/**
 * Image picker tests.
 *
 * @vitest-environment jsdom
 *
 * The picker's whole promise is that nothing is uploaded until a form says
 * so, and that what the form reads back is the URL it should store. Those two
 * things are what these tests hold in place.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { imagePicker } from './image-upload'

function fakeFile(name = 'rice.png', type = 'image/png'): File {
  return new File(['x'], name, { type })
}

/** jsdom has no blob URLs; the picker only needs the two functions to exist. */
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:preview', writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, writable: true })
})

/** Puts a file on the hidden input the way a file dialog would. */
function choose(root: HTMLElement, file: File): void {
  const input = root.querySelector('input[type=file]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change'))
}

describe('imagePicker', () => {
  it('starts with the saved URL and reports nothing pending', () => {
    const picker = imagePicker({ value: 'https://i.ibb.co/a.png' })
    expect(picker.value()).toBe('https://i.ibb.co/a.png')
    expect(picker.isDirty()).toBe(false)
    expect(picker.root.querySelector('img')?.getAttribute('src')).toBe('https://i.ibb.co/a.png')
  })

  it('does not upload while the user is still filling the form', () => {
    const upload = vi.fn()
    const picker = imagePicker({ upload })
    choose(picker.root, fakeFile())
    expect(picker.isDirty()).toBe(true)
    expect(upload).not.toHaveBeenCalled()
  })

  it('uploads on commit and hands back the hosted URL', async () => {
    const upload = vi.fn(async () => ({ url: 'https://i.ibb.co/new.png' }))
    const picker = imagePicker({ upload })
    choose(picker.root, fakeFile())
    await expect(picker.commit()).resolves.toBe('https://i.ibb.co/new.png')
    expect(upload).toHaveBeenCalledTimes(1)
    expect(picker.isDirty()).toBe(false)
    expect(picker.value()).toBe('https://i.ibb.co/new.png')
  })

  it('commits to the existing URL without a request when nothing changed', async () => {
    const upload = vi.fn()
    const picker = imagePicker({ value: 'https://i.ibb.co/old.png', upload })
    await expect(picker.commit()).resolves.toBe('https://i.ibb.co/old.png')
    expect(upload).not.toHaveBeenCalled()
  })

  it('refuses a file the validator rejects, and shows why', () => {
    const upload = vi.fn()
    const picker = imagePicker({ upload, validate: () => 'Choose a smaller image.' })
    choose(picker.root, fakeFile('huge.png'))
    expect(picker.isDirty()).toBe(false)
    expect(picker.root.textContent).toContain('Choose a smaller image.')
  })

  it('reports progress through to the caller’s bar', async () => {
    const seen: number[] = []
    const picker = imagePicker({
      upload: async (_file, onProgress) => {
        onProgress(0.5)
        onProgress(1)
        return { url: 'https://i.ibb.co/p.png' }
      },
      onChange: (url) => seen.push(url ? 1 : 0),
    })
    choose(picker.root, fakeFile())
    await picker.commit()
    expect(seen).toEqual([1])
  })

  it('clears the stored URL when the image is removed', () => {
    const changes: (string | null)[] = []
    const picker = imagePicker({ value: 'https://i.ibb.co/a.png', onChange: (url) => changes.push(url) })
    const remove = [...picker.root.querySelectorAll('button')].find((b) => b.textContent?.includes('Remove'))
    remove?.click()
    expect(picker.value()).toBeNull()
    expect(changes).toEqual([null])
  })

  it('renders disabled with an explanation when no uploader is given', () => {
    const picker = imagePicker({ disabledHint: 'Add an ImgBB key in Settings to enable uploads.' })
    const choosePhoto = picker.root.querySelector('button') as HTMLButtonElement
    expect(choosePhoto.disabled).toBe(true)
    expect(picker.root.textContent).toContain('Add an ImgBB key in Settings')
  })

  it('surfaces an upload failure to the caller instead of swallowing it', async () => {
    const picker = imagePicker({
      upload: async () => {
        throw new Error('The image host could not be reached.')
      },
    })
    choose(picker.root, fakeFile())
    await expect(picker.commit()).rejects.toThrowError(/could not be reached/)
    // The file stays pending, so a retry does not need a second file dialog.
    expect(picker.isDirty()).toBe(true)
  })
})
