# 15 — Image uploads (ImgBB)

Mekholi stores no image bytes of its own. A product photo or a shop logo goes
to [ImgBB](https://imgbb.com) straight from the browser, and only the returned
URL is written to Postgres.

## Why an external host

| Option | Why not |
|---|---|
| Supabase Storage | Quota'd on the free tier, and every read then costs the project's bandwidth — a shop browsing its own catalogue would spend it. |
| Bytes in Postgres | `bytea` in a row that POS queries read on every product list. The worst place to put a megabyte. |
| ImgBB | Free, CDN-backed, one POST, no server of ours in the path. The URL is the only thing we own, and it is the only thing a receipt or a product grid needs. |

The trade is stated plainly: images live somewhere we do not control, and a
deleted ImgBB image becomes a broken link. Nothing operational depends on the
picture — a sale, a stock movement and a receipt total are all unaffected.

## Where the key comes from

Three sources, in order. The first one with a value wins.

| # | Source | Set by | Reaches |
|---|---|---|---|
| 1 | `organizations.settings.imgbbApiKey` | The owner, in **Settings → Image uploads** | Every device in that shop, on its next load |
| 2 | `localStorage['mekholi.imgbb.key']` | Mirrored automatically from (1) | This device, on the very first paint |
| 3 | `VITE_IMGBB_API_KEY` | Whoever built the bundle | Every shop in that deployment |

Get a key at <https://api.imgbb.com>.

### Why it is not just the env var

It was, and that is why image uploads were switched off everywhere in
practice. A `VITE_` value is fixed at build time, so a shop that wanted
product photos needed someone to edit `.env`, rebuild and redeploy. Until
that happened every picker in the app rendered disabled and told the
shopkeeper to *"set VITE_IMGBB_API_KEY"* — an instruction no shopkeeper can
act on. A feature nobody can switch on is a feature that is not there.

So the key is now a shop setting. Paste it, press **Test key**, save, and
photos work on that device immediately and on the shop's other tills the
next time they open the app. No rebuild, no deploy, no developer.

The env var is still honoured as source (3): a self-hosted deployment that
would rather ship one key for all of its shops can keep doing exactly that.

### Clearing it falls back, it does not go dark

Emptying the shop's key returns the app to the build default rather than
switching uploads off — a deployment that shipped a key should keep working
when a shop clears its own.

The bag is authoritative when it loads. A shop with no key *clears* the
device mirror, which is what stops one shop's key following the next shop
signed in on the same till.

### The key is public, and that is by design

An ImgBB key is a **public** upload key. Every `VITE_`-prefixed value is
compiled into the bundle and readable by anyone (spec §44), and ImgBB issues
these keys precisely for browser uploads: the key can upload, and nothing
else. It cannot read an account, delete other images, or bill anything.

That is what makes storing it in a settings row the shop's own staff can read
an acceptable trade — it gives away nothing the bundle did not already hand to
anyone who opened devtools.

With no key from any source, uploads switch off cleanly: the picker renders
disabled with a sentence pointing at the screen that fixes it, and every other
part of the product form still works. No screen crashes for want of a key.

```bash
# .env — optional, a default for every shop in this deployment
VITE_IMGBB_API_KEY=your_public_imgbb_key
```

## Testing a key before trusting it

ImgBB publishes no "is this key valid?" endpoint — upload is the whole API. So
**Test key** does the only honest thing and uploads: a 1×1 transparent PNG, 68
bytes, with `expiration=60` so it deletes itself a minute later.

It is never retried. A key test that quietly attempts twice turns a flaky
answer into a confident one, and the entire point of the button is to tell the
truth about a key before a shop trusts a catalogue to it.

## Shape of the code

```
src/shared/images/imgbb.ts         pure client — validation, transport, parsing, key probe
src/app/images.ts                  resolves the key from all three sources; the app's one uploader
src/components/ui/image-upload.ts  the picker widget (business-ignorant)
src/features/settings/settings-view.ts   the Image uploads card
```

Three layers, three reasons:

- **`shared/images/imgbb.ts`** knows ImgBB's wire format and nothing about this
  app. It takes its key as an argument and its transport as an option, which is
  why it can be tested in Node with no network and no browser.
- **`src/app/images.ts`** is the only place the key is resolved. A feature
  calls `uploadImage()`; no feature constructs a client and no feature reads
  the key. `adoptImageUploadKey()` is called wherever the shop profile is
  already being fetched — the app shell on boot and the settings screen on
  load — so the key costs no extra round trip.
- **`imagePicker()`** is a UI-kit control, so it may not import the app layer
  (docs/03 §3). The uploader arrives as a function. Swapping ImgBB for anything
  else touches `src/app/images.ts` and nothing else.

## Rules the client enforces

| Rule | Reason |
|---|---|
| PNG, JPG, WEBP, GIF, BMP only | What ImgBB accepts, checked before sending. |
| 10 MB ceiling (ImgBB allows 32) | A 30 MB photo on a shop's phone tether is a five-minute upload nobody waits through. |
| Validation happens on the device | A refusal that costs zero bytes. |
| Retry **once**, and only on a transport error | A dropped packet is worth repeating. A rejected key is not — the answer will not change. |
| Upload on `commit()`, not on file choice | A form abandoned half-filled spends no data. The bytes leave only when the save is otherwise going to succeed. |
| `AbortSignal` honoured | Closing the dialog stops the upload. |
| Progress over XMLHttpRequest | `fetch` still cannot report bytes sent; a frozen dialog on a slow line reads as a crash. |

## What is stored

Only `data.url` — a direct CDN link. The client also returns `thumbUrl`,
`displayUrl`, `deleteUrl` and the dimensions, so a future screen can show a
grid thumbnail or offer an undo without a second upload. `products.image_url`
and `organizations.logo_url` hold plain text URLs; nothing else changes in the
schema.

## Where it appears

| Screen | Field |
|---|---|
| Products → full form | Product image |
| Products → quick add | Product photo |
| Products → list | Inline photo, straight onto a row |
| Settings → Shop details | Shop logo (printed on receipts when "Show the shop logo" is on) |
| Settings → Image uploads | The key itself, with a **Test key** button |

Both use the same picker: click, drag-and-drop, or a phone camera through the
native file dialog.

## Tests

`src/shared/images/imgbb.test.ts` covers validation, URL building, expiry
clamping, response parsing (including a 200 carrying no URL), the retry policy,
abort, and the key probe — that it is one request, expires, and never retries.

`src/app/images.test.ts` covers the precedence that makes the feature reachable:
the shop key beats the build default, clearing it falls back instead of going
dark, the key is mirrored to the device so the first paint is not disabled, and
one shop's key does not follow the next shop onto the same till.

`src/components/ui/image-upload.test.ts` covers the picker's promise: nothing
uploads before `commit()`, a rejected file never reaches the network, and a
failed upload keeps the file pending so a retry needs no second file dialog.

`src/features/settings/settings-view.test.ts` covers the card: the key field
exists, the status line reflects the key *in force* rather than the text in the
box, **Test key** probes without saving, saving trims and persists, and no
screen ever tells a shopkeeper to set an environment variable.
