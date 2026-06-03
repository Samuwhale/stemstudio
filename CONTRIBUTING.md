# Contributing

StemStudio is a FOSS local desktop app. Keep the code easy to read, easy to change, and honest about the fact that the supported product is one built Electron app with bundled local processes.

Read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before participating.

## Good Contributions

- Fix a clear bug in import, processing, mixing, export, storage cleanup, diagnostics, or packaging.
- Improve public YouTube URL import for local processing.
- Reduce confusing UI copy or flow without adding chrome.
- Improve local setup, build reliability, or contributor documentation.
- Remove dead code or simplify an awkward module boundary.
- Tighten file safety around local paths, external binaries, or cleanup behavior.

Open an issue before starting broad product work, major UI rewrites, dependency swaps, or anything that changes the local-only product boundary.

## Setup

Use Node.js 20 or newer, npm 10 or newer, Python 3.11 or newer, and macOS with the Xcode Command Line Tools installed.

```sh
npm run setup:local
```

`setup:local` installs JavaScript dependencies, creates `.venv` when needed, freezes the bundled API, worker, `audio-separator`, and `yt-dlp` runtimes, builds the frontend, and runs the desktop package doctor.

## Build

```sh
npm run desktop:build:mac
```

The build script prepares the runtime, builds the frontend, runs the desktop package doctor, and packages the signed macOS app.

## Checks

Before opening a pull request, run:

```sh
npm run check
```

`npm run check` runs frontend linting, frontend typecheck, a production frontend build, and a backend compile check.

StemStudio does not include a formal test suite yet. Do not add broad test scaffolding just to satisfy process. Add a narrow test only when it protects behavior that inspection cannot cover well.

Also mention the manual flow you verified and any unchecked audio-processing or UI behavior.

## Pull Requests

Keep pull requests small. Explain the user-facing change, the files you touched, and the checks you ran.

Use the pull request template. Include screenshots for visible UI changes, but do not run the app or open a browser just to satisfy process if a build and typecheck answer the question.

Do not commit:

- `.env` files
- uploaded audio
- generated stems
- export bundles
- model caches
- logs
- `data/app.db`
- built release artifacts unless the change explicitly updates packaged outputs

Read [SECURITY.md](./SECURITY.md) before changing storage cleanup, external binary execution, YouTube import, or file download behavior.

## Code Style

- Prefer simple functions and explicit data flow.
- Remove dead code when you replace behavior.
- Do not keep compatibility layers for old launch modes unless the current app still needs them.
- Avoid abstractions that hide the local file, SQLite, API, worker, or frontend boundary.
- Keep UI copy short and specific. Say what happened and what the user can do next.
- Keep public-facing writing direct. Cut filler, vague claims, and generated-sounding phrasing.

## Product Boundaries

StemStudio runs as a local desktop app. Do not add hosted-product assumptions such as accounts, object storage, public file URLs, billing, multi-tenant data boundaries, or remote workers unless the project explicitly moves in that direction.

YouTube import is for local processing of public URLs. Do not expand it into a public hosted workflow without reviewing platform terms and copyright requirements.
