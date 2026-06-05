import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const publicDir = join(import.meta.dirname, "..", "public");
const logoPath = join(publicDir, "logo.png");
const outPath = join(publicDir, "og-image.png");

const width = 1200;
const height = 630;
const logoTargetHeight = 300;
const logoPaddingLeft = 100;
const textGap = 80;

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

const logoMeta = await sharp(readFileSync(logoPath)).metadata();
const logoAspect = (logoMeta.width ?? 1) / (logoMeta.height ?? 1);
const logoHeight = logoTargetHeight;
const logoWidth = Math.round(logoHeight * logoAspect);

const logo = await sharp(readFileSync(logoPath)).resize(logoWidth, logoHeight).png().toBuffer();

const logoLeft = logoPaddingLeft;
const logoTop = Math.round((height - logoHeight) / 2);
const textLeft = logoLeft + logoWidth + textGap;

const textOverlay = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${textLeft}" y="270" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="72" font-weight="700" fill="#ffffff">PR Agent</text>
    <text x="${textLeft}" y="340" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="32" font-weight="400" fill="rgba(255,255,255,0.92)">Self-hosted AI pull request review platform</text>
    <text x="${textLeft}" y="390" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="24" font-weight="400" fill="rgba(255,255,255,0.75)">Reviews · Descriptions · Q&amp;A</text>
  </svg>`,
);

await sharp(background)
  .resize(width, height)
  .composite([
    { input: logo, left: logoLeft, top: logoTop },
    { input: textOverlay, left: 0, top: 0 },
  ])
  .png()
  .toFile(outPath);

console.log(`Wrote ${outPath}`);
