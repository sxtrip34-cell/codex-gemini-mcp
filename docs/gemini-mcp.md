# gemini-mcp

MCP server for **Google Gemini on your Google account, without an API key**. It has two backends:

| Backend | Used for | How |
|---|---|---|
| Antigravity CLI (`agy`) | `gemini_ask`: text, code, analysis, web research | `agy --print … --output-format json`, signed in with the Google account in Antigravity |
| Gemini web app | `gemini_image`, `gemini_video`, `gemini_music`, `gemini_chat` | Real Chrome with its own profile, running **headless**, attached over the DevTools protocol with `playwright-core` |

## Tools

| Tool | Parameters | Typical time |
|---|---|---|
| `gemini_image` | `prompt` · `output_dir` · `filename` · `aspect` (`1:1`, `9:16`, `3:4`, `4:3`, `16:9`) · `format` (`image`, `gif`) · `reference_images` · `chat_url` · `preview` · `wait_seconds` | 15–60 s (edits up to ~2 min) |
| `gemini_video` | `prompt` · `output_dir` · `filename` · `aspect` (`landscape`, `portrait`) · `format` (`video`, `gif`) · `reference_images` · `chat_url` · `preview` · `wait_seconds` | 1–5 min, **experimental** |
| `gemini_music` | `prompt` · `format` (`mp3`, `video`) · `output_dir` · `filename` · `chat_url` · `wait_seconds` | 1–2 min |
| `gemini_chat` | `prompt` · `mode` (`auto`, `hydrogen`, `neon`, `carbon`) · `thinking` (`low`, `medium`, `high`) · `files` · `output_dir` · `chat_url` · `timeout_seconds` · `wait_seconds` | seconds to minutes |
| `gemini_ask` | `prompt` · `conversation_id` · `cwd` · `add_dirs` · `access` (`read-only`, `edit`) · `model` · `effort` · `timeout_seconds` · `wait_seconds` | seconds (web research: minutes) |
| `gemini_status` | `open_window` · `list_models` | seconds |
| `gemini_job` | `job_id` · `wait_seconds` · `cancel` | — |

Mode names are the ones the Gemini web app shows. Which modes you have depends on your plan; a mode outside it returns a clear error. `gemini_chat` puts your account's default mode and thinking level back after the call.

## First sign-in

```bash
npm run gemini:signin
```

This opens the gemini-mcp Chrome profile in a visible window on gemini.google.com. Sign in, press Enter, and the server uses that session from then on, headless. If Google ever ends the session, any tool returns a "not signed in" error; run the command again, or call `gemini_status` with `open_window: true`.

## How a media job runs

1. Open a new tab (or the `chat_url` you passed) in the English UI (`?hl=en`), so the selectors don't depend on the account language.
2. Pick the tool (`Create image`, `Create video`, `Create music`), set the aspect ratio and format, upload the attachments, send the prompt. Intro dialogs and promos are closed automatically.
3. Wait for the media and its download button. If Gemini answers with text instead (a refusal, an error, a quota message), return that text as an error right away instead of waiting.
4. Click Gemini's own "Download" button and take the file from Chrome's download events. It lands in `~/.gemini-mcp/downloads` first, then moves to `output_dir`. Existing files are never overwritten.
5. Return the paths, a preview and the `chat_url`.

Clicks, typing and downloads go through one lock (`~/.gemini-mcp/ui.lock`) shared across server processes, so Claude Code, Antigravity and the panel can use the same Chrome at once. The long wait for a generation happens outside the lock.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_MCP_OUTPUT_DIR` | `~/Pictures/Gemini` | Output folder when a call gives none. |
| `GEMINI_MCP_WAIT_SECONDS` | `280` | How long a call waits before returning a `job_id`. |
| `GEMINI_MCP_HOME` | `~/.gemini-mcp` | Chrome profile, downloads, lock, agy work folder. |
| `GEMINI_MCP_CDP_PORT` | `9339` | DevTools port of the dedicated Chrome (localhost only). |
| `GEMINI_MCP_HEADLESS` | `1` | `0` shows the window (handy for debugging selectors). |
| `CHROME_PATH`, `AGY_PATH`, `FFMPEG_PATH` | auto | Tool locations. |

## When Google changes the page

All selectors live in `packages/gemini-mcp/web.mjs`. Run with `GEMINI_MCP_HEADLESS=0` to watch the window, then use the smoke test:

```bash
node packages/gemini-mcp/test/smoke.mjs gemini_image '{"prompt":"a red apple on a wooden table","output_dir":"./out"}'
```
