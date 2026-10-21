import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  textTertiary: "#687286",
  accentSolid: "#1e69e9",
  accentText: "#1858cc",
  washStrong: "#b9dcfc",
  washMid: "#d9eafe",
  washSoft: "#edf5ff",
  danger: "#c9262f",
  dangerSoft: "#ffe9e6",
};

const sans = "Geist";
const mono = "Geist Mono";

const ASCENT = 1.005;
const CONTENT = 1.3;

const baseline = (top, size, lineHeight) => top + (lineHeight - CONTENT * size) / 2 + ASCENT * size;

const esc = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const text = (x, y, content, opts = {}) => {
  const { size = 12, weight = 400, fill = color.text, family = sans, spacing, anchor } = opts;
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
  return `<text x="${x}" y="${y}" ${attrs}>${esc(content)}</text>`;
};

const rect = (x, y, w, h, opts = {}) => {
  const { r = 0, fill = "none" } = opts;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
};

const logoData = `data:image/png;base64,${readFileSync(join(siteDir, "public", "logo.png")).toString("base64")}`;
const logo = (x, y, size, clip) =>
  `<image href="${logoData}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${clip})"/>`;

const clouds = [
  [-168, -13, 528, 151, 0.85],
  [96, -25, 336, 101, 0.7],
  [816, 6, 576, 164, 0.85],
  [792, -6, 288, 88, 0.65],
  [-192, 265, 480, 202, 0.9],
  [900, 214, 528, 227, 0.9],
];

const headline = { size: 72, spacing: -2.52 };
const pill = { x: 263, y: 136, w: 387, h: 80, rotate: -2 };
const win = { x: 200, y: 264, w: 800, h: 420, r: 20, bar: 64 };

const neutralLayers = [
  [1, 1, 0.03],
  [2, 2, 0.03],
  [4, 4, 0.03],
  [8, 8, 0.03],
];
const windowLayers = [
  ...neutralLayers,
  [16, 16, 0.04],
  [32, 32, 0.04],
  [64, 64, 0.08, color.accentSolid],
];
const blurs = [...new Set(windowLayers.map(([, blur]) => blur))];

const roundRect =
  (x, y, w, h, r) =>
  ({ grow = 0, dy = 0, fill, opacity, blur }) =>
    `<rect x="${x - grow}" y="${y + dy - grow}" width="${w + grow * 2}" height="${h + grow * 2}" rx="${r + grow}" fill="${fill}"${
      opacity === undefined ? "" : ` opacity="${opacity}"`
    }${blur ? ` filter="url(#blur${blur})"` : ""}/>`;

const circle =
  (cx, cy, radius) =>
  ({ grow = 0, dy = 0, fill, opacity, blur }) =>
    `<circle cx="${cx}" cy="${cy + dy}" r="${radius + grow}" fill="${fill}"${
      opacity === undefined ? "" : ` opacity="${opacity}"`
    }${blur ? ` filter="url(#blur${blur})"` : ""}/>`;

const elevated = (shape, fill, { layers = [], ring }) => [
  ...layers
    .toReversed()
    .map(([dy, blur, opacity, flood = color.text]) => shape({ dy, fill: flood, opacity, blur })),
  ring === undefined ? "" : shape({ grow: 1, fill: color.text, opacity: ring }),
  shape({ fill }),
];

const defs = `
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color.washStrong}"/>
      <stop offset="0.34" stop-color="${color.washMid}"/>
      <stop offset="0.62" stop-color="${color.washSoft}"/>
      <stop offset="1" stop-color="${color.surface}"/>
    </linearGradient>
    <linearGradient id="pillFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color.surface}"/>
      <stop offset="0.45" stop-color="${color.washSoft}"/>
      <stop offset="1" stop-color="${color.washMid}"/>
    </linearGradient>
    ${clouds
      .map(
        ([, , , , alpha], i) => `<radialGradient id="cloud${i}">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${alpha}"/>
      <stop offset="0.7" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>`,
      )
      .join("\n    ")}
    <filter id="cloudBlur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
    ${blurs
      .map(
        (blur) => `<filter id="blur${blur}" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="${blur / 2}"/>
    </filter>`,
      )
      .join("\n    ")}
    <clipPath id="windowClip">${rect(win.x, win.y, win.w, win.h, { r: win.r })}</clipPath>
    <clipPath id="logoPill">${rect(pill.x + 18, pill.y + 18, 44, 44, { r: 9 })}</clipPath>
    <clipPath id="logoComment">${rect(240, 360, 44, 44, { r: 10 })}</clipPath>
  </defs>`;

const sky = [
  rect(0, 0, WIDTH, HEIGHT, { fill: "url(#sky)" }),
  `<g filter="url(#cloudBlur)">`,
  ...clouds.map(
    ([x, y, w, h], i) =>
      `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="url(#cloud${i})"/>`,
  ),
  `</g>`,
];

const headlineText = (x, top, content, opts = {}) =>
  text(x, baseline(top, headline.size, opts.lineHeight ?? 76), content, {
    size: headline.size,
    weight: 500,
    spacing: headline.spacing,
    ...opts,
  });

const heading = [
  headlineText(WIDTH / 2, 52, "Every pull request gets a", { anchor: "middle" }),
  `<g transform="rotate(${pill.rotate} ${pill.x + pill.w / 2} ${pill.y + pill.h / 2})">`,
  ...elevated(roundRect(pill.x, pill.y, pill.w, pill.h, pill.h / 2), "url(#pillFill)", {
    layers: neutralLayers,
    ring: 0.05,
  }),
  ...elevated(circle(pill.x + 40, pill.y + 40, 34), color.surface, {
    layers: neutralLayers,
    ring: 0.05,
  }),
  logo(pill.x + 18, pill.y + 18, 44, "logoPill"),
  headlineText(pill.x + 88, pill.y + 6, "reviewer", { lineHeight: 68, fill: color.accentText }),
  `</g>`,
  headlineText(668, 138, "you host"),
];

const finding = (top, label, title, { labelFill, pillFill, pillRing }) => [
  ...elevated(roundRect(240, top + 1, 44, 40, 10), pillFill, { ring: pillRing }),
  text(262, baseline(top + 7, 24, 28), label, {
    size: 24,
    weight: 600,
    fill: labelFill,
    anchor: "middle",
  }),
  text(298, baseline(top, 34, 42), title, { size: 34, weight: 500, spacing: -0.34 }),
];

const prWindow = [
  ...elevated(roundRect(win.x, win.y, win.w, win.h, win.r), color.surface, {
    layers: windowLayers,
    ring: 0.05,
  }),
  `<g clip-path="url(#windowClip)">`,
  rect(win.x, win.y, win.w, win.bar, { fill: color.surfaceRaised }),
  rect(win.x, win.y + win.bar - 1, win.w, 1, { fill: color.line }),
  ...[224, 248, 272].map((x) => `<circle cx="${x + 7}" cy="296" r="7" fill="${color.line}"/>`),
  ...elevated(roundRect(312, 277, 602, 38, 10), color.surface, { ring: 0.07 }),
  text(613, baseline(284, 20, 24), "github.com/acme/api/pull/284", {
    size: 20,
    fill: color.textSecondary,
    anchor: "middle",
  }),

  logo(240, 360, 44, "logoComment"),
  text(298, baseline(364, 28, 36), "pr-agent", { size: 28, weight: 600 }),
  ...elevated(roundRect(429, 367, 52, 30, 8), color.surfaceRaised, { ring: 0.07 }),
  text(439, baseline(370, 20, 24), "bot", { size: 20, weight: 500, fill: color.textSecondary }),
  text(495, baseline(364, 28, 36), "commented just now", { size: 28, fill: color.textTertiary }),

  ...finding(432, "P1", "Webhook ack can race the durable write", {
    labelFill: color.danger,
    pillFill: color.dangerSoft,
  }),
  text(298, baseline(486, 21, 28), "src/webhooks/intake.ts · lines 148–152", {
    size: 21,
    family: mono,
    fill: color.textTertiary,
  }),
  rect(240, 542, 720, 1, { fill: color.line }),
  ...finding(571, "P2", "Summary edit ignores stale head guard", {
    labelFill: color.textSecondary,
    pillFill: color.surfaceRaised,
    pillRing: 0.07,
  }),
  `</g>`,
];

const svg = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  ${defs}
  ${sky.join("\n  ")}
  ${heading.join("\n  ")}
  ${prWindow.join("\n  ")}
</svg>`;

await sharp(Buffer.from(svg), { density: 144 })
  .resize(WIDTH, HEIGHT, { kernel: "lanczos3" })
  .png({ compressionLevel: 9 })
  .toFile(outPath);

console.log(`Wrote ${outPath}`);
