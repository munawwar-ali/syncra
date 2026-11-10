/** Colors come from the design tokens in src/styles.css (Doc 04 §9). */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        ink: 'var(--ink)',
        ivory: 'var(--ivory)',
        lime: 'var(--lime)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        fg: 'var(--text)',
        muted: 'var(--text-muted)',
        line: 'var(--border)',
        primary: 'var(--primary)',
        'primary-contrast': 'var(--primary-contrast)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        offline: 'var(--offline)',
      },
      borderRadius: { card: '8px', input: '6px' },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  darkMode: ['class', '[data-theme="dark"]'],
};
