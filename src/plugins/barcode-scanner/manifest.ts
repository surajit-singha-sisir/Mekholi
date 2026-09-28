/**
 * Barcode Scanner — manifest.
 *
 * Pure data, no imports from the core and no side effects, so the Plugins
 * screen can list it without loading a line of its behaviour (docs/05 §1).
 *
 * ── Why the setup screen is a plugin and the scanning is not ─────────────
 * The till has always listened for scans: a wedge scanner is a keyboard, and
 * `shared/devices/scanner.ts` recognises the burst by its speed with no
 * configuration at all. That must keep working with every plugin switched
 * off, because for most shops it is simply how the POS is used.
 *
 * What this plugin adds is the screen for the shops where the default is
 * wrong — a Bluetooth scanner slower than the threshold, a model that sends
 * a prefix character, a serial unit — plus the live test that tells a
 * shopkeeper whether the thing in their hand is being read as a scan or as
 * typing. That is a diagnosis tool, not part of the sale, so it is optional.
 *
 * Free: configuring hardware you already own is not a feature to sell.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'
import details from './DETAILS.md?raw'

export const barcodeScannerManifest: PluginManifest = {
  id: 'barcode-scanner',
  name: 'Barcode Scanner',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  category: 'optional',
  pricing: {
    plan: 'free',
    priceBdt: 0,
  },
  icon: 'barcode_scanner',
  description:
    'Tune how this device reads a barcode scanner — speed threshold, prefix, beep — and test it live.',
  // Scanner settings belong to the device doing the scanning, so nothing of
  // the shop's is stored on the server.
  dataOwnership: 'transient',
  permissions: [],
  settingsSchema: [],
}
