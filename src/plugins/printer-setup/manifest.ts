/**
 * Printer Setup — manifest.
 *
 * Pure data, no imports from the core and no side effects, so the Plugins
 * screen can list it without loading a line of its behaviour (docs/05 §1).
 *
 * ── Why hardware setup is a plugin ───────────────────────────────────────
 * Most shops that run this software print nothing. They read the total off
 * the screen and the customer walks out; a thermal printer is a thing a
 * *particular* kind of counter has. Keeping the pairing screens, the ESC/POS
 * test page and the invoice designer in the core meant every shop carried
 * them in the bundle and met them in the settings menu whether or not a
 * printer existed.
 *
 * What stays in the core is the part a sale depends on: the receipt data, the
 * renderer, and the transports in `shared/devices`. A shop can always print
 * through the browser dialog with this plugin switched off. What the plugin
 * adds is the configuration — pairing, paper, and what the invoice says.
 *
 * Free, and it always will be: a shop should not have to pay to describe its
 * own printer.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'
import details from './DETAILS.md?raw'

export const printerSetupManifest: PluginManifest = {
  id: 'printer-setup',
  name: 'Printer Setup',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  category: 'optional',
  pricing: {
    plan: 'free',
    priceBdt: 0,
  },
  icon: 'print',
  description:
    'Pair a thermal printer over Bluetooth, USB or the network, and design what the printed invoice says.',
  // Nothing of the shop's is stored: printers and the invoice design live in
  // this device's own storage, because a Bluetooth handle means nothing on
  // another machine.
  dataOwnership: 'transient',
  permissions: [],
  settingsSchema: [],
}
