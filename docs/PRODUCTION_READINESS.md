# MockupSwap — System Audit and Refactoring Roadmap

> Audit date: 2026-07-13
> Scope: application architecture, archive lifecycle, preview isolation, persistence,
> async correctness, performance, accessibility, test/build tooling, and documentation.
> Baseline: 101 tests and strict TypeScript passed before the original audit.
> Current verification totals are recorded below.

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
| High | Persistence | Expose a generation-aware `dirty / saving / saved / at-risk` state machine and unload protection. | The UI reflects the active IndexedDB write precisely, stale completions are ignored, and the browser warns while recovery data can still be lost. |
| Medium | Performance | Cache the STORE-compressed snapshot for an unchanged archive revision. | Page navigation, selection, theme, and tab changes no longer rebuild the full zip. |
| Medium | Preview lifecycle | Catch preview-build errors and close the busy state in `finally`. | Failures surface instead of leaving an unhandled rejection and permanent spinner. |
| High | Active preview | Prefer and isolate browser-ready `dist`/`build`/`out` entries over source-root development HTML. | Dropped framework projects no longer open an uncompiled blank entry or collide with build assets. |
| Medium | Preview diagnostics | Bridge iframe resource/runtime failures into a visible canvas banner and persistent onboarding error notifications. | Blank or degraded previews now explain the actual failure and offer a reload action. |
| Medium | Memory | Revoke blob-preview URLs produced after an effect was cancelled. | Interrupted fallback rebuilds no longer leak object URLs. |
| High | Preview scaling | Publish immutable revision-specific caches with bounded writes and `AbortSignal` cancellation. | Large projects avoid `Cache.keys()` limits; superseded builds cannot mix generations or leave staging caches behind. |
| Medium | Browser coverage | Add Playwright coverage for a 500-file active site and a cancelled 1,200-file generation. | Modules, root-relative fetch/CSS, workers, project switching, cache cleanup, and export run against real Chromium and the service worker. |
| High | Archive safety | Centralize hard limits across ZIP, TAR/TGZ, folders, and loose files. | Intake rejects oversized input, record floods, expanded-data excess, compression bombs, oversized text sources, and non-portable paths before source scanning. |
| Medium | Build tooling | Upgrade Vite 5 to Vite 8 and `@vitejs/plugin-react` 6. | The build uses Rolldown, matches the current plugin peer range, and removes the prior Vite/esbuild audit findings. |
| Medium | Async correctness | Sequence Manual Replace planning requests. | Slow earlier searches cannot overwrite a newer result/count. |
| Medium | Worker transport | Transfer mutation buffers and file-read buffers rather than clone them. | Large replacement assets cross the worker boundary with less peak memory. |
| Medium | Worker lifecycle | Clean synchronous `postMessage` failures and late cancellation ids. | No orphan pending handlers or lifetime cancellation-id leak. |
| Medium | Restore safety | Validate every persisted patch union variant before rehydration. | Malformed/old rows are dropped before history, undo, or export consumes them. |
| Medium | Input correctness | Centralize image acceptance with a known-extension fallback. | Valid SVG/ICO/AVIF/BMP drag-drops work even when the OS supplies no MIME type. |
| Low | Type safety | Distinguish full saved records from blob-free list summaries. | Callers can no longer assume stripped list rows contain zip blobs. |
| Low | CSP | Remove unnecessary inline/blob script permission and block host form submission. | The editor shell has a narrower script policy. |
| Low | Planning | Add stable roadmap IDs, a required acceptance-test issue form, a PR evidence checklist, and contract tests. | Scheduled work moves to linked issues without duplicating a second backlog in this audit. |
| Low | Licensing | Add the MIT license text and package metadata. | Public distribution now has an explicit license grant. |

## Current verification

- `npm test`: 24 files, 156 tests passing.
- `npm run test:e2e`: 2 Chromium tests passing.
- Coverage gate: 85% lines across the selected fragile core modules.
- `npm run typecheck`: passing with strict/no-unused rules.
- `npm run build`: passing; Vite emits separate worker, re-encoder, export,
  JSZip, CSS, and application chunks.
- `git diff --check`: clean.
- `npm audit`: no production or development vulnerabilities after the Vite 8
  migration.

## Open roadmap status

The audit records completed production changes above. Remaining work lives in
the [roadmap scheduling index](ROADMAP.md), where each open item has a stable ID
and a GitHub issue-form link. Detailed scope, acceptance criteria, acceptance
tests, and verification evidence move into the concrete issue when work is
scheduled; they are not duplicated here.

| Priority | Open IDs | Scheduling state |
| --- | --- | --- |
| P0 — production trust boundary | `SEC-001`–`SEC-002` | Unscheduled |
| P1 — scale and correctness | `SCALE-001`–`SCALE-003` | Unscheduled |
| P2 — maintainability and coverage | `QA-001`–`QA-004`, `UX-001` | Unscheduled |
| P3 — product evolution | `PROD-001`–`PROD-008` | Unscheduled |

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
