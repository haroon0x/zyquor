import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const buildDir = resolve(import.meta.dirname, "../build");
const source = await readFile(resolve(buildDir, "icon.svg"));

await mkdir(buildDir, { recursive: true });

const pngs = await Promise.all(
  sizes.map(async (size) => {
    const output = resolve(buildDir, `icon-${size}.png`);
    const png = await sharp(source)
      .resize(size, size, { fit: "fill" })
      .png()
      .toBuffer();
    await writeFile(output, png);
    return { size, output, png };
  }),
);

const appPng = pngs.find(({ size }) => size === 512);
if (!appPng) {
  throw new Error("Failed to render the 512px app icon");
}

await writeFile(resolve(buildDir, "icon.png"), appPng.png);
await writeFile(
  resolve(buildDir, "icon.ico"),
  await pngToIco(pngs.filter(({ size }) => size <= 256).map(({ output }) => output)),
);

console.log(`Generated ${sizes.length} PNG sizes, icon.png, and icon.ico in ${buildDir}`);
