import type { Config } from 'tailwindcss'

/**
 * Semantic design tokens (§38).
 *
 * Colours are HSL triplets defined as CSS custom properties in
 * `src/styles/tokens.css`. Components reference the semantic name
 * (`bg-primary`, `text-danger`) and never a raw hex value, so re-theming
 * and dark mode are a variable swap rather than a find-and-replace.
 */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,html}'],
  theme: {
    // Full screen list (defaults + a small-phone `xs` at 420px), kept in
    // ascending order so Tailwind emits the `max-*` variants correctly. The
    // sticky header uses `max-xs:` to compact itself on the narrowest phones.
    screens: {
      xs: '420px',
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        primary: {
          DEFAULT: 'hsl(var(--color-primary) / <alpha-value>)',
          // The darker partner for hover and press. A real colour, not
          // `/90` translucency, which picked up whatever was behind it.
          strong: 'hsl(var(--color-primary-strong) / <alpha-value>)',
          soft: 'hsl(var(--color-primary-soft) / <alpha-value>)',
          foreground: 'hsl(var(--color-primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--color-secondary) / <alpha-value>)',
          strong: 'hsl(var(--color-secondary-strong) / <alpha-value>)',
          foreground: 'hsl(var(--color-secondary-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--color-success) / <alpha-value>)',
          // The darker partner for hover and press. A real colour, not
          // `/90` translucency, which picked up whatever was behind it.
          strong: 'hsl(var(--color-success-strong) / <alpha-value>)',
          soft: 'hsl(var(--color-success-soft) / <alpha-value>)',
          foreground: 'hsl(var(--color-success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--color-warning) / <alpha-value>)',
          // The darker partner for hover and press. A real colour, not
          // `/90` translucency, which picked up whatever was behind it.
          strong: 'hsl(var(--color-warning-strong) / <alpha-value>)',
          soft: 'hsl(var(--color-warning-soft) / <alpha-value>)',
          foreground: 'hsl(var(--color-warning-foreground) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'hsl(var(--color-danger) / <alpha-value>)',
          // The darker partner for hover and press. A real colour, not
          // `/90` translucency, which picked up whatever was behind it.
          strong: 'hsl(var(--color-danger-strong) / <alpha-value>)',
          soft: 'hsl(var(--color-danger-soft) / <alpha-value>)',
          foreground: 'hsl(var(--color-danger-foreground) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'hsl(var(--color-info) / <alpha-value>)',
          // The darker partner for hover and press. A real colour, not
          // `/90` translucency, which picked up whatever was behind it.
          strong: 'hsl(var(--color-info-strong) / <alpha-value>)',
          soft: 'hsl(var(--color-info-soft) / <alpha-value>)',
          foreground: 'hsl(var(--color-info-foreground) / <alpha-value>)',
        },
        surface: {
          DEFAULT: 'hsl(var(--color-surface) / <alpha-value>)',
          muted: 'hsl(var(--color-surface-muted) / <alpha-value>)',
          raised: 'hsl(var(--color-surface-raised) / <alpha-value>)',
        },
        border: 'hsl(var(--color-border) / <alpha-value>)',
        input: 'hsl(var(--color-input) / <alpha-value>)',
        ring: 'hsl(var(--color-ring) / <alpha-value>)',
        content: {
          DEFAULT: 'hsl(var(--color-content) / <alpha-value>)',
          muted: 'hsl(var(--color-content-muted) / <alpha-value>)',
          subtle: 'hsl(var(--color-content-subtle) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Hind Siliguri', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.375rem',
        md: '0.5rem',
        lg: '0.75rem',
        xl: '1rem',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'slide-up': 'slide-up 160ms ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config
