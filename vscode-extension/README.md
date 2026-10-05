# TutorBot for VS Code

A minimalist chat panel for TutorBot. Click the TutorBot icon (graduation cap) in the activity bar, or press ⌘Esc.

Everything TutorBot needs ships with the extension: its AI engine ([pi](https://github.com/earendil-works/pi-mono)) runs on VS Code's built-in Node.js, so there's nothing else to install. Your notes, progress and exercises live in `~/TutorBot` (change it with `tutorbot.home`).

Optional tools TutorBot uses when they're installed: `java` and `python3` for Java/Python exercises, and `pdftotext` (from poppler) to read PDF class materials.

## Setup: connect your API key

TutorBot runs on your own AI provider key. The first time you open the panel, it asks you to connect one:

1. Click **Connect API key** in the panel (or run **TutorBot: Connect API Key** from the command palette).
2. Pick your provider: Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, Mistral, Groq or xAI.
3. Paste the key.

The key is stored in your system keychain (VS Code Secret Storage) and is only passed to the TutorBot process the panel starts. It isn't written to any file or settings. TutorBot then picks a model automatically; change it any time with **TutorBot: Change Model** (or click the model name in the panel footer). To forget a key, run **TutorBot: Remove API Key**.

A key already set in your shell environment (e.g. `ANTHROPIC_API_KEY`) also works.

- **Chat**: replies stream in with typeset math and highlighted code. Tool steps show as compact rows you can expand.
- **Quizzes in place**: click an option or press 1–9. Typed answers have their own box, and the answer and explanation show right after you answer.
- **Home**: the home button or `/home` lets you switch subject, start a new subject, or just chat. New Chat is in the `…` menu.
- **Conversations**: the panel's `…` menu → Conversations (or the command palette) shows every conversation, grouped by subject. Click one to open it. Hover and use the pencil to rename a conversation or a subject (renaming a subject keeps its progress and history), or the trash can to delete a conversation. Deleted conversations go to the Trash; your progress, grades and review schedule are kept.
- **Progress**: the chart button in the header (or *TutorBot: Open Progress*) opens a dashboard tab. It shows memory (fades between reviews) and proof level for every concept, across the whole course map, with upcoming exams as coverage plus an at-risk list. Buttons there (Teach me, Check, Practice, Checkpoint) run in the chat. It reads TutorBot's files directly, so it works without TutorBot running and updates live.
- **Coding exercises**: the file opens in the editor and the tests re-run as you type. Errors show as squiggles. Use Submit (⌘⌥↵) and Hint (⌘⌥H).
- **Ask about code**: select code, then ⌘⌥K or right-click → *Ask TutorBot About This Code*.

Settings: `tutorbot.model` (empty = automatic, or `provider/model`, e.g. `anthropic/claude-sonnet-5-5`), `tutorbot.home`. For development, `tutorbot.tutorPath` loads TutorBot's extensions and skills from a working copy instead of the bundled one.

## Building

```bash
cd vscode-extension
npm install                      # pinned pi + ts-fsrs, used only at build time
npx @vscode/vsce package         # runs scripts/build-runtime.mjs, then packages
```

`scripts/build-runtime.mjs` assembles `runtime/`: pi with only its runtime dependencies, plus TutorBot's extensions (`../extensions`) and the teach skill (`../skills/teach`).
