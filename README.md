# Hatch

A Windows desktop app where AIs build things for you. Pick Claude, ChatGPT, Gemini, OpenRouter, any OpenAI-compatible API or a local model (Ollama), describe what you want, and watch it write the files, build them and test them in the chat's own project folder.

**[Download the latest version](https://github.com/DinoJakeYT/hatch-ai/releases/latest)** (Windows 10/11, 64-bit). Hatch updates itself when a new version comes out.

## What it does

- **Any AI, one app.** Use your Claude Pro/Max or ChatGPT plan by signing in, or API keys for Claude, OpenAI, Gemini, OpenRouter and custom providers. Each chat can use a different AI, and you can switch mid-chat.
- **Local models that actually build things.** Ollama models get Hatch's own simple tool system (create files, edit, run, read, preview), step-by-step guides for C++/3D/web/Python projects, build checks, loop detection and starter templates, so even small models finish real projects.
- **Teams.** A lead AI plans and checks while helper AIs do the hands-on work, at the same time if you like. For example, Claude leads while a free local model writes and builds the code, which saves your Claude usage.
- **Watch it work.** Chat bubbles, live cards for every file it writes and command it runs, screenshots of what it built, and a "working now" bar showing what each AI is doing.
- **Undo.** Hatch saves the project before every message, so one click puts the files back.
- **Play.** Run the program or page the AI just built from the top bar.
- **Send messages while it works.** They reach the AI at its next step without stopping it.
- **Overnight work.** Let a local model keep building and improving a project for hours, with checkpoints after every working build and a report in the morning.
- **Skills.** Import skills (SKILL.md) from GitHub or a folder, write your own, or approve the ones an AI proposes. Every AI gets them.
- **Usage tracking.** Plan limits and API costs per AI, with optional monthly budgets.
- **Local model manager.** Download and delete Ollama models, and see which ones fit your graphics card.
- **Instructions and memory** shared by every AI, and chat groups, hiding and renaming.

## What you need

Hatch itself is all you need to chat. Depending on what you use:

| For | Install |
|---|---|
| Claude with your Pro/Max plan | Nothing: sign in from Hatch |
| ChatGPT with your Plus/Pro plan | Nothing: sign in from Hatch |
| Gemini | [Node.js](https://nodejs.org) and a Gemini API key (free tier at aistudio.google.com) |
| Local models | [Ollama](https://ollama.com), then download a model from Settings > Local models |
| C++ projects | Visual Studio 2022 with "Desktop development with C++" (the free Community edition is fine) |
| Local models running commands | [Git for Windows](https://git-scm.com) (its bash works best) |

## Run it from the source code

```bash
git clone https://github.com/DinoJakeYT/hatch-ai.git
cd hatch-ai
npm install
npm start
```

Your chats, settings and keys live in `%APPDATA%\Hatch`, and projects in `Documents\Hatch Projects`. API keys are encrypted with Windows' own protection (Electron safeStorage).

## Making a release

Releases are built and published from your own PC with the GitHub CLI (no GitHub Actions):

```bash
npm version patch
npm run release
```

`npm version patch` (or `minor` / `major`) bumps the version, commits it and tags it. `npm run release` builds the installer, pushes the code and the tag, and creates the GitHub release with the installer and `latest.yml`, which installed copies of Hatch check to update themselves. Add notes with `npm run release -- "What's new"`.

You need [Git](https://git-scm.com) and the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`) to the account that owns the repo. To build the installer without publishing it, run `npm run dist` (it ends up in `dist/`).

## How it's built

Electron, with no front-end framework. The main process (`main.mjs`) runs the chats; each AI has an engine in `engines/`:

- `claude.mjs`: the Claude Agent SDK, for Claude and any Anthropic-compatible endpoint.
- `codex.mjs`: the OpenAI Codex SDK, for ChatGPT and OpenAI.
- `gemini.mjs`: the Gemini CLI.
- `local.mjs`: Hatch's own agent for Ollama models.

Teams, skills, Undo checkpoints, overnight work, usage tracking and the updater are in `lib/`, and the window is in `renderer/`.

## License

Hatch is free software under the [GNU General Public License v3.0](LICENSE). Copyright (C) 2026 DinoJakeYT.

The installer includes third-party components under their own licenses: Electron, the Claude Agent SDK (Anthropic's terms), the OpenAI Codex CLI and the Gemini CLI (Apache 2.0), marked, DOMPurify and others listed in `package.json`. Hatch is an independent project, not made by or affiliated with Anthropic, OpenAI, Google or Ollama.
