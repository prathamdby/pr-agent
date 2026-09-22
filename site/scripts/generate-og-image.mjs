import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
  Social card at 1200×630. The layout is the hero of the landing page: wordmark, heading, pills,
  and the PrWindow mock inside a wash card. Positions were measured from that markup at 1× and the
  colours mirror the semantic tokens in app/globals.css, so a token change means a regeneration.

  Text goes through librsvg and fontconfig, not a browser. Geist ships as woff2 for the page, which
  that stack cannot read, so ../assets/fonts carries the same faces as TTF and the script points
  fontconfig at only that directory. Every glyph then comes from Geist on any machine.
*/
const siteDir = join(import.meta.dirname, "..");
const fontDir = join(siteDir, "assets", "fonts");
const outPath = join(siteDir, "public", "og-image.png");

const fontConfigDir = join(tmpdir(), "pr-agent-og-fontconfig");
mkdirSync(fontConfigDir, { recursive: true });
writeFileSync(
  join(fontConfigDir, "fonts.conf"),
  `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${join(fontConfigDir, "cache")}</cachedir>
</fontconfig>
`,
);
process.env.FONTCONFIG_FILE = join(fontConfigDir, "fonts.conf");
const sharp = (await import("sharp")).default;

const WIDTH = 1200;
const HEIGHT = 630;

const color = {
  surface: "#ffffff",
  surfaceRaised: "#f6f7f9",
  line: "#e3e6eb",
  text: "#0f1522",
  textSecondary: "#4a5568",
  textTertiary: "#7f8a9c",
  accentSolid: "#1e69e9",
  accentText: "#1858cc",
  washStrong: "#b9dcfc",
  washMid: "#d9eafe",
  washSoft: "#edf5ff",
  success: "#1a7f37",
  successSoft: "#dcf7e3",
};

const sans = "Geist";
const mono = "Geist Mono";

/* Geist: ascender 1005 and descender 295 per 1000 units, so a line of text is 1.3em tall. */
const ASCENT = 1.005;
const CONTENT = 1.3;

/** Baseline of line `index` in a block whose top edge is `top`, for CSS font-size and line-height. */
const baseline = (top, size, lineHeight, index = 0) =>
  top + index * lineHeight + (lineHeight - CONTENT * size) / 2 + ASCENT * size;

const esc = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const text = (x, y, content, opts = {}) => {
  const {
    size = 12,
    weight = 400,
    fill = color.text,
    family = sans,
    spacing,
    anchor,
    italic = false,
  } = opts;
  const attrs = [
    `font-family="${family}"`,
    `font-size="${size}"`,
    `font-weight="${weight}"`,
    `fill="${fill}"`,
    spacing === undefined ? "" : `letter-spacing="${spacing}"`,
    anchor === undefined ? "" : `text-anchor="${anchor}"`,
  ]
    .filter(Boolean)
    .join(" ");
  const body = Array.isArray(content) ? content.join("") : esc(content);
  // Geist ships upright only here; a 12° skew stands in for the italic instance.
  return italic
    ? `<text transform="translate(${x} ${y}) skewX(-12)" ${attrs}>${body}</text>`
    : `<text x="${x}" y="${y}" ${attrs}>${body}</text>`;
};

const tspan = (content, opts = {}) => {
  const attrs = Object.entries({
    "font-weight": opts.weight,
    fill: opts.fill,
    "font-family": opts.family,
    "font-size": opts.size,
    dx: opts.dx,
  })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  return `<tspan${attrs}>${esc(content)}</tspan>`;
};

const rect = (x, y, w, h, opts = {}) => {
  const { r = 0, fill = "none", stroke, strokeWidth = 1, opacity, filter, clip } = opts;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${
    stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ""
  }${opacity === undefined ? "" : ` opacity="${opacity}"`}${filter ? ` filter="url(#${filter})"` : ""}${
    clip ? ` clip-path="url(#${clip})"` : ""
  }/>`;
};

const hline = (x, y, w, fill = color.line) => rect(x, y, w, 1, { fill });

/* Hugeicons stroke-rounded glyphs on a 24-unit grid, drawn at 1.5 stroke like components/icons.tsx. */
const glyphs = {
  tick: ['<path d="M5 14L8.5 17.5L19 6.5"/>'],
  info: [
    '<circle cx="12" cy="12" r="10"/>',
    '<path d="M12 16V12"/>',
    '<path d="M12.125 8.25H12M12.25 8.25C12.25 8.11193 12.1381 8 12 8C11.8619 8 11.75 8.11193 11.75 8.25C11.75 8.38807 11.8619 8.5 12 8.5C12.1381 8.5 12.25 8.38807 12.25 8.25Z"/>',
  ],
};

const icon = (name, x, y, size, stroke) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${glyphs[name].join("")}</svg>`;

const logoData = `data:image/png;base64,${readFileSync(join(siteDir, "public", "logo.png")).toString("base64")}`;
const logo = (x, y, size, clip) =>
  `<image href="${logoData}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${clip})"/>`;

const codeChip = (x, y, w, label) =>
  rect(x, y, w, 16, { r: 6, fill: color.surfaceRaised }) +
  text(x + 4, baseline(y + 1, 11, 14), label, { size: 11, family: mono });

const countPill = (x, label) =>
  rect(x, 201.5, 18, 16.3, { r: 8.15, fill: color.surfaceRaised, filter: "ring" }) +
  text(x + 9, baseline(202.5, 10, 13), label, {
    size: 10,
    fill: color.textSecondary,
    anchor: "middle",
  });

/* Cloud puffs from .wash-clouds, given as fractions of the box that is the wash card grown by 20%. */
const clouds = [
  [0.18, 0.82, 0.34, 0.26, 0.95],
  [0.36, 0.92, 0.2, 0.16, 0.9],
  [0.8, 0.86, 0.3, 0.24, 0.92],
  [0.93, 0.7, 0.16, 0.13, 0.85],
  [0.86, 0.2, 0.26, 0.2, 0.8],
  [0.1, 0.16, 0.14, 0.11, 0.75],
];

const wash = { x: 640, y: 40, w: 616, h: 654 };
const cloudBox = {
  x: wash.x - wash.w * 0.2,
  y: wash.y - wash.h * 0.2,
  w: wash.w * 1.4,
  h: wash.h * 1.4,
};

const defs = `
  <defs>
    <linearGradient id="wash" x1="0.213" y1="0.09" x2="0.787" y2="0.91">
      <stop offset="0" stop-color="${color.washStrong}"/>
      <stop offset="0.48" stop-color="${color.washMid}"/>
      <stop offset="1" stop-color="${color.washSoft}"/>
    </linearGradient>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse" x="${wash.x}" y="${wash.y}">
      <path d="M28 0H0V28" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1"/>
    </pattern>
    <radialGradient id="gridFade" cx="0.5" cy="0.4" r="0.5">
      <stop offset="0.3" stop-color="#ffffff"/>
      <stop offset="0.9" stop-color="#000000"/>
    </radialGradient>
    <mask id="gridMask">
      ${rect(wash.x, wash.y, wash.w, wash.h, { fill: "url(#gridFade)" })}
    </mask>
    ${clouds
      .map(
        ([, , , , alpha], i) => `<radialGradient id="cloud${i}">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${alpha}"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>`,
      )
      .join("\n    ")}
    <filter id="cloudBlur" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
    <filter id="ring" x="-5%" y="-10%" width="110%" height="120%">
      <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="grow"/>
      <feFlood flood-color="${color.text}" flood-opacity="0.07"/>
      <feComposite in2="grow" operator="in"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="soft" x="-10%" y="-20%" width="120%" height="160%">
      <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="grow"/>
      <feFlood flood-color="${color.text}" flood-opacity="0.05" result="ringFill"/>
      <feComposite in="ringFill" in2="grow" operator="in" result="ring"/>
      <feDropShadow in="SourceAlpha" dx="0" dy="2" stdDeviation="1.5" flood-color="${color.text}" flood-opacity="0.05" result="near"/>
      <feDropShadow in="SourceAlpha" dx="0" dy="8" stdDeviation="6" flood-color="${color.text}" flood-opacity="0.05" result="far"/>
      <feMerge><feMergeNode in="far"/><feMergeNode in="near"/><feMergeNode in="ring"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="float" x="-20%" y="-20%" width="140%" height="140%">
      <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="grow"/>
      <feFlood flood-color="${color.text}" flood-opacity="0.05" result="ringFill"/>
      <feComposite in="ringFill" in2="grow" operator="in" result="ring"/>
      <feDropShadow in="SourceAlpha" dx="0" dy="4" stdDeviation="3" flood-color="${color.text}" flood-opacity="0.06" result="near"/>
      <feDropShadow in="SourceAlpha" dx="0" dy="24" stdDeviation="20" flood-color="${color.text}" flood-opacity="0.07" result="far"/>
      <feDropShadow in="SourceAlpha" dx="0" dy="64" stdDeviation="40" flood-color="${color.accentSolid}" flood-opacity="0.06" result="glow"/>
      <feMerge><feMergeNode in="glow"/><feMergeNode in="far"/><feMergeNode in="near"/><feMergeNode in="ring"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="washClip">${rect(wash.x, wash.y, wash.w, wash.h, { r: 20 })}</clipPath>
    <clipPath id="windowClip">${rect(680, 80, 560, 664.4, { r: 12 })}</clipPath>
    <clipPath id="articleClip">${rect(696, 244.9, 528, 363, { r: 8 })}</clipPath>
    <clipPath id="checksClip">${rect(696, 619.9, 528, 108.5, { r: 8 })}</clipPath>
    <clipPath id="logoLarge">${rect(64, 93.4, 44, 44, { r: 6 })}</clipPath>
    <clipPath id="logoSmall">${rect(708, 252.9, 20, 20, { r: 6 })}</clipPath>
  </defs>`;

const hero = [
  logo(64, 93.4, 44, "logoLarge"),
  text(120, baseline(99.4, 24, 31), "PR Agent", { size: 24, weight: 600, spacing: -0.24 }),
  ...["AI PR reviews", "on your", "own servers"].map((line, i) =>
    text(64, baseline(173.4, 64, 66.56, i), line, { size: 64, weight: 500, spacing: -2.24 }),
  ),
  ...["Same first pass every pull request", "gets, without a per-seat bill."].map((line, i) =>
    text(64, baseline(397.1, 22, 35.75, i), line, { size: 22, fill: color.textSecondary }),
  ),
  ...[
    [64, 138, "MIT licensed"],
    [212, 158, "No per-seat fee"],
    [380, 201, "Your own model keys"],
  ].flatMap(([x, w, label]) => [
    rect(x, 500.6, w, 36, { r: 18, fill: color.surface, filter: "soft" }),
    icon("tick", x + 12, 510.6, 16, color.accentText),
    text(x + 36, baseline(508.3, 15, 19), label, { size: 15, fill: color.textSecondary }),
  ]),
];

const washCard = [
  rect(wash.x, wash.y, wash.w, wash.h, { r: 20, fill: "url(#wash)", filter: "soft" }),
  `<g clip-path="url(#washClip)">`,
  rect(wash.x, wash.y, wash.w, wash.h, { fill: "url(#grid)" }).replace(
    "/>",
    ' mask="url(#gridMask)"/>',
  ),
  `<g filter="url(#cloudBlur)">`,
  ...clouds.map(
    ([cx, cy, rx, ry], i) =>
      `<ellipse cx="${cloudBox.x + cx * cloudBox.w}" cy="${cloudBox.y + cy * cloudBox.h}" rx="${
        rx * cloudBox.w * 0.7
      }" ry="${ry * cloudBox.h * 0.7}" fill="url(#cloud${i})"/>`,
  ),
  `</g>`,
  `</g>`,
];

const windowChrome = [
  rect(680, 80, 560, 664.4, { r: 12, fill: color.surface, filter: "float" }),
  `<g clip-path="url(#windowClip)">`,
  rect(680, 80, 560, 42.9, { fill: color.surfaceRaised }),
  hline(680, 121.9, 560),
  ...[692, 708, 724].map((x) => `<circle cx="${x + 5}" cy="100.9" r="5" fill="${color.line}"/>`),
  rect(746, 88, 482, 25.9, { r: 6, fill: color.surface, filter: "ring" }),
  text(987, baseline(93, 11, 14), "github.com/acme/api/pull/284", {
    size: 11,
    fill: color.textTertiary,
    anchor: "middle",
  }),

  text(
    696,
    baseline(136.9, 15, 19),
    [
      tspan("Route env knobs through settings"),
      tspan("#284", { weight: 400, fill: color.textTertiary, dx: 4 }),
    ],
    { size: 15, weight: 600, spacing: -0.15 },
  ),
  rect(696, 165.5, 44, 21.9, { r: 10.95, fill: color.successSoft }),
  text(704, baseline(168.5, 11, 14), "Open", { size: 11, weight: 500, fill: color.success }),
  text(748, baseline(167.7, 12, 16), "pratham wants to merge 3 commits into", {
    fill: color.textSecondary,
  }),
  codeChip(980, 167.7, 36, "main"),
  text(1020, baseline(167.7, 12, 16), "from", { fill: color.textSecondary }),
  codeChip(1050, 167.7, 127, "pd/settings-knobs"),

  hline(696, 227.9, 528),
  text(696, baseline(200.4, 12, 16), "Conversation", { weight: 500 }),
  rect(696, 226.9, 76, 2, { fill: color.accentSolid }),
  text(792, baseline(200.9, 12, 16), "Commits", { fill: color.textSecondary }),
  countPill(849, "3"),
  text(887, baseline(200.9, 12, 16), "Checks", { fill: color.textSecondary }),
  countPill(934, "2"),
  text(972, baseline(200.9, 12, 16), "Files changed", { fill: color.textSecondary }),
  countPill(1056, "6"),
  `</g>`,
];

const findings = [
  {
    top: 447.1,
    label: "P1 · c4",
    title: "Webhook ack can race the durable write",
    marker: "On the diff ·",
    chip: [883, 162, "src/webhooks/intake.ts"],
    lines: "· lines 148–152",
  },
  {
    top: 503.5,
    label: "P2 · c3",
    title: "Summary edit ignores stale head guard",
    marker: "Summary only ·",
    chip: [903, 155, "src/review/publish.ts"],
    lines: "· line 91",
  },
];

const reviewComment = [
  rect(696, 244.9, 528, 363, { r: 8, fill: color.surface, filter: "soft" }),
  `<g clip-path="url(#articleClip)">`,
  rect(696, 244.9, 528, 37, { fill: color.surfaceRaised }),
  hline(696, 280.9, 528),
  logo(708, 252.9, 20, "logoSmall"),
  text(736, baseline(254.1, 12, 16), "pr-agent", { weight: 600 }),
  rect(789, 255.1, 24, 15, { r: 6, fill: color.surfaceRaised, filter: "ring" }),
  text(793, baseline(256.1, 10, 13), "bot", { size: 10, weight: 500, fill: color.textSecondary }),
  text(816, baseline(254.1, 12, 16), "commented just now", { fill: color.textSecondary }),
  text(1084, baseline(254.9, 11, 14), "Pull request conversation", {
    size: 11,
    fill: color.textTertiary,
  }),

  text(710, baseline(294.9, 14, 18), "PR Agent Review", { size: 14, weight: 600 }),
  hline(710, 319.9, 500),

  rect(710, 332.9, 3, 66.3, { fill: color.accentSolid }),
  icon("info", 725, 337.6, 14, color.accentText),
  text(743, baseline(335.9, 12, 16), "Note", { weight: 500, fill: color.accentText }),
  ...[
    "Adds a retry wrapper around the webhook dispatcher so transient GitHub failures do",
    "not drop deliveries.",
  ].map((line, i) => text(725, baseline(358.1, 12, 19.5, i), line, { fill: color.textSecondary })),

  text(710, baseline(420.1, 12, 16), "Size", { weight: 600 }),
  codeChip(822, 420.1, 15, "M"),
  hline(710, 446.1, 500),
  ...findings.flatMap((f) => [
    text(710, baseline(f.top + 9.5, 12, 16), f.label, { weight: 600 }),
    text(822, baseline(f.top + 9.5, 12, 16), f.title, { weight: 500 }),
    text(822, baseline(f.top + 31, 11, 14), f.marker, {
      size: 11,
      fill: color.textTertiary,
      italic: true,
    }),
    codeChip(f.chip[0], f.top + 30, f.chip[1], f.chip[2]),
    text(f.chip[0] + f.chip[1] + 4, baseline(f.top + 31, 11, 14), f.lines, {
      size: 11,
      fill: color.textTertiary,
      italic: true,
    }),
    hline(710, f.top + 55.4, 500),
  ]),
  text(710, baseline(569.4, 12, 16), "Mergeability", { weight: 600 }),
  text(822, baseline(569.4, 12, 16), "Two-way: trivial to revert; only error-message rendering.", {
    fill: color.textSecondary,
  }),
  `</g>`,

  rect(696, 619.9, 528, 108.5, { r: 8, fill: color.surface, filter: "soft" }),
  `<g clip-path="url(#checksClip)">`,
  rect(696, 619.9, 528, 36.5, { fill: color.surfaceRaised }),
  hline(696, 655.4, 528),
  `</g>`,
];

const svg = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  ${defs}
  ${rect(0, 0, WIDTH, HEIGHT, { fill: color.surface })}
  ${hero.join("\n  ")}
  ${washCard.join("\n  ")}
  <g clip-path="url(#washClip)">
  ${windowChrome.join("\n  ")}
  ${reviewComment.join("\n  ")}
  </g>
</svg>`;

/* Rasterise at 2× and downsample so text and hairlines get the same anti-aliasing a browser gives. */
await sharp(Buffer.from(svg), { density: 144 })
  .resize(WIDTH, HEIGHT, { kernel: "lanczos3" })
  .png({ compressionLevel: 9 })
  .toFile(outPath);

console.log(`Wrote ${outPath}`);
