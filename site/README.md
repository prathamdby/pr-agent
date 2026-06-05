# PR Agent landing page

The marketing site for PR Agent. It is fully isolated from the main application: its own
dependencies, its own build, and no imports from the parent project.

## Stack

- React 19 + Vite
- Tailwind CSS v4
- shadcn-style UI primitives (owned in `src/components/ui`)
- Motion for animation
- Phosphor icons and simple-icons for brand marks
- Geist (self-hosted via Fontsource)

## Develop

```bash
cd site
npm install
npm run dev
```

## Build

```bash
npm run build      # type-check + production build into dist/
npm run preview    # serve the built site locally
```

## Notes

- The product screenshots in `public/shots` are copied from `docs/readme/assets` so the page
  shows the real GitHub surfaces.
- The accent colour and design tokens live in `src/index.css`.
