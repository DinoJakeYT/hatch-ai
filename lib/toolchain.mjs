// Finds the build tools on this PC, so local models get commands that actually work here.
// Visual C++ (MSVC) only works after its setup script runs, so we run it once and hand its
// environment to every command the model runs.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { raylib, raylibBuildFlags } from './libs.mjs';

const TOOLS = ['g++', 'clang++', 'cmake', 'ninja', 'make', 'mingw32-make', 'python', 'py', 'node', 'npm',
  'dotnet', 'javac', 'java', 'rustc', 'cargo', 'go'];

const run = (exe, args, opts = {}) => new Promise(resolve => {
  execFile(exe, args, { windowsHide: true, maxBuffer: 1 << 22, timeout: 60000, ...opts }, (err, out) => resolve(err ? '' : out));
});

async function findMsvc() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const inst = (await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'])).trim();
  const vcvars = inst && path.join(inst, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!vcvars || !fs.existsSync(vcvars)) return null;
  const out = await run('cmd.exe', ['/d', '/s', '/c', `""${vcvars}" >nul && set"`], { windowsVerbatimArguments: true });
  const env = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  if (!env.INCLUDE) return null;
  return { vcvars, env, version: inst.match(/\\(\d{4})\\/)?.[1] || '' };
}

async function detect() {
  const found = {};
  await Promise.all(TOOLS.map(async t => {
    const p = (await run('where.exe', [t])).split(/\r?\n/)[0].trim();
    // the Windows Store "python" stub isn't a real Python
    if (p && !/WindowsApps\\python/i.test(p)) found[t] = p;
  }));
  return { found, msvc: await findMsvc() };
}

let current = null;
export const ready = detect().then(t => (current = t)).catch(() => (current = { found: {}, msvc: null }));
export function refresh() {
  return detect().then(t => (current = t));
}

// Extra environment for commands: MSVC's variables, and no Git Bash path rewriting of "/options".
export function commandEnv(base) {
  const env = { ...base };
  if (current?.msvc) {
    for (const [k, v] of Object.entries(current.msvc.env)) {
      if (/^(Path|PATH)$/.test(k)) continue;
      env[k] = v;
    }
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path';
    env[pathKey] = current.msvc.env.Path || current.msvc.env.PATH || env[pathKey];
  }
  env.MSYS_NO_PATHCONV = '1';
  env.MSYS2_ARG_CONV_EXCL = '*';
  return env;
}

export function cppCompiler() {
  if (current?.msvc) return 'msvc';
  if (current?.found['g++']) return 'g++';
  if (current?.found['clang++']) return 'clang++';
  return null;
}

// What a C++ program needs, read from its source.
export function cppNeeds(text) {
  return {
    raylib: /#include\s*[<"]raylib\.h[>"]/.test(text),
    opengl: /#include\s*<GL\/(gl|glu)\.h>/i.test(text),
    gui: /#include\s*<windows\.h>/i.test(text) && /CreateWindow|WinMain/.test(text),
    windowed: /\bw?WinMain\b/.test(text),
  };
}

// The build command for C++ files (Hatch uses it to check code itself, and tells models about it).
export function cppBuildCommand(files, exe, { windowed, gui, opengl, raylib: usesRaylib } = {}) {
  const kind = cppCompiler();
  if (kind === 'msvc') {
    if (usesRaylib) {
      const r = raylibBuildFlags();
      if (r) return `cl -nologo -EHsc -std:c++17 -O2 ${r.compile} ${files.join(' ')} -Fe:${exe} ${r.link} -link -subsystem:windows ${r.entry}`;
    }
    const libs = [gui || opengl ? 'user32.lib gdi32.lib' : '', opengl ? 'opengl32.lib glu32.lib' : ''].filter(Boolean).join(' ');
    return `cl -nologo -EHsc -std:c++17 -O2 ${files.join(' ')} -Fe:${exe}${libs ? ` ${libs}` : ''}${windowed ? ' -link -subsystem:windows' : ''}`;
  }
  if (kind) {
    const libs = [gui || opengl ? '-luser32 -lgdi32' : '', opengl ? '-lopengl32 -lglu32' : ''].filter(Boolean).join(' ');
    return `${kind} -std=c++17 -O2 ${files.join(' ')} -o ${exe}${libs ? ` ${libs}` : ''}${windowed ? ' -mwindows' : ''}`;
  }
  return null;
}

// What the model is told about this PC.
export function summary() {
  const t = current || { found: {}, msvc: null };
  const f = t.found;
  const lines = ['Tools on this PC:'];
  const cpp = cppCompiler();
  if (cpp === 'msvc') {
    lines.push(`- C++: Microsoft Visual C++ ${t.msvc.version} (cl) works in every <run>. Build with:`,
      '  cl -nologo -EHsc -std:c++17 -O2 main.cpp -Fe:game.exe',
      '  Write cl options with "-" (not "/"). For a window/graphics program add: user32.lib gdi32.lib -link -subsystem:windows',
      '  For 3D with OpenGL (built into Windows) add: user32.lib gdi32.lib opengl32.lib glu32.lib -link -subsystem:windows',
      `  ${f['g++'] ? '' : 'There is NO g++ and NO clang on this PC: never use them.'}`);
    const r = raylib();
    lines.push(r
      ? `- raylib ${r.version} (easy 3D/2D game library) is installed. #include "raylib.h" and build with:\n  ${cppBuildCommand(['main.cpp'], 'game.exe', { raylib: true })}`
      : '- raylib is NOT installed (the user can install it in Hatch Settings > Local models). Use OpenGL instead.');
  } else if (cpp) {
    lines.push(`- C++: ${cpp} (build: ${cpp} -std=c++17 -O2 main.cpp -o game.exe)`);
  } else {
    lines.push('- C++: no C++ compiler is installed. Tell the user to install Visual Studio with "Desktop development with C++" if they want C++.');
  }
  if (f.python || f.py) lines.push(`- Python: ${f.python ? 'python' : 'py'}`);
  if (f.node) lines.push(`- Node.js: node${f.npm ? ', npm' : ''}`);
  if (f.dotnet) lines.push('- C#/.NET: dotnet');
  if (f.javac) lines.push('- Java: javac, java');
  if (f.cmake) lines.push(`- CMake${f.ninja ? ' + Ninja' : ''} (only if really needed)`);
  if (f.cargo) lines.push('- Rust: cargo');
  if (f.go) lines.push('- Go: go');
  const missing = ['make', 'cargo', 'go'].filter(x => !f[x]);
  if (missing.length) lines.push(`- Not installed: ${missing.join(', ')}`);
  return lines.filter(l => l.trim()).join('\n');
}

// The same facts for Claude, Codex and Gemini, whose shells don't have Visual C++ set up the way
// Hatch's own runs do. Without this they spend minutes searching the PC for a compiler.
export function leadSummary() {
  const t = current || { found: {}, msvc: null };
  const f = t.found;
  const lines = ['Tools on this PC (Hatch already checked; no need to search for them):'];
  if (t.msvc) {
    // vcvars looks for vswhere on PATH, and prints a confusing "not recognized" line without it
    const installer = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer');
    const call = cmd => `cmd /d /c "set "PATH=%PATH%;${installer}" && call "${t.msvc.vcvars}" >nul && ${cmd}"`;
    lines.push(`- C++: Visual C++ ${t.msvc.version} is installed but not on PATH. Build in one command, e.g.:`,
      `  ${call('cl -nologo -EHsc -std:c++17 -O2 main.cpp -Fe:game.exe')}`,
      '  Windows/OpenGL programs add: user32.lib gdi32.lib opengl32.lib glu32.lib -link -subsystem:windows',
      '  (Hatch\'s local-model helpers already have Visual C++ set up: give them just the cl command, without the vcvars part.)');
    const r = raylib();
    lines.push(r ? `- raylib ${r.version} is installed. raylib build: ${call(cppBuildCommand(['main.cpp'], 'game.exe', { raylib: true }))}`
      : '- raylib is NOT installed. Use Win32 + OpenGL (built into Windows) for 3D.');
  } else if (cppCompiler()) {
    lines.push(`- C++: ${cppCompiler()}`);
  } else {
    lines.push('- C++: no compiler installed (Visual Studio with "Desktop development with C++" would add one).');
  }
  if (f.python || f.py) lines.push(`- Python: ${f.python ? 'python' : 'py'}`);
  if (f.node) lines.push(`- Node.js: node${f.npm ? ', npm' : ''}`);
  if (f.dotnet) lines.push('- C#/.NET: dotnet');
  if (f['g++'] || f['clang++']) lines.push(`- Also: ${['g++', 'clang++'].filter(x => f[x]).join(', ')}`);
  return lines.join('\n');
}

export function describe() {
  const t = current || { found: {}, msvc: null };
  return {
    msvc: t.msvc ? `Visual C++ ${t.msvc.version}` : null,
    tools: Object.keys(t.found),
  };
}
