#!/usr/bin/env bash
# Check the actual PR diff before release; exercised by version-guard.test.mjs.
set -euo pipefail

# Under workflow_dispatch there is no PR context — fall back to the
# fork point from origin/main (same semantics as the PR's triple-dot
# diff). Fetch main explicitly so merge-base cannot depend on
# checkout side effects.
if [ -z "${BASE_SHA}" ]; then
  git fetch --no-tags --quiet origin +refs/heads/main:refs/remotes/origin/main
  BASE_SHA="$(git merge-base origin/main HEAD)"
  HEAD_SHA="$(git rev-parse HEAD)"
fi

# Read both sides of renames and preserve exact Git path bytes until classification.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
changes="$(node "$SCRIPT_DIR/version-guard-changes.mjs" "$BASE_SHA" "$HEAD_SHA")"
changed="$(printf '%s\n' "$changes" | jq -r '.changed[]')"
ships="$(printf '%s\n' "$changes" | jq -r '.shipped[]')"
ts="$(printf '%s\n' "$changes" | jq -r '.typescript[]')"
bundle_changed="$(printf '%s\n' "$changes" | jq -r '.bundle[]')"
echo "Changed files:"; printf '%s\n' "$changed" | sed 's/^/  /'

# TypeScript reaches users through the bundle. Native sources and Shortcut
# assets ship verbatim and remain release detectors even with an unchanged bundle.
code="$ships"
if [ -n "$ts" ] && [ -n "$bundle_changed" ]; then
  code="$(printf '%s\n%s' "$ships" "$ts" | grep -v '^$' || true)"
elif [ -n "$ts" ]; then
  echo "::notice::src/ TypeScript changed but the committed bundle is byte-identical — nothing ships, so no version bump is required. (ci.yml's build-verify step proves build/ matches src/.)"
fi

# Runtime deps are shipped code too: they are inlined into the
# committed bundle. Compare only the `dependencies` map —
# devDependencies stay exempt so dev-dep automerge is unaffected
# (a devDep bump that changes the bundle is caught by build/**).
deps_changed=""
if printf '%s\n' "$changed" | grep -qx 'package.json'; then
  old_deps="$(git show "${BASE_SHA}:package.json" | jq -cS '.dependencies // {}')"
  new_deps="$(git show "${HEAD_SHA}:package.json" | jq -cS '.dependencies // {}')"
  if [ "$old_deps" != "$new_deps" ]; then
    deps_changed=1
    echo "Runtime dependencies changed:"
    echo "  base: $old_deps"
    echo "  head: $new_deps"
  fi
fi

oldv="$(git show "${BASE_SHA}:package.json" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
newv="$(node -e 'console.log(require("./package.json").version)')"
echo "package.json version: base=${oldv}  head=${newv}"

# ── CHANGELOG history is append-only ──────────────────────────────
# The rule below only proves the NEW version has a heading. A PR that
# RENAMES an existing heading instead of adding one satisfies it while
# ERASING a published release: retitling "## [1.1.12] - 2026-08-03"
# to "## [1.1.13] - 2026-08-04" leaves 1.1.13 documented and 1.1.12
# gone. Not hypothetical — apple-numbers-mcp #54 did exactly that, and
# since nothing downstream reads CHANGELOG.md it stayed invisible
# until an audit found the one missing heading across every published
# version in the four repos.
# So: every "## [X.Y.Z]" heading present at the base must still be
# present here. Adding is free; renaming or deleting one fails.
# Compared against the CHECKED-OUT tree — the merge result under
# pull_request, HEAD under workflow_dispatch — so a branch that is
# merely stale (main released while the PR sat open) is never blamed
# for headings it has not merged yet.
if [ ! -f CHANGELOG.md ]; then
  echo "::error::CHANGELOG.md is missing from this branch. It is the only record of what each published version contains — restore it."
  exit 1
fi
# Reading the base copy needs real history. The checkout above pins
# fetch-depth: 0; deepen defensively, then refuse to run rather than
# pass unevaluated, so a future edit to that input cannot silently
# turn this check into a no-op.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  git fetch --no-tags --quiet --unshallow || true
fi
if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  echo "::error::Base commit ${BASE_SHA} is not present in this clone (shallow checkout?), so the CHANGELOG history check cannot be evaluated. Restore 'fetch-depth: 0' on the checkout step."
  exit 1
fi
if git cat-file -e "${BASE_SHA}:CHANGELOG.md" 2>/dev/null; then
  base_heads="$(git show "${BASE_SHA}:CHANGELOG.md" | sed -nE 's/^## \[([0-9]+\.[0-9]+\.[0-9]+)\].*/\1/p')"
  head_heads="$(sed -nE 's/^## \[([0-9]+\.[0-9]+\.[0-9]+)\].*/\1/p' CHANGELOG.md)"
  # Loop + `grep -qxF` rather than `comm`: no sort-order or locale
  # assumptions, and a version string is full of regex metacharacters.
  lost=""
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    printf '%s\n' "$head_heads" | grep -qxF -- "$v" || lost="${lost}${v} "
  done <<< "$base_heads"
  if [ -n "$lost" ]; then
    echo "::error::CHANGELOG.md no longer has a '## [X.Y.Z]' heading for release(s) documented on the base: ${lost% }. A published release's section must never be renamed, retitled or removed — add a NEW heading for this release and restore the one(s) above."
    exit 1
  fi
  echo "CHANGELOG.md preserves every release heading present on the base."
else
  echo "::notice::No CHANGELOG.md at the base commit — no release headings to preserve."
fi

if [ "$oldv" != "$newv" ]; then
  # Bump present: require it to be an increase (typo'd downgrades)…
  OLDV="$oldv" NEWV="$newv" node -e '
    const a = process.env.OLDV.split(".").map(Number);
    const b = process.env.NEWV.split(".").map(Number);
    const cmp = (b[0]-a[0]) || (b[1]-a[1]) || (b[2]-a[2]);
    if (cmp > 0) { console.log("Version bumped " + process.env.OLDV + " -> " + process.env.NEWV + "."); process.exit(0); }
    console.error("::error::package.json version went " + process.env.OLDV + " -> " + process.env.NEWV + " (not an increase). Bump it forward.");
    process.exit(1);
  '
  # …and require it to be UNPUBLISHED. Two concurrently-open PRs can
  # each bump to the same next patch; without this, the second merge
  # is a version collision publish.yml silently skips. Registry
  # errors fail open (a registry outage must not block merges).
  PKG="$(node -p "require('./package.json').name")"
  set +e
  existing="$(npm view "${PKG}@${newv}" version 2>/dev/null)"
  set -e
  if [ -n "$existing" ]; then
    echo "::error::${PKG}@${newv} is already published on npm — this bump collides with an existing release (another PR likely claimed it first). Rebase on main and bump again:  pnpm version patch --no-git-tag-version"
    exit 1
  fi
  echo "${PKG}@${newv} is unclaimed on npm."

  # …and require CHANGELOG.md to document it under a REAL version
  # heading. An entry parked under "## [Unreleased]" is orphaned the
  # moment the release ships: nothing in the release path renames
  # that section (the `version` lifecycle script only syncs the
  # plugin manifests), so the published version ends up undocumented
  # while its notes sit under a heading claiming they are unreleased.
  # apple-notes-mcp shipped 2.6.10 and 2.6.11 exactly that way before
  # this check existed. dependabot-rebuild.yml already inserts a real
  # heading, so bot PRs pass unchanged.
  esc="$(printf '%s' "${newv}" | sed 's/\./\\./g')"
  if ! grep -qE "^## \[${esc}\]" CHANGELOG.md; then
    echo "::error::package.json bumped to ${newv} but CHANGELOG.md has no '## [${newv}]' heading. Move this release's notes out of '## [Unreleased]' and file them under '## [${newv}] - $(date -u +%Y-%m-%d)'. Keep an empty '## [Unreleased]' at the top — dependabot-rebuild.yml hard-fails without that marker."
    exit 1
  fi
  echo "CHANGELOG.md documents ${newv}."

  # …and require "## [Unreleased]" to be EMPTY. The heading check
  # above proves the new version is documented somewhere; it says
  # nothing about notes still parked under "## [Unreleased]", which
  # this release drains: everything on main ships in the next publish,
  # so prose left under that marker describes released behaviour while
  # claiming to be unreleased, and nothing later renames the section.
  # Until now nothing guarded that at all. dependabot-rebuild.yml
  # inserts its "## [X.Y.Z]" heading directly BELOW the marker and
  # leaves it empty, so bot PRs pass unchanged.
  if [ -z "$(awk 'index($0,"## [Unreleased]")==1{print "y"; exit}' CHANGELOG.md)" ]; then
    echo "::error::CHANGELOG.md has no '## [Unreleased]' heading. Keep an empty one at the top — dependabot-rebuild.yml hard-exits without that marker, so dropping it silently breaks the Dependabot rebuild + auto-bump path."
    exit 1
  fi
  unrel="$(awk 'index($0,"## [Unreleased]")==1{u=1;next} u&&index($0,"## ")==1{exit} u{print}' CHANGELOG.md)"
  if [ -n "$(printf '%s' "$unrel" | tr -d '[:space:]')" ]; then
    echo "::error::Version is bumped to ${newv} but '## [Unreleased]' is not empty. This release publishes everything on main, so those notes ship as ${newv} while sitting under a heading that says they are unreleased — and nothing renames that section later. Move them under '## [${newv}] - $(date -u +%Y-%m-%d)' and leave '## [Unreleased]' empty. Content found:"
    printf '%s\n' "$unrel" | sed 's/^/  /'
    exit 1
  fi
  echo "'## [Unreleased]' is empty."
fi

if [ -z "$code" ] && [ -z "$deps_changed" ]; then
  echo "::notice::No shipped-byte changes — version bump not required."
  exit 0
fi
if [ -n "$code" ]; then
  echo "Shipped-byte changes detected:"; printf '%s\n' "$code" | sed 's/^/  /'
fi

if [ "$oldv" = "$newv" ]; then
  if [ -n "$deps_changed" ]; then
    echo "::error::Runtime dependencies changed (the shipped bundle changes) but package.json version is unchanged (${oldv}). Bump at least a patch + add a CHANGELOG entry so publish.yml actually ships the dependency update:  pnpm version patch --no-git-tag-version"
  else
    echo "::error::Shipped bytes changed (the committed build/ bundle, requirements.txt, a verbatim-shipped src/ file, native runtime source, or a Shortcut asset) but package.json version is unchanged (${oldv}). Bump it at least a patch:  pnpm version patch --no-git-tag-version  (and add a CHANGELOG entry)."
  fi
  exit 1
fi
echo "Shipped bytes changed and version is bumped — OK."
