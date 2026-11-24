# Contributing

Thanks for helping. Bug reports, selector fixes for the Gemini web app, new router languages and tests are all welcome.

## Layout

```
packages/
  codex-mcp/      MCP server for the Codex CLI          (server.mjs)
  gemini-mcp/     MCP server for Gemini                 (server.mjs, web.mjs = Gemini web app, agy.mjs = Antigravity CLI, browser.mjs = headless Chrome)
  vscode-panel/   Side-bar extension                    (extension.js, router.js, mcp-client.js, media/)
scripts/          install.mjs, check.mjs
docs/             guides; docs/src = sources of the README graphics
```

## Setup

```bash
npm install
npm test            # syntax check of every file + router/parser unit tests (no Codex or Gemini needed)
```

Smoke tests talk to the real services and need you to be signed in:

```bash
npm run smoke:codex -- codex_status '{}'
npm run smoke:gemini -- gemini_status '{}'
```

To work on the panel, open `packages/vscode-panel` in VS Code and press F5 (Extension Development Host). Run from a clone, it finds the servers in the repository by itself.

## Guidelines

- Keep the servers dependency-light: the MCP SDK, plus `playwright-core` for Gemini.
- Everything must run without API keys, on the user's own sign-ins.
- Never log or return personal data (emails, tokens). Status output masks emails.
- Gemini web selectors live only in `packages/gemini-mcp/web.mjs`. Prefer roles and `aria-label`s on the English UI (`?hl=en`) over CSS classes.
- Router changes: add a case to `packages/vscode-panel/test/router.test.js`.
- Graphics: edit `docs/src/*.html`, then `node docs/src/render.mjs` (and `node docs/src/demo.mjs` for the GIF; needs Chrome and ffmpeg).

## Pull requests

Describe what changed and how you tested it (OS, editor, which tools). Keep PRs focused. CI runs `npm test` on Windows and Linux.
