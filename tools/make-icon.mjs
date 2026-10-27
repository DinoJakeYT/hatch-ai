// Renders assets/logo.svg into assets/hatch.ico (16-256px) and assets/logo-256.png.
// Run with: npx electron tools/make-icon.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf8');
  const w = new BrowserWindow({ show: false });
  await w.loadURL('data:text/html,<html><body></body></html>');

  // draw the SVG at each size directly so small icons stay crisp
  const pngs = await w.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    await img.decode();
    return ${JSON.stringify(SIZES)}.map(s => {
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, s, s);
      return c.toDataURL('image/png').split(',')[1];
    });
  })()`);
  const images = pngs.map(b => Buffer.from(b, 'base64'));

  const header = Buffer.alloc(6 + 16 * SIZES.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(SIZES.length, 4);
  let offset = header.length;
  SIZES.forEach((s, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  fs.writeFileSync(path.join(root, 'assets', 'hatch.ico'), Buffer.concat([header, ...images]));
  fs.writeFileSync(path.join(root, 'assets', 'logo-256.png'), images[SIZES.indexOf(256)]);
  console.log('icon written');
  app.quit();
});
