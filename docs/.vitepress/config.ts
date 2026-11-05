import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

// GitHub Pages serves project sites under /<repo>/.
const base = process.env.DOCS_BASE ?? '/syncra/';

export default withMermaid(
  defineConfig({
    title: 'Syncra',
    description: 'Self-hostable sync engine for offline-first apps, built on Yjs.',
    base,
    srcExclude: ['spec/**', 'adr/**', 'traceability.md', 'README.md'],
    // Links that leave docs/ (result files in loadtest/) are valid on GitHub but not in the built site.
    ignoreDeadLinks: [/^\.\.\//, /localhost/],
    themeConfig: {
      nav: [
        { text: 'Get started', link: '/getting-started' },
        { text: 'Guides', link: '/sdk-guide' },
        { text: 'Reference', link: '/protocol' },
        { text: 'GitHub', link: 'https://github.com/munawwar-ali/syncra' },
      ],
      sidebar: [
        {
          text: 'Start',
          items: [
            { text: 'Getting started', link: '/getting-started' },
            { text: 'SDK guide', link: '/sdk-guide' },
          ],
        },
        {
          text: 'Operate',
          items: [
            { text: 'Self-hosting', link: '/self-hosting' },
            { text: 'Deployment', link: '/deployment' },
            { text: 'Capacity', link: '/capacity' },
            { text: 'Benchmarks', link: '/benchmarks' },
          ],
        },
        {
          text: 'Understand',
          items: [
            { text: 'Architecture', link: '/architecture' },
            { text: 'Protocol', link: '/protocol' },
            { text: 'Security', link: '/security' },
            { text: 'Sharding', link: '/sharding' },
            { text: 'Comparison', link: '/comparison' },
            { text: 'FAQ', link: '/faq' },
          ],
        },
      ],
      search: { provider: 'local' },
    },
  }),
);
