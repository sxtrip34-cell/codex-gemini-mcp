# Changelog

## 1.0.0

First public release.

- **codex-mcp:** `generate_image` (edits, variants, transparency), `generate_video` (ffmpeg or Blender), `generate_3d` (Blender, GLB/glTF/FBX/OBJ/STL/USDZ, validated), `codex`, `codex_reply`, `codex_status`, `codex_job`. Background jobs with progress, sandboxed runs, and a Codex CLI lookup that survives app updates.
- **gemini-mcp:** `gemini_image` (Nano Banana, edits), `gemini_video` (Veo, experimental), `gemini_music` (MP3), `gemini_chat` (web models, restores your default mode, keeps media in answers), `gemini_ask` (Antigravity CLI), `gemini_status`, `gemini_job`. Headless Chrome with its own profile and a lock shared across processes.
- **Panel** for VS Code, Antigravity and Cursor: a Gemini/Codex switch, model and power per provider, automatic chat/image/video/music/3D routing (TR/EN/RU/KA keywords, Gemini Flash for ambiguous messages), hand-offs between providers, inline previews.
- Cross-platform installer (`scripts/install.mjs`) with `--dry-run`, unit tests, CI.
