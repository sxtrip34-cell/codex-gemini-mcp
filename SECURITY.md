# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. You will get an answer as soon as possible.

## What to keep in mind

- The servers run locally with your own sign-ins (Codex, Google). They do not store keys or tokens themselves.
- `gemini-mcp` starts Chrome with a DevTools port on `127.0.0.1` (default 9339). While it runs, other programs on the same machine can reach that browser profile, which is signed in to Google. Don't run it on shared machines.
- Codex jobs run in Codex's sandbox. Video and 3D jobs may write to their work folder and the output folder. The panel's Codex chat may edit files in the open workspace.
- Treat generated files and model output as untrusted content.
