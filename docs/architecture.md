# MockupSwap — Architecture

> Maintenance rule: update this document whenever architecture changes.
> Last reconciled with the codebase: 2026-07-15.

## 1. Purpose and boundaries

MockupSwap is a local-first React application for loading a static website
archive/folder, detecting image references, editing source content, previewing
the result, and exporting a deployable zip. Project bytes remain in the browser;
there is no application backend, authentication provider, telemetry service, or
API key.

The editor understands static HTML, CSS/preprocessor sources, manifests,
framework templates, and conservative literal visual references in JavaScript
and TypeScript families. It can render active built sites through the preview
service worker, but it neither builds source projects nor discovers arbitrary
computed runtime asset paths.

## 2. Stack

| Layer | Implementation |
| --- | --- |
| UI | React 18 + TypeScript 5 + Tailwind CSS 4 |
| Build | Vite 5 |
| Archive | ZIP via JSZip 3; browser-side POSIX/GNU/PAX TAR + gzip intake |
| Worker | Module Web Worker for zip parse, logo scan, snapshot, and export |
| Detection | DOMParser for markup; comment-aware CSS/code/manifest scanners |
| Preview | Service worker path server, with blob-based fallback |
| Persistence | IndexedDB sessions, named projects, and checkpoints |
| Tests | Vitest 4 + jsdom + V8 coverage |

Production code is strict TypeScript with unused locals/parameters rejected.
`npm run build` runs tests, TypeScript build validation, and Vite.

## 3. Major modules

```text
src/
├── App.tsx                         orchestration and cross-feature state
├── components/
│   ├── WorkspaceShell.tsx          desktop/tablet/mobile pane layout
│   ├── LeftPanel.tsx               upload, projects, files, modes
│   ├── CenterPanel.tsx             preview toolbar and iframe
│   ├── RightPanel.tsx              inspector, editor actions, export
│   ├── ChangeHistoryPanel.tsx      patches and checkpoints
│   ├── ManualReplacePanel.tsx      literal multi-file replacement
│   ├── DialogShell.tsx             focus-trapped modal primitive
│   └── ErrorBoundary.tsx           app/panel recovery UI
├── lib/
│   ├── archiveTypes.ts             JSZip-compatible abstraction
│   ├── projectInput.ts              ZIP/TAR/folder/loose-file normalization
│   ├── fileTypes.ts                 shared format and picker contracts
│   ├── workerZipArchive.ts         main-thread worker-backed facade
│   ├── projectWorkerClient.ts      request/progress/cancel transport
│   ├── imageDetector.ts            image reference scan
│   ├── assetReplacer.ts            replace/remove/placeholder surgery
│   ├── editorPatch.ts              direct editor mutations
│   ├── undoStack.ts                patch reversal
│   ├── previewServer.ts            service-worker preview population
│   ├── previewService.ts           opaque blob fallback
│   ├── exportService.ts            zip/report generation helpers
│   ├── idb.ts                      persistence stores and outcomes
│   └── persistedPatch.ts           restore-time union validation
└── workers/
    ├── projectWorker.ts            JSZip ownership and heavy packaging
    └── projectWorkerProtocol.ts    typed worker messages

public/preview-sw.js                path-based virtual preview server
tests/                              unit/component/in-memory zip tests
```

`App.tsx` remains the primary state holder. `WorkspaceShell` isolates responsive
layout, while domain components receive explicit state and callbacks. This is
functional but concentrated; the audit roadmap recommends domain hooks before
adding more features.

## 4. Archive and worker model

Before worker handoff, `projectInput.ts` recognizes ZIP signatures, unpacks
TAR/TAR.GZ/TGZ regular files, traverses directory picks/drops, normalizes safe
relative paths, rejects case-collisions, and packages non-ZIP inputs as ZIP.
Unknown companion files are retained when the selection contains recognizable
website source or assets. Symlinks, devices, traversal paths, and unsupported
archive types are not imported.

The worker then loads JSZip and retains the base archive under a generated
project id. It returns only file metadata, summary data, and logo candidates.
The UI holds a `WorkerZipArchive`, which implements the small `ZipArchiveLike`
surface used by the pure libraries.

```text
Archive / folder / loose files
  → safe normalization to ZIP
  → project worker: JSZip + entry metadata + logo scan
  → WorkerZipArchive facade in App
  → main-thread DOM image detection (worker file reads)
  → source/asset overrides retained by the facade
  → worker snapshot/export with transferable mutation buffers
```

Source edits write overrides through the facade; untouched base files stay in
the worker. Export and persistence send a mutation snapshot back to the worker,
which composes a fresh zip without copying the entire base archive to the UI.
ArrayBuffer request/response payloads use transfer lists.

Cancellation is request-id based. Initial analysis may terminate and recreate
the worker; late cancel messages are ignored once a request is no longer active.
Only one live project is expected, and replaced project ids are disposed.

## 5. Detection and mutation

`imageDetector.ts` reads HTML, CSS/preprocessor files, manifests, framework
templates, and JS/TS/JSX/TSX source. HTML is enumerated with `DOMParser`;
template/noscript content is intentionally ignored for deployable HTML but
exposed while scanning framework template files. CSS scanning covers `url()`
and quoted `image-set()` candidates. Code scanning is deliberately limited to
literal imports/require, `new URL(..., import.meta.url)`, fetch calls, static JSX
attributes, and CSS-in-JS URLs; comments and dynamic expressions are excluded.
URLs are resolved against archive paths and classified as local, missing, or
remote/risky.

All mutations operate on `project.zip` and produce an `AppliedPatch` union
member. Detection-derived actions use a composite identity:

```text
sourceFile::sourceTag::sourceAttr::rawUrl
```

Fit-style and grouped actions add suffixes or dedicated ids. Every patch stores
the exact source state needed for undo and a post-state for diff/report output.
Manual replacements snapshot each touched file. Restore-time patch rows are
validated by action before entering the live map.

Undo proceeds newest-first when changes share a source file. Per-row undo also
cascades through later dependent patches so an older source snapshot cannot
silently overwrite newer tracked work.

## 6. Preview architecture and trust model

The preferred path caches project responses under `/preview/<projectId>/...`.
`public/preview-sw.js` serves them with real MIME types and maps root-relative
requests back to the requesting preview client's project. Built projects under
`dist/`, `build/`, or similar roots therefore retain native module imports,
dynamic imports, `fetch`, workers, wasm, and root-relative assets.

HTML is augmented with a runtime that provides navigation bridging and editor
selection/edit/reorder/nudge messages. The parent accepts those messages only
when `event.source` is the current iframe window, then validates payload shape.

The service-worker iframe requires both `allow-scripts` and `allow-same-origin`
so the worker controls its requests. Consequently, active preview code is
same-origin with the editor and must be trusted. Top navigation is omitted. For
arbitrary third-party uploads, production deployment must move this preview to
a dedicated origin.

When the served path is unavailable, `previewService.ts` builds top-level blob
documents containing frame-owned asset blobs. This fallback deliberately omits
`allow-same-origin`, giving it an opaque origin. Object URLs are tracked and
revoked on rebuild, cancellation, and unmount.

## 7. Persistence

IndexedDB database `mockswap` currently uses three stores:

- `sessions`: one schema-version-keyed autosave row;
- `projects`: named full project records;
- `checkpoints`: named frozen versions indexed by `projectId`.

A snapshot includes project metadata, current STORE-compressed zip blob,
original zip blob, patch rows, UI selection, theme, and save time. Autosave is
debounced by one second and explicitly depends on the archive revision. A
synchronous mutation version prevents the generated blob and patch list from
coming from different source states. Superseded autosave generations are
discarded before they write or update status. The zip blob is cached and reused
while the archive revision is unchanged.

Save APIs return `ok`, `quota-exceeded`, or `error`. Failure marks the top bar at
risk and creates one persistent warning per failure streak. Project/checkpoint
lists return types that omit their stripped blob fields, although the current
store shape still requires IndexedDB to materialize full rows before stripping.

## 8. Responsive UI and accessibility

`WorkspaceShell` owns three responsive modes:

- desktop: project, preview, and inspector columns;
- tablet: project + preview with inspector drawer;
- mobile: one active pane selected by a segmented control.

Dialogs use `DialogShell` for initial focus, focus trapping, Escape dismissal,
and focus restoration. App and preview have independent error boundaries.
Toasts and progress animations respect reduced motion. A light/dark theme is
persisted. A few saved-project/checkpoint operations still use native browser
prompt/confirm dialogs and are roadmap work.

## 9. Build, CSP, and deployment

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite development server |
| `npm test` | Vitest once with coverage |
| `npm run typecheck` | strict TypeScript validation |
| `npm run build` | tests + TypeScript build + Vite output |
| `npm run preview` | serve the production bundle locally |

Vite emits the application, project worker, JSZip, export service, image
re-encoder, and CSS as separate chunks.

`index.html` includes a baseline meta policy. Production hosts should send the
equivalent or stricter header:

```text
Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline' blob:; script-src 'self'; worker-src 'self'; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

The preview service worker needs root scope. Configure SPA fallback so
`/preview-sw.js` remains a real JavaScript asset and is not rewritten to
`index.html`. Serve over HTTPS (localhost is sufficient for development).

## 10. Known risks and extension rules

Current high-value risks are tracked in `PRODUCTION_READINESS.md`: same-origin
active preview, monolithic orchestration, full-record IndexedDB listing,
main-thread DOM scanning, missing archive expansion limits, and incomplete
browser-level coverage.

When extending the system:

1. Keep `project.zip` as the only mutable file source.
2. Put source surgery in `src/lib`, not components.
3. Record exact undo and diff state for every mutation.
4. Never write preview/blob URLs into exportable source.
5. Validate persisted schema additions and bump the schema/database version as
   appropriate.
6. Clean up object URLs, listeners, timers, worker requests, and abort handlers.
7. Add regression tests before broadening markup, CSS, or code matching rules.
8. Reassess both served and blob preview modes for every sandbox/CSP change.
