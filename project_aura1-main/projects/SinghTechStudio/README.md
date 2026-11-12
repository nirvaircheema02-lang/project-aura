# SinghTechStudio — React Source Project

The full editable source for the SinghTechStudio website. **Vite + React 18**, plain CSS
(no Tailwind / UI framework). State-based routing (single page, no router).

## Quick start

```bash
npm install        # first time only
npm run dev        # local dev → http://localhost:5173
npm run build      # production build → /dist  (static files to deploy)
npm run preview    # preview the production build locally
```

## Deploy (go live)

Any static host. Recommended:

- **Vercel** — `npm i -g vercel` then `vercel --prod` (auto-detects Vite), or import the repo in the Vercel dashboard.
- **Netlify** — connect the repo, **Build command:** `npm run build`, **Publish directory:** `dist`. (Or run `npm run build` and drag the `dist` folder to https://app.netlify.com/drop.)
- **Cloudflare Pages** — build command `npm run build`, output dir `dist`.

> Serve from the **domain root** (asset paths are absolute: `/assets`, `/frames`, `/work`). To host under a sub-path, set `base` in `vite.config.js` and rebuild.

## Project structure

```
index.html                  app entry (loads Manrope font)
vite.config.js
src/
  main.jsx                  React mount
  App.jsx                   page switch (Home/Services/Work/About/Contact/Detail)
  styles/global.css         ALL styling + design tokens (:root variables)
  components/               Header, Footer, CTASection, ProjectCard, Reveal,
                            SplitWords, Testimonials (outcomes), Icon, WhatsAppFloat
  sections/                 HeroFrames (scroll-scrub hero), WorkShowcase (pinned),
                            ProcessTimeline, FreeAudit, ParticleCanvas
  pages/                    HomePage, ServicesPage, WorkPage, AboutPage,
                            ContactPage, ProjectDetailPage
  data/                     portfolio.js (projects), services.js, constants.js
public/
  frames/                   235 JPGs — the scroll-scrubbed hero sequence
  work/                     project gallery images (Arjun, Amrit, 25Colleges)
  process/ + process-showcase.mp4   source clips used to generate the hero frames
```

## Edit before launch

- **WhatsApp number** — `src/data/constants.js` (`WA_URL`, currently a placeholder `9199999999`).
- **Contact email / location** — `src/components/Footer.jsx`, `src/pages/ContactPage.jsx`.
- **Contact form** — currently shows a success message only; wire it to Formspree / email / your CRM in `src/pages/ContactPage.jsx`.

## Add or edit projects

1. Drop images in `public/work/` (e.g. `myproject-1.jpg`).
2. Add/edit an entry in `src/data/portfolio.js` (title, category, `liveUrl`, `img`, `gallery`, challenge, delivered, results…). The Work showcase, grid, and detail page update automatically.

## Regenerate the hero (optional)

The scroll hero plays `public/frames/` (235 JPGs) pre-extracted from
`public/process-showcase.mp4` (the 3 clips in `public/process/` merged with
crossfades). To change it, re-merge + re-export frames with ffmpeg and update
`FRAME_COUNT` in `src/sections/HeroFrames.jsx`.
