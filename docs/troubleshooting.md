# Troubleshooting

### The tools don't show up in Claude Code

Claude Code loads MCP servers when a session starts. Run `claude mcp list` (both servers should say *Connected*), then start a new session. If a server fails, run it by hand to see the error:

```bash
node packages/codex-mcp/server.mjs     # prints "[codex-mcp] … ready" on stderr; Ctrl+C to stop
node packages/gemini-mcp/server.mjs
```

### `codex-mcp`: "could not start Codex" or no images

- Check that Codex is installed and signed in: `codex login status` (or open the Codex app).
- `codex_status` shows which CLI the server found. Set `CODEX_PATH` if it picked the wrong one.
- Image generation needs Codex's built-in image tool (`codex features list | grep image_generation`).

### `codex-mcp`: video or 3D jobs fail on a blocked command

Video and 3D jobs run in Codex's `workspace-write` sandbox. If ffmpeg or Blender gets blocked on your system, set `CODEX_MCP_BUILD_SANDBOX=danger-full-access` for the server.

### `gemini-mcp`: "not signed in"

Run `npm run gemini:signin`, sign in in the window that opens, and press Enter. The session is kept in `~/.gemini-mcp/chrome-profile`.

### `gemini-mcp`: a tool times out or can't find a button

The Gemini web app changed, or a new intro dialog appeared. Run the server with `GEMINI_MCP_HEADLESS=0` to watch it, and update the selectors in `packages/gemini-mcp/web.mjs`. Please open an issue with what you saw.

### `gemini_video` answers "I'm having a hard time fulfilling your request"

That text comes from Gemini, not from the server. It usually means the daily video quota is used up, or Veo isn't available for the account or region. Try once in the Gemini web app yourself.

### The panel says *Retry* for a provider

Hover over the status to read the error, or open the **Codex · Gemini** output channel. If a server isn't found, run the installer again or set `codexGemini.codexServerPath` / `codexGemini.geminiServerPath`.

### Port 9339 is taken

Set `GEMINI_MCP_CDP_PORT` to a free port for the gemini server (and for the panel, through your editor's environment).
