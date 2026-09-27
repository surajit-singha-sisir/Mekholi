# 18 — The Bangladesh VAT system (মূসক)

What Mekholi needs to know about VAT to serve a Bangladeshi shop honestly.
This document is the source the `bd-vat` plugin's in-app guide is condensed
from. It describes the law as the shopkeeper meets it, not as the statute
book orders it.

Primary law: **VAT and Supplementary Duty Act, 2012** (মূল্য সংযোজন কর ও
সম্পূরক শুল্ক আইন, ২০১২), in force since July 2019, administered by the
**National Board of Revenue (NBR)** through the VAT Online System (VOS).

---

## 1. The shape of the tax

VAT (মূসক — মূল্য সংযোজন কর) is a consumption tax collected in stages.
Every registered business charges VAT on its taxable sales (**output tax**),
deducts the VAT it paid on its own purchases (**input tax credit**), and
remits the difference to the NBR each month. The consumer bears the whole
tax; the businesses along the chain are unpaid collectors.

The input-credit chain is the reason paperwork matters so much: a buyer can
only deduct input VAT if they hold a proper **Mushak 6.3** tax invoice from
the seller, naming both BINs. No challan, no credit — which is why B2B
customers ask for "Mushak challan" by name.

## 2. Rates

| Rate | Applies to |
|---|---|
| **15% (standard)** | Most goods and services, and all taxable imports |
| **0% (zero-rated)** | Exports and deemed exports — input credit still refundable |
| **Truncated / reduced rates** | Sector-specific: commonly cited bands are 1.5% (land development), 2%–2.4% (hospital & cleaning services), 4.5% (legal/advisory), 5% (electricity, IT-enabled services, some foods), 7.5% (commercial rentals, workshops, non-AC restaurants), 10% (advertising, large rented shops) |
| **Exempt (First Schedule)** | Basic foodstuffs, most agriculture at farm stage, certain health and education — outside the VAT net entirely, no input credit |

Two things a POS must respect:

* **A truncated rate is a package deal.** A supplier charging a truncated
  rate generally cannot claim input credit on the related purchases. The
  rate on the invoice is the whole story.
* **Exempt ≠ zero-rated.** Both print ৳0 VAT, but a zero-rated seller keeps
  the input-credit chain and an exempt one does not.

## 3. Who must register — the three tiers

Thresholds were revised by the VAT amendment ordinance of January 2025;
NBR's older public FAQ still shows the previous figures. Both are given —
a shop should confirm its own band with its VAT circle.

| Annual taxable turnover | Since 2025 revision | Older FAQ figures | Obligation |
|---|---|---|---|
| Small | up to ৳50 lakh | up to ৳30 lakh | Outside the net (may register voluntarily) |
| Middle | ৳50 lakh – ৳3 crore | ৳30 – ৳80 lakh | **Enlistment** for Turnover Tax — ~4% (previously 3%) on gross turnover, no input credit, no VAT charged to customers, quarterly **Mushak 9.2** |
| Large | above ৳3 crore | above ৳80 lakh | **Full VAT registration** — a 9-digit **BIN**, 15%/applicable rate on sales, input credit, monthly **Mushak 9.1** |

Registration/enlistment must be taken within 15 days of the obligation
arising. Some activities require registration **regardless of turnover**
(importers, makers of certain scheduled goods, some services).

**The BIN (Business Identification Number)** is the VAT registration
number, issued through the VAT Online System. It goes on every tax
invoice, and a business without one must not issue a document that calls
itself a VAT invoice — which is why Mekholi's Mushak template wants the
BIN configured before the form means anything.

## 4. The Mushak form family (the ones a shop meets)

| Form | What it is |
|---|---|
| **Mushak 2.1 / 2.3** | Registration (BIN) / enlistment applications |
| **Mushak 6.1** | Purchase register — every purchase, kept current |
| **Mushak 6.2** | Sales register — every sale, kept current |
| **Mushak 6.3** | **The tax invoice (challan)** issued with each taxable sale — see docs/17 and the receipt design; seller name/address/BIN, serial number, date & time, buyer details (BIN for B2B), line items with quantity/unit price/value, VAT rate and amount, any SD, total |
| **Mushak 6.4** | Contractual production challan; **credit/debit note** family (6.7/6.8) adjusts issued invoices |
| **Mushak 6.6** | VAT deduction at source (VDS) certificate |
| **Mushak 9.1** | Monthly VAT return — due by the **15th of the following month** |
| **Mushak 9.2** | Quarterly turnover-tax return for enlisted businesses |

Records — invoices and registers — must be preserved for at least 5 years.

## 5. Supplementary Duty and other companions

* **Supplementary Duty (SD)**: an excise-like levy on "luxury" or
  discouraged goods/services (tobacco, carbonated drinks, telecom airtime,
  some imports). Charged *before* VAT: VAT applies on the SD-inclusive
  value. A general retail POS rarely computes SD itself; it mostly arrives
  baked into the purchase price.
* **VDS (VAT deducted at source)**: government bodies and large withholding
  entities deduct VAT when paying suppliers, issuing Mushak 6.6. They are
  discouraged from buying from unregistered suppliers at all.
* **Advance Tax (AT)** on imports, adjustable in the return.
* **EFD/SDC devices**: NBR has been rolling out Electronic Fiscal Devices
  for retail sectors; where mandated, the fiscal receipt comes from the
  EFD. Mekholi's Mushak template covers the ordinary software-invoice case.

## 6. Inclusive vs exclusive pricing — the retail reality

Bangladeshi shelf prices are almost always **VAT-inclusive**: the customer
pays the sticker. For a 15% inclusive price the VAT inside it is
`price × 15/115`. Mekholi's cart supports both modes per product
(`taxInclusive`), mirrors the Postgres rounding, and never adds tax on top
of an inclusive price (see migration 021). The Mushak template does not
change any amount — it *states* the VAT that the product configuration
already produced, because a tax invoice that invents charges would be
wrong in both directions.

## 7. What this means for Mekholi, concretely

1. **The Mushak 6.3 template** (shipped in `src/shared/receipt/`) turns the
   receipt into the prescribed tax invoice: form heading, BIN, VAT stated
   on every sale, even ৳0.00 — presentation, never arithmetic.
2. **Rates live on products.** 15%/truncated/0% are per-product settings;
   inclusive is the default retail expectation.
3. **The bd-vat plugin** owns the Bangladesh-specific surface: the in-app
   guide (this document, condensed and bilingual), the BIN, and the switch
   that makes the Mushak template the shop's invoice. A shop outside
   Bangladesh, or under the threshold, simply never enables it.
4. **Not registered → no Mushak.** Printing "VAT Invoice" with no BIN
   misrepresents the document. The plugin says so instead of pretending.

---

*Sources: NBR VAT FAQ (nbr.gov.bd); VAT & SD Act 2012; 2025–2026 practitioner
guides (bizmend.com, taxdo.com, vatcompliance.co) — thresholds cross-checked
across the January 2025 ordinance figures and NBR's published FAQ.*
