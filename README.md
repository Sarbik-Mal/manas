# Manas

A local-first, editor-independent AI coding agent CLI for Windows.

Manas runs as a single `manas.exe` with no runtime to install. It works mostly through shell commands (PowerShell, or Git Bash when available) and adapts to each kind of project, such as Next.js, FastAPI, Spring Boot or Jupyter notebooks, using area skills and automatic checks. Editor plugins are thin front ends over the same core. Sessions, backups and memory stay on your PC.

> **Status:** planning complete; development starting (milestone 0).

## Highlights

- **One core, many front ends:** the CLI, editor plugins and scripts all drive the same core over a JSON-lines protocol.
- **Safe by design:** read-before-edit, backups and `/rewind` for every change, parsed-command permissions, and a secrets vault that keeps keys out of model requests.
- **Checks the model can't ignore:** type checkers, linters and tests run after edits, enforced by the core.
- **Cheap long sessions:** a fixed tool list for prompt caching, subagents for exploration, and compaction near the context limit.
- **Your own key:** uses the OpenAI Responses API with your API key.

## Requirements

- Windows 10 or 11
- An OpenAI API key
- Optional: Git for Windows (enables the bash tool and worktrees), Python with `ipykernel` (for notebooks)

## Development

Built with TypeScript and Bun, compiled into one executable.

```powershell
bun install
bun test
bun run build        # produces manas.exe
```

For development, put your key in `.env` (never committed):

```
OPENAI_API_KEY=sk-...
```

## Project layout

```
packages/
├── protocol/   shared message types and schemas
├── core/       the agent (builds into manas.exe)
└── vscode/     VS Code plugin (later)
evals/          fixture projects and eval cases
```

## License

[MIT](LICENSE)
