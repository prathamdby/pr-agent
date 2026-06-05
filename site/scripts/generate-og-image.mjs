import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const logoPath = join(publicDir, "logo.png");
const outPath = join(publicDir, "og-image.png");

const width = 1200;
const height = 630;
const logoSize = 300;

const background = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#59B2FF"/>
        <stop offset="100%" stop-color="#1A4FD6"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)" rx="0"/>
  </svg>`,
);

const textOverlay = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="480" y="270" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="72" font-weight="700" fill="#ffffff">PR Agent</text>
    <text x="480" y="340" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="32" font-weight="400" fill="rgba(255,255,255,0.92)">Self-hosted AI pull request review platform</text>
    <text x="480" y="390" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="24" font-weight="400" fill="rgba(255,255,255,0.75)">Reviews · Descriptions · Q&amp;A</text>
  </svg>`,
);

const logo = await sharp(readFileSync(logoPath))
  .resize(logoSize, logoSize)
  .png()
  .toBuffer();

const logoLeft = 100;
const logoTop = Math.round((height - logoSize) / 2);

await sharp(background)
  .resize(width, height)
  .composite([
    { input: logo, left: logoLeft, top: logoTop },
    { input: textOverlay, left: 0, top: 0 },
  ])
  .png()
  .toFile(outPath);

console.log(`Wrote ${outPath}`);
