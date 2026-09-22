import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

/*
  Social card in the site's light theme. Colours mirror the semantic tokens in app/globals.css.
  Text renders with whatever sans-serif fontconfig resolves; Geist is named first so a machine
  with it installed matches the page exactly.
*/
const publicDir = join(import.meta.dirname, "..", "public");
const logoPath = join(import.meta.dirname, "..", "assets", "logo-source.png");
const outPath = join(publicDir, "og-image.png");

const width = 1200;
const height = 630;
const logoSize = 132;
const paddingLeft = 96;

const sans = "Geist, Inter, 'DejaVu Sans', ui-sans-serif, system-ui, sans-serif";

const background = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="wash" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="55%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#d9eafe"/>
      </linearGradient>
      <pattern id="grid" width="36" height="36" patternUnits="userSpaceOnUse">
        <path d="M 36 0 L 0 0 0 36" fill="none" stroke="#1e69e9" stroke-opacity="0.07" stroke-width="1"/>
      </pattern>
      <radialGradient id="fade" cx="82%" cy="18%" r="70%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#wash)"/>
    <rect width="${width}" height="${height}" fill="url(#grid)"/>
    <rect width="${width}" height="${height}" fill="url(#fade)" opacity="0.55"/>
  </svg>`,
);

const logo = await sharp(readFileSync(logoPath)).resize(logoSize, logoSize).png().toBuffer();

const logoLeft = paddingLeft;
const logoTop = 118;
const textLeft = paddingLeft;

const textOverlay = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${textLeft + logoSize + 28}" y="${logoTop + 82}" font-family="${sans}" font-size="44" font-weight="600" fill="#0f1522" letter-spacing="-1">PR Agent</text>
    <text x="${textLeft}" y="352" font-family="${sans}" font-size="66" font-weight="500" fill="#0f1522" letter-spacing="-2.4">AI PR reviews</text>
    <text x="${textLeft}" y="428" font-family="${sans}" font-size="66" font-weight="500" fill="#0f1522" letter-spacing="-2.4">on your own servers</text>
    <rect x="${textLeft}" y="478" width="222" height="48" rx="24" fill="#1e69e9"/>
    <text x="${textLeft + 111}" y="510" text-anchor="middle" font-family="${sans}" font-size="21" font-weight="500" fill="#ffffff">No per-seat fee</text>
    <text x="${textLeft + 246}" y="510" font-family="${sans}" font-size="21" font-weight="400" fill="#4a5568">MIT licensed · Docker Compose · Bring your own model keys</text>
  </svg>`,
);

await sharp(background)
  .resize(width, height)
  .composite([
    { input: logo, left: logoLeft, top: logoTop },
    { input: textOverlay, left: 0, top: 0 },
  ])
  .png({ compressionLevel: 9, palette: true, colors: 128 })
  .toFile(outPath);

console.log(`Wrote ${outPath}`);
