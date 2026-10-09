# Contributing to Apple Notes MCP Server

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/sweetrb/apple-notes-mcp.git
   cd apple-notes-mcp
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

   This repo pins pnpm via `packageManager` in `package.json` — `corepack enable` provides it. Development needs Node >= 22.13 (CI tests on Node 22 and 24); the published server itself runs on Node >= 20.

3. **Build the project**

   ```bash
   pnpm run build
   ```

4. **Run tests**
   ```bash
   pnpm test
   ```

## Code Style

This project uses ESLint and Prettier for code quality and formatting.

```bash
# Check for linting issues
pnpm run lint

# Auto-fix linting issues
pnpm run lint:fix

# Format code
pnpm run format

# Check formatting
pnpm run format:check
```

## Testing

All new features should include tests. We use Vitest for testing.

```bash
# Run tests once
pnpm test

# Run tests in watch mode
pnpm run test:watch
```

### Testing Guidelines

- Tests mock the `runAppleScript` function since AppleScript only works on macOS
- Test both success and failure paths
- Test edge cases (empty strings, special characters, etc.)

### Native broker security tests

Run `pnpm run test:broker-security` on a Mac with the command-line developer
tools and hardened-runtime enforcement enabled. The harness compiles temporary
fixtures, applies ad-hoc signatures, and tests direct socket requests, sealed
resource and runtime tampering, and harmless DYLD injection. It does not install
a LaunchAgent, use signing credentials, invoke Notes, or request TCC grants.

The command first runs host-classification, bounded marker-read and CI-result
regression tests. The native harness then checks the actual host capability using
identity-bound injection positive controls and independent hardened C controls
in both synchronous and detached launches. A static `runtime` signature or the
SIP status alone does not prove enforcement. Signing checks, running process
flags and constructor records must agree before the host can be classified.

The native harness distinguishes three results:

- **Exit 0: verified.** The positive controls work, both hardened controls and the
  broker block injection, and every remaining native check passes.
- **Exit 2: confirmed host coverage gap.** Both hardened controls and the broker
  admit the exact challenged startup injection on a host reporting SIP disabled.
  All remaining checks pass. The injection boundary is explicitly **NOT
  VALIDATED**, with a warning and structured report; it is never counted as a
  passed assertion.
- **Exit 1: failure or inconclusive evidence.** Injection reaches the broker on
  an enforcing host, control results disagree, required identity/signature evidence
  is missing or invalid, policy cannot corroborate an observed injection gap, or
  any other assertion or cleanup fails. Unsupported
  hosts also report failure rather than verified coverage.

The full hostile inherited environment remains in the test on a confirmed-gap
host. Only the exact validated startup constructor record is permitted there;
additional or child-process injection records remain fatal. Runtime security
restrictions are unchanged. CI runs the host-classification and marker-read tests
in their own fatal step, then runs CI-result regression tests separately before
invoking the native harness directly with a persistent report. The required step
accepts exit 0 or a strictly validated exit 2 report: `host-gap`, matching exit
code, no failures, completed checks, successful cleanup, unchanged markers, a
written report and explicitly disabled SIP must all agree. The empirical host
classification is rechecked from the report. Exit 1, unknown statuses, missing or
malformed evidence and any field mismatch remain fatal.

An accepted gap emits a warning and a job summary headed **DYLD injection
enforcement NOT VALIDATED on this host**, including the check count and SIP
evidence. CI always uploads the native report, including failure evidence. This
policy follows the maintainer's explicit approval in
[review 5471653001](https://github.com/sweetrb/apple-notes-mcp/pull/276#pullrequestreview-5471653001).
There is no blanket `continue-on-error` and unavailable enforcement coverage is
never reported as verified. The standalone harness still returns exit 2 for a
confirmed gap; CI acceptance does not change runtime security restrictions.

For a persistent evidence file, run
`node scripts/test-broker-security.mjs --report /absolute/path/report.json`.
The report supplements the console evidence and does not change exit semantics.

## Pull Request Process

1. **Create a feature branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Follow the existing code style
   - Add JSDoc comments for new functions
   - Add tests for new functionality

3. **Run all checks**

   ```bash
   pnpm run lint
   pnpm run typecheck
   pnpm run format:check
   pnpm test
   pnpm run build
   ```

4. **Version bump & committed bundle** (shipped-code changes only)
   - Any change to shipped code (`src/**` excluding tests, or the runtime `dependencies` in `package.json`) must bump `package.json` at least a patch (`pnpm version patch --no-git-tag-version`) and add a CHANGELOG.md entry in the same PR — the `require-version-bump` CI check fails the PR otherwise. Docs-only and test-only PRs are exempt.
   - The bundled `build/index.js` is committed to git: after source changes, rebuild (`pnpm run build`) and commit the updated bundle alongside `src/` — CI verifies the committed bundle matches the source.

5. **Commit your changes**
   - Use clear, descriptive commit messages
   - Reference any related issues

6. **Push and create a PR**
   - Describe what your PR does
   - Link any related issues

## Adding New Tools

When adding a new MCP tool:

1. **Add the schema** in `src/index.ts` (with a structured `Use when: / Returns: / Do not use when:` description, plus `Safety:` for any write/destructive tool)
2. **Implement the method** in `src/services/appleNotesManager.ts`
3. **Add type definitions** in `src/types.ts`
4. **Write tests** in `src/services/appleNotesManager.test.ts`
5. **Update documentation** in README.md and CHANGELOG.md. If the skill guidance changed, edit `skills/apple-notes/SKILL.md` (the canonical copy) and run `pnpm run sync:skills` — the `codex/` and `.antigravity-plugin/` copies are generated from it and CI fails if they drift

## AppleScript Guidelines

- Always escape user input using `escapeForAppleScript()` for plain text or `escapeHtmlForAppleScript()` for HTML content
- Handle errors gracefully (return null/false instead of throwing)
- Log errors with `console.error()` for debugging
- Test on actual macOS when possible

## Questions?

Open an issue for any questions about contributing.
