/**
 * The string catalogue.
 *
 * English is the source. A Bangla entry that is missing falls back to English
 * rather than showing a key — a half-translated screen is usable, a screen of
 * `nav.dashboard` is not.
 *
 * Bengali is a first-class locale in this product (docs/01): most shops using
 * Mekholi will read Bangla before they read English. Translations here are
 * shop-floor Bangla — the words a shopkeeper says — not literal dictionary
 * renderings. "Stock" stays স্টক because that is what is said at a counter;
 * "মজুদ" is correct and nobody uses it.
 */

export const LOCALES = ['en', 'bn'] as const
export type Locale = (typeof LOCALES)[number]

export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  bn: 'বাংলা',
}

/** BCP-47 tags, for Intl number, currency and date formatting. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-BD',
  bn: 'bn-BD',
}

export type StringKey = keyof typeof en

/**
 * The *base* of a plural family: `common.itemCount`, given that
 * `common.itemCount.other` is in the catalogue. Derived rather than written
 * by hand, so `t('common.itemCount', { count })` type-checks only while the
 * family really exists — delete the `.other` member and every call site
 * turns red.
 */
export type PluralKey = StringKey extends infer Key
  ? Key extends `${infer Base}.other`
    ? Base
    : never
  : never

export const en = {
  // ── Plural families ────────────────────────────────────────────────────
  //
  // A key ending in a CLDR category (`.one`, `.other`) is not looked up
  // directly: `t('common.itemCount', { count })` picks the member through
  // `Intl.PluralRules`. Bangla needs one form where English needs two, which
  // is exactly why the choice is not `count === 1` in the view.
  'common.itemCount.one': '{count} item',
  'common.itemCount.other': '{count} items',
  'common.productCount.one': '{count} product',
  'common.productCount.other': '{count} products',
  'common.saleCount.one': '{count} sale',
  'common.saleCount.other': '{count} sales',
  'common.dayCount.one': '{count} day',
  'common.dayCount.other': '{count} days',
  'common.lowStockCount.one': '{count} item is running low',
  'common.lowStockCount.other': '{count} items are running low',

  // ── Navigation ─────────────────────────────────────────────────────────
  'nav.dashboard': 'Dashboard',
  'nav.pos': 'Point of Sale',
  'nav.sales': 'Sales',
  'nav.customers': 'Customers',
  'nav.products': 'Products',
  'nav.catalogue': 'Catalogue',
  'nav.stock': 'Stock',
  'nav.suppliers': 'Suppliers',
  'nav.purchases': 'Purchases',
  'nav.expenses': 'Expenses',
  'nav.reports': 'Reports',
  'nav.analytics': 'Analytics',
  'nav.register': 'Register',
  'nav.users': 'Staff',
  'nav.roles': 'Roles',
  'nav.plugins': 'Plugins',
  'nav.audit': 'Audit trail',
  'nav.settings': 'Settings',

  'nav.section.main': 'Overview',
  'nav.section.selling': 'Selling',
  'nav.section.inventory': 'Inventory',
  'nav.section.insights': 'Insights',
  'nav.section.admin': 'Administration',

  // ── Shell ──────────────────────────────────────────────────────────────
  'shell.search': 'Search…',
  'shell.signOut': 'Sign out',
  'shell.mainNavigation': 'Main navigation',
  'shell.sidebar': 'Sidebar',
  'shell.noFeatures': 'No features available for your role.',
  'shell.menu': 'Menu',
  'shell.reload': 'Reload this page',
  'shell.switchShop': 'Switch shop',

  // ── Common ─────────────────────────────────────────────────────────────
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.edit': 'Edit',
  'common.add': 'Add',
  'common.remove': 'Remove',
  'common.active': 'Active',
  'common.off': 'Off',
  'common.readOnly': 'Read only',
  'common.loading': 'Loading…',
  'common.required': 'Required',
  'common.chooseImage': 'Choose image',
  'common.uploading': 'Uploading…',

  // ── Settings ───────────────────────────────────────────────────────────
  'settings.title': 'Settings',
  'settings.subtitle': 'Shop details, taxes, receipts and device preferences.',
  'settings.loadFailed': 'Settings could not be loaded',
  'settings.partialFailure': 'Some settings could not be loaded: {message}',

  'settings.shopDetails': 'Shop details',
  'settings.shopName': 'Shop name',
  'settings.currency': 'Currency',
  'settings.currencyHint':
    'The currency the books are kept in. To read amounts converted into another currency, enable the Multi-Currency plugin.',
  'settings.timezone': 'Timezone',
  'settings.language': 'Language',
  'settings.languageHint': 'Changes the app language straight away, for everyone in this shop.',
  'settings.shopLogo': 'Shop logo',
  'settings.shopLogoHint': 'Shown on receipts when the option below is on. Hosted on ImgBB; only the link is stored.',
  'settings.shopLogoDisabled': 'Add an ImgBB key under Image uploads below to upload a logo.',
  'settings.save': 'Save settings',
  'settings.saved': 'Settings saved',

  'settings.imageUploads': 'Image uploads',
  'settings.imgbbIntro':
    'Product photos and your shop logo are hosted on ImgBB. Add a free key here and uploads switch on for every device in this shop — no reinstall, no developer.',
  'settings.imgbbKey': 'ImgBB API key',
  'settings.imgbbKeyHint':
    'Free from api.imgbb.com. It is an upload-only public key: it cannot read your account, delete your images or be billed.',
  'settings.imgbbTest': 'Test key',
  'settings.imgbbOnShop': 'Uploads are on, using this shop’s key.',
  'settings.imgbbOnBuild': 'Uploads are on, using the key this installation shipped with.',
  'settings.imgbbOff': 'Uploads are off. Add a key to enable product photos and the shop logo.',
  'settings.imgbbSaved': 'Key saved. Photos work on this device now, and on the others when they next open the app.',

  'settings.receiptDevice': 'Receipt and device',
  'settings.receiptFooter': 'Receipt footer',
  'settings.receiptFooterHint': 'Printed below the payment summary.',
  'settings.receiptFooterPlaceholder': 'Thank you for shopping with us.',
  'settings.deviceName': 'Device name',
  'settings.deviceNameHint': 'Helps identify this counter in audit entries.',
  'settings.deviceNamePlaceholder': 'Front counter',
  'settings.showLogo': 'Show the shop logo on receipts',
  'settings.autoPrint': 'Print receipts automatically after a sale',

  'settings.appearance': 'Appearance',
  'settings.theme': 'Theme',
  'settings.themeHint': 'Applies to this device only.',
  'theme.system': 'Match device',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.toggleToDark': 'Switch to dark theme',
  'theme.toggleToLight': 'Switch to light theme',

  'settings.timezoneHint': 'Decides which day a sale is counted in.',
  'settings.taxes': 'Taxes',
  'settings.noTaxes': 'No tax rules',
  'settings.noTaxesHint': 'Products will be tax-free until you add a rule.',
  'settings.addTax': 'Add tax rule',
  'settings.editTax': 'Edit tax rule',
  'settings.saveTax': 'Save tax rule',
  'settings.taxAdded': 'Tax rule added',
  'settings.taxUpdated': 'Tax rule updated',
  'settings.taxName': 'Name',
  'settings.taxRate': 'Rate (%)',
  'settings.taxInclusive': 'Price already includes this tax',
  'settings.taxActive': 'Use this tax for new sales',
  'settings.taxInvalid': 'Enter a name and a rate between 0 and 100.',
  'settings.taxIncluded': 'tax included',
  'settings.taxAdded_checkout': 'added at checkout',

  'settings.paymentMethods': 'Payment methods',
  'settings.noPaymentMethods': 'No payment methods',
  'settings.noPaymentMethodsHint':
    'Add a method through provisioning or the database before taking payments.',
  'settings.cashDrawer': 'cash drawer',
} as const

export const bn: Partial<Record<StringKey, string>> = {
  // Bangla has a single plural form: the number carries the plurality, and
  // "৩টি পণ্যগুলি" is what a machine writes, not a shopkeeper.
  'common.itemCount.one': '{count}টি পণ্য',
  'common.itemCount.other': '{count}টি পণ্য',
  'common.productCount.one': '{count}টি পণ্য',
  'common.productCount.other': '{count}টি পণ্য',
  'common.saleCount.one': '{count}টি বিক্রয়',
  'common.saleCount.other': '{count}টি বিক্রয়',
  'common.dayCount.one': '{count} দিন',
  'common.dayCount.other': '{count} দিন',
  'common.lowStockCount.one': '{count}টি পণ্যের স্টক কমে গেছে',
  'common.lowStockCount.other': '{count}টি পণ্যের স্টক কমে গেছে',

  // ── Navigation ─────────────────────────────────────────────────────────
  'nav.dashboard': 'ড্যাশবোর্ড',
  'nav.pos': 'পয়েন্ট অব সেল',
  'nav.sales': 'বিক্রয়',
  'nav.customers': 'কাস্টমার',
  'nav.products': 'পণ্য',
  'nav.catalogue': 'ক্যাটালগ',
  'nav.stock': 'স্টক',
  'nav.suppliers': 'সরবরাহকারী',
  'nav.purchases': 'ক্রয়',
  'nav.expenses': 'খরচ',
  'nav.reports': 'রিপোর্ট',
  'nav.analytics': 'এনালাইসিস',
  'nav.register': 'ক্যাশ রেজিস্টার',
  'nav.users': 'কর্মী',
  'nav.roles': 'ভূমিকা',
  'nav.plugins': 'প্লাগইন',
  'nav.audit': 'কার্যবিবরণী',
  'nav.settings': 'সেটিংস',

  'nav.section.main': 'সারসংক্ষেপ',
  'nav.section.selling': 'বিক্রয়',
  'nav.section.inventory': 'ইনভেন্টরি',
  'nav.section.insights': 'পর্যালোচনা',
  'nav.section.admin': 'ব্যবস্থাপনা',

  // ── Shell ──────────────────────────────────────────────────────────────
  'shell.search': 'খুঁজুন…',
  'shell.signOut': 'সাইন আউট',
  'shell.mainNavigation': 'প্রধান মেনু',
  'shell.sidebar': 'সাইডবার',
  'shell.noFeatures': 'আপনার ভূমিকার জন্য কোনো সুবিধা নেই।',
  'shell.menu': 'মেনু',
  'shell.reload': 'পাতাটি আবার লোড করুন',
  'shell.switchShop': 'দোকান বদলান',

  // ── Common ─────────────────────────────────────────────────────────────
  'common.save': 'সংরক্ষণ',
  'common.cancel': 'বাতিল',
  'common.edit': 'সম্পাদনা',
  'common.add': 'যোগ করুন',
  'common.remove': 'সরান',
  'common.active': 'চালু',
  'common.off': 'বন্ধ',
  'common.readOnly': 'শুধু দেখা যাবে',
  'common.loading': 'লোড হচ্ছে…',
  'common.required': 'আবশ্যক',
  'common.chooseImage': 'ছবি বাছুন',
  'common.uploading': 'আপলোড হচ্ছে…',

  // ── Settings ───────────────────────────────────────────────────────────
  'settings.title': 'সেটিংস',
  'settings.subtitle': 'দোকানের তথ্য, কর, রসিদ ও ডিভাইসের পছন্দ।',
  'settings.loadFailed': 'সেটিংস লোড করা যায়নি',
  'settings.partialFailure': 'কিছু সেটিংস লোড করা যায়নি: {message}',

  'settings.shopDetails': 'দোকানের তথ্য',
  'settings.shopName': 'দোকানের নাম',
  'settings.currency': 'মুদ্রা',
  'settings.currencyHint':
    'হিসাব যে মুদ্রায় রাখা হয়। অন্য মুদ্রায় রূপান্তর করে দেখতে মাল্টি-কারেন্সি প্লাগইন চালু করুন।',
  'settings.timezone': 'সময় অঞ্চল',
  'settings.language': 'ভাষা',
  'settings.languageHint': 'অ্যাপের ভাষা সঙ্গে সঙ্গে বদলে যাবে, এই দোকানের সবার জন্য।',
  'settings.shopLogo': 'দোকানের লোগো',
  'settings.shopLogoHint': 'নিচের অপশনটি চালু থাকলে রসিদে ছাপা হবে। ছবি ImgBB-তে থাকে, শুধু লিঙ্কটি সংরক্ষিত হয়।',
  'settings.shopLogoDisabled': 'লোগো আপলোড করতে নিচের “ছবি আপলোড” অংশে ImgBB কী দিন।',
  'settings.save': 'সেটিংস সংরক্ষণ করুন',
  'settings.saved': 'সেটিংস সংরক্ষিত হয়েছে',

  'settings.imageUploads': 'ছবি আপলোড',
  'settings.imgbbIntro':
    'পণ্যের ছবি আর দোকানের লোগো ImgBB-তে রাখা হয়। এখানে একটি ফ্রি কী দিলেই এই দোকানের সব ডিভাইসে আপলোড চালু হয়ে যাবে — নতুন করে ইনস্টল বা ডেভেলপার লাগবে না।',
  'settings.imgbbKey': 'ImgBB API কী',
  'settings.imgbbKeyHint':
    'api.imgbb.com থেকে ফ্রি নিন। এটি শুধু আপলোডের পাবলিক কী — এটি দিয়ে আপনার অ্যাকাউন্ট দেখা, ছবি মোছা বা বিল করা যায় না।',
  'settings.imgbbTest': 'কী পরীক্ষা করুন',
  'settings.imgbbOnShop': 'আপলোড চালু আছে, এই দোকানের কী দিয়ে।',
  'settings.imgbbOnBuild': 'আপলোড চালু আছে, ইনস্টলেশনের সঙ্গে আসা কী দিয়ে।',
  'settings.imgbbOff': 'আপলোড বন্ধ আছে। পণ্যের ছবি ও দোকানের লোগোর জন্য একটি কী দিন।',
  'settings.imgbbSaved': 'কী সংরক্ষিত হয়েছে। এই ডিভাইসে এখনই ছবি কাজ করবে, বাকিগুলোতে পরের বার অ্যাপ খুললেই।',

  'settings.receiptDevice': 'রসিদ ও ডিভাইস',
  'settings.receiptFooter': 'রসিদের নিচের লেখা',
  'settings.receiptFooterHint': 'পেমেন্টের হিসাবের নিচে ছাপা হয়।',
  'settings.receiptFooterPlaceholder': 'আমাদের কাছ থেকে কেনার জন্য ধন্যবাদ।',
  'settings.deviceName': 'ডিভাইসের নাম',
  'settings.deviceNameHint': 'কার্যবিবরণীতে এই কাউন্টার চিনতে সাহায্য করে।',
  'settings.deviceNamePlaceholder': 'সামনের কাউন্টার',
  'settings.showLogo': 'রসিদে দোকানের লোগো দেখান',
  'settings.autoPrint': 'বিক্রয়ের পর রসিদ নিজে থেকেই প্রিন্ট করুন',

  'settings.appearance': 'চেহারা',
  'settings.theme': 'থিম',
  'settings.themeHint': 'শুধু এই ডিভাইসে প্রযোজ্য।',
  'theme.system': 'ডিভাইস অনুযায়ী',
  'theme.light': 'উজ্জ্বল',
  'theme.dark': 'অন্ধকার',
  'theme.toggleToDark': 'অন্ধকার থিমে যান',
  'theme.toggleToLight': 'উজ্জ্বল থিমে যান',

  'settings.timezoneHint': 'কোন দিনের বিক্রয় হিসেবে গণনা হবে তা ঠিক করে।',
  'settings.taxes': 'কর',
  'settings.noTaxes': 'কোনো কর নিয়ম নেই',
  'settings.noTaxesHint': 'নিয়ম যোগ না করা পর্যন্ত পণ্যে কোনো কর বসবে না।',
  'settings.addTax': 'কর নিয়ম যোগ করুন',
  'settings.editTax': 'কর নিয়ম সম্পাদনা',
  'settings.saveTax': 'কর নিয়ম সংরক্ষণ করুন',
  'settings.taxAdded': 'কর নিয়ম যোগ হয়েছে',
  'settings.taxUpdated': 'কর নিয়ম হালনাগাদ হয়েছে',
  'settings.taxName': 'নাম',
  'settings.taxRate': 'হার (%)',
  'settings.taxInclusive': 'দামের মধ্যেই এই কর ধরা আছে',
  'settings.taxActive': 'নতুন বিক্রয়ে এই কর ব্যবহার করুন',
  'settings.taxInvalid': 'একটি নাম দিন এবং ০ থেকে ১০০-এর মধ্যে হার দিন।',
  'settings.taxIncluded': 'কর সহ',
  'settings.taxAdded_checkout': 'বিক্রয়ের সময় যোগ হবে',

  'settings.paymentMethods': 'পেমেন্ট পদ্ধতি',
  'settings.noPaymentMethods': 'কোনো পেমেন্ট পদ্ধতি নেই',
  'settings.noPaymentMethodsHint': 'পেমেন্ট নেওয়ার আগে ডেটাবেস বা প্রভিশনিং থেকে একটি পদ্ধতি যোগ করুন।',
  'settings.cashDrawer': 'ক্যাশ ড্রয়ার',
}

export const DICTIONARIES: Record<Locale, Partial<Record<StringKey, string>>> = { en, bn }
