# Codex · Gemini

One side-bar panel for **Codex** and **Gemini**, backed by the local `codex-mcp` and `gemini-mcp` servers from [codex-gemini-mcp](https://github.com/sxtrip34-cell/codex-gemini-mcp).

- Switch between Gemini and Codex. Each keeps its own conversation.
- Pick the model and the power (thinking level / reasoning effort). Codex models come from your Codex account.
- Just write. The panel works out whether you want chat, an image, a video, music or a 3D model. It reads aspect ratio, length and format from the wording, and hands off what the other provider does better.
- Results show inline, with Open, Show and Copy path.

No API keys: everything runs on your own Codex (ChatGPT) and Google sign-ins.

## Setup

Install the servers with the repository's installer (`node scripts/install.mjs`), which also installs this extension. The panel finds the servers by itself; you can set their paths in the **Codex · Gemini** settings.

See the [panel guide](https://github.com/sxtrip34-cell/codex-gemini-mcp/blob/main/docs/panel.md) for details.
