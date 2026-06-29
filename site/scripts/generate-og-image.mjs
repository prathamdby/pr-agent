import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const publicDir = join(import.meta.dirname, "..", "public");
const logoPath = join(import.meta.dirname, "..", "assets", "logo-source.png");
const outPath = join(publicDir, "og-image.png");

const width = 1200;
const height = 630;
const logoTargetHeight = 190;
const logoPaddingLeft = 86;
const textGap = 64;

const background = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <rect x="0" y="0" width="22" height="${height}" fill="#2563eb"/>
    <circle cx="1090" cy="96" r="46" fill="#dbeafe"/>
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
    <text x="${textLeft}" y="228" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="56" font-weight="800" fill="#111827">PR Agent</text>
    <text x="${textLeft}" y="308" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="44" font-weight="700" fill="#111827">AI reviews pull requests</text>
    <text x="${textLeft}" y="366" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="44" font-weight="700" fill="#111827">on your own servers</text>
    <rect x="${textLeft}" y="416" width="394" height="58" rx="12" fill="#2563eb"/>
    <text x="${textLeft + 28}" y="455" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="25" font-weight="700" fill="#ffffff">No per-seat fee</text>
    <text x="${textLeft}" y="528" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="25" font-weight="500" fill="#4b5563">MIT licensed · Docker Compose · BYO model keys</text>
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
