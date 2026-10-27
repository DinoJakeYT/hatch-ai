// Command-line preview, so every AI engine (Claude, ChatGPT, Gemini...) can see what it built.
//   "<Hatch>\node_modules\electron\dist\electron.exe" "<Hatch>\tools\preview.mjs" <file-or-url>
// Prints the screenshot's path (plus any page errors); the AI then opens that PNG with its own image viewer.
import { app } from 'electron';
import path from 'node:path';
import { capture } from '../lib/preview.mjs';

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const target = process.argv.slice(2).find(a => !a.startsWith('--'));
  const outDir = path.join(app.getPath('appData'), 'Hatch', 'previews');
  try {
    if (!target) throw new Error('Usage: preview.mjs <file.html | image | program.exe | http://url>');
    const r = await capture(/^https?:\/\//i.test(target) ? target : path.resolve(target), outDir);
    console.log(`Screenshot saved: ${r.image}`);
    if (r.colors) console.log(`Size ${r.size.width}x${r.size.height}, main colors: ${r.colors}`);
    if (r.blank) console.log('Note: the screenshot is almost one solid color, so nothing may be drawn.');
    if (r.errors.length) console.log(`Page errors:\n${r.errors.join('\n')}`);
  } catch (err) {
    console.error(`Preview failed: ${err.message}`);
    process.exitCode = 1;
  }
  app.quit();
});
