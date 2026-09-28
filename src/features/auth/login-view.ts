/**
 * Sign in / create shop (spec §41).
 *
 * One screen, two modes. The sign-up path collects the shop type up front
 * because it decides which plugins are recommended at provisioning — asking
 * later would mean a second onboarding pass.
 */

import { h, icon } from '../../components/ui/h'
import { button } from '../../components/ui/button'
import { input, field, select } from '../../components/ui/input'
import {
  signIn,
  signInWithGoogle,
  signUp,
  authSettings,
  type SignUpInput,
} from '../../app/platform/auth'
import { bindDrafts, clearDraft } from '../../app/state/drafts'
import { isConfigured } from '../../app/platform/supabase'
import taxonomy from '../../../data/shop_categories.json'

type Mode = 'signin' | 'signup'

/**
 * Mirrors data/shop_categories.json. Groups carry the bilingual label and an
 * icon; leaves carry the recommendation bundle used at provisioning.
 */
interface ShopType {
  id: string
  name: string
  name_bn: string
  parentId: string
  icon: string
  recommends?: {
    plugins?: string[]
    units?: string[]
    categories?: string[]
    paymentMethods?: string[]
    posLayout?: string
  }
}

interface ShopGroup {
  id: string
  name: string
  name_bn: string
  parentId: null
  icon: string
  children: ShopType[]
}

const GROUPS = (taxonomy as { categories: ShopGroup[] }).categories

export function loginView(options: { onAuthenticated: () => void }): HTMLElement {
  const { onAuthenticated } = options
  let mode: Mode = 'signin'

  // `min-h-full`, not `min-h-screen`: this renders inside `#app`, which is
  // already the height of the viewport. `min-h-screen` on top of that is one
  // viewport *plus* whatever the card needs, which is a second scrollbar and a
  // strip of empty space under the form.
  const root = h('div', {
    class:
      'flex min-h-full items-center justify-center overflow-y-auto bg-surface-muted p-4',
  })

  const render = (): void => {
    root.replaceChildren(mode === 'signin' ? signInCard() : signUpCard())
  }

  // ── Sign in ───────────────────────────────────────────────────────────

  function signInCard(): HTMLElement {
    const email = input({
      id: 'signin-email',
      type: 'email',
      autocomplete: 'email',
      placeholder: 'you@shop.com',
      autofocus: true,
    })
    const password = input({
      id: 'signin-password',
      type: 'password',
      autocomplete: 'current-password',
      placeholder: '••••••••',
    })
    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const submit = button('Sign in', { variant: 'primary', fullWidth: true, size: 'lg' })

    const go = async (): Promise<void> => {
      if (!email.value || !password.value) {
        showError('Enter your email and password.')
        return
      }
      submit.disabled = true
      submit.textContent = 'Signing in…'
      const result = await signIn(email.value, password.value)
      if (result.ok) {
        clearDraft('auth.signin')
        onAuthenticated()
        return
      }
      submit.disabled = false
      submit.textContent = 'Sign in'
      showError(result.error)
    }

    const showError = (message: string): void => {
      errorSlot.textContent = message
      errorSlot.classList.remove('hidden')
    }

    submit.addEventListener('click', () => void go())
    password.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void go()
    })

    const el = card(
      h('h1', { class: 'text-xl font-semibold text-content', text: 'Sign in' }),
      h('p', { class: 'mt-1 text-sm text-content-muted', text: 'Welcome back to your shop.' }),
      h('div', { class: 'mt-5 space-y-4' }, field('Email', email, { required: true }), field('Password', password, { required: true })),
      errorSlot,
      h('div', { class: 'mt-5' }, submit),
      h('div', { class: 'mt-4' }, googleButton(errorSlot)),
      footer(() => {
        mode = 'signup'
        render()
      }, 'New here?', 'Create your shop')
    )

    // The email survives a refresh or a failed attempt; the password never
    // touches localStorage. Cleared on successful sign-in.
    bindDrafts(el, 'auth.signin')
    return el
  }

  // ── Sign up ───────────────────────────────────────────────────────────

  function signUpCard(): HTMLElement {
    const name = input({ id: 'signup-name', autocomplete: 'name', placeholder: 'Rahim Uddin' })
    const shopName = input({ id: 'signup-shop', placeholder: 'Rahim Store' })
    const email = input({ id: 'signup-email', type: 'email', autocomplete: 'email', placeholder: 'you@shop.com' })
    const password = input({
      id: 'signup-password',
      type: 'password',
      autocomplete: 'new-password',
      placeholder: 'At least 8 characters',
    })

    const typeOptions = GROUPS.flatMap((group) =>
      group.children.map((type) => ({
        value: type.id,
        label: `${type.name_bn} · ${type.name}`,
      }))
    )
    const shopType = select({
      id: 'signup-type',
      options: typeOptions,
      placeholder: 'Choose what you sell…',
    })

    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const submit = button('Create my shop', { variant: 'primary', fullWidth: true, size: 'lg' })

    // Told before the fields are filled, not after the account is created.
    // With confirmation switched on, an email sign-up cannot reach the app:
    // the account exists, no session is issued, and the confirmation mail
    // (default Supabase mailer, rate-limited, cannot deliver to arbitrary
    // addresses) usually never arrives. Saying so afterwards leaves a
    // stranded account behind; saying so here costs the shopkeeper nothing.
    const noticeSlot = h('div', { class: 'mt-4' })

    const showError = (message: string): void => {
      errorSlot.textContent = message
      errorSlot.classList.remove('hidden')
    }

    const go = async (): Promise<void> => {
      if (password.value.length < 8) {
        showError('Password must be at least 8 characters.')
        return
      }
      if (!shopType.value) {
        showError('Choose the type of shop you run.')
        return
      }
      submit.disabled = true
      submit.textContent = 'Setting up your shop…'

      const payload: SignUpInput = {
        name: name.value,
        email: email.value,
        password: password.value,
        shopName: shopName.value,
        shopType: shopType.value,
      }
      const result = await signUp(payload)
      if (result.ok) {
        clearDraft('auth.signup')
        onAuthenticated()
        return
      }
      submit.disabled = false
      submit.textContent = 'Create my shop'
      showError(result.error)
    }

    submit.addEventListener('click', () => void go())

    const el = card(
      h('h1', { class: 'text-xl font-semibold text-content', text: 'Set up your shop' }),
      h('p', {
        class: 'mt-1 text-sm text-content-muted',
        text: 'Takes about a minute. Your stock location, register and staff roles are created for you.',
      }),
      noticeSlot,
      h(
        'div',
        { class: 'mt-5 space-y-4' },
        field('Your name', name),
        field('Shop name', shopName, { required: true }),
        field('What do you sell?', shopType, {
          required: true,
          hint: 'This decides which features are recommended for you.',
        }),
        field('Email', email, { required: true }),
        field('Password', password, { required: true })
      ),
      errorSlot,
      h('div', { class: 'mt-5' }, submit),
      h('div', { class: 'mt-4' }, googleButton(errorSlot)),
      footer(() => {
        mode = 'signin'
        render()
      }, 'Already have a shop?', 'Sign in')
    )

    // A failed signup (rate limit, network drop, accidental refresh) must not
    // cost the shopkeeper the form they just filled in. Cleared on success.
    bindDrafts(el, 'auth.signup')

    void authSettings().then((settings) => {
      if (!settings || settings.mailerAutoconfirm) return
      noticeSlot.replaceChildren(confirmationNotice())
    })

    return el
  }

  render()
  return root
}

/**
 * OAuth sign-in. The page navigates away, so the button only needs an error
 * slot for the case where GoTrue refuses to start the flow at all.
 */
function googleButton(errorSlot: HTMLElement): HTMLElement {
  const go = async (): Promise<void> => {
    try {
      await signInWithGoogle()
    } catch (error) {
      errorSlot.textContent = error instanceof Error ? error.message : 'Google sign-in failed.'
      errorSlot.classList.remove('hidden')
    }
  }
  // Hand-built rather than `button()`: the kit renders Material Symbols
  // ligatures, and the Google mark comes from Font Awesome.
  const btn = h(
    'button',
    {
      type: 'button',
      class:
        'inline-flex w-full items-center justify-center gap-2 rounded-md border border-border ' +
        'bg-surface px-4 py-2.5 text-sm font-medium text-content transition-colors ' +
        'hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
        'active:scale-[0.98]',
      onclick: () => void go(),
    },
    h('i', { class: 'fa-brands fa-google text-lg', 'aria-hidden': 'true' }),
    h('span', { text: 'Continue with Google' })
  )
  return btn
}

/**
 * Shown on the sign-up card when the auth server still requires email
 * confirmation. Marks itself with `data-signup-notice` so the mobile audit can
 * assert the screen agrees with the server's own setting.
 */
function confirmationNotice(): HTMLElement {
  return h(
    'div',
    {
      class:
        'flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-content',
      dataset: { signupNotice: 'true' },
      role: 'status',
    },
    icon('mark_email_unread', 'text-lg text-warning shrink-0'),
    h(
      'div',
      { class: 'min-w-0' },
      h('p', {
        class: 'font-medium',
        text: 'Email confirmation is switched on for this project',
      }),
      h('p', {
        class: 'mt-1 text-content-muted',
        text:
          'A new email sign-up cannot sign in until the link is clicked, and that ' +
          'email usually never arrives. Continue with Google below, or turn off ' +
          '"Confirm email" in Supabase → Authentication → Sign In / Providers → Email.',
      })
    )
  )
}

function card(...children: HTMLElement[]): HTMLElement {
  return h(
    'div',
    {
      class: 'w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-sm',
    },
    h(
      'div',
      { class: 'mb-5 flex items-center gap-3' },
      h('img', {
        src: './icons/mekholi-192.png',
        alt: 'Mekholi logo',
        class: 'h-12 w-12 rounded-xl shadow-sm',
        width: '48',
        height: '48',
      }),
      h(
        'div',
        null,
        h('p', { class: 'text-lg font-bold tracking-tight text-content', text: 'Mekholi' }),
        h('p', { class: 'text-xs text-content-muted', text: 'Point of sale and inventory' })
      )
    ),
    ...children
  )
}

function footer(switchMode: () => void, prompt: string, linkLabel: string): HTMLElement {
  return h(
    'p',
    { class: 'mt-3 text-center text-sm text-content-muted' },
    prompt,
    ' ',
    // The link carries its own 44px hit area: it is the only way between sign
    // in and sign up, and a bare 20px-tall inline link is a miss on a phone.
    // The negative margins keep the visual rhythm of the card unchanged.
    h('button', {
      type: 'button',
      class:
        'inline-flex min-h-[44px] -my-3 items-center px-2 -mx-2 align-middle ' +
        'font-medium text-primary hover:underline ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md',
      text: linkLabel,
      onclick: switchMode,
    })
  )
}

/** Shown when VITE_SUPABASE_URL is absent, so the failure is legible. */
export function notConfiguredView(): HTMLElement {
  return h(
    'div',
    { class: 'flex min-h-full items-center justify-center overflow-y-auto bg-surface-muted p-6' },
    h(
      'div',
      { class: 'max-w-md rounded-xl border border-border bg-surface p-6 text-center' },
      icon('cloud_off', 'text-4xl text-content-subtle'),
      h('h1', { class: 'mt-3 text-lg font-semibold text-content', text: 'Not connected to a server' }),
      h('p', {
        class: 'mt-2 text-sm text-content-muted',
        text:
          'Mekholi needs a Supabase project. Copy .env.example to .env, fill in ' +
          'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then run `supabase db reset` ' +
          'to create the schema.',
      }),
      h('p', {
        class: 'mt-3 text-xs text-content-subtle',
        text: isConfigured() ? '' : 'Status: no credentials found at build time.',
      })
    )
  )
}
