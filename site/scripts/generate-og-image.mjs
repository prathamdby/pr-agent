import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const publicDir = join(import.meta.dirname, "..", "public");
const logoPath = join(import.meta.dirname, "..", "assets", "logo-source.png");
const outPath = join(publicDir, "og-image.png");

const width = 1200;
const height = 630;
const logoTargetHeight = 280;
const logoPaddingLeft = 100;
const textGap = 72;

const background = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#fafafa" rx="0"/>
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
    <text x="${textLeft}" y="282" font-family="Geist Sans, ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="72" font-weight="600" fill="#171717">PR Agent</text>
    <text x="${textLeft}" y="340" font-family="Geist Sans, ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="28" font-weight="400" fill="#4d4d4d">Self-hosted AI pull request review platform</text>
    <text x="${textLeft}" y="384" font-family="Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="400" fill="#7d7d7d">Reviews · Descriptions · Q&amp;A</text>
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
