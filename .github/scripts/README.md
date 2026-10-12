# Release guard

Run the full offline Git fixture suite from the repository root:

    node --test .github/scripts/version-guard.test.mjs

The fixtures invoke the exact shell guard used by the required version check.
They create temporary Git repositories and substitute an offline npm command;
they do not load the server, native helpers, Shortcuts or Notes data.

CI first runs those fixtures, then checks the actual pull request:

    BASE_SHA=<base-commit> HEAD_SHA=<head-commit> bash .github/scripts/version-guard.sh

With `BASE_SHA` empty or unset, the guard fetches `origin/main` and compares its
fork point with `HEAD`, as it does for a manual workflow dispatch.

The shared classifier detects native runtime files and signed/unsigned Shortcut
assets even when the JavaScript bundle is unchanged. Both sides of a rename are
checked. Documentation, clearly named native test fixtures, and TypeScript edits
with an unchanged bundle remain exempt; the existing version, dependency and
changelog checks still apply. These scripts live outside the npm package.

Every file under `build/` remains a shipped-byte detector, including files in
directories named `__tests__` or `__mocks__`.
