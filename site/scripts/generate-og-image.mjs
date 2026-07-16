import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const publicDir = join(import.meta.dirname, "..", "public");
const logoPath = join(import.meta.dirname, "..", "assets", "logo-source.png");
const outPath = join(publicDir, "og-image.png");

const width = 1200;
const height = 630;
const logoTargetHeight = 160;
const logoPaddingLeft = 86;
const textGap = 56;

const background = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="wash" cx="78%" cy="18%" r="55%">
        <stop offset="0%" stop-color="#1a211c"/>
        <stop offset="100%" stop-color="#0d110f"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="#0d110f"/>
    <rect width="${width}" height="${height}" fill="url(#wash)"/>
    <g fill="#5a6256" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="18" opacity="0.45">
      <text x="72" y="72">+</text><text x="140" y="96">/</text><text x="210" y="64">-</text>
      <text x="980" y="540">#</text><text x="1040" y="568">{</text><text x="1100" y="520">}</text>
      <text x="860" y="88">*</text><text x="920" y="120">~</text><text x="80" y="560">&gt;</text>
    </g>
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
    <text x="${textLeft}" y="236" font-family="Georgia, 'Times New Roman', serif" font-size="64" font-weight="400" fill="#e8ebe4">PR Agent</text>
    <text x="${textLeft}" y="310" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="34" font-weight="500" fill="#b4bbae">AI reviews pull requests</text>
    <text x="${textLeft}" y="358" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="34" font-weight="500" fill="#a8b492">on your own servers</text>
    <rect x="${textLeft}" y="410" width="248" height="52" fill="#e8ebe4"/>
    <text x="${textLeft + 28}" y="444" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="22" font-weight="600" fill="#0d110f">No per-seat fee</text>
    <text x="${textLeft}" y="512" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="22" font-weight="500" fill="#7d8678">MIT licensed · Docker Compose · BYO model keys</text>
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
