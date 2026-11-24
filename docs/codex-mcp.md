# codex-mcp

MCP server that hands image, video and 3D generation, and any other task, to the **OpenAI Codex CLI** on your machine. It runs `codex exec --json` with your Codex sign-in (ChatGPT), so there is no API key.

## Tools

| Tool | Parameters | Typical time |
|---|---|---|
| `generate_image` | `prompt` · `output_dir` · `filename` · `count` (1–8 variants) · `aspect` (`square`, `landscape`, `portrait`, `wide`, `tall` or free text) · `transparent` · `edit_image` · `reference_images` · `model` · `reasoning_effort` · `preview` · `wait_seconds` | 20–90 s |
| `generate_video` | `prompt` · `output_dir` · `filename` · `duration_seconds` (2–120) · `aspect` (`landscape`, `portrait`, `square`) · `fps` · `audio` · `reference_images` · `model` · `reasoning_effort` · `preview` · `wait_seconds` | 3–15 min |
| `generate_3d` | `prompt` · `output_dir` · `filename` · `format` (`glb`, `gltf`, `fbx`, `obj`, `stl`, `usdz`) · `detail` (`low`, `medium`, `high`) · `textures` · `animated` · `reference_images` · `model` · `reasoning_effort` · `preview` · `wait_seconds` | 3–15 min |
| `codex` | `prompt` · `cwd` · `sandbox` (`read-only`, `workspace-write`) · `images` · `model` · `reasoning_effort` · `wait_seconds` | varies |
| `codex_reply` | `session_id` · `prompt` · `output_dir` · `images` · `wait_seconds` | varies |
| `codex_status` | none | instant |
| `codex_job` | `job_id` · `wait_seconds` · `cancel` (no `job_id`: list jobs) | — |

`reasoning_effort` accepts `low`, `medium`, `high`, `xhigh`, `max` and `ultra`, if the model supports that level (`codex_status` lists each model's levels).

## How a job runs

1. Every call becomes a background job. The call waits `wait_seconds` (default 280); if the job isn't done by then, it returns `Still running … job_id: …` and the client calls `codex_job` to keep waiting. Progress notifications are sent every 10 s.
2. **Images:** Codex runs read-only with its built-in `image_gen` tool. The server collects the files from `~/.codex/generated_images/<session>/` itself and copies them to `output_dir`, never overwriting (`name-v2.png`).
3. **Video and 3D:** Codex gets a work folder (`~/.codex-mcp/work/<job>`), the `output_dir` as an extra writable root, and the paths of ffmpeg, Blender, Node and Python. The prompt asks it to validate the result (ffprobe, re-import in Blender, look at frames) and to skip git, repositories and publishing.
4. Results list the files, add a preview image, and return a `session_id` for `codex_reply`.

## Finding Codex

In order: `CODEX_PATH`; `CODEX_CLI_PATH` in `~/.codex/config.toml` (the desktop app keeps it current on updates); `C:\Program Files\WindowsApps\OpenAI.Codex_*` and `Get-AppxPackage` on Windows; `codex` on `PATH`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_MCP_OUTPUT_DIR` | `~/Pictures/Codex` | Output folder when a call gives none. |
| `CODEX_MCP_WAIT_SECONDS` | `280` | How long a call waits before returning a `job_id`. |
| `CODEX_MCP_IMAGE_EFFORT` | `medium` | Reasoning effort for image jobs (overridden by `reasoning_effort`). |
| `CODEX_MCP_BUILD_SANDBOX` | `workspace-write` | Sandbox for video/3D jobs; `danger-full-access` if a tool gets blocked. |
| `CODEX_MCP_HOME` | `~/.codex-mcp` | Work folders and `sessions.json`. |
| `CODEX_HOME` | `~/.codex` | Codex's own home. |
| `CODEX_PATH`, `FFMPEG_PATH`, `BLENDER_PATH` | auto | Tool locations. |

## Smoke test

```bash
npm run smoke:codex                                  # list tools
node packages/codex-mcp/test/smoke.mjs codex_status '{}'
node packages/codex-mcp/test/smoke.mjs generate_image '{"prompt":"a red ceramic cup","output_dir":"./out"}'
```
