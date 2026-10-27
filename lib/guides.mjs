// Guides: step-by-step methods that local models follow, like a stronger agent would.
// They live as Markdown files in %APPDATA%\Hatch\guides and can be edited in Settings.
// The first line "keywords: ..." decides when a guide is used; general.md is always used.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

export const GUIDES_DIR = path.join(DATA_DIR, 'guides');

const DEFAULTS = {
  'general.md': `keywords: *
# How to work
Work like an expert engineer, in this order. Do these steps with action tags; don't write them out as a tutorial.

1. Understand. If the project folder already has files, <list path="."/> and <read> the important ones before changing anything.
2. Plan. Write a short checklist of 3-7 small steps, each ending in something you can check:
<plan>
- [ ] first step
- [ ] second step
</plan>
3. Build in small steps. Do one step at a time. Always write COMPLETE files: no placeholders, no "...", no "rest of the code here".
4. Check your work. After changing code, build or run it (see the language guide) and read the output. For anything visual (web pages, window games), use <preview> to see what it looks like. Programs you run can't be typed into: pipe test input in instead, and let the user play/use it with <open>.
5. Fix errors properly. Read the FIRST error, look at that line in the file, fix the cause, then build again. Never run a failing command again without changing something first. For a small file (under ~150 lines), fix it by rewriting the whole file with <file>; use <edit> only for one small change in a big file.
6. Use what this PC has. Only use the tools listed under "Tools on this PC". Don't ask the user to install things unless there's truly no other way.
7. Keep the plan current. When a step is done, write the <plan> again with it marked - [x].
8. Finish honestly. Only say it works after a build or run succeeded. Then tell the user in one or two sentences how to open or play it.
`,
  'cpp.md': `keywords: c++, cpp, .cpp, .hpp, cmake, msvc, visual studio, win32, directx, opengl, raylib
# C++ guide
- Use the C++ compiler listed under "Tools on this PC", with ONE build command. No CMake unless the user asks.
- Start small: first a version that compiles and runs (a window that opens, or a board that prints). Build it. Then add one feature at a time and build after each.
- Console game: standard library only (iostream, string, vector, random, chrono, thread). Keys without pressing Enter: #include <conio.h>, then _kbhit() and _getch().
- 2D window game with nothing to download: start from the Hatch template <template name="cpp-2d-win32"/> (Win32 + GDI, a game loop, keyboard, drawing, score). You get its main.cpp back; change Update(dt) and Render(dc).
  Build it with: cl -nologo -EHsc -std:c++17 -O2 main.cpp -Fe:game.exe user32.lib gdi32.lib -link -subsystem:windows
- 3D game: see the 3D guide (templates cpp-3d-opengl and cpp-3d-raylib).
- Don't use SDL, SFML, raylib or other libraries unless the user already installed them.
- Keep it to a few files (main.cpp, plus game.h/game.cpp if it grows). Every .cpp file goes in the build command.
- Test it: <run timeout="5">./game.exe</run> starts it for 5 seconds to check it runs without crashing.
- Look at it: <preview path="game.exe"/> opens the program for a few seconds, takes a screenshot of its window and tells you what it shows. Use it to check a window game actually draws things.
- Programs you run get NO keyboard input, and nobody can type into them from the chat. To test a console game's input, pipe answers in: <run>printf '50\\n25\\n75\\n' | ./game.exe</run>
- Make console programs exit when input ends: if (!(std::cin >> guess)) return 0;
- If a test shows a bug, fix the code and build again. Don't run the same test again unchanged.
- When it builds and runs, <open path="game.exe"/> so the user can play it in its own window, and say so.
`,
  'cpp3d.md': `keywords: 3d, opengl, raylib, first person, fps, voxel, minecraft, 3d game, camera, cube, terrain, shooter, racing
# 3D C++ games guide
- Never write the window and 3D setup from scratch. Start from a Hatch template that already builds and runs, then change it:
  <template name="cpp-3d-raylib"/>   if raylib is installed (see "Tools on this PC"): the easiest, with DrawCube, DrawSphere, DrawModel, Camera3D, sounds
  <template name="cpp-3d-opengl"/>   otherwise: Win32 + OpenGL, built into Windows, nothing to download
  You get its main.cpp back. Build it once unchanged to see it works, then add your game one feature at a time.
- OpenGL template: put game rules in Update(dt) and drawing in Render(time). Draw with DrawBox(x, y, z, size, r, g, b) and glBegin/glEnd. The camera is cam (x, y, z, yaw, pitch).
  Build: cl -nologo -EHsc -std:c++17 -O2 main.cpp -Fe:game.exe user32.lib gdi32.lib opengl32.lib glu32.lib -link -subsystem:windows
- raylib template: game rules go before BeginDrawing, 3D drawing between BeginMode3D and EndMode3D, 2D text after EndMode3D. Use the raylib build command from "Tools on this PC".
  It includes raymath.h, so Vector3Add, Vector3Distance, Vector3Normalize, Clamp and + - * on Vector3 all work. For collisions use CheckCollisionBoxes or CheckCollisionSpheres.
- Keep everything in main.cpp until it's big. Simple shapes (cubes, spheres, planes) and colors are fine; no model or texture files unless the user gives them.
- Check it: build after every feature, then <preview path="game.exe"/> to see a screenshot of the running game. Fix anything black, empty or wrong.
- When it works, <open path="game.exe"/> so the user can play.
`,
  'web.md': `keywords: html, web, browser, website, webpage, javascript, css, canvas, page
# Web guide
- Simplest is best: index.html with style.css and game.js (or all in index.html). No npm, no package.json, no build tools unless the user asks for a framework.
- Never run npm install for plain HTML/JavaScript.
- Check: after writing a separate .js file, run <run>node --check game.js</run> to catch syntax errors (browser code using document/window is fine). node --check only works on .js files, never on .html: for JavaScript inside index.html, <preview> reports its errors.
- Look at it: <preview path="index.html"/> takes a screenshot and tells you what's on screen plus any JavaScript errors. Fix anything that looks wrong, blank, or errors, then preview again.
- When it's done, <open path="index.html"/>.
`,
  'python.md': `keywords: python, .py, pygame, tkinter, flask, django
# Python guide
- Run programs with: python main.py
- For a window or game with nothing to install, use tkinter (built in). Only use pygame if the user wants it; install it first with <run>python -m pip install pygame</run>.
- Check: <run>python -m py_compile main.py</run> after writing, then a test run: <run timeout="5">python main.py</run>. Programs get no keyboard input: pipe test answers in, e.g. <run>printf '3\\n' | python main.py</run>
- When it works, tell the user to run: python main.py
`,
};

// Write the built-in guides, and update ones the user hasn't edited when Hatch's version changes.
// (The hash of each default as written is remembered; a file still matching it was never edited.)
const HASHES = path.join(GUIDES_DIR, '.defaults.json');
fs.mkdirSync(GUIDES_DIR, { recursive: true });
let written = {};
try { written = JSON.parse(fs.readFileSync(HASHES, 'utf8')); } catch {}
const hash = s => crypto.createHash('sha1').update(s.replace(/\r\n/g, '\n')).digest('hex');
for (const [name, text] of Object.entries(DEFAULTS)) {
  const f = path.join(GUIDES_DIR, name);
  const current = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  if (current === null || (hash(current) === written[name] && current !== text)) {
    fs.writeFileSync(f, text);
    written[name] = hash(text);
  } else if (current === text) {
    written[name] = hash(text);
  }
}
fs.writeFileSync(HASHES, JSON.stringify(written, null, 2));

export function list() {
  return fs.readdirSync(GUIDES_DIR).filter(f => f.endsWith('.md')).sort((a, b) => (a === 'general.md' ? -1 : b === 'general.md' ? 1 : a.localeCompare(b)));
}

export function read(name) {
  try { return fs.readFileSync(path.join(GUIDES_DIR, path.basename(name)), 'utf8'); } catch { return ''; }
}

export function write(name, text) {
  const n = path.basename(name).replace(/[^\w.-]/g, '').replace(/(\.md)?$/, '.md');
  fs.writeFileSync(path.join(GUIDES_DIR, n), text);
  return n;
}

function keywords(text) {
  const m = /^keywords:\s*(.+)$/im.exec(text);
  return m ? m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
}

// Picks guides from what the user asked for and what's already in the project folder.
export function pick(requestText, cwd) {
  let files = '';
  try { files = fs.readdirSync(cwd).join(' ').toLowerCase(); } catch {}
  const hay = ` ${requestText.toLowerCase()} ${files} `;
  const chosen = [];
  for (const name of list()) {
    const text = read(name);
    const keys = keywords(text);
    const hit = keys.includes('*') || keys.some(k => (k.startsWith('.') ? hay.includes(k) : new RegExp(`(^|[^a-z0-9+])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9+]|$)`).test(hay)));
    if (hit) chosen.push({ name, text: text.replace(/^keywords:.*\n/i, '').trim() });
  }
  return chosen;
}
