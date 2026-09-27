/**
 * Settings → Plugins (spec §31, §51; docs/05 §5, §10; docs/07 §4, §10).
 *
 * The screen a shopkeeper uses to switch capabilities on and off. Three things
 * about it are deliberate:
 *
 *  * **Nothing here is hard-coded per plugin.** The list comes from
 *    `plugin_catalog()` — what the *server* ships — and the settings form is
 *    rendered from the plugin's own `settingsSchema`. Adding a plugin to this
 *    bundle never means editing this file (spec §51).
 *  * **Switching on is a decision, so it is previewed.** `plugin_impact()`
 *    answers the question a permission list cannot: which roles would gain
 *    these permissions *silently*, because they hold a wildcard. A shopkeeper
 *    who learns that from an incident report has lost trust in the system.
 *  * **Switching off is not deletion.** Migrations, tables, data and grants
 *    all survive; only the behaviour stops. The confirm dialog says so, and
 *    the plugin's data comes back when it is switched on again.
 *
 * A plugin that fails to load is shown as *needing attention* with the error
 * the host recorded, and one button to try again — never a silent absence.
 */

import { h, mount } from '../../components/ui/h'
import { button, iconButton, spinner } from '../../components/ui/button'
import { badge, card, emptyState, stat } from '../../components/ui/card'
import { checkbox, field, input, searchInput, select } from '../../components/ui/input'
import { confirm, modal } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { activeOrganization, can } from '../../app/state/session'
import { pluginRegistry, pluginConfig, rememberConfig, syncPlugins, alwaysOnPlugins } from '../../app/plugins'
import { translateError } from '../../app/platform/errors'
import {
  LICENCE_KEY,
  licenceFor,
  priceLabel,
  startSubscription,
  startTrial,
  type Licence,
} from '../../shared/registry/plugin-licence'
import { pluginCover } from './plugin-cover'
import { pluginShelfOrder } from './plugin-order'
import type { PluginManifest } from '../../shared/registry/plugin-types'
import type { PluginCatalogEntry, PluginImpactRole } from '../../shared/repositories/contracts'

type Filter = 'all' | 'on' | 'off' | 'attention'

const CATEGORY_LABELS: Record<PluginCatalogEntry['category'], string> = {
  core: 'Core',
  optional: 'Optional',
  industry: 'Industry',
}

const CATEGORY_ORDER: PluginCatalogEntry['category'][] = ['core', 'optional', 'industry']

/** What a plugin actually contributed to this session, read from the host. */
function contributions(pluginKey: string): string[] {
  const count = (items: readonly { source?: string }[]): number =>
    items.filter((item) => item.source === pluginKey).length

  const registry = pluginRegistry
  const parts: Array<[number, string]> = [
    [count(registry.nav.items), 'screen'],
    [count(registry.routes.items), 'route'],
    [count(registry.widgets.items), 'dashboard widget'],
    [count(registry.posPanels.items), 'POS panel'],
    [count(registry.saleTabs.items), 'sale tab'],
    [count(registry.formSections.items), 'form section'],
    [count(registry.productFields.items), 'product field'],
    [count(registry.permissions.items), 'permission'],
  ]

  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}${n === 1 ? '' : 's'}`)
}

export function pluginsView(): HTMLElement {
  const repos = getRepositories()
  const org = activeOrganization()
  const organizationId = org?.organization_id ?? ''
  const canManage = can('plugins.manage')

  let entries: PluginCatalogEntry[] = []
  let filter: Filter = 'all'
  let search = ''
  let loadError: string | null = null

  const headerSlot = h('div', { class: 'space-y-3 border-b border-border p-4' })
  const listSlot = h('div', { class: 'p-4' })
  // Wider than the rest of the app's settings screens on purpose: a plugin
  // card carries a cover, a description, what it contributes, what it costs
  // and its controls, and squeezing that into 64rem wrapped every line.
  const root = h('div', { class: 'flex w-full flex-col' }, headerSlot, listSlot)

  const searchBox = searchInput('Search plugins…', (value) => {
    search = value
    render()
  })

  const filterBox = select({
    value: filter,
    options: [
      { value: 'all', label: 'All plugins' },
      { value: 'on', label: 'Switched on' },
      { value: 'off', label: 'Switched off' },
      { value: 'attention', label: 'Needs attention' },
    ],
    onChange: (value) => {
      filter = value as Filter
      render()
    },
    class: 'sm:max-w-[12rem]',
  })

  const reloadButton = iconButton('refresh', 'Reload the plugin list', {
    onClick: () => void load(),
  })

  let requestId = 0

  async function load(): Promise<void> {
    const id = ++requestId
    mount(listSlot, h('div', { class: 'flex justify-center p-8' }, spinner()))
    try {
      const catalog = await repos.plugins.catalog(organizationId)
      if (id !== requestId) return
      entries = withAlwaysOn(catalog)
      loadError = null
      for (const entry of catalog) rememberConfig(entry.key, entry.config)
    } catch (error) {
      if (id !== requestId) return
      loadError = translateError(error).message
    } finally {
      if (id === requestId) {
        renderHeader()
        render()
      }
    }
  }

  function renderHeader(): void {
    const on = entries.filter((entry) => entry.enabled).length
    const pending = entries.reduce((sum, entry) => sum + entry.migrationsPending, 0)
    const broken = entries.filter((entry) => entry.status === 'error').length

    mount(
      headerSlot,
      h(
        'div',
        { class: 'flex flex-wrap items-start justify-between gap-3' },
        h(
          'div',
          { class: 'min-w-0' },
          h('h2', { class: 'text-xl font-semibold text-content', text: 'Plugins' }),
          h('p', {
            class: 'mt-0.5 text-sm text-content-muted',
            text: 'Extra capabilities for this shop. Everything here is optional — the core shop works without any of it.',
          })
        ),
        reloadButton
      ),
      h('div', { class: 'grid gap-2 sm:grid-cols-3' }, [
        stat('Switched on', `${on} of ${entries.length}`),
        stat('Migrations to apply', pending === 0 ? 'None' : String(pending)),
        stat('Needs attention', broken === 0 ? 'None' : String(broken), broken ? { tone: 'danger' } : {}),
      ]),
      h(
        'div',
        { class: 'flex flex-col gap-2 sm:flex-row' },
        h('div', { class: 'sm:flex-1' }, searchBox),
        filterBox
      )
    )
  }

  function visibleEntries(): PluginCatalogEntry[] {
    const needle = search.trim().toLowerCase()
    return entries
      .filter((entry) => {
        if (filter === 'on' && !entry.enabled) return false
        if (filter === 'off' && entry.enabled) return false
        if (filter === 'attention' && entry.status !== 'error') return false
        if (!needle) return true
        return (
          entry.name.toLowerCase().includes(needle) ||
          entry.key.includes(needle) ||
          (entry.description ?? '').toLowerCase().includes(needle)
        )
      })
      .sort(pluginShelfOrder)
  }

  function render(): void {
    if (loadError) {
      mount(
        listSlot,
        emptyState('The plugin list could not be loaded', {
          description: loadError,
          iconName: 'error',
          action: button('Try again', { variant: 'primary', onClick: () => void load() }),
        })
      )
      return
    }

    if (entries.length === 0) {
      mount(
        listSlot,
        emptyState('This server ships no plugins', {
          description:
            'Plugins arrive with the server bundle. When one is published, it appears here with what it adds.',
          iconName: 'extension_off',
        })
      )
      return
    }

    const visible = visibleEntries()
    if (visible.length === 0) {
      mount(
        listSlot,
        emptyState('Nothing matches that', {
          description: 'Try a different search, or show all plugins.',
          iconName: 'search_off',
        })
      )
      return
    }

    mount(
      listSlot,
      h(
        'div',
        { class: 'space-y-4' },
        ...CATEGORY_ORDER.map((category) => {
          const group = visible.filter((entry) => entry.category === category)
          if (group.length === 0) return null
          return h(
            'section',
            { class: 'space-y-2' },
            h('h3', {
              class: 'text-xs font-semibold uppercase tracking-wide text-content-subtle',
              text: `${CATEGORY_LABELS[category]} (${group.length})`,
            }),
            ...group.map(pluginCard)
          )
        })
      )
    )
  }

  function manifestOf(key: string): PluginManifest | undefined {
    return pluginRegistry.get(key)?.manifest
  }

  /**
   * Show the always-on plugins even when the server has never heard of them.
   *
   * `plugin_packages` is seeded by a migration, and a shop whose database is
   * a version behind would otherwise see a menu entry in the sidebar for a
   * plugin that does not exist on this screen. Running code the list denies
   * is worse than an extra row: the row at least tells the truth.
   */
  function withAlwaysOn(catalog: PluginCatalogEntry[]): PluginCatalogEntry[] {
    const known = new Set(catalog.map((entry) => entry.key))
    const missing = alwaysOnPlugins()
      .filter((key) => !known.has(key))
      .map((key) => manifestOf(key))
      .filter((manifest): manifest is PluginManifest => manifest !== undefined)
      .map<PluginCatalogEntry>((manifest) => ({
        key: manifest.id,
        name: manifest.name,
        category: manifest.category,
        version: manifest.version,
        coreApiVersion: manifest.coreApiVersion,
        description: manifest.description,
        dependencies: [...(manifest.dependencies ?? [])],
        conflicts: [...(manifest.conflicts ?? [])],
        installed: true,
        enabled: true,
        status: 'ok',
        lastError: null,
        config: pluginConfig(manifest.id),
        enabledAt: null,
        permissions: [],
        migrationsTotal: 0,
        migrationsPending: 0,
      }))
    return [...catalog, ...missing]
  }

  function licenceOf(entry: PluginCatalogEntry): Licence {
    return licenceFor(manifestOf(entry.key)?.pricing, pluginConfig(entry.key))
  }

  /** One card per plugin: what it is, what it costs, and its controls. */
  function pluginCard(entry: PluginCatalogEntry): HTMLElement {
    const registration = pluginRegistry.get(entry.key)
    const manifest = manifestOf(entry.key)
    const hostError = registration?.error ?? null
    const failed = entry.status === 'error' || registration?.status === 'error'
    const blocked = registration?.status === 'blocked'
    const loaded = registration?.status === 'loaded'
    const parts = loaded ? contributions(entry.key) : []
    const licence = licenceOf(entry)
    const paid = licence.status !== 'free'
    const alwaysOn = alwaysOnPlugins().includes(entry.key)

    const statusBadge = alwaysOn
      ? badge('Always on', { tone: 'success', iconName: 'lock' })
      : failed
      ? badge('Needs attention', { tone: 'danger', iconName: 'error' })
      : blocked
        ? badge('Blocked', { tone: 'warning', iconName: 'block' })
        : entry.enabled
          ? badge('On', { tone: 'success', iconName: 'check_circle' })
          : badge('Off', { tone: 'neutral', iconName: 'power_settings_new' })

    const priceBadge = !paid
      ? badge('Free', { tone: 'success', iconName: 'volunteer_activism' })
      : licence.status === 'trial'
        ? badge(`Trial · ${licence.daysLeft}d left`, { tone: 'info', iconName: 'schedule' })
        : licence.status === 'active'
          ? badge('Subscribed', { tone: 'success', iconName: 'workspace_premium' })
          : licence.status === 'expired'
            ? badge('Expired', { tone: 'danger', iconName: 'event_busy' })
            : badge(priceLabel(manifest?.pricing), { tone: 'warning', iconName: 'sell' })

    // ── The right-hand column ────────────────────────────────────────────
    // Everything that *acts* lives here, in one place, in the same order on
    // every card: state, price, the switch, then settings. A shopkeeper
    // scanning the list reads the left edge for what a thing is and the right
    // edge for what they can do about it.
    const controls: (HTMLElement | null)[] = [
      h('div', { class: 'flex flex-wrap items-center justify-end gap-1.5' }, statusBadge, priceBadge),
      h('p', { class: 'text-right text-xs text-content-subtle', text: licence.summary }),
    ]

    if (alwaysOn) {
      controls.push(
        h('p', {
          class: 'text-right text-xs text-content-subtle',
          text: 'Always on — it configures this device and stores nothing on the server.',
        })
      )
    } else if (canManage) {
      controls.push(
        entry.enabled
          ? button('Switch off', {
              variant: 'secondary',
              icon: 'toggle_off',
              fullWidth: true,
              onClick: () => void switchOff(entry),
            })
          : button(paid && !licence.entitled ? 'Subscribe & switch on' : 'Switch on', {
              variant: 'primary',
              icon: paid && !licence.entitled ? 'shopping_cart_checkout' : 'toggle_on',
              fullWidth: true,
              onClick: () => void switchOn(entry),
            })
      )
    }

    controls.push(
      h('div', { class: 'flex justify-end' },
        // An icon, not a button with a word: settings is the secondary action
        // and it should not compete with the switch above it.
        iconButton('tune', `${entry.name} settings`, {
          variant: 'ghost',
          disabled: !entry.installed,
          title: entry.installed ? 'Settings' : 'Switch this plugin on first',
          onClick: () => openSettings(entry),
        })
      )
    )

    return card(
      h('div', { class: 'flex flex-col gap-4 lg:flex-row lg:items-start' },
        // ── Cover ──────────────────────────────────────────────────────
        h('img', {
          src: manifest?.cover ?? pluginCover({ id: entry.key, name: entry.name }),
          alt: '',
          class: [
            'h-24 w-full shrink-0 rounded-lg border border-border object-cover',
            'lg:h-20 lg:w-28',
            entry.enabled ? '' : 'opacity-60 grayscale',
          ].filter(Boolean).join(' '),
        }),

        // ── What it is ─────────────────────────────────────────────────
        h('div', { class: 'min-w-0 flex-1' },
          h('div', { class: 'flex flex-wrap items-center gap-2' },
            h('p', { class: 'text-base font-semibold text-content', text: entry.name }),
            badge(`v${entry.version}`, { tone: 'neutral' }),
            entry.migrationsPending > 0
              ? badge(`${entry.migrationsPending} migration(s) pending`, { tone: 'info' })
              : null
          ),
          h('p', { class: 'mt-1 text-sm text-content-muted', text: entry.description ?? '—' }),
          h('p', { class: 'mt-1 text-xs text-content-subtle', text: `id: ${entry.key}` }),
          parts.length > 0
            ? h('p', { class: 'mt-2 text-xs text-content-muted', text: `Adds: ${parts.join(' · ')}` })
            : null,
          entry.permissions.length > 0
            ? h('p', {
                class: 'mt-1 text-xs text-content-subtle',
                text: `Permissions: ${entry.permissions.map((permission) => permission.key).join(', ')}`,
              })
            : null,
          entry.dependencies.length > 0
            ? h('p', {
                class: 'mt-1 text-xs text-content-subtle',
                text: `Needs: ${entry.dependencies.join(', ')}`,
              })
            : null,
          workerLine(entry.key)
        ),

        // ── What you can do about it ───────────────────────────────────
        h('div', { class: 'flex w-full shrink-0 flex-col gap-2 lg:w-52' }, ...controls)
      ),

      blocked && registration?.error
        ? h('div', { class: 'mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3' },
            h('p', { class: 'text-xs text-content-muted', text: registration.error })
          )
        : null,

      failed && (hostError ?? entry.lastError)
        ? h(
            'div',
            { class: 'mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3' },
            h('p', { class: 'text-xs font-medium text-danger', text: 'This plugin did not finish loading' }),
            h('p', { class: 'mt-1 text-xs text-content-muted', text: hostError ?? entry.lastError ?? '' }),
            h(
              'div',
              { class: 'mt-2' },
              button('Try again', {
                size: 'sm',
                icon: 'restart_alt',
                onClick: () => void retry(entry),
              })
            )
          )
        : null
    )
  }

  /**
   * What this plugin has cost the app, measured rather than guessed.
   *
   * The worker times every turn a plugin takes. A shop complaining that "the
   * till got slow after I switched things on" deserves a number, and a plugin
   * the worker has stopped calling must say so out loud.
   */
  function workerLine(key: string): HTMLElement | null {
    const stat = pluginRegistry.worker.statFor(key)
    if (!stat || stat.runs === 0) return null
    const average = Math.round(stat.totalMs / stat.runs)
    const trouble = stat.failures + stat.timeouts
    return h('p', {
      class: `mt-2 text-xs ${trouble > 0 ? 'text-warning' : 'text-content-subtle'}`,
      text:
        `${stat.runs} turn${stat.runs === 1 ? '' : 's'} · ${average}ms average · ` +
        `slowest ${stat.slowestMs}ms` +
        (trouble > 0 ? ` · ${trouble} gave up` : '') +
        (pluginRegistry.worker.isTripped(key) ? ' · not being asked any more' : ''),
    })
  }

  /** The permissions a wildcard role would gain — the reason to ask first. */
  function impactText(roles: PluginImpactRole[]): string {
    if (roles.length === 0) {
      return 'No role gains these permissions automatically; grants stay as they are.'
    }
    return roles
      .map((role) => `${role.roleName} (${role.wildcard}) gains ${role.permissions.join(', ')}`)
      .join('\n')
  }

  /**
   * Switching a plugin on is a decision with three consequences, and the
   * dialog states all three before anything happens: what it will cost, what
   * permissions it hands out, and what it will do to the database.
   *
   * The money is first because it is the one the shopkeeper cannot undo by
   * switching the plugin off again.
   */
  async function switchOn(entry: PluginCatalogEntry): Promise<void> {
    const manifest = manifestOf(entry.key)
    const pricing = manifest?.pricing
    const licence = licenceOf(entry)

    try {
      if (!licence.entitled && pricing) {
        const started = await offerSubscription(entry, licence)
        if (!started) return
      }

      const impact = await repos.plugins.impact(organizationId, entry.key)
      const willEnable = dependenciesOf(entry.key)
      const paidDependencies = willEnable
        .map((key) => entries.find((other) => other.key === key))
        .filter((other): other is PluginCatalogEntry => !!other)
        .filter((other) => (manifestOf(other.key)?.pricing?.priceBdt ?? 0) > 0)

      const ok = await confirm(`Switch on ${entry.name}?`, {
        message:
          `${licenceOf(entry).summary}\n\n` +
          `It adds ${entry.permissions.length} permission(s).\n\n` +
          impactText(impact) +
          (entry.migrationsPending > 0
            ? `\n\n${entry.migrationsPending} migration(s) will be applied to this shop's database. ` +
              'Applying a migration cannot be undone by switching the plugin off.'
            : '') +
          (willEnable.length > 0 ? `\n\nAlso switched on: ${willEnable.join(', ')}.` : '') +
          (paidDependencies.length > 0
            ? `\n\nThose are charged separately: ` +
              paidDependencies
                .map((other) => `${other.name} ${priceLabel(manifestOf(other.key)?.pricing)}`)
                .join(', ') +
              '.'
            : ''),
        confirmLabel: 'Switch on',
        iconName: 'extension',
      })
      if (!ok) return

      const result = await repos.plugins.enable(organizationId, entry.key, entry.version)

      // A licence recorded before the shop had a `plugins` row could not be
      // written then. The row exists now — write it before `syncPlugins()`
      // replaces this tab's memory with the server's copy, or the trial
      // would evaporate at the next sign-in.
      const pending = pluginConfig(entry.key)
      if (LICENCE_KEY in pending) {
        try {
          const saved = await repos.plugins.setConfig(organizationId, entry.key, pending)
          rememberConfig(entry.key, saved.config)
        } catch {
          // Offline or refused: the licence still holds for this session,
          // and the next subscribe attempt writes it again.
        }
      }

      await syncPlugins()
      toastSuccess(
        result.migrationsApplied > 0
          ? `${entry.name} is on — ${result.migrationsApplied} migration(s) applied.`
          : `${entry.name} is on.`
      )
      await load()
    } catch (error) {
      toastError(translateError(error).message)
      await load()
    }
  }

  /**
   * The paywall, such as it is.
   *
   * There is no payment gateway in this build, and pretending otherwise would
   * be worse than saying so: the dialog is explicit that subscribing records
   * an entitlement against the shop and that billing is settled separately.
   * The licence itself is written into the plugin's own config, so it reaches
   * every device the shop signs in on.
   */
  async function offerSubscription(entry: PluginCatalogEntry, licence: Licence): Promise<boolean> {
    const pricing = manifestOf(entry.key)?.pricing
    if (!pricing) return true
    const trialDays = pricing.trialDays ?? 14
    const canTrial = licence.status === 'unlicensed'

    const ok = await confirm(`${entry.name} is a paid plugin`, {
      message:
        `${priceLabel(pricing)}, per shop.\n\n` +
        (canTrial
          ? `Start a ${trialDays}-day free trial now — it switches itself off when the trial ends, ` +
            'and nothing is charged until you subscribe.'
          : `${licence.summary}\n\nSubscribing renews the entitlement for 30 days.`) +
        '\n\nBilling is arranged with your supplier; this records the entitlement for this shop.',
      confirmLabel: canTrial ? `Start ${trialDays}-day trial` : 'Subscribe',
      iconName: 'workspace_premium',
    })
    if (!ok) return false

    const config = {
      ...pluginConfig(entry.key),
      [LICENCE_KEY]: canTrial ? startTrial(pricing) : startSubscription(),
    }
    if (entry.installed) {
      try {
        const saved = await repos.plugins.setConfig(organizationId, entry.key, config)
        rememberConfig(entry.key, saved.config)
        return true
      } catch {
        // Fall through: remembered below, re-written after switch-on.
      }
    }
    // No `plugins` row exists until `plugin_enable` runs, and writing config
    // before then is a guaranteed `plugin_not_installed` (a 400 in the
    // network tab). So the entitlement is remembered for this session, and
    // `switchOn` writes it for real the moment the row exists.
    rememberConfig(entry.key, config)
    return true
  }

  async function switchOff(entry: PluginCatalogEntry): Promise<void> {
    const dependents = entries
      .filter((other) => other.enabled && other.dependencies.includes(entry.key))
      .map((other) => other.name)

    if (dependents.length > 0) {
      toastError(`${entry.name} is needed by ${dependents.join(', ')}. Switch those off first.`)
      return
    }

    const ok = await confirm(`Switch off ${entry.name}?`, {
      message:
        'Its screens and panels disappear from the shop straight away. Its tables, data and permissions are kept, ' +
        'so switching it back on restores everything.',
      confirmLabel: 'Switch off',
      tone: 'danger',
      iconName: 'toggle_off',
    })
    if (!ok) return

    try {
      await repos.plugins.disable(organizationId, entry.key)
      await syncPlugins()
      toastSuccess(`${entry.name} is off. Its data is still here.`)
      await load()
    } catch (error) {
      toastError(translateError(error).message)
    }
  }

  async function retry(entry: PluginCatalogEntry): Promise<void> {
    try {
      // Re-applying is idempotent: migrations already recorded are skipped, and
      // the plugin is switched on again — which is what "try again" means.
      await repos.plugins.enable(organizationId, entry.key, entry.version)
      await syncPlugins()
      toastSuccess(`${entry.name} reloaded.`)
      await load()
    } catch (error) {
      toastError(translateError(error).message)
    }
  }

  /** Names of plugins that must be on for this one to work. */
  function dependenciesOf(key: string, seen = new Set<string>()): string[] {
    if (seen.has(key)) return []
    seen.add(key)
    const entry = entries.find((other) => other.key === key)
    if (!entry) return []
    return entry.dependencies.flatMap((dependency) => [
      ...(entries.find((other) => other.key === dependency)?.enabled ? [] : [dependency]),
      ...dependenciesOf(dependency, seen),
    ])
  }

  /**
   * The settings form is built from the plugin's own schema (spec §36): a
   * plugin declares the fields, the core draws them, and an unknown key is
   * dropped rather than written into `plugins.config`.
   */
  function openSettings(entry: PluginCatalogEntry): void {
    const schema = pluginRegistry.get(entry.key)?.manifest.settingsSchema ?? []
    const current = pluginConfig(entry.key)
    const dialog = modal({
      title: `${entry.name} settings`,
      ...(schema.length > 0 ? { subtitle: 'Stored with the shop, shared by every device.' } : {}),
      iconName: 'tune',
      size: 'sm',
    })

    if (schema.length === 0) {
      mount(
        dialog.body,
        h('p', {
          class: 'text-sm text-content-muted',
          text: 'This plugin has no settings yet. Anything it needs it works out on its own.',
        }),
        h('div', { class: 'mt-4 flex justify-end' }, button('Close', { onClick: () => dialog.close() }))
      )
      return
    }

    const draft: Record<string, unknown> = { ...current }
    const controls: HTMLElement[] = []

    for (const setting of schema) {
      const value = current[setting.key] ?? setting.default
      if (setting.type === 'boolean') {
        controls.push(
          h(
            'div',
            { class: 'py-1' },
            checkbox({
              label: setting.label,
              checked: value === true,
              onChange: (checked) => {
                draft[setting.key] = checked
              },
            }),
            setting.helpText ? h('p', { class: 'mt-1 text-xs text-content-subtle', text: setting.helpText }) : null
          )
        )
        continue
      }

      if (setting.type === 'select') {
        const control = select({
          value: value === undefined || value === null ? '' : String(value),
          options: (setting.options ?? []).map((option) => ({ value: option.value, label: option.label })),
          ...(setting.placeholder ? { placeholder: setting.placeholder } : {}),
          onChange: (next) => {
            draft[setting.key] = next
          },
        })
        controls.push(
          field(setting.label, control, {
            ...(setting.helpText ? { hint: setting.helpText } : {}),
          })
        )
        continue
      }

      const isNumber = setting.type === 'number'
      const control = input({
        type: isNumber ? 'number' : 'text',
        value: value === undefined || value === null ? '' : String(value),
        ...(setting.placeholder ? { placeholder: setting.placeholder } : {}),
        ...(isNumber && setting.min !== undefined ? { min: setting.min } : {}),
        ...(isNumber && setting.max !== undefined ? { max: setting.max } : {}),
        ...(isNumber ? { step: setting.step ?? 'any' } : {}),
        onInput: (next) => {
          draft[setting.key] = isNumber ? (next === '' ? null : Number(next)) : next
        },
      })
      controls.push(
        field(setting.label, control, {
          ...(setting.helpText ? { hint: setting.helpText } : {}),
        })
      )
    }

    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-3' },
        ...controls,
        h('div', { class: 'flex justify-end gap-2 pt-2' }, [
          button('Cancel', { onClick: () => dialog.close() }),
          button('Save', {
            variant: 'primary',
            icon: 'save',
            onClick: () => {
              void (async () => {
                try {
                  const saved = await repos.plugins.setConfig(organizationId, entry.key, draft)
                  rememberConfig(entry.key, saved.config)
                  // A settings change can change what the plugin draws, so the
                  // host is told to re-read rather than the page reloaded.
                  await syncPlugins()
                  toastSuccess(`${entry.name} settings saved.`)
                  dialog.close()
                  await load()
                } catch (error) {
                  toastError(translateError(error).message)
                }
              })()
            },
          }),
        ])
      )
    )
  }

  renderHeader()
  void load()

  return root
}
