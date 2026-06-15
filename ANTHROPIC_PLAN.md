# Squad Claude — Decoupling Plan

## Goal

Decouple `@github/copilot-sdk` from the Squad runtime so that Claude/Anthropic users never install it.
Keep the Copilot path fully functional for users who have it.
Rename packages under the `@ozbobdev` npm scope.

## Decision log

| Decision | Choice |
|---|---|
| npm scope | `@ozbobdev` |
| SDK package name | `@ozbobdev/squad-claude-sdk` |
| CLI package name | `@ozbobdev/squad-claude-cli` |
| Copilot SDK | Move to `optionalDependencies`; lazy-load at runtime |

---

## Phase 1 — Make Copilot optional in squad-sdk

**Files touched: 3**

### `packages/squad-sdk/package.json`

- `name`: `@bradygaster/squad-sdk` → `@ozbobdev/squad-claude-sdk`
- Move `@github/copilot-sdk` from `dependencies` → `optionalDependencies`
- Remove `vscode-jsonrpc` from `dependencies` (only needed by Copilot SDK transitively)
- Update `description`: remove "GitHub Copilot", replace with "multi-agent runtime for Claude and Anthropic"
- Remove `"copilot"` from `keywords`; add `"anthropic"`, `"claude"`
- Update `homepage` and `repository` to point to `github.com/ozbobdev/squad.claude`

### `packages/squad-sdk/src/adapter/client.ts`

Remove the top-level static import:
```typescript
// REMOVE:
import { CopilotClient } from "@github/copilot-sdk";
```

Add a lazy loader near the top of the file:
```typescript
type CopilotClientCtor = typeof import('@github/copilot-sdk').CopilotClient;
let _CopilotClient: CopilotClientCtor | undefined;

async function requireCopilotClient(): Promise<CopilotClientCtor> {
  if (!_CopilotClient) {
    const mod = await import('@github/copilot-sdk').catch(() => null);
    _CopilotClient = mod?.CopilotClient;
  }
  if (!_CopilotClient) {
    throw new Error(
      '@github/copilot-sdk is not installed.\n' +
      'Run: npm install @github/copilot-sdk\n' +
      'Or:  pass { anthropicMode: true } to use the Anthropic/Claude provider instead.'
    );
  }
  return _CopilotClient;
}
```

Move `new CopilotClient(...)` from the constructor into `connect()`:
- Constructor sets `this.client = null` (the field becomes nullable)
- `connect()` calls `const Ctor = await requireCopilotClient()` then `this.client = new Ctor({...})`
- All methods that call `this.client` guard with `if (!this.client) throw ...`

The `anthropicMode` short-circuit in `connect()` already returns before `requireCopilotClient()` is
reached, so Claude users never trigger the dynamic import.

### `packages/squad-sdk/src/build/bundle.ts`

Remove `'@github/copilot-sdk'` from `DEFAULT_EXTERNAL`:
```typescript
// BEFORE:
const DEFAULT_EXTERNAL = ['@github/copilot-sdk'];

// AFTER:
const DEFAULT_EXTERNAL: string[] = [];
```

Copilot SDK is no longer a guaranteed peer, so it should not be treated as an external.

---

## Phase 2 — Harden the CLI entry point

**Files touched: 1**

### `packages/squad-cli/src/cli-entry.ts`

Add a helper before the patch blocks:
```typescript
function isPackageInstalled(pkg: string): boolean {
  try { require.resolve(pkg); return true; } catch { return false; }
}
```

Wrap the ESM import patch block (currently lines ~25–54) in a guard:
```typescript
if (isPackageInstalled('@github/copilot-sdk')) {
  // ... existing vscode-jsonrpc/node ESM patch ...
}
```

Wrap the `node:sqlite` / Node version check block (currently lines ~56–72) in the same guard:
```typescript
if (isPackageInstalled('@github/copilot-sdk')) {
  // ... existing Node 22.5+ sqlite version check ...
}
```

**Result:** A Claude-only user running `squad init` or `squad doctor` will no longer hit the
Copilot SDK boot-time ESM patch or the sqlite version assertion.

---

## Phase 3 — Graceful degradation in Copilot CLI commands

**Files touched: 5**

### New file: `packages/squad-cli/src/cli/core/copilot-guard.ts`

```typescript
export function requireCopilotOrExit(command: string): void {
  try {
    require.resolve('@github/copilot-sdk');
  } catch {
    console.error(
      `'squad ${command}' requires @github/copilot-sdk.\n` +
      'Install it with: npm install @github/copilot-sdk\n' +
      'Or use the Claude provider (anthropicMode: true) instead.'
    );
    process.exit(1);
  }
}
```

### Files that call `requireCopilotOrExit` at their top:

| File | Call |
|------|------|
| `src/cli/commands/copilot.ts` | `requireCopilotOrExit('copilot')` |
| `src/cli/commands/copilot-bridge.ts` | `requireCopilotOrExit('copilot')` |
| `src/cli/core/copilot-invocation.ts` | `requireCopilotOrExit('copilot')` |

### `src/cli/copilot-install.ts`

Wrap the body in a try/catch dynamic import and export no-op stubs when SDK is absent:
```typescript
let impl: typeof import('./copilot-install-impl.js') | null = null;
try {
  impl = await import('./copilot-install-impl.js');
} catch {
  impl = null;
}
export const detectCopilotEnvironment = impl?.detectCopilotEnvironment ?? (() => null);
```

---

## Phase 4 — Rename squad-cli package

**Files touched: 2 + bulk string replace**

### `packages/squad-cli/package.json`

- `name`: `@bradygaster/squad-cli` → `@ozbobdev/squad-claude-cli`
- In `dependencies`: `"@bradygaster/squad-sdk"` → `"@ozbobdev/squad-claude-sdk"`
- Remove `"./copilot-install"` from the `exports` map (it becomes an internal detail)
- Update `description`, `keywords`, `homepage`, `repository`

### Bulk string replace across `packages/squad-cli/src/`

Every `import` or `require` that references `@bradygaster/squad-sdk` becomes
`@ozbobdev/squad-claude-sdk`. This is a mechanical find-and-replace with no logic changes.

---

## Phase 5 — Root monorepo

**Files touched: 1**

### `package.json` (root, private — does not publish)

- `name`: `@bradygaster/squad` → `@ozbobdev/squad-claude`

---

## Phase 6 — Test suite

**Files touched: up to 6**

Existing tests mock `@github/copilot-sdk` with `vi.mock(...)`. After Phase 1's refactor
(constructor → `connect()` deferral), verify that:

- `vi.mock('@github/copilot-sdk', ...)` still intercepts the dynamic `import()` inside
  `requireCopilotClient()`. Vitest's module mocking covers dynamic imports, so this should
  work without changes.
- Add one new test: `new SquadClient()` with Copilot SDK absent throws the correct error
  message when `connect()` is called.
- Add one new test: `new SquadClient({ anthropicMode: true })` with Copilot SDK absent
  connects successfully (the lazy import is never triggered).

---

## What is NOT changing

| Area | Status |
|---|---|
| Squad runtime (agents, routing, casting, ceremonies, state, skills) | Unchanged |
| `CopilotSessionAdapter` | Kept — Copilot path still fully functional |
| `AnthropicSessionAdapter` | Already implemented |
| `SquadSession` interface and event model | Unchanged |
| `.squad/` file format and CLI commands (non-Copilot) | Unchanged |
| `squad init`, `squad upgrade`, `squad doctor`, etc. | Unchanged |

---

## Outcome

| Scenario | Before | After |
|---|---|---|
| `npm install @ozbobdev/squad-claude-sdk` (Claude only) | Pulls in Copilot SDK | Copilot SDK not installed |
| `new SquadClient({ anthropicMode: true })` | Copilot SDK loaded at startup | Never touched |
| `new SquadClient()` without Copilot SDK | Crashes at import time | Clear error at `connect()` |
| `squad copilot` without Copilot SDK | Obscure ESM crash | Friendly message + exit 1 |
| `squad init` / `squad doctor` without Copilot SDK | ESM patch runs (may fail) | Patch skipped entirely |

---

---

## Phase 7 — GitHub Actions: publish to npmjs

### Context: existing workflows

| Workflow | File | Role |
|---|---|---|
| Squad npm Publish | `squad-npm-publish.yml` | Publishes both packages to npmjs — **needs updating** |
| Squad Release | `squad-release.yml` | Creates git tag + GitHub Release on push to `main` — **no changes needed** |
| Setup Squad Node (composite) | `actions/setup-squad-node/action.yml` | DRY node/npm setup — **no changes needed** |

`squad-release.yml` fires on push to `main`, creates the GitHub Release, which then
triggers `squad-npm-publish.yml` via `on: release: types: [published]`. The chain is
already wired — only the publish workflow needs updating.

---

### Changes to `.github/workflows/squad-npm-publish.yml`

**Files touched: 1**

All changes are string replacements — no structural changes to the workflow logic.

#### Job: `preflight` — lockfile stability check

The lockfile drift check filters on `@bradygaster/squad-`:

```yaml
# BEFORE:
k.includes('node_modules/@bradygaster/squad-') &&

# AFTER:
k.includes('node_modules/@ozbobdev/squad-claude-') &&
```

Same check, same two occurrences.

#### Job: `preflight` — registry health check (inside `registry-check` job)

```yaml
# BEFORE:
if ! npm view @bradygaster/squad-sdk version 2>/dev/null; then
  echo "::warning::Cannot verify @bradygaster/squad-sdk on registry..."
else
  echo "✅ @bradygaster package namespace is accessible"

# AFTER:
if ! npm view @ozbobdev/squad-claude-sdk version 2>/dev/null; then
  echo "::warning::Cannot verify @ozbobdev/squad-claude-sdk on registry..."
else
  echo "✅ @ozbobdev package namespace is accessible"
```

#### Job: `publish-sdk`

```yaml
# BEFORE — job name:
name: Publish @bradygaster/squad-sdk

# AFTER:
name: Publish @ozbobdev/squad-claude-sdk
```

```yaml
# BEFORE — build step:
run: npm -w packages/squad-sdk run build

# AFTER (workspace name matches the renamed package.json name):
run: npm -w @ozbobdev/squad-claude-sdk run build
```

> Note: npm workspace `-w` flag accepts either the directory path
> (`packages/squad-sdk`) or the package name. Either works; the directory form
> is safer during the rename transition.

```yaml
# BEFORE — version verify:
PKG_VERSION=$(node -p "require('./packages/squad-sdk/package.json').version")

# AFTER (path is unchanged — only the package name inside that file changes):
PKG_VERSION=$(node -p "require('./packages/squad-sdk/package.json').version")
```

```yaml
# BEFORE — publish step:
run: npm -w packages/squad-sdk publish --access public --provenance

# AFTER (no change — path unchanged):
run: npm -w packages/squad-sdk publish --access public --provenance
```

```yaml
# BEFORE — verification:
if npm view @bradygaster/squad-sdk@${{ steps.version.outputs.version }} version 2>/dev/null; then

# AFTER:
if npm view @ozbobdev/squad-claude-sdk@${{ steps.version.outputs.version }} version 2>/dev/null; then
```

#### Job: `publish-cli`

```yaml
# BEFORE — job name:
name: Publish @bradygaster/squad-cli

# AFTER:
name: Publish @ozbobdev/squad-claude-cli
```

```yaml
# BEFORE — file: guard:
SDK_DEP=$(node -p "require('./packages/squad-cli/package.json').dependencies['@bradygaster/squad-sdk']")
if [[ "$SDK_DEP" == file:* ]]; then
  echo "::error::squad-cli has file: dependency on squad-sdk..."

# AFTER:
SDK_DEP=$(node -p "require('./packages/squad-cli/package.json').dependencies['@ozbobdev/squad-claude-sdk']")
if [[ "$SDK_DEP" == file:* ]]; then
  echo "::error::squad-claude-cli has file: dependency on squad-claude-sdk..."
```

```yaml
# BEFORE — SDK resolvability check:
SDK_DEP=$(node -p "require('./packages/squad-cli/package.json').dependencies['@bradygaster/squad-sdk']")
if ! npm view "@bradygaster/squad-sdk" versions --json 2>/dev/null | node -e "...

# AFTER:
SDK_DEP=$(node -p "require('./packages/squad-cli/package.json').dependencies['@ozbobdev/squad-claude-sdk']")
if ! npm view "@ozbobdev/squad-claude-sdk" versions --json 2>/dev/null | node -e "...
```

```yaml
# BEFORE — verification:
if npm view @bradygaster/squad-cli@${{ steps.version.outputs.version }} version 2>/dev/null; then

# AFTER:
if npm view @ozbobdev/squad-claude-cli@${{ steps.version.outputs.version }} version 2>/dev/null; then
```

---

### Required GitHub Secrets

| Secret | Where set | Purpose | Notes |
|---|---|---|---|
| `NPM_TOKEN` | Repo → Settings → Secrets → Actions | Authenticates `npm publish` to the `@ozbobdev` npm org | **New token required** — the existing token (if any) is scoped to `@bradygaster`. See setup steps below. |
| `GITHUB_TOKEN` | Built-in (automatic) | Creates releases, reads repo | No action needed |

**No other secrets are required.** The `id-token: write` permission in the workflow
enables npm provenance via OIDC — it does not require a separate secret.

---

### One-time setup before first publish

These steps must be completed manually once, outside of CI:

#### 1. Create the `@ozbobdev` npm organisation

```
https://www.npmjs.com/org/create
```

Log in to npmjs.com as the `OzBob` account, create the org `ozbobdev`, and set
package access to **Public** (free tier).

#### 2. Generate a publish token

1. npmjs.com → Avatar → Access Tokens → **Generate New Token** → **Classic Token**
2. Type: **Automation** (bypasses 2FA for CI use)
3. Scope: leave default — the token inherits the account's publish rights to `@ozbobdev`
4. Copy the token immediately (shown once)

#### 3. Add the token to GitHub

```
GitHub repo → Settings → Secrets and variables → Actions → New repository secret
Name:  NPM_TOKEN
Value: <paste token>
```

#### 4. Enable npm provenance for the org (optional but recommended)

npmjs.com → `@ozbobdev` org → Settings → **Publishing access** →
enable "Require two-factor authentication for publishing" and
"Allow provenance for this organization".

Provenance (`--provenance` flag in the workflow) links the published package to its
exact GitHub commit and Actions run. It requires:
- The GitHub repo to be the declared source (`repository` field in package.json)
- `id-token: write` permission (already in the workflow)
- The npm org to allow provenance (free, opt-in setting above)

If provenance causes issues on first publish, temporarily drop the flag:
```yaml
run: npm -w packages/squad-sdk publish --access public
```

---

### How the release flow works end-to-end

```
1. Bump versions in packages/squad-sdk/package.json
                      packages/squad-cli/package.json
   (keep them in sync)

2. Update CHANGELOG.md with the new version entry

3. Push to main
   → squad-release.yml fires
   → validates CHANGELOG.md has the new version
   → creates git tag vX.Y.Z
   → creates GitHub Release

4. GitHub Release published event
   → squad-npm-publish.yml fires
   → preflight: validates no file: deps, lockfile stable, semver valid
   → smoke-test: dry-run npm pack for both packages
   → registry-check: pings npmjs, verifies @ozbobdev namespace reachable
   → publish-sdk: builds + publishes @ozbobdev/squad-claude-sdk
   → publish-cli: verifies SDK is on registry, builds + publishes @ozbobdev/squad-claude-cli
```

---

## Implementation order

1. Phase 1 (squad-sdk) — build-verify after each step
2. Phase 2 (cli-entry.ts guards) — lightweight, low risk
3. Phase 3 (Copilot command guards) — additive only
4. Phase 4 (package rename) — do last; triggers the bulk find-and-replace
5. Phase 5 (root package.json) — trivial
6. Phase 6 (tests) — run full test suite after all phases
7. Phase 7 (GitHub Actions) — update workflow strings; complete one-time npm org setup

Each phase is independently buildable and testable. Stop after Phase 1 if the
lazy-load refactor reveals unexpected complexity.

Phase 7 can be done in parallel with Phases 2–6 since it only touches YAML files.
The one-time npm org setup (creating `@ozbobdev`, generating the token, adding the
GitHub secret) must be done before the first publish attempt.
