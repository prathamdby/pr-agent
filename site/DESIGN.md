# PR Agent Design System

This file describes how the landing page in `site/` looks and why, so a later change keeps the same design. It is the reference for tokens, class recipes, and the rules behind them. Read it before touching `site/app/globals.css`, anything under `site/components/`, or the copy in `site/lib/content.ts`.

The page is a TanStack Start app (React 19, Tailwind v4). Tailwind’s stock palette is switched off, so every colour utility on the page comes from the semantic tokens in `site/app/globals.css`. Everything below is copied from the real files. When a file and this document disagree, fix one of them in the same PR.

## Contents

1. [Reference and mood](#reference-and-mood)
2. [House rules](#house-rules)
3. [Typography](#typography)
4. [Colour](#colour)
5. [Radii](#radii)
6. [Depth](#depth)
7. [Motion](#motion)
8. [Layout](#layout)
9. [Components](#components)
10. [Icons and marks](#icons-and-marks)
11. [Content and voice](#content-and-voice)
12. [Do and don’t](#do-and-dont)
13. [Verification](#verification)
14. [File map](#file-map)

## Reference and mood

The PR Agent Design System is a light, calm, product-led look: a white sheet on a grey backdrop, one blue accent, soft blue washes behind real GitHub output, and a lot of air. Hold these traits whatever section you add:

- **A white sheet over a light grey backdrop.** `.page-frame` is the sheet: `bg-surface`, `min-height: 100svh`, and from `min-width: 84rem` it caps at `max-width: 84rem`, centres, and takes `--shadow-card`. The `<body>` behind it is `bg-bg`. The sheet runs from the top edge, so the sticky header has nothing to fight, to the bottom edge, where the footer wordmark meets the fold.
- **Generous whitespace.** Sections breathe with `py-16 sm:py-20 lg:py-24`. Nothing sits closer than it must.
- **One blue accent, sampled from the logo** (`site/assets/logo-source.png`): sky `#339bfd` and royal `#1e69e9`. Everything else is grey or white.
- **Wash panels behind product mock-ups.** A soft blue gradient (`.wash`) with a faint white grid (`.wash-grid`) or blurred cloud puffs (`.wash-clouds`).
- **GitHub-styled output mocks inside those washes** (`site/components/github-output/`), so the reader sees what lands on a pull request rather than an abstract illustration.
- **A giant faded brand wordmark closing the page** (`.wordmark-clip` and `.wordmark-sky`, rendered by `site/components/footer.tsx`).
- **Clean cut and calm.** Depth comes from soft layered shadows, never from borders. Hairline `border-line` rules only separate rows inside a card or frame a mock’s chrome.
- **No dark mode.** `color-scheme: light` on `html`, `theme-color` `#ffffff` in the head.

## House rules

These rules are followed without exception. They are grouped the way the site applies them, each with the class or token that implements it.

### User interface

- Radii are concentric: outer radius = inner radius + padding. See [Radii](#radii) for the `.tabs-shell` maths.
- Align optically, not geometrically. `.btn` uses `line-height: 1` with `items-center` so icon and label share one optical centre; list bullets sit at `mt-2 size-1.5` rather than on the line box centre.
- A button with an icon on one side takes less padding on that side: `.btn-trailing` is `padding-inline: 1rem 0.75rem`, `.btn-leading` is `0.75rem 1rem`.
- Depth is layered `box-shadow`, not borders. The first layer of every shadow token is a hairline standing in for a border.
- Raster images carry a 1px, 8% outline so a light image still has an edge: `img { outline: 1px solid rgb(0 0 0 / 0.08); outline-offset: -1px; }`. The logo, which already has an edge, opts out with `outline-none`.
- Icon stroke matches text weight: Hugeicons stroke-rounded at `strokeWidth={1.5}` beside Geist at 400–500.

### Animation

- Animate from the trigger. The mobile menu drops out of the header (`translate: 0 -4px` to `0 0`); the copied check grows out of the copy icon (`.swap`).
- Frequently used menus open instantly and only animate on close. `.menu-panel` uses `@starting-style` to skip the entrance and transitions `opacity, translate, filter, display` on the way out. Escape closes it and returns focus to the menu button. Following a menu link (or the header “Deploy” button) while it is open sets `data-instant="true"` and closes it inside `flushSync`, with no exit: the panel sits in the header’s flow, so a fade-out would still be taking up space when the browser measures the anchor, and the scroll would land a full menu height past it.
- Exits are subtler than entrances and end in a 4px blur: `.menu-panel[data-open="false"]` and `.swap > [data-shown="false"]` both finish at `filter: blur(4px)`.
- Name the transition properties. Never `transition: all`. `.btn` lists `background-color, color, box-shadow, scale`.
- Buttons scale on press: `.btn:active { scale: 0.97 }` with `scale 200ms ease-out`. The accepted range is 0.95–0.98. The hero pill link, which is button-shaped, does the same with `active:scale-[0.97]`.
- Icon swaps cross-fade: the new icon goes `scale 0.25` to `1` and `blur 4px` to `0` while the old one shrinks away (`.swap`).
- Transitions for interactions, keyframes for one-offs. `.btn`, `.swap`, `.menu-panel`, and `.disclosure` transition; `rise` and `panel-in` are keyframes. `panel-in` only plays when a tab is picked with the pointer: on page load and while arrowing through the strip the panel switches instantly, because keyboard-driven actions should not animate.
- Disable transitions while switching themes. There is one theme today. If a second arrives, zero `transition-duration` for the frame the switch happens in.
- `will-change: transform` on anything that jitters by 1–2px during motion: `.window`.
- Stagger entrances in small groups. The hero runs `motion-safe:animate-rise` at 0ms, 90ms, and 180ms for its three blocks.
- No animation on page load unless intentional. The hero rise is the one intentional load animation. Every other section is still until the reader acts.
- Hover feedback is instant: colour and background hovers run 150ms, never longer.

### Typography

- Only `woff2`, self-hosted: `/fonts/Geist-Variable.woff2` and `/fonts/GeistMono-Variable.woff2`.
- `font-variant-numeric: tabular-nums` on counters, prices, and tables: the `.tabular` utility on step numbers, `$0`, `#284`, tab counts, and the copyright line.
- Long text stays at 60–75 characters per line. Descriptions cap at `max-w-[46ch]` to `max-w-[58ch]`. `ch` is the width of a zero, wider than Geist’s average letter, so check real lines: FAQ answers at `max-w-[52ch]` run about 70 characters.
- `text-wrap: balance` on `h1`, `h2`, `h3`; `text-wrap: pretty` on `p`. Both set in `@layer base`.
- `overflow-wrap: break-word` on paragraphs; `white-space: nowrap` on labels that must not break (`.btn`, `GhPill`, `.wordmark-sky`).
- Font smoothing on the root: `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`.
- Copy is written in normal capitalisation. Use `text-transform` if caps are ever needed. Nothing on the page is shouted today.
- Smart punctuation: curly quotes, en dashes for ranges (`P0–P2`, `lines 148–152`), the ellipsis character (`/ask …`), middle dots as separators (`/review · /describe`). No em dashes anywhere.
- `text-underline-position: from-font` on the root; `text-decoration-skip-ink: auto` and `text-underline-offset: 3px` on `a`.
- Ellipsised text gets a tooltip: the truncated clone command carries `title={CLONE_COMMAND}`.

### Colours

- Every palette step has a purpose. The primitives in `:root` are exactly the values the semantic tokens need, nothing more.
- Components use semantic tokens only, never primitives. `--palette-*` is read only inside `@theme`.
- Tokens are named by purpose (`surface-raised`, `text-tertiary`, `wash-strong`), not by hue.
- `accent` is reserved for the brand blue. Status colours have their own tokens.
- Contrast is measured against the real background. `text-tertiary` (`#687286`) clears 4.5:1 on both `surface` (4.8:1) and `surface-raised` (4.5:1), so small labels and muted detail stay readable. Do not lighten it; anything paler fails on `surface-raised`.
- A dark theme, if ever added, is a separate palette behind one switch mechanism, not per-component overrides.
- Gradients interpolate `in oklab`: `.wash`, `.wordmark-sky`, and `.accent-word`.

### Accessibility

- Native elements first: `<button>`, `<a>`, `<details name="faq">`, `<table>`, `<dl>`, `<figure>`, `<ol>`.
- `:focus-visible`, not `:focus`: `outline: 2px solid var(--color-focus); outline-offset: 2px`.
- `tabindex` is only ever `0` or `-1`: the roving tab strip in `site/components/use-cases.tsx` and the scrollable preview region.
- Icon-only buttons carry `aria-label`. The menu button reads “Open menu” or “Close menu” with `aria-expanded` and `aria-controls`.
- Every `<img>` has `alt`. The logo beside the product name uses `alt=""` because the name carries the meaning.
- Labels are visible. The page has no inputs; if one arrives, no placeholder-only labels.
- Never block paste, keep submit enabled. Not exercised today. Keep it that way if a form arrives.
- Hit areas are at least 24px, preferably 40–44px: `.btn` is 40px tall, header buttons 36px, mobile menu links and tabs 44px, footer links `min-h-8`. Small text links that cannot grow without moving the layout (the footer legal bar, the 404 resource paths, the `GhDetails` summary in mocks) take `.hit-area`, a `::after` that reaches 4px above and below and 6px to each side. Keep that inset under half the gap to the next target.
- `.btn` sets `cursor: pointer` (Tailwind v4 resets buttons to the default cursor) and `user-select: none`, and `html` clears `-webkit-tap-highlight-color` so the press scale is the only tap feedback.
- Mock links are inert. The triage mock’s `thread` cells are styled like GitHub links but render as `span`, because a mock has no real thread to open.
- `pointer-events: none` on decoration: rails, the scribble, the header sentinel, wash textures, the wordmark.
- Hover styles only inside `@media (hover: hover)` in `globals.css`. Tailwind v4’s `hover:` variant is already gated the same way.
- `prefers-reduced-motion` is honoured: keyframe entrances are `motion-safe:`, the `.disclosure` height animation is inside `no-preference`, and `reduce` zeroes the `.btn`, `.disclosure-icon`, `.menu-panel`, and `.swap` transitions and turns smooth scrolling off.
- `role="status"` for quiet confirmations (`CopyButton`, where the region is a sibling of the button so the confirmation never joins the button’s accessible name); `role="alert"` only for something that needs attention now.
- Never colour alone. Every comparison mark and pill pairs its colour with an icon or text.
- The skip link is the first focusable element in `<body>`.

### Layout

- `html { scroll-padding-top: 80px }` clears the 64px sticky header for anything scrolled into view, including keyboard focus, so a focused control is never hidden under the header. Anchor targets add `scroll-mt-5` (20px) on top, so every anchored section's first line lands exactly 100px down.
- Group spacing is at least twice item spacing: cards `gap-4` inside sections that start at `mt-10 sm:mt-12`; footer links `gap-1` under headings at `mt-3` inside columns at `gap-10`.

### Writing

- Buttons lead with a verb: “Deploy yourself”, “Copy prompt”, “Open an issue”, “Copy command”.
- Confirmations say what happened: “Copied to clipboard”.
- Step labels are consistent within a list: “Step 1” in the features timeline, “Step 01” in the quickstart, always `tabular`.
- Links describe their target: “Read the feature docs”, never “click here”.
- Sentence case everywhere, including headings, tab labels, and table headers.
- Toggles are named for their on state. None today.
- Empty states help. None today; the page has no data views.
- Address the reader as “you”: “Your servers, your keys”.

## Typography

### Fonts

| Token         | Value                                                                              | Purpose                               |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| `--font-sans` | `"Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | Everything except code                |
| `--font-mono` | `"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`           | `code`, `pre`, `kbd`, commands, paths |

Both faces are variable (`font-weight: 100 900`), `font-display: swap`, self-hosted under `site/public/fonts/` with the licence in `site/public/fonts/licenses/geist-OFL.txt`. `site/app/__root.tsx` preloads the sans file only (`rel="preload" as="font" type="font/woff2" crossOrigin="anonymous"`). Mono loads on demand.

Weights: 400 for body copy and ghost nav items, 500 for headings, buttons, and labels, 600 for the brand name in the header and footer and for the bot name inside mocks. Nothing heavier.

### Headings

| Where                     | Recipe                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Hero `h1`                 | `text-[clamp(2.5rem,5.6vw,4.25rem)] font-medium leading-[1.04] tracking-[-0.035em] text-text`    |
| CTA banner `h2`           | `text-[clamp(2.25rem,5vw,3.75rem)] font-medium leading-[1.04] tracking-[-0.035em] text-text`     |
| 404 `h1`                  | `text-[clamp(2rem,4vw,3rem)] font-medium leading-[1.08] tracking-[-0.03em] text-text`            |
| Section `h2`              | `text-[clamp(1.875rem,3.4vw,2.625rem)] font-medium leading-[1.12] tracking-[-0.025em] text-text` |
| Tab panel `h3`            | `text-2xl font-medium tracking-[-0.02em] text-text`                                              |
| Quickstart step `h3`      | `text-xl font-medium tracking-[-0.015em] text-text`                                              |
| Feature step `h3`         | `text-lg leading-snug font-medium text-text sm:text-xl`                                          |
| Card and pricing `h3`     | `text-[17px] leading-snug font-medium text-text`                                                 |
| Row heading, FAQ question | `text-[15px] leading-snug font-medium text-text`                                                 |
| Pricing figure            | `tabular text-[clamp(4.5rem,10vw,8rem)] leading-none font-medium tracking-[-0.05em] text-text`   |

The pattern: `font-medium`, tighter tracking as the size grows (`-0.015em` at 20px up to `-0.035em` at 68px), line height between `1.04` and `1.12`, and `clamp()` for anything that scales with the viewport. Headings never go bold. The hero `h1` keeps the brand in a `sr-only` span (`HERO_BRAND`) so the accessible name matches the markdown page while only the tagline is visible.

### Body and labels

| Role                | Recipe                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Hero support        | `max-w-[46ch] text-base leading-relaxed text-text-secondary sm:text-lg`                            |
| Section description | `max-w-[58ch] text-base leading-relaxed text-text-secondary sm:text-[1.0625rem]`                   |
| Card body           | `text-[15px] leading-relaxed text-text-secondary` or `text-sm leading-relaxed text-text-secondary` |
| Muted detail        | `text-sm leading-relaxed text-text-tertiary`                                                       |
| Eyebrow             | `text-[13px] font-medium text-text-secondary`                                                      |
| Small print         | `text-[13px] text-text-tertiary`                                                                   |
| Mock body           | `text-xs leading-relaxed text-text`, `text-[11px]` for meta, `text-[10px]` for the bot badge       |

Numbers that count or line up take `.tabular` (`font-variant-numeric: tabular-nums`): `$0`, `Step 1`, `#284`, tab counts, the copyright year.

## Colour

### Primitives

Raw values live in `:root` as `--palette-*`. Nothing outside the `@theme` block reads them, so a component can only reach a colour through the purpose it serves. The one exception is the shadow ink: `--shadow-ink` and the `.wash` base rules pick between the two `--palette-ink-*` channels (see [Depth](#depth)). Blues are sampled from `site/assets/logo-source.png`.

| Primitive               | Value      | Feeds                                     |
| ----------------------- | ---------- | ----------------------------------------- |
| `--palette-white`       | `#ffffff`  | `surface`, `on-accent`                    |
| `--palette-gray-50`     | `#f6f7f9`  | `bg`, `surface-raised`                    |
| `--palette-gray-100`    | `#eef0f3`  | `surface-hover`                           |
| `--palette-gray-200`    | `#e3e6eb`  | `line`                                    |
| `--palette-gray-500`    | `#687286`  | `text-tertiary`                           |
| `--palette-gray-700`    | `#4a5568`  | `text-secondary`                          |
| `--palette-gray-950`    | `#0f1522`  | `text`                                    |
| `--palette-blue-50`     | `#edf5ff`  | `accent-soft`, `wash-soft`                |
| `--palette-blue-100`    | `#d9eafe`  | `wash-mid`                                |
| `--palette-blue-200`    | `#b9dcfc`  | `wash-strong`                             |
| `--palette-blue-500`    | `#339bfd`  | `accent-bright`, `focus` (logo sky)       |
| `--palette-blue-600`    | `#1e69e9`  | `accent-solid` (logo royal)               |
| `--palette-blue-700`    | `#1858cc`  | `accent-hover`, `accent-text`             |
| `--palette-green-100`   | `#dcf7e3`  | `success-soft`                            |
| `--palette-green-700`   | `#1a7f37`  | `success`                                 |
| `--palette-red-100`     | `#ffe9e6`  | `danger-soft`                             |
| `--palette-red-700`     | `#c9262f`  | `danger`                                  |
| `--palette-amber-100`   | `#fff1cf`  | `warning-soft`                            |
| `--palette-amber-700`   | `#9a6700`  | `warning`                                 |
| `--palette-ink-neutral` | `15 21 34` | Shadow ink off a wash (gray-950 channels) |
| `--palette-ink-wash`    | `14 42 78` | Shadow ink on a wash (deep wash blue)     |

### Semantic tokens

`@theme` declares `--color-*: initial` first. That removes Tailwind’s stock palette, so `bg-red-500` does not exist and only the tokens below become utilities (`bg-surface`, `text-accent-text`, `divide-line`, `border-line`, `bg-accent-soft/60`, and so on).

| Token                    | Primitive | Purpose                                                                                                      |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------ |
| `--color-bg`             | gray-50   | Backdrop behind the page sheet                                                                               |
| `--color-surface`        | white     | Page sheet, cards, mock windows, secondary buttons, selected tab                                             |
| `--color-surface-raised` | gray-50   | Wells inside cards, mock chrome, tabs shell, neutral pills, code block and pricing shells                    |
| `--color-surface-hover`  | gray-100  | Hover fill for ghost and secondary buttons and menu links                                                    |
| `--color-line`           | gray-200  | Hairline rules between rows, mock chrome borders, rail strokes, window dots                                  |
| `--color-text`           | gray-950  | Headings, primary copy                                                                                       |
| `--color-text-secondary` | gray-700  | Body copy, eyebrows, nav, mock meta                                                                          |
| `--color-text-tertiary`  | gray-500  | Small labels, step numbers, provider marks, the “No” mark                                                    |
| `--color-accent-solid`   | blue-600  | Primary button fill, eyebrow dash, list bullets, info dot, active tab underline in the PR mock, CTA scribble |
| `--color-accent-hover`   | blue-700  | Primary button hover                                                                                         |
| `--color-accent-text`    | blue-700  | Accent text and icons on white: chips, icon tiles, mock links, the “Yes” mark                                |
| `--color-accent-soft`    | blue-50   | Icon tile fill, command chips, step pills, tinted comparison column                                          |
| `--color-accent-bright`  | blue-500  | Wordmark top, `.accent-word` top, `::selection` tint                                                         |
| `--color-on-accent`      | white     | Text and icons on `accent-solid`                                                                             |
| `--color-wash-strong`    | blue-200  | Wash gradient start                                                                                          |
| `--color-wash-mid`       | blue-100  | Wash gradient middle                                                                                         |
| `--color-wash-soft`      | blue-50   | Wash gradient end                                                                                            |
| `--color-success`        | green-700 | Passing checks, “Open” and “Fixed” pills, the copied check mark                                              |
| `--color-success-soft`   | green-100 | Fill behind `success` pills                                                                                  |
| `--color-danger`         | red-700   | Failing checks                                                                                               |
| `--color-danger-soft`    | red-100   | Fill behind `danger` pills                                                                                   |
| `--color-warning`        | amber-700 | “Dismissed” pill                                                                                             |
| `--color-warning-soft`   | amber-100 | Fill behind `warning` pills                                                                                  |
| `--color-focus`          | blue-500  | `:focus-visible` outline                                                                                     |

Rules that go with the table:

- Status colours only appear inside the GitHub mock-ups and the copy confirmation, and each is paired with an icon or label (`XCircle` with `text-danger`, `CheckCircle` with `text-success`, a pill with its word).
- `::selection` is `color-mix(in srgb, var(--color-accent-bright) 24%, transparent)` with `text` on top.
- `bg-surface/85` with `backdrop-blur-md` is the only translucent surface (the sticky header).
- The social card in `site/scripts/generate-og-image.mjs` redraws the hero and the `PrWindow` mock as SVG with these values copied by hand, and sets Geist from `site/assets/fonts/` because librsvg cannot read the page's woff2. Regenerate it with `nub run site:generate-og` when a token, the hero copy, or the mock changes.

## Radii

| Token          | Value | Typical use                                                         |
| -------------- | ----- | ------------------------------------------------------------------- |
| `--radius-xs`  | 6px   | Chips, inline code, small logos, compact copy buttons, `GhPre`      |
| `--radius-sm`  | 8px   | Buttons, icon tiles, check-run boxes, the inline `GhComment` frame  |
| `--radius-md`  | 12px  | `.window`, `CodeBlock`, wells, the CTA command box, the triage wash |
| `--radius-lg`  | 16px  | Cards, the comparison table, the FAQ card, quickstart steps         |
| `--radius-xl`  | 20px  | Hero wash, pricing shells                                           |
| `--radius-2xl` | 24px  | Tabs shell                                                          |

Radii compose concentrically: an element nested with 4px of padding steps down one size (`xl` 20 to `lg` 16 to `md` 12 to `sm` 8), and one nested with 2px of padding steps `sm` 8 to `xs` 6. When the padding is larger than the outer radius the maths gives zero; step down at least one size instead. A `rounded-lg` card with `p-6` holds `rounded-md` wells, `rounded-sm` tiles, and `rounded-xs` chips. An inner element is never rounder than its container.

Worked example, the tabs shell in `globals.css`:

```css
.tabs-shell {
  --tabs-radius: var(--radius-2xl); /* 24px */
  --tabs-pad: 8px;
  --tabs-panel-pad: 6px;
  padding: var(--tabs-pad);
  border-radius: var(--tabs-radius);
}
.tabs-tab,
.tabs-panel {
  border-radius: calc(var(--tabs-radius) - var(--tabs-pad)); /* 16px */
}
.tabs-media {
  border-radius: calc(var(--tabs-radius) - var(--tabs-pad) - var(--tabs-panel-pad)); /* 10px */
}
```

Worked example, the CTA command box in `site/components/cta-banner.tsx`: the box is `rounded-md bg-surface p-1.5 shadow-card` (12px radius, 6px padding), so the primary `CopyButton` inside it is `rounded-xs` (6px). The same maths puts `rounded-xs` chips inside `py-1` code captions and `rounded-sm` tiles inside `p-6` cards.

## Depth

Depth comes from layered shadows. Each layer doubles its offset and blur at about 3% alpha, so the edge stays crisp while the falloff is long and soft, the way light from above behaves. The first layer of every token is a 1px hairline that stands in for a border.

Every layer is `rgb(var(--shadow-ink) / α)`, and a shadow takes the hue of the surface it falls on. `--shadow-ink` is `--palette-ink-neutral` by default. `.wash *` switches descendants of a wash to `--palette-ink-wash`, because a grey shadow on blue reads as dirt; the wash's own shadow falls on the page and stays neutral. `.wash :is(.window, .bg-surface) *` switches back to neutral inside any white surface sitting on the wash, so buttons, tabs, and chips inside a window keep grey shadows.

Apply shadows through the `shadow-*` utilities, or `@apply shadow-*` inside a component class. Never write `box-shadow: var(--shadow-*)`: a custom property resolves `--shadow-ink` where it is declared, on `:root`, so the wash ink would never reach it.

| Token             | Layers                                                                         | Where                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--shadow-ring`   | `0 0 0 1px` at 7%                                                              | Chips, wells, the bot badge, the URL pill, check-run boxes, neutral pills, code block and pricing shells. A border without a border                                                             |
| `--shadow-soft`   | 1px hairline at 5%, then `1, 2, 4, 8` at 3%                                    | Secondary buttons, the hero pill link, feature step tiles, the `CodeBlock` code box, inline `GhComment`, `.tabs-panel` and the selected tab, the hero wash card, pricing panels and price pills |
| `--shadow-card`   | `--shadow-soft` plus `16, 32` at 3%                                            | Cards, `.tabs-shell`, the comparison table, the FAQ card, quickstart steps, the CTA command box, pricing tiles, `.skip-link`, `.page-frame`                                                     |
| `--shadow-float`  | `--shadow-card` with `16, 32` at 4%, plus `0 64px 64px rgb(30 105 233 / 0.06)` | `.window` mock shells. The last layer is a faint blue glow so a window lifts off its wash                                                                                                       |
| `--shadow-button` | `inset 0 1px 0 rgb(255 255 255 / 0.16)`, then the `--shadow-soft` ladder       | Primary buttons: a lit top edge over the same ladder as a secondary button, so the pair sits at one height                                                                                      |
| `--shadow-header` | `0 1px 0` at 5%, then `2, 4, 8, 16` at 2%                                      | The header once it sticks (`data-stuck="true"`)                                                                                                                                                 |

Tailwind exposes them as `shadow-ring`, `shadow-soft`, `shadow-card`, `shadow-float`, `shadow-button`, `shadow-header`. Use `border-line` only for rules between rows (`divide-y divide-line`, `border-b border-line`) and for the mock chrome; never to outline a card or a button.

## Motion

| Token                | Value                                       | Purpose                                                             |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `--ease-out-quart`   | `cubic-bezier(0.25, 1, 0.5, 1)`             | Every non-trivial transition and both keyframes                     |
| `--animate-rise`     | `rise 700ms var(--ease-out-quart) both`     | Hero entrance: `opacity 0`, `translate 0 14px`, `blur(4px)` to rest |
| `--animate-panel-in` | `panel-in 240ms var(--ease-out-quart) both` | Tab panel copy: `opacity 0`, `translate 0 6px` to rest              |

Recipes, all in `globals.css`:

- **Buttons.** `.btn` transitions `background-color, color, box-shadow, scale` with durations `150ms, 150ms, 150ms, 200ms` and timing `ease, ease, ease, ease-out`. `.btn:active { scale: 0.97 }`.
- **Icon swap.** `.swap` is an `inline-grid` with every child on `grid-area: 1 / 1`; children transition `opacity, scale, filter` for 200ms. `[data-shown="false"]` is `opacity: 0; scale: 0.25; filter: blur(4px)`. Used by the menu button (`Menu` and `X`) and `CopyButton` (`Copy` and `Check`). The `data-shown` state sits on wrapper spans around the icons, because the Hugeicons component does not forward data attributes to its SVG; put it on the icon and both icons render at once.
- **Mobile menu.** `.menu-panel` transitions `opacity, translate, filter, display` for 160ms `ease-out` with `transition-behavior: allow-discrete`. Closed is `display: none; opacity: 0; translate: 0 -4px; filter: blur(4px)`. Open sets the resting values inside `@starting-style` too, so opening is instant and only closing animates.
- **Disclosures.** `.disclosure-icon` transitions `rotate 200ms`; `.disclosure[open] .disclosure-icon { rotate: 45deg }` turns the plus into a cross. Under `prefers-reduced-motion: no-preference`, `.disclosure::details-content` transitions `block-size 240ms` and `content-visibility 240ms allow-discrete`, which relies on `interpolate-size: allow-keywords` on `html`.
- **Sticky header.** `transition-[box-shadow] duration-200` and `data-[stuck=true]:shadow-header`.
- **Hovers.** `transition-colors duration-150` on links; the `.btn` variants change background inside `@media (hover: hover)`.
- **Skip link.** `transition: transform 150ms var(--ease-out-quart)` from `translateY(-200%)` to `0` on `:focus-visible`.
- **Reduced motion.** `html { scroll-behavior: auto }`, and `.btn, .skip-link, .disclosure-icon, .menu-panel, .swap > * { transition-duration: 0ms }`. Utility transitions that move something (the hero pill press, the `GhDetails` chevron) add `motion-reduce:transition-none`. Keyframe entrances are applied with the `motion-safe:` variant, so they never run for readers who asked for less motion.

## Layout

- **Container.** `.container-x`: `max-width: 72rem`, `padding-inline` `1.25rem`, then `2rem` from `40rem`, then `3rem` from `64rem`.
- **Breakpoints.** Tailwind defaults: `sm` 40rem, `md` 48rem, `lg` 64rem. The only custom query is `min-width: 84rem` for `.page-frame`.
- **Section rhythm.** `Section` renders a `py-16 sm:py-20 lg:py-24` band around a `container-x scroll-mt-5` that carries the anchor `id`. Content under a `SectionHeading` starts at `mt-10 sm:mt-12`.
- **Anchors.** Every section the header or footer links to is a `Section`, and the `id` sits on its inner container, not the padded band, so the band's `py-16`/`py-20`/`py-24` never shifts where the content lands. The container's `scroll-mt-5` (20px) plus the root `scroll-padding-top` of 80px puts the first line 100px down at every breakpoint, clearing the 64px header with room to spare. `aria-labelledby` stays on the `<section>`. The providers strip sets `scroll-mt-5` on its unpadded `<section>` by hand because it is not a `Section`; its top rule lands at the same 100px.
- **Sticky header.** `sticky top-0 z-40 bg-surface/85 backdrop-blur-md`, 64px tall. A 1px sentinel above it (`absolute inset-x-0 top-0 h-px`) feeds an `IntersectionObserver`; when the sentinel leaves the viewport the header gets `data-stuck="true"` and `shadow-header`.
- **Sticky side columns.** Features and FAQ pin their copy column at `lg:sticky lg:top-28 lg:self-start` (112px, under the header).
- **Grid ratios.** Hero `lg:grid-cols-[minmax(0,10fr)_minmax(0,11fr)]`; features and footer `5fr` / `7fr`; FAQ `4fr` / `8fr`; pricing `7fr` / `5fr`; tab panel `9fr` / `11fr`; quickstart step `2fr` / `3fr`. Always `minmax(0, …)` so long code or paths cannot widen a column.
- **Page order** (`site/app/index.tsx`): Header, Hero, Providers, Features (`#features`), UseCases (`#examples`), Capabilities (`#capabilities`), Pricing (`#pricing`), Alternatives (`#alternatives`), Faq (`#faq`), Quickstart (`#usage`), CtaBanner, Footer.

## Components

### Buttons

`.btn` is the shared chassis; variants add colour. From `globals.css`:

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  height: 2.5rem;
  padding-inline: 1rem;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
```

| Class            | Fill and ink                                      | Depth             | Hover (`@media (hover: hover)`)     |
| ---------------- | ------------------------------------------------- | ----------------- | ----------------------------------- |
| `.btn-primary`   | `accent-solid` on `on-accent`                     | `--shadow-button` | `accent-hover`                      |
| `.btn-secondary` | `surface` on `text`                               | `--shadow-soft`   | `surface-hover`                     |
| `.btn-ghost`     | transparent on `text-secondary`                   | none              | `surface-hover`, ink becomes `text` |
| `.btn-trailing`  | `padding-inline: 1rem 0.75rem` for an icon after  |                   |                                     |
| `.btn-leading`   | `padding-inline: 0.75rem 1rem` for an icon before |                   |                                     |

`Button` and `ButtonLink` in `site/components/button.tsx` compose those classes from `variant`, `trailingIcon`, and `leadingIcon`, wrap the label in a `<span>`, and add `target="_blank" rel="noopener noreferrer"` when `external` is set. External links use `ArrowUpRight` in `text-text-tertiary`; internal ones use `ChevronRight`. Header buttons override the height with `h-9`; nav items are `btn btn-ghost h-9 px-3 font-normal`; the icon-only menu button is `btn btn-ghost size-9 px-0` with an `aria-label`.

```tsx
<ButtonLink href="#usage" trailingIcon={<ChevronRight className="size-4" />}>
  Deploy yourself
</ButtonLink>
<CopyButton
  text={SETUP_PROMPT}
  label="Copy prompt"
  variant="secondary"
  iconAfter
  prefix={<AssistantMarks />}
/>
```

The hero pairs the primary link with a secondary `CopyButton` whose `prefix` is three `size-3.5` provider marks in `text-text-secondary`, so “any AI tool” is shown rather than said.

### Section, heading, eyebrow

`site/components/section.tsx` owns the page band and its heading block.

```tsx
<section aria-labelledby={labelledBy} className="py-16 sm:py-20 lg:py-24">
  <div id={id} className="container-x scroll-mt-5">
    {children}
  </div>
</section>
```

- `Eyebrow`: `inline-flex items-center gap-2 text-[13px] font-medium text-text-secondary` with a `h-1.5 w-3.5 rounded-full bg-accent-solid` dash before the word.
- `SectionHeading`: eyebrow, then the section `h2` recipe at `mt-4`, then an optional `max-w-[58ch]` description at `mt-4`; an optional `action` renders beside the copy on `md` (`md:flex-row md:items-end md:justify-between md:gap-12`) and under it on narrow screens.
- Sections with a side column (features, pricing, FAQ) inline the same eyebrow and `h2` recipe instead of `SectionHeading`.
- Pricing plans are shell cards: each `li` is a grey shell (`flex flex-col rounded-xl bg-surface-raised p-2 shadow-ring`) holding a `wash wash-grid` (or `wash-clouds`) `aspect-[4/3] rounded-md shadow-soft` panel inset at the top (20px shell, 8px padding, 12px panel, so the radii stay concentric) with a `size-20 rounded-md bg-surface shadow-card` tile carrying the plan's Hugeicons mark in `text-accent-text` and a `rounded-full bg-surface shadow-soft` pill with the plan's price line; the `h3` and one `text-sm text-text-secondary` line sit in the shell's footer (`flex-1 px-3 pt-4 pb-3`). Every odd-indexed card flips at every width: the copy takes `order-first pt-3 pb-4` and sits above the panel, so the cards alternate in the three-up row and in the stacked column, and the flipped panel stays flush with the shell's bottom inset. The grid spans the container, so the cards line up with the heading and the copy above them.

### Cards, tiles, chips, wells

- **Card**: `rounded-lg bg-surface p-6 shadow-card` (`flex flex-col` when the card needs a bottom slot). No border.
- **Icon tile**: `grid size-10 shrink-0 place-items-center rounded-sm bg-accent-soft text-accent-text` holding a `size-5` icon. The features timeline uses the white variant, `grid size-11 place-items-center rounded-sm bg-surface text-accent-text shadow-soft`, joined by a `w-px bg-line` spine.
- **Command chip**: `rounded-xs bg-surface-raised px-2 py-1 font-mono text-xs font-medium text-accent-text shadow-ring`; the “Automatic” chip is the same with `text-text-secondary`. Inside the tab panel the chip is `rounded-xs bg-accent-soft px-2 py-1 font-mono text-xs font-medium text-accent-text`.
- **Step pill**: `tabular inline-flex h-7 items-center rounded-full bg-accent-soft px-2.5 text-xs font-semibold text-accent-text`.
- **Hero pill link**: `inline-flex h-8 items-center gap-2 rounded-full bg-surface pr-3 pl-1.5 text-[13px] whitespace-nowrap text-text-secondary shadow-soft`, pressing to `scale 0.97`, with a `size-5 rounded-full bg-accent-soft text-accent-text` badge holding a `Star size-3`, the label “Star PR Agent on GitHub”, and an `ArrowUpRight size-3.5 text-text-tertiary` because it leaves the site (`REPO_URL`, new tab).
- **Well** (a list inside a card): `divide-y divide-line rounded-md bg-surface-raised px-5 shadow-ring`.
- **Feature cue**: `inline-flex max-w-full items-center rounded-xs bg-surface-raised px-2 py-1 font-mono text-xs text-text-secondary shadow-ring`.

### CodeBlock and CopyButton

`site/components/code-block.tsx` is a `figure` with `rounded-md bg-surface-raised p-1.5 shadow-ring`. The `figcaption` is `pt-0.5 pr-0.5 pb-1.5 pl-2` with a `Terminal` icon, the label, and a ghost `CopyButton` whose `target` is `` `${label} snippet` ``, so two “Copy” buttons in one step read as “Copy Terminal snippet” and “Copy .env snippet” to a screen reader. The `pre` is `overflow-x-auto rounded-xs bg-surface p-4 text-[13px] leading-relaxed shadow-soft`. Highlighting is minimal and by hand: in `bash`, a `#` line is `block whitespace-pre-wrap text-text-tertiary` (comments may wrap) and every other line keeps its first word in `text-accent-text` and never wraps (the block scrolls instead); in `dotenv`, the key is `text-accent-text`, `=` is `text-text-tertiary`, the value `text-text-secondary`.

`site/components/copy-button.tsx` confirms with an icon swap and a label change, so the state never rests on colour alone:

```tsx
const icon = (
  <span className="swap size-4" aria-hidden="true">
    <span data-shown={!copied} className="grid place-items-center">
      <Copy className={iconAfter ? "size-4 text-text-tertiary" : "size-3.5"} />
    </span>
    <span data-shown={copied} className="grid place-items-center">
      <Check className={iconAfter ? "size-4 text-success" : "size-3.5 text-success"} />
    </span>
  </span>
);

<>
  <button type="button" onClick={copy} className={chassis}>
    {prefix}
    {iconAfter ? null : icon}
    <span className="grid">
      <span className={copied ? "invisible col-start-1 row-start-1" : "col-start-1 row-start-1"}>
        {label}
      </span>
      <span className={copied ? "col-start-1 row-start-1" : "invisible col-start-1 row-start-1"}>
        Copied
      </span>
    </span>
    {iconAfter ? icon : null}
  </button>
  <span role="status" className="sr-only">
    {copied ? "Copied to clipboard" : ""}
  </span>
</>;
```

Both labels occupy the same grid cell, so the button keeps the width of the longer one and the swap never shifts layout. The `role="status"` region beside the button repeats the confirmation for screen readers. State is a timestamp and resets 1800ms after the latest copy, so copying again restarts the window. A denied clipboard write is swallowed because the text stays visible and selectable beside the button. Chassis per variant: `ghost` is `btn btn-ghost h-7 gap-1.5 rounded-xs pr-2 pl-1.5 text-xs` (code blocks, icon side one step tighter), `primary` is `btn btn-primary btn-leading h-9 rounded-xs text-[13px]` (the CTA command box), `secondary` is `btn btn-secondary btn-trailing` with `iconAfter`, or `btn btn-secondary px-3` when a `prefix` puts marks on the leading side too (the hero). `prefix` renders before the label.

### GitHub output primitives

`site/components/github-output/primitives.tsx` renders bot output the way GitHub’s light theme does, so the examples look like the real thing.

| Primitive   | Recipe                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GhComment` | `article overflow-hidden text-xs leading-relaxed text-text` in a `window` frame or the inline `rounded-sm bg-surface shadow-soft`; header `border-b border-line bg-surface-raised px-3 py-2` with the logo, `pr-agent`, a `bot` badge (`rounded-xs px-1 py-px text-[10px] font-medium text-text-secondary shadow-ring`), “commented just now”, and the `surface` label on `sm` |
| `GhTitle`   | `border-b border-line pb-1.5 text-sm font-semibold text-text`, a markdown `##` as GitHub renders it                                                                                                                                                                                                                                                                            |
| `GhNote`    | `border-l-[3px] border-accent-solid py-0.5 pl-3 text-text-secondary` with an `Info` icon and “Note” in `text-accent-text`                                                                                                                                                                                                                                                      |
| `GhCode`    | `rounded-xs bg-surface-raised px-1 py-px font-mono text-[11px] text-text`                                                                                                                                                                                                                                                                                                      |
| `GhLabel`   | `font-semibold text-text`                                                                                                                                                                                                                                                                                                                                                      |
| `GhKvTable` | `w-full border-collapse text-left`, rows `border-b border-line align-top last:border-b-0`, `th` `w-24 py-2 pr-3 font-semibold sm:w-28`, no header row                                                                                                                                                                                                                          |
| `GhDetails` | `details.disclosure.group` with a `ChevronRight size-3.5` that rotates 90° on open                                                                                                                                                                                                                                                                                             |
| `GhPill`    | `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap` plus a tone                                                                                                                                                                                                                                                                |
| `GhPre`     | `overflow-x-auto rounded-xs bg-surface-raised p-2.5 font-mono text-[11px] leading-relaxed text-text`                                                                                                                                                                                                                                                                           |

Pill tones: `success` is `bg-success-soft text-success`, `danger` is `bg-danger-soft text-danger`, `warning` is `bg-warning-soft text-warning`, `neutral` is `bg-surface-raised text-text-secondary shadow-ring`, `accent` is `bg-accent-soft text-accent-text`. The four mocks (`review-summary.tsx`, `description-block.tsx`, `ask-reply.tsx`, `triage-report.tsx`) mirror the real renderers named in their doc comments; keep their structure in step with the output the bot actually posts.

### Window and wash

`.window` is the mock-up shell: `bg-surface`, `border-radius: var(--radius-md)`, `--shadow-float`, `will-change: transform`. `PrWindow` (`site/components/pr-window.tsx`) adds browser chrome: `border-b border-line bg-surface-raised px-3 py-2`, three `size-2.5 rounded-full bg-line` dots, and a URL pill `tabular rounded-xs bg-surface px-2.5 py-1 text-[11px] text-text-tertiary shadow-ring`. The PR tabs are one `scrollbar-none flex overflow-x-auto` row of `shrink-0 whitespace-nowrap` items, so narrow screens scroll them instead of wrapping; the baseline is `shadow-[inset_0_-1px_0_var(--color-line)]` rather than a border, so the active tab's `border-b-2` paints over it without a negative margin the scroll box would clip. The PR mock is `aria-hidden`; the real examples live in the use-cases tabs.

`.wash` is the blue panel behind mock-ups:

```css
.wash {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  background: linear-gradient(
    145deg in oklab,
    var(--color-wash-strong) 0%,
    var(--color-wash-mid) 48%,
    var(--color-wash-soft) 100%
  );
}
```

`.wash-grid::before` paints a 28px white grid at 55% alpha masked by a radial ellipse at `50% 40%`; `.wash-clouds::after` paints six white radial puffs, banked along the bottom edge on both sides and unequal in size, over `inset: -20%` blurred by 12px. Both pseudo-elements are `z-index: -1` inside the wash’s isolated stacking context, so they stay under every child and can be combined freely: the hero is `wash wash-grid`, the tab media well is `wash wash-clouds`, the CTA banner is `wash wash-grid wash-clouds`. Every wash is `pointer-events: none` texture over a real container; children position themselves with `absolute` insets or normal flow.

### Use-cases tabs

`site/components/use-cases.tsx` is the section the maintainer cares most about. The strip and the panel share one shell, so the strip reads as the top of the card rather than a separate control.

- Shell: `tabs-shell mt-10 sm:mt-12` (`--shadow-card`, `bg-surface-raised`, 8px padding).
- Strip: `role="tablist"` in `grid grid-cols-2 gap-1 sm:grid-cols-4`. Selected tab is `btn tabs-tab h-11 bg-surface text-[15px] text-text shadow-soft`, the same depth as the panel below it; the rest are `btn btn-ghost tabs-tab h-11 text-[15px] font-normal`. Roving `tabIndex` (`0` on the selected tab, `-1` elsewhere) with ArrowLeft, ArrowRight, Home, and End handled on the list.
- Panel: `tabs-panel grid gap-1.5 lg:h-[39rem] lg:grid-cols-[minmax(0,9fr)_minmax(0,11fr)] lg:overflow-hidden`. The height is fixed at `lg` so switching tabs never moves the page.
- Copy column: `flex flex-col p-5 sm:p-8 lg:p-10`, plus `motion-safe:animate-panel-in` after a pointer pick, with the command chip, the `h3`, the description, a `divide-y divide-line` bullet list, and a `mt-auto pt-8` button so the CTA sits on the same baseline in every tab.
- Preview: `wash wash-clouds tabs-media p-4 sm:p-6 lg:p-8`, then a frame at `h-[24rem] [mask-image:linear-gradient(to_bottom,black_78%,transparent_100%)] sm:h-[27rem] lg:absolute lg:inset-8 lg:h-auto`. At `lg` the preview is taken out of flow, so its content can never stretch the row. Inside it, `role="region"` with `aria-label="{tab} example output"` and `tabIndex={0}` is `scrollbar-none h-full overflow-y-auto overscroll-contain rounded-md focus-visible:outline-offset-[-3px]`: long outputs scroll behind the bottom fade with no visible scrollbar.
- Every panel is rendered and toggled with `hidden`, so each keeps its scroll position and the DOM order matches the strip.

### Commands bento

`site/components/capabilities.tsx` lays five of the six capabilities out (`docs-only` stays in `CAPABILITIES` for the markdown page) as `ul mt-10 grid gap-4 sm:mt-12 sm:grid-cols-2 lg:grid-cols-3`. Copy comes only from `CAPABILITIES` in `content.ts`; the file owns arrangement.

- **Review and verify “loop” card** (`sm:row-span-2`): a `grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4`. A dashed `Rail` (an `absolute left-0 w-10` span with an SVG `line` at `x=20.5`, `strokeDasharray="3 3"`, `text-line`) runs from under the review tile through an 18px info dot (`size-[18px] rounded-full bg-accent-solid text-on-accent` with `Info size-3.5`) beside the 12px subtext “Then, after every push” (`text-xs text-text-tertiary`, both in an `h-20` row), then behind the verify tile, where a `viewBox="0 0 56 160"` path `M20.5 0V126a16 16 0 0 0 16 16H52` bends with a 16px corner into the verify copy. The tiles sit at `relative z-10` so the rail passes behind them. A wrapper span takes the insets because an absolutely positioned SVG keeps its intrinsic height instead of stretching.
- **Describe and ask cards**: the plain `Card` recipe with an icon tile top-left and a command chip top-right.
- **Triage card** (`sm:col-span-2`): `md:grid-cols-2 md:gap-8`, copy on the left and a small verdict mock on the right, `wash wash-grid flex items-center rounded-md p-4 sm:p-5` around a `.window rounded-sm` (the padding exceeds the wash radius, so the window steps down a size) with a `PR Agent Triage` header and four `GhPill` verdicts (`success`, `accent`, `neutral`, `warning`). It is `aria-hidden` decoration and stays vertically centred.

### Comparison matrix

`site/components/alternatives.tsx` renders `COMPARISON_CRITERIA` against `ALTERNATIVE_ROWS` twice:

- From `md`, a table in `hidden overflow-hidden rounded-lg bg-surface shadow-card md:block`: `table-fixed`, criteria column `w-[26%]`, brand mark `size-6` over a `text-[13px] font-medium` name in each header, and the PR Agent column tinted `bg-accent-soft/60` in both header and cells.
- Below `md`, one card per criterion (`rounded-lg bg-surface px-5 pt-5 pb-2 shadow-card`) with `min-h-12` rows, `size-[18px]` marks, and the product row in `font-medium text-text` while the others are `text-text-secondary`, so the comparison stays two columns wide on a phone.

Marks always pair an icon with text: “yes” is `Check size-[18px] text-accent-text` with a `sr-only` “Yes”; “partial” is `Minus size-3.5` with a visible “Partial” in `text-xs text-text-secondary`; “no” is `X size-4 text-text-tertiary` with a `sr-only` “No”. The markdown page uses `comparisonMarkLabel` for the same three states.

### FAQ

`site/components/faq.tsx` uses native `<details name="faq">` so only one answer is open at a time, with the first open by default. Each item is `disclosure group border-b border-line last:border-b-0` inside a `rounded-lg bg-surface px-5 shadow-card sm:px-6` card. The summary is `group/summary flex items-center justify-between gap-6 py-5 text-[15px] font-medium text-text` with the `h3` inside it; the marker is removed and a `size-8 rounded-full text-text-tertiary` circle carries a `Plus disclosure-icon size-4` that rotates to a cross and gains `group-open:bg-surface-raised group-open:text-text`; hovering the question darkens the icon with `group-hover/summary:text-text`. Answers are `max-w-[52ch] pb-5 text-[15px] leading-relaxed text-text-secondary`.

### Header and mobile menu

`site/components/header.tsx`: a 64px bar (`container-x flex h-16 items-center justify-between gap-4`) with the logo (`size-7 rounded-sm outline-none`) and product name (`text-[15px] font-semibold tracking-[-0.01em]`), a `hidden md:flex` nav of ghost buttons, a ghost GitHub link from `sm`, the primary “Deploy” button, and a `md:hidden` menu button whose icon is a `.swap`. Nav hrefs are absolute hashes (`/#features`) so the same header works from the 404 page. The mobile panel is `menu-panel border-t border-line md:hidden` with `data-open`, links at `flex h-11 items-center rounded-sm px-3 text-[15px] text-text hover:bg-surface-hover`.

### Footer and wordmark

`site/components/footer.tsx` sits straight on the CTA band, with no divider, and holds the logo, a `max-w-xs text-sm` blurb, and a `mt-auto pt-6 flex gap-2` row of social links on the left (the column is `flex flex-col items-start` and stretches to the grid row from `lg`, so the row sits level with the bottom of the longest link column; stacked, `pt-6` keeps it off the blurb), three link columns (`Product`, `Documentation`, `For agents`) on the right, a `text-[13px] text-text-tertiary` legal bar, and the wordmark. Links are `inline-flex min-h-8 items-center rounded-xs text-sm text-text-secondary transition-colors duration-150 hover:text-text`; agent file links add `font-mono text-[13px]`. Legal bar links are `hit-area rounded-xs`, so their focus ring is rounded and their target reaches 24px. The social links come from `SOCIAL_LINKS` (GitHub at `REPO_URL`, X at `X_URL`, LinkedIn at `LINKEDIN_URL`, all in `site/lib/site.ts`): each is an icon-only `size-10 rounded-sm bg-surface-raised text-text-secondary shadow-ring` tile holding a `size-[18px]` mark, with an `aria-label` and a matching `title`, opening in a new tab. Hover lifts to `bg-surface-hover text-text`; press is `active:scale-[0.97]`, with `transition-[color,background-color,scale] duration-[150ms,150ms,200ms] ease-out`.

The wordmark is the page’s closing note:

```css
.wordmark-clip {
  --wordmark-size: clamp(4.5rem, 17.5vw, 14rem);
  --wordmark-cap-top: 0.145em;
  --wordmark-cap-height: 0.71em;
  height: calc(var(--wordmark-size) * 0.6);
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}
.wordmark-sky {
  translate: 0 -0.125em;
  font-size: var(--wordmark-size);
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.05em;
  white-space: nowrap;
  color: transparent;
  background-clip: text;
}
```

The metrics are measured, not guessed: with Geist 500 at `line-height: 1`, cap tops sit 0.145em below the line box and caps are 0.71em tall (canvas `TextMetrics`). The clip is 0.6em tall and the word is lifted 0.125em, so the box starts just above the caps and shows most of them, cut a little above the baseline, so the word reads as rising from the fold. The fill is the hero sky: five white radial cloud puffs over a `to bottom in oklab` gradient from `accent-bright` at 14% through a 55% mix with `wash-strong` at 46% to `wash-strong` at 72% and `wash-mid` at 84%, all clipped to the glyphs with `background-clip: text`. It is `aria-hidden`; the product name is already in the footer above it.

### Hero and CTA banner

The hero (`site/components/hero.tsx`) is `pt-10 pb-16 sm:pt-16 lg:pt-20 lg:pb-20`, a `grid items-center gap-12 lg:grid-cols-[minmax(0,10fr)_minmax(0,11fr)] lg:gap-10`. Copy on the left in three staggered `motion-safe:animate-rise` groups: the star-the-repo pill link, the `h1` with the brand in a `sr-only` span, then the support paragraph, the two buttons and the `HERO_CTA_NOTE` line. The primary button (“Deploy yourself”) links to `#usage`; the secondary one (“Copy prompt”) is a `CopyButton` fronted by three provider marks that copies `renderSetupPrompt()` from `site/lib/agentResources.ts`: what PR Agent is, every machine-readable URL from the resource registry, the repository, and the job the assistant is asked to do. On the right a `wash wash-grid aspect-[4/3] w-full rounded-xl shadow-soft sm:aspect-[5/4] lg:aspect-auto lg:h-[36rem]` card with the `PrWindow` (`w-full`) pinned at `absolute inset-x-5 top-5 sm:inset-x-8 sm:top-8 lg:top-12 lg:right-auto lg:left-12 lg:w-[34rem]`, so it fills the card below `lg` and is cropped by the card’s `overflow: hidden`.

The CTA banner (`site/components/cta-banner.tsx`) is a full-bleed band inside the sheet, `wash wash-grid wash-grid-fade wash-clouds py-12 text-center sm:py-16`, with a `container-x` inside it, no rounded corners and no shadow. `wash-grid-fade` intersects the grid's radial mask with `linear-gradient(to bottom, black 20%, transparent 60%)`, so the grid sits behind the heading and is gone before the command box. An overlay `linear-gradient(to bottom, transparent 55%, var(--color-surface) 100%)` fades its lower half into the page, so the command box and its shadow float over white and the footer, which follows it directly, reads as one surface. It holds exactly three things: the heading with the word “reviewer” in `accent-word italic` underlined by a hand-drawn `Scribble` SVG (one 4px stroke in `text-accent-solid`, `vectorEffect="non-scaling-stroke"`, `preserveAspectRatio="none"`), one `max-w-[46ch]` sentence, and the clone command box (`rounded-md bg-surface p-1.5 shadow-card` with a `truncate` `code` carrying `title` and a primary `CopyButton`). Do not add anything to it.

`.accent-word` fills the glyphs with the same cloudy sky as `.wordmark-sky`, clipped with `background-clip: text`: five white radial cloud puffs at 18–22% over a `to bottom in oklab` gradient from `accent-bright` at 0% through `accent-solid` at 45% to `accent-text` at 90%. The wordmark's own sky fades to `wash-mid`, which disappears on the wash behind this heading, so this one runs deeper and its clouds are fainter. Measured on the rendered letters against the pixels behind them, the median is about 4:1, the same as a flat `accent-solid` word, and the palest 5% sit near 3:1. Do not raise the cloud alpha or lighten the stops without measuring again. Inline padding of `0.04em 0.1em`, cancelled by an equal negative margin, keeps the italic overhang inside the clipped background. The scribble is a single flat stroke so the underline reads as one tone under the gradient.

### 404

`site/components/not-found.tsx` reuses `Header`, `Eyebrow`, the button pair, a `divide-y divide-line rounded-lg bg-surface px-5 shadow-card sm:px-6` list of `AGENT_RESOURCES`, and `Footer`. The markdown twin is `renderNotFoundMarkdown` in `site/lib/pageMarkdown.ts`.

## Icons and marks

### Hugeicons

Every UI icon comes from `site/components/icons.tsx`, which wraps `@hugeicons/react` with glyphs from `@hugeicons/core-free-icons` (stroke-rounded set):

```tsx
<HugeiconsIcon
  icon={glyph}
  strokeWidth={1.5}
  color="currentColor"
  className={className}
  aria-hidden="true"
  focusable="false"
/>
```

The 1.5 stroke matches Geist at 400–500, so an icon beside a label reads as the same ink. Every icon is decorative and hidden from assistive tech; the text beside it carries the meaning. Exported names: `ChevronRight`, `ArrowUpRight`, `Plus`, `Minus`, `Check`, `Copy`, `Menu`, `X`, `GitHubMark`, `XMark` (the X logo; `X` is the close icon), `LinkedInMark`, `Terminal`, `Server`, `PullRequest`, `Scan`, `Comment`, `Gauge`, `Eye`, `Document`, `Question`, `Refresh`, `Wrench`, `Feather`, `Wallet`, `Shield`, `CheckCircle`, `XCircle`, `Info`. Add a new one by importing the glyph and calling `fromGlyph`; never paste a hand-drawn UI icon. Usual sizes: `size-5` in tiles, `size-4` in buttons, `size-3.5` in chips and small labels.

The only hand-drawn SVGs on the page are illustration, not icons: the dashed rails in the commands bento and the CTA scribble.

### Competitor marks

`site/components/brand-logos.tsx` holds CodeRabbit, Greptile, Cursor, and Macroscope, each taken from the company’s own brand kit (`coderabbit.ai/press-kit`, `greptile.com/design`, `cursor.com/brand`, `macroscope.com/brand-kit`) and reduced to bare geometry filled with `currentColor`, so a mark takes the text colour of the surface it sits on instead of shipping a palette. They are `aria-hidden` because the product name always sits next to them. `BrandLogo` switches on `AlternativeId` from `content.ts`; PR Agent keeps its full-colour raster `/logo.png` at `rounded-xs outline-none`. Adding a tool to `ALTERNATIVE_ROWS` forces a mark here and a column in every criterion.

### Provider marks

`site/components/provider-logos.tsx` holds OpenAI, Claude, Gemini, DeepSeek, Grok, and Moonshot AI from thesvg.org (`https://thesvg.org/icons/<slug>/mono.svg`, or `light.svg`/`default.svg` when the catalogue has no mono variant; the Gemini sparkle is the mask shape of its colour file). Each is reduced to `currentColor` geometry with `role="img"` and an `aria-label`, because here the mark is the content. Every mark component also carries that name as `label`, which the strip uses as its React key; every factory-made component is named `Mark`, so `Mark.name` would collide. Every viewBox is a square centred on the mark’s ink, measured with `getBBox` in a headless browser, so all six share one box and one optical centre; the heavy Grok slash gets a slightly larger box and the thin DeepSeek whale a slightly smaller one so they read the same size as the rest. The strip (`site/components/providers.tsx`) renders them at `size-6` in `text-text-tertiary` with `gap-x-9 gap-y-4`, flat, monochrome, with no tile behind them, followed by “and more”. The hero’s copy-prompt button reuses `OpenAiMark`, `ClaudeMark`, and `GeminiMark` at `size-3.5`. To add a provider: fetch the mark, measure its ink, generate the centred square viewBox, keep the fill `currentColor`.

## Content and voice

- All page copy lives in `site/lib/content.ts` and is shared by the HTML sections, the markdown page (`site/lib/pageMarkdown.ts`), and `renderLlmsTxt` in `site/lib/llmsKnowledge.ts`. Change the constant, never the JSX, and check `site/public/llms.txt` still equals `renderLlmsTxt()` after a build.
- Machine-readable URLs come from `site/lib/agentResources.ts`; the footer, 404, head links, sitemap, and OpenAPI all read that list.
- Operator voice. Speak to the reader as “you”: “Your GitHub credentials and AI keys stay in your account.”
- Sentence case for every heading, tab, button, and table header.
- Short sentences. No puffery, no chatbot filler. If a sentence could sit in another product’s page unchanged, cut it.
- No em dashes in site copy. Use a full stop, a comma, or a colon. En dashes only for ranges (`P0–P2`), the ellipsis character for elided arguments (`/ask …`), middle dots for inline lists (`Your servers · your keys`), and curly quotes when quoting.
- Real product words, not marketing ones: `/review`, `/describe`, `/ask`, `/triage`, `FEATURE_*`, “pull request”, “GitHub App”.
- Competitor claims stay factual and come from each product’s public pages. A hosted reviewer with a self-host tier counts as “partial” for the ownership rows. Do not add a criterion you cannot source.
- The public docs rules in `AGENTS.md` (Public documentation) apply to the site as well: a behaviour, env, feature-mode, host, or privacy change updates `content.ts`, `llmsKnowledge.ts`, and `site/public/llms.txt` in the same PR as the README.

## Do and don’t

Learned over the design session. Treat these as review criteria for any site change.

**Do**

- Keep changes literal and minimal. When asked to change one thing, change that thing.
- Restore rather than reinterpret. If something the maintainer liked is lost, put it back as it was.
- Keep copy short. One sentence where one sentence works.
- Keep small marks small: the loop card’s info dot is 18px and its label is 12px subtext.
- Fix heights that would otherwise move: the tab panel is `lg:h-[39rem]`, the preview frame `h-[24rem] sm:h-[27rem]`, and the loop card rows `h-10` and `h-20`, so nothing shifts between tabs or states.
- Hide scrollbars and signal overflow with a fade (`scrollbar-none` plus the mask on the preview).
- Merge logos with their text: flat, monochrome, `currentColor`, no tile behind them.
- Merge the tab strip into its card: one shell, one shadow.
- Use soft, realistic, layered shadows everywhere depth is needed. Never a border for depth.
- Reuse `Section`, `SectionHeading`, `Eyebrow`, the `.btn` chassis, the card recipe, the icon tile, and the tokens. A new section built from those already looks right.
- Keep the PR Agent look no matter what feature is added: white sheet, blue washes, GitHub mocks, calm spacing.

**Don’t**

- Add elements nobody asked for. A CTA that grew an extra checks mock and longer copy was rejected as far too verbose and tall; the banner now holds a heading, one sentence, and one command box.
- Reach for a primitive colour, a hex value, or a Tailwind stock colour in a component. Only `--color-*` tokens exist as utilities on purpose.
- Draw a UI icon by hand or pull one from another icon set.
- Put a white tile, card, or pill behind a logo.
- Let a preview, a mock, or a tab change the height of its row.
- Show a native scrollbar inside a card.
- Use `transition: all`, animate on page load outside the hero, or animate a menu’s entrance.
- Use an em dash, title case, or a sentence that talks about the product instead of to the reader.
- Add a dark mode, a second theme mechanism, or per-component colour overrides.
- Preserve complexity because it already exists. The smallest recipe that makes the design clear wins (`AGENTS.md`, Design taste).

## Verification

Run these before calling a site change done. They are the checks the maintainer expects to see in the PR.

1. Repository gate:

   ```bash
   nub run check:code
   nub run --node site:build
   ```

   `check:code` runs the typecheck, `oxlint`, and `oxfmt --check`. The site build runs `vite build` and two `tsc --noEmit` passes, and its `emitLlmsTxt` plugin rewrites `site/public/llms.txt`; `git status site/public/llms.txt` must be clean afterwards, or the regenerated file belongs in the same commit. Run `nub run fmt` if the format check fails.

2. Screenshots at three widths. Start the dev server (`nub run site:dev`, port 3000), note its process id so you stop only what you started, then drive it with Playwright. Playwright is not a repository dependency, so install it into a throwaway directory and point `NODE_PATH` at it (`npx -p playwright node -e` does not resolve the module from the repo). `playwright install chromium` is instant when that build is already in `~/.cache/ms-playwright`:

   ```bash
   work="$(mktemp -d)"
   npm --prefix "$work" install --silent playwright
   "$work/node_modules/.bin/playwright" install chromium
   NODE_PATH="$work/node_modules" node -e '
   const { chromium } = require("playwright");
   (async () => {
     const browser = await chromium.launch();
     for (const width of [1440, 820, 390]) {
       const page = await browser.newPage({ viewport: { width, height: 900 } });
       await page.goto("http://127.0.0.1:3000/", { waitUntil: "load" });
       await page.screenshot({ path: `/tmp/site-${width}.png`, fullPage: true });
       const overflow = await page.evaluate(
         () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
       );
       console.log(width, overflow === 0 ? "no horizontal overflow" : `overflow ${overflow}px`);
       await page.close();
     }
     await browser.close();
   })();
   '
   ```

   Look at all three images. 1440 is the desktop layout, 820 the tablet layout where the comparison table is still a table and the tab strip is four wide, 390 the phone layout where the comparison becomes cards and the strip is two by two.

3. `document.documentElement.scrollWidth <= document.documentElement.clientWidth` at every width. Any horizontal overflow is a bug, usually a mock or a code line missing `min-w-0`, `truncate`, or `overflow-x-auto`.

4. Expected noise: `/_vercel/insights/script.js` returns 404 locally. The analytics script only exists on Vercel. Ignore that request and nothing else.

5. For copy changes, also read the markdown twin (`curl -H 'Accept: text/markdown' http://127.0.0.1:3000/`) so the shared constants render sensibly without markup.

## File map

| Path                                  | Owns                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `site/app/globals.css`                | Fonts, primitives, semantic tokens, radii, shadows, motion, component classes, utilities     |
| `site/app/__root.tsx`                 | Head metadata, font preload, skip link, `.page-frame`                                        |
| `site/app/index.tsx`                  | Section order                                                                                |
| `site/components/section.tsx`         | `Section`, `SectionHeading`, `Eyebrow`                                                       |
| `site/components/button.tsx`          | `Button`, `ButtonLink`                                                                       |
| `site/components/icons.tsx`           | Every UI icon (Hugeicons)                                                                    |
| `site/components/header.tsx`          | Sticky header, mobile menu                                                                   |
| `site/components/hero.tsx`            | Hero copy, staggered entrance, hero wash                                                     |
| `site/components/pr-window.tsx`       | The decorative pull request window                                                           |
| `site/components/providers.tsx`       | Provider strip                                                                               |
| `site/components/provider-logos.tsx`  | Model provider marks                                                                         |
| `site/components/features.tsx`        | “How it works” timeline                                                                      |
| `site/components/use-cases.tsx`       | Output example tabs                                                                          |
| `site/components/capabilities.tsx`    | Commands bento, loop card, triage card                                                       |
| `site/components/pricing.tsx`         | `$0` figure and three shell cards, each with an inset wash panel, a mark, and a line of copy |
| `site/components/alternatives.tsx`    | Comparison table and cards                                                                   |
| `site/components/brand-logos.tsx`     | Competitor marks                                                                             |
| `site/components/faq.tsx`             | Native accordion                                                                             |
| `site/components/quickstart.tsx`      | Installation steps                                                                           |
| `site/components/code-block.tsx`      | `CodeBlock`                                                                                  |
| `site/components/copy-button.tsx`     | `CopyButton`                                                                                 |
| `site/components/cta-banner.tsx`      | Closing wash banner and clone command                                                        |
| `site/components/footer.tsx`          | Footer columns, social links, legal bar, wordmark                                            |
| `site/components/not-found.tsx`       | 404 page                                                                                     |
| `site/components/github-output/*.tsx` | GitHub-styled primitives and the four output mocks                                           |
| `site/lib/content.ts`                 | Every line of page copy                                                                      |
| `site/lib/agentResources.ts`          | Every machine-readable URL                                                                   |
| `site/lib/pageMarkdown.ts`            | Markdown twin of the page and the 404                                                        |
| `site/lib/llmsKnowledge.ts`           | `renderLlmsTxt` and the agent profile                                                        |
| `site/assets/logo-source.png`         | Source of the two accent blues and the social card logo                                      |
| `site/scripts/generate-og-image.mjs`  | Social card, hand-mirrored tokens and hero layout                                            |
| `site/assets/fonts/`                  | Geist and Geist Mono variable `ttf` for the social card, plus licence                        |
| `site/public/fonts/`                  | Geist and Geist Mono `woff2` plus licence                                                    |
| `docs/development.md` (Landing site)  | The pointer to this file and the markdown negotiation rules                                  |
