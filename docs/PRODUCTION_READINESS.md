# MockupSwap — System Audit and Refactoring Roadmap

> Audit date: 2026-07-13
> Scope: application architecture, archive lifecycle, preview isolation, persistence,
> async correctness, performance, accessibility, test/build tooling, and documentation.
> Baseline: 101 tests and strict TypeScript passed before changes; 108 tests pass
> after the patch set. The production build succeeds.

## Executive assessment

MockupSwap has a strong functional core: source edits are reversible, export is
local-only, parsing and URL surgery have meaningful test coverage, large binary
zip work is partially worker-backed, and failures are generally surfaced in the
UI. It is suitable for trusted local use today.

The primary production constraint is the active preview trust boundary. Modern
projects are served from same-origin `/preview/...` URLs so native modules,
workers, `fetch()`, and root-relative assets work. That requires the preview
iframe to retain `allow-same-origin`; uploaded scripts must therefore be treated
as trusted. A public service that accepts arbitrary third-party projects should
serve previews from a dedicated origin before being described as isolated.

## Changes implemented in this audit

| Priority | Area | Change | Result |
| --- | --- | --- | --- |
| High | Preview security | Authenticate `postMessage` events against the currently mounted iframe. | Other windows can no longer forge editor/navigation messages. |
| High | Preview security | Grant `allow-same-origin` only to service-worker previews; keep blob fallback opaque. | The fallback can no longer reach editor storage or DOM through inherited blob origin. |
| High | Persistence | Make archive revision an explicit autosave dependency. | Source mutations reliably schedule persistence without waiting for unrelated UI changes. |
| High | Persistence | Guard snapshot generation with a synchronous mutation version. | A save cannot pair an older zip blob with newer patch metadata. |
| High | Persistence | Discard superseded autosave generations before write/status updates. | A slower obsolete snapshot cannot overwrite a newer scheduled save. |
| Medium | Performance | Cache the STORE-compressed snapshot for an unchanged archive revision. | Page navigation, selection, theme, and tab changes no longer rebuild the full zip. |
| Medium | Preview lifecycle | Catch preview-build errors and close the busy state in `finally`. | Failures surface instead of leaving an unhandled rejection and permanent spinner. |
| Medium | Memory | Revoke blob-preview URLs produced after an effect was cancelled. | Interrupted fallback rebuilds no longer leak object URLs. |
| Medium | Async correctness | Sequence Manual Replace planning requests. | Slow earlier searches cannot overwrite a newer result/count. |
| Medium | Worker transport | Transfer mutation buffers and file-read buffers rather than clone them. | Large replacement assets cross the worker boundary with less peak memory. |
| Medium | Worker lifecycle | Clean synchronous `postMessage` failures and late cancellation ids. | No orphan pending handlers or lifetime cancellation-id leak. |
| Medium | Restore safety | Validate every persisted patch union variant before rehydration. | Malformed/old rows are dropped before history, undo, or export consumes them. |
| Medium | Input correctness | Centralize image acceptance with a known-extension fallback. | Valid SVG/ICO/AVIF/BMP drag-drops work even when the OS supplies no MIME type. |
| Low | Type safety | Distinguish full saved records from blob-free list summaries. | Callers can no longer assume stripped list rows contain zip blobs. |
| Low | CSP | Remove unnecessary inline/blob script permission and block host form submission. | The editor shell has a narrower script policy. |

## Current verification

- `npm test`: 18 files, 108 tests passing.
- Coverage gate: 85% lines across the selected fragile core modules.
- `npm run typecheck`: passing with strict/no-unused rules.
- `npm run build`: passing; Vite emits separate worker, re-encoder, export,
  JSZip, CSS, and application chunks.
- `git diff --check`: clean.
- Dependency vulnerability lookup: not completed. The local sandbox blocked
  the npm audit request because it would disclose dependency metadata to an
  external registry without separate explicit approval. Run `npm audit` in an
  approved CI environment.

## Remaining findings and recommended refactoring

### P0 — Production trust boundary

1. **Put active previews on a dedicated origin.** The service-worker preview is
   intentionally same-origin and can run uploaded JavaScript. For arbitrary
   uploads, use a separate preview host/origin with no editor cookies or storage,
   a narrow message protocol, per-session unguessable ids, and an allowlist of
   parent origins. Keep the existing blob fallback for browsers without worker
   support.
2. **Enforce response headers at the host.** Meta CSP is a useful baseline, not
   a substitute for headers. Add the policy documented in `architecture.md`,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and an
   explicit `Permissions-Policy`.

### P1 — Scale and correctness

1. **Split `App.tsx` by domain.** At roughly 3,400 lines it owns onboarding,
   preview navigation, editing, history, persistence, projects, checkpoints,
   export, dialogs, and responsive UI. Extract hooks in this order:
   `useProjectLifecycle`, `usePatchHistory`, `usePreviewSession`,
   `useProjectPersistence`, then `useEditorBridge`. Keep zip mutation primitives
   in `src/lib` and make the hooks orchestration-only.
2. **Separate IndexedDB metadata from blob payloads.** `listProjects()` and
   `listCheckpoints()` currently must read full records before stripping blobs.
   Introduce metadata stores (or normalized records) so listing many large
   projects does not materialize every zip. Migrate in a new DB version and keep
   full payload reads id-based.
3. **Move source scanning off the UI thread.** Zip parse/logo detection/export
   run in a worker, but `detectImages` uses browser `DOMParser` on the main
   thread. Either use a worker-safe HTML parser with strict size limits or split
   source extraction in the worker from small, scheduled DOM parse batches on
   the UI thread.
4. **Add archive resource limits.** The 150 MB input warning is soft and based
   on compressed file size. Add configurable limits for entry count, cumulative
   uncompressed bytes, individual text-source bytes, path length, and compression
   ratio before parsing/detecting. This is the defense against accidental or
   hostile zip bombs.
5. **Expose explicit persistence state.** Superseded generations are discarded
   before writes and the browser serializes store transactions, but the UI only
   distinguishes healthy versus at-risk. A small save queue/state machine would
   expose `dirty / saving / saved / at-risk` precisely and make unload warnings
   possible.

### P2 — Maintainability and coverage

1. Add component/integration tests for autosave-after-edit, cancelled preview
   rebuild cleanup, stale manual-search suppression, worker restart, project
   restore, and same-origin versus blob sandbox flags.
2. Add a browser smoke suite (Playwright) covering upload → preview → editor
   change → undo → checkpoint → export at desktop and mobile widths.
3. Add ESLint with React Hooks and accessibility rules. TypeScript catches type
   failures but not missing hook dependencies, impure updater functions, or most
   ARIA mistakes.
4. Raise branch coverage in `exportService`, `urlRewriter`, `undoStack`, and the
   persisted-patch validator. The line gate is healthy; branch coverage remains
   roughly 68%.
5. Replace native `prompt()`/`confirm()` calls in saved projects and checkpoints
   with `DialogShell` forms so focus, validation, theming, and keyboard behavior
   are consistent.
6. Convert roadmap items into issue-linked acceptance tests as work is
   scheduled so this audit remains status, not a second backlog.
7. Add an actual `LICENSE` file and a `license` package field before public
   distribution; the README's current “MIT-style for now” wording is not a
   complete license grant.

### P3 — Product evolution

1. Add JavaScript reference detection through a conservative AST pass for
   string-literal imports, `new URL(..., import.meta.url)`, and common asset maps.
2. Add a project-level diff/export manifest view rather than only per-patch
   diffs.
3. Add responsive thumbnail virtualization for projects with hundreds of image
   references instead of the current fixed cap of 60 previews.
4. Add optional telemetry only if the local-only privacy promise is explicitly
   revised; keep it absent by default.

## Refactoring invariants

- `project.zip` remains the only mutable file-system state.
- Every source-changing action records exact pre/post text and is undoable.
- Exported references are deployable relative paths—never `blob:`, `file:`, or
  parent-owned object URLs.
- Worker facades remain compatible with pure library functions and in-memory
  JSZip tests.
- Preview capability changes must preserve both active-site rendering and the
  documented trust boundary.
- New persistence formats require a DB/schema migration and malformed-row tests.
