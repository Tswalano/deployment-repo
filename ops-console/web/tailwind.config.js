import colors from 'tailwindcss/colors';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces and text come from CSS variables (src/theme.css) so the same classes work in dark and light.
        ink: { 950: 'rgb(var(--ink-950) / <alpha-value>)', 900: 'rgb(var(--ink-900) / <alpha-value>)', 850: 'rgb(var(--ink-850) / <alpha-value>)', 800: 'rgb(var(--ink-800) / <alpha-value>)', 700: 'rgb(var(--ink-700) / <alpha-value>)', 600: 'rgb(var(--ink-600) / <alpha-value>)', 500: 'rgb(var(--ink-500) / <alpha-value>)' },
        slate: { ...colors.slate, 100: 'rgb(var(--slate-100) / <alpha-value>)', 200: 'rgb(var(--slate-200) / <alpha-value>)', 300: 'rgb(var(--slate-300) / <alpha-value>)', 400: 'rgb(var(--slate-400) / <alpha-value>)', 500: 'rgb(var(--slate-500) / <alpha-value>)', 600: 'rgb(var(--slate-600) / <alpha-value>)' },
        emerald: { ...colors.emerald, 100: 'rgb(var(--emerald-100) / <alpha-value>)', 200: 'rgb(var(--emerald-200) / <alpha-value>)', 300: 'rgb(var(--emerald-300) / <alpha-value>)', 400: 'rgb(var(--emerald-400) / <alpha-value>)' },
        rose: { ...colors.rose, 100: 'rgb(var(--rose-100) / <alpha-value>)', 200: 'rgb(var(--rose-200) / <alpha-value>)', 300: 'rgb(var(--rose-300) / <alpha-value>)', 400: 'rgb(var(--rose-400) / <alpha-value>)' },
        amber: { ...colors.amber, 100: 'rgb(var(--amber-100) / <alpha-value>)', 200: 'rgb(var(--amber-200) / <alpha-value>)', 300: 'rgb(var(--amber-300) / <alpha-value>)', 400: 'rgb(var(--amber-400) / <alpha-value>)' },
        indigo: { ...colors.indigo, 100: 'rgb(var(--indigo-100) / <alpha-value>)', 200: 'rgb(var(--indigo-200) / <alpha-value>)', 300: 'rgb(var(--indigo-300) / <alpha-value>)', 400: 'rgb(var(--indigo-400) / <alpha-value>)' },
        sky: { ...colors.sky, 100: 'rgb(var(--sky-100) / <alpha-value>)', 200: 'rgb(var(--sky-200) / <alpha-value>)', 300: 'rgb(var(--sky-300) / <alpha-value>)', 400: 'rgb(var(--sky-400) / <alpha-value>)' },
        violet: { ...colors.violet, 100: 'rgb(var(--violet-100) / <alpha-value>)', 200: 'rgb(var(--violet-200) / <alpha-value>)', 300: 'rgb(var(--violet-300) / <alpha-value>)', 400: 'rgb(var(--violet-400) / <alpha-value>)' },
        fuchsia: { ...colors.fuchsia, 100: 'rgb(var(--fuchsia-100) / <alpha-value>)', 200: 'rgb(var(--fuchsia-200) / <alpha-value>)', 300: 'rgb(var(--fuchsia-300) / <alpha-value>)', 400: 'rgb(var(--fuchsia-400) / <alpha-value>)' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: { '2xs': ['0.6875rem', '1rem'] },
    },
  },
  plugins: [],
};
