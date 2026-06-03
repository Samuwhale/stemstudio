# Release Guide

Use this guide when publishing a StemStudio release.

## Before Tagging

1. Update `package.json`, `desktop/package.json`, and `pyproject.toml` to the same version.
2. Update `CHANGELOG.md`.
3. Run `npm run check`.
4. Run `npm audit --audit-level=high`.
5. Build the signed macOS package with `npm run desktop:build:mac`.
6. Confirm `npm run desktop:verify:mac` passes.

## GitHub Release

1. Commit the release changes.
2. Push `main`.
3. Create an annotated tag, for example `v0.1.0`.
4. Push the tag.
5. Create a GitHub release from the tag.
6. Attach the signed DMG and zip from `release/`.

Do not attach logs, `.env` files, local databases, uploaded audio, generated stems, model caches, or unsigned scratch builds.
