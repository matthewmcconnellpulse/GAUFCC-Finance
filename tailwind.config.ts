import type { Config } from 'tailwindcss'

/**
 * GAUFCC Finance design tokens — extends the Pulse palette, softened for
 * trustees. Source of truth: docs/DESIGN.md and the Claude Design mockup
 * in docs/design/.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Core brand
        indigo: {
          DEFAULT: '#211951', // anchor · sidebars · ink
          deep: '#15103a',
          soft: '#2d216d',
        },
        ink: '#0d0a26',
        mint: {
          DEFAULT: '#08f2c7', // primary action · live / money moments only
          700: '#04b894',
          900: '#036c57',
        },
        cyan: {
          DEFAULT: '#1de4ff', // data · links
          600: '#16b6ce',
          800: '#0e7c8c',
        },
        pink: {
          DEFAULT: '#ff80e3', // one hot data point
          600: '#f25cce',
        },
        // Warm neutrals ("paper" and "stone")
        paper: {
          DEFAULT: '#fbfaf7',
          2: '#f6f4ee',
          3: '#f3f1ea',
        },
        stone: {
          150: '#ebe9e3',
          200: '#e5e2da',
          300: '#d6d3c9',
          400: '#b3afa3',
          500: '#807c70',
          700: '#4a4740',
          900: '#2b2925',
        },
        // Status
        warn: {
          DEFAULT: '#f5a524',
          ink: '#8a5200',
          mid: '#b86e02',
        },
        danger: {
          DEFAULT: '#e5484d',
          ink: '#c03538',
        },
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Geist', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card: '12px',
        control: '8px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(13,10,38,.06)',
        panel: '0 8px 30px rgba(13,10,38,.12)',
      },
      keyframes: {
        syncPulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.35' },
        },
      },
      animation: {
        syncPulse: 'syncPulse 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
