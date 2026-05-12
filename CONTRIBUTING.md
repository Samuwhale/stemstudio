# Contributing

StemStudio is a local personal tool. Keep the code easy to read, easy to change, and honest about what runs on a single machine.

## Setup

Use Node.js 20 or newer and Python 3.10 or newer.

```sh
npm run check:system
npm run setup
npm run setup:processing
```

`npm run setup:processing` installs `audio-separator`. Skip it only when your change does not touch real stem separation.

## Development

Run the full app locally with:

```sh
npm run dev
```

Run the focused pieces with:

```sh
npm run dev:api
npm run dev:worker
npm run dev:frontend
```

## Checks

Before opening a pull request, run:

```sh
npm run check
```

`npm run check` runs frontend linting, frontend typecheck, the production build, and a backend compile check.

StemStudio does not include a formal test suite yet. Do not add broad test scaffolding just to satisfy process. Add a narrow test only when it protects behavior that inspection cannot cover well.

## Pull Requests

Keep pull requests small. Explain the user-facing change, the files you touched, and the checks you ran.

Do not commit:

- `.env` files
- uploaded audio
- generated stems
- export bundles
- model caches
- logs
- `data/app.db`

## Code Style

- Prefer simple functions and explicit data flow.
- Remove dead code when you replace behavior.
- Do not keep compatibility layers for old local data shapes unless the current app still needs them.
- Avoid abstractions that hide the local file, SQLite, API, worker, or frontend boundary.
- Keep UI copy short and specific. Say what happened and what the user can do next.

## Product Boundaries

StemStudio runs locally. Do not add hosted-product assumptions such as accounts, object storage, public file URLs, billing, multi-tenant data boundaries, or remote workers unless the project explicitly moves in that direction.

YouTube import is for local personal use. Do not expand it into a public hosted workflow without reviewing platform terms and copyright requirements.
