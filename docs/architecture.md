# MockupSwap — Architecture

> **Maintenance rule:** If architecture changes, update architecture.md. If architecture does not change, leave it untouched.

---

## 1. Project purpose

**MockupSwap** is a single-page browser tool for **swapping images and logos inside any static website `.zip`** — without touching a text editor. The user uploads a site archive, points at the image(s) they want to change, drops in replacements, and exports an updated `.zip` that is ready to re-deploy.

Key product properties:

- **Local-only.** No file ever leaves the browser. No backend, no API keys, no environment file.
- **Static-site only.** Reads HTML / CSS / manifest; does not understand dynamic JS module imports.
- **Per-patch reversible.** Every apply snapshots pre/post source text so the user can undo any single change, the last change, the per-image stack, or the whole project.

Intended user: anyone iterating on a static mockup (from a generator, a designer, or a prior site) who needs to swap assets before deploy.

---

## 2. Technology stack

| Layer            | Choice                                          |
| ---------------- | ----------------------------------------------- |
| Build tool       | **Vite 5** (`vite` + `@vitejs/plugin-react`)    |
| Language         | **TypeScript 5** (strict, `noUnusedLocals`, `noUnusedParameters`) |
| Framework        | **React 18** with `StrictMode`                  |
| Styling          | **Tailwind CSS 4** (`@tailwindcss/vite`)        |
| Zip I/O          | **JSZip 3** (browser-only, async)               |
| Persistence      | **IndexedDB** (hand-rolled, no library)         |
| Image work       | Browser **Canvas API** + `createImageBitmap`    |
| Iframe preview   | Native sandboxed `<iframe src="blob:...">` with frame-owned subresource blobs + injected navigation script |
| Tests             | None (intentional; no test framework configured) |

**No** backend, **no** auth, **no** third-party SaaS, **no** environment variables, **no** build secrets.

---

## 3. Directory structure

```
/
├── index.html                    — single entry HTML; mounts #root
├── vite.config.ts                — Vite config (port 5173, host: true)
├── tsconfig.json / *.app.json / *.node.json
├── package.json
└── src/
    ├── main.tsx                  — createRoot + StrictMode
    ├── App.tsx                   — top-level state machine, orchestration
    ├── types.ts                  — all shared types incl. AppliedPatch union
    ├── index.css                 — Tailwind import + scrollbar tweaks
    ├── components/               — UI layer (all TSX)
    │   ├── LeftPanel.tsx         — file tree + tabbed bottom panel
    │   ├── CenterPanel.tsx       — iframe preview + toolbar
    │   ├── RightPanel.tsx        — asset details + action area + export
    │   ├── FileTree.tsx          — collapsible directory tree
    │   ├── ProjectSummary.tsx    — file-count stats card
    │   ├── DetectedImagesList.tsx — bulk-replace drop zone + filterable list
    │   ├── ChangeHistoryPanel.tsx — History tab with per-row Undo
    │   ├── DiffView.tsx          — disclosure-rendered line diff
    │   ├── LogoHelperPanel.tsx   — Logo Helper tab UI
    │   ├── ManualReplacePanel.tsx — Manual Replace tab UI
    │   ├── FitStylePanel.tsx     — object-fit / radius / overlay chips
    │   ├── UploadButton.tsx      — drag-drop zip upload target
    │   └── FileIcon.tsx          — inline-SVG icon set (no icon library)
    └── lib/                      — pure-TS business logic
        ├── zipReader.ts          — File → LoadedProject
        ├── imageDetector.ts      — HTML / CSS / manifest → ImageDetection[]
        ├── logoHelper.ts         — logo scan + apply (header/footer/favicon/apple-touch/manifest)
        ├── assetReplacer.ts      — applyReplacement / applyRemove / applyPlaceholder
        ├── bulkReplace.ts        — apply one image to N detections, with rollback
        ├── manualReplace.ts      — plain-text find/replace, per-file snapshots
        ├── fitStyles.ts          — applyFitStyleToImg / applyFitStyleToCss
        ├── previewService.ts     — zip → sandboxed iframe preview index
        ├── urlRewriter.ts        — rewrite HTML/CSS refs to preview URL tokens
        ├── urlResolver.ts        — relative-path resolution against zip paths
        ├── imageReencoder.ts     — optional WebP round-trip via Canvas
        ├── exportService.ts      — wrap mutated zip + MOCKUPSWAP_CHANGES.md
        ├── undoStack.ts          — central undoPatchById / undoMany primitive
        ├── idb.ts                — IndexedDB wrapper (session persistence)
        ├── fileTree.ts           — flat entries → nested FileNode
        ├── lineDiff.ts           — LCS line diff for History panel
        ├── filenameSanitizer.ts  — safe filenames + assets/mockups/<name>
        ├── pathRelative.ts       — POSIX path.relative from source to target
        ├── mime.ts               — extension → MIME lookup
        └── fileTypes.ts          — FileCategory, formatBytes, normalizePath
```

**Generation rules:** `dist/` (Vite output) and `*.tsbuildinfo` files are build artifacts and git-ignored.

---

## 4. Frontend architecture

### 4.1 Layout

3-column fixed grid (`360px / 1fr / 320px`) under a top bar; tabs sit inside the left panel's bottom region.

```
┌───────────────────────────────────────────────────────┐
│  TopBar                              (project name)   │
├─────────────┬───────────────────────────┬─────────────┤
│             │                           │             │
│  LeftPanel  │       CenterPanel         │ RightPanel  │
│             │       (iframe preview)    │             │
│ ─ Upload    │                           │ Asset det.  │
│ ─ Summary   │                           │ Action area │
│ ─ FileTree  │                           │  Replace    │
│             │                           │  Remove     │
│ ─ Mode tabs │                           │  Placehold. │
│   Images    │                           │ Fit & style │
│   Logos     │                           │ Export      │
│   Manual    │                           │             │
│   History   │                           │             │
└─────────────┴───────────────────────────┴─────────────┘
```

### 4.2 Component tree

`App.tsx` is the **single top-level state holder** for project + patches + selection + UI mode. Every panel props-drills callbacks + state; there is no Redux / Zustand / Context.

```
<App>
 ├── <TopBar>                                    — header
 ├── <RestoreBanner>                             — boot-time restore UI
 ├── <LeftPanel>    ─► mode tabs (Images/Logos/Manual/History)
 │     ├── <UploadButton>
 │     ├── <ProjectSummaryCard>
 │     ├── <FileTree>
 │     └── mode-specific panel:
 │         ├── <DetectedImagesList>              — Images tab
 │         ├── <LogoHelperPanel>                 — Logos tab
 │         ├── <ManualReplacePanel>              — Manual tab
 │         └── <ChangeHistoryPanel>              — History tab
 ├── <CenterPanel>  — preview toolbar + <iframe src=blob:...>
 ├── <RightPanel>   ─► <FitStylePanel> + Export section
 └── {bulkConfirm && <BulkConfirmModal>}
```

### 4.3 State model

All persistent state lives in `App.tsx`:

| State                                   | Type                          | Purpose |
| --------------------------------------- | ----------------------------- | ------- |
| `project`, `originalFile`, `originalBlob` | `LoadedProject \| null`        | Current and pristine zip |
| `patchesByKey`                          | `Map<string, AppliedPatch>`   | All applied edits; key is `sourceFile::sourceTag::sourceAttr::rawUrl` (or `#fit` / `manual:`) |
| `detections`, `logoCandidates`          | `ImageDetection[] / LogoCandidate[]` | Scan results |
| `selectedDetectionKey`                  | `string \| null`              | Right-panel focus |
| `thumbnails`                            | `Map<resolvedPath, blobUrl>`  | Preview thumbs |
| `preview`                               | `PreviewIndex \| null`        | Iframe HTML preview index |
| `leftPanelMode`                         | `'images' \| 'logos' \| 'manual' \| 'history'` | Active tab |
| `bulkFolder`, `bulkPendingFile`         | folder scope + dropped image   | Bulk-replace draft |
| `webpReencode`                          | `boolean`                     | Per-session opt-in for image re-encode |
| `restoreBanner`, `restoring`            | boot-time restore UI flags     | IndexedDB roll-forward |

### 4.4 Persistence

`src/lib/idb.ts` is a self-contained IndexedDB wrapper:

- **Store:** `mockswap.sessions` keyed by `schemaVersion`.
- **Schema:** single row containing `projectMeta`, `mutatedZipBlob`, `originalZipBlob`, `patches[]`, `selection`, `savedAt`.
- **Policy:** writes are **1-second debounced** (`SAVE_DEBOUNCE_MS`) from `App.tsx` after every meaningful mutation. `QuotaExceededError` is caught and silently dropped — the app keeps working from memory.
- **Boot:** `App.tsx` calls `loadSession()` once on mount; if a row exists and there's no current project, a `<RestoreBanner>` lets the user promote the blob back into the live `LoadedProject`. `Reset Project`/`Reload`/`Upload different zip` all call `clearSession()`.

### 4.5 Concurrency + memory bounds

- Thumbnail reads: 4 at a time, capped at 60 total (`THUMBNAIL_CONCURRENCY`, `THUMBNAIL_CAP`).
- Detection entry reads: 12 at a time (`READ_CONCURRENCY` in `imageDetector.ts`).
- Blob URLs from preview: tracked and `URL.revokeObjectURL`'d on cleanup.

---

## 5. Backend architecture

**None.** MockupSwap is a pure client-side single-page app. There is no server, no API, no database, no auth provider, no telemetry, no third-party SDKs beyond `JSZip`. The exported artifact is produced in the browser and downloaded via an `<a download>` click.

> If a backend is ever added, this section must be rewritten.

---

## 6. Data flow

End-to-end pipeline (single-pass; every step below is local):

```
   ┌─────────────┐
   │ USER UPLOAD │ (drag-drop or pick)
   └───┬─────────┘
       │ File
       ▼
┌──────────────┐    ┌────────────────┐    ┌──────────────────┐
│ zipReader.ts │───►│ LoadedProject  │───►│ imageDetector.ts │──► ImageDetection[]
└──────────────┘    │ .zip + entries │    └──────────────────┘
                    └───────┬────────┘           │
                            │                   ▼
                            │           ┌────────────────┐
                            │           │ logoHelper.ts  │──► LogoCandidate[]
                            │           └────────────────┘
                            ▼
                  ┌───────────────────────┐
                  │ App.tsx state machine │
                  └───────────┬───────────┘
                              │
       ┌──────────────────────┼────────────────────────────┐
       │                      │                            │
       ▼                      ▼                            ▼
┌──────────────┐      ┌──────────────┐         ┌───────────────────┐
│ Replace /    │      │ Manual       │         │ Logo Helper       │
│ Fit & style  │      │ Replace      │         │ (bulk apply)      │
│ / Remove /   │      │ (text)       │         │                   │
│ Placeholder  │      └──────┬───────┘         └─────────┬─────────┘
└──────┬───────┘             │                           │
       │                     │                           │
       │   all paths write to project.zip via apply*    │
       └─────────┬───────────────────┬───────────────────┘
                 ▼                   ▼
           ┌──────────────────────────────────┐
           │ patchesByKey: Map<id, Patch>     │
           │  → previewService rebuilds the   │
           │    blob index (previewRevision)  │
           │  → undoStack.ts remains the      │
           │    single undo primitive         │
           └─────────────────┬────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
   ┌────────────────────┐         ┌────────────────────────┐
   │ CenterPanel        │         │ Diff per applied patch │
   │ <iframe src=blob…> │         │ ChangeHistoryPanel    │
   │ (live preview)     │         │ (per-row Undo)        │
   └────────────────────┘         └────────────────────────┘
                             │
                             ▼
                  ┌───────────────────────┐
                  │ EXPORT                │
                  │ exportService.ts      │
                  │ ─ copies zip entries  │
                  │ ─ writes              │
                  │   MOCKUPSWAP_CHANGES.md
                  │ ─ <a download>        │
                  └───────────────────────┘
```

### 6.1 Detection → patch key

Every `AppliedPatch` is keyed on a stable composite derived from the detection:

```
${sourceFile}::${sourceTag}::${sourceAttr}::${rawUrl}
```

To allow **multiple patches against the same detection** (a replace + a fit-style) the fit-style is keyed with a `#fit` suffix, so the patches map stays one-entry-per-`(location, kind)` pair.

### 6.2 Preview ↔ zip

`previewServer.ts` is the preferred preview path:

- **Service-worker server**: uploaded files are cached under `/preview/<projectId>/...` and served by `public/preview-sw.js` with real paths and content types. This lets active sites use native URL resolution for ES modules, dynamic imports, `fetch()`, root-relative assets, workers, and wasm.
- **Site root mapping**: when the selected entry is inside a build directory such as `dist/index.html`, files under that directory are served at the preview web root. Files outside that root keep their zip path so they cannot overwrite the entry page.
- **Preview sandbox**: `CenterPanel.tsx` renders the preview iframe with `sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"` and `allow="clipboard-read; clipboard-write"`. `allow-same-origin` is required so the service worker can control the frame; top navigation remains blocked.
- **Fallback**: if service workers, secure context, or the iframe probe are unavailable, `previewService.ts` builds the legacy blob-backed preview so static HTML/CSS still renders.
- **Navigation**: `augmentHtml()` injects a `data-mockswap-preview` runtime into every HTML file. It shims storage access when needed and forwards relative `<a href>` clicks to `App.tsx` via `{ type: 'mockswap:navigate', href, sourceFile }`.

### 6.3 Undo / Reset

`undoStack.ts` is the **single primitive** that mutates `project.zip` back to pre-patch state. Every variant of `AppliedPatch` stores `previousSourceText` (or per-file snapshots for `manual-replace`) so undo is topologically safe.

- `App.handleUndoPatchById` walks cascades correctly so a `manual-replace` made AFTER a per-detection patch on the same file is included in the rollback.
- `App.handleUndoAll` reverses patches in DESC `appliedAt` order.
- `App.handleResetProject` re-runs `handleUpload(originalFile)` to clear ALL state to the pristine original.

---

## 7. Authentication

**None.** No user model, no session token, no SSO. All "sessions" are local IndexedDB rows committed by *the current browser profile on the current device*. Two browsers on the same machine see two independent sessions. Refreshing the tab within the same browser keeps the session alive (subject to IndexedDB quota).

---

## 8. External integrations

| Vendor / library | Where                                             | Purpose                                  |
| ---------------- | ------------------------------------------------- | ---------------------------------------- |
| **JSZip**        | `zipReader.ts`, `exportService.ts`, every apply    | Read / mutate / write zip in the browser |
| **React 18**     | all components and `App.tsx`                       | UI rendering + state management          |
| **Tailwind 4**  | `src/index.css`, every component                   | Utility-CSS styling                      |
| **Vite 5**      | `vite.config.ts`                                   | Dev server + production bundler         |

**No outbound network calls of any kind.** Network-only references discovered in source files are flagged (`manus`, `cdn`, `blob-self`, `cross-origin-http`, `protocol-relative`) but never fetched.

---

## 9. Build and deployment process

### 9.1 Scripts

| Script             | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `npm run dev`       | `vite` — dev server, hot reload, port 5173                |
| `npm run typecheck` | `tsc -b --noEmit` — full project typecheck, no output     |
| `npm run build`     | `tsc -b && vite build` — emits `dist/`                   |
| `npm run preview`   | `vite preview` — serve `dist/` at port 4173              |

### 9.2 Requirements

- Node.js **18+**, npm
- A modern browser with IndexedDB, `<a download>`, `createImageBitmap`, blob URL support

### 9.3 Production deploy

The output of `npm run build` is a **fully static `dist/` directory**:

```
dist/
 ├── index.html
 └── assets/
      ├── index-<hash>.css
      └── index-<hash>.js
```

Deploy to any static host:

- **Recommended:** Netlify / Vercel / Cloudflare Pages — drop the `dist/` folder, no server config.
- **Self-hosted:** any web server that serves a Single-Page App (configure history fallback to `index.html`, though MockupSwap has no client-side routes).
- **Local:** `npx serve dist/` or `python -m http.server` from inside `dist/`.

Recommended production response headers:

```
Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline' blob:; script-src 'self' 'unsafe-inline' blob:; worker-src 'self'; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'
X-Content-Type-Options: nosniff
```

The checked-in `index.html` includes an equivalent meta-CSP so the static app has a baseline policy even on hosts without header configuration. Prefer the response-header form in production because it is applied before document parsing and supports the full CSP surface. Keep `frame-src 'self' blob:`: `'self'` is required for the service-worker preview URLs, while `blob:` keeps the fallback preview available. Chromium also applies the creator policy to `blob:` preview documents, so `script-src` must include `'unsafe-inline' blob:` for the fallback bootstrap, injected navigation script, and frame-owned script blobs; `style-src` includes `blob:` for rewritten stylesheet blobs. `worker-src 'self'` keeps the app's Vite module worker on same-origin assets even though `script-src` permits preview script blobs.

Host-specific examples:

- **Netlify:** create `_headers` in the published output or configure it from the project source so `/*` emits the two headers above.
- **Vercel:** add a `headers()` rule in `vercel.json` for `/(.*)` with `Content-Security-Policy` and `X-Content-Type-Options`.
- **Cloudflare Pages:** add a `_headers` file with a `/*` block containing the two headers above.

### 9.4 Environment variables

**None.** MockupSwap has no API keys, no secrets, and no runtime configuration via `.env`. If you add anything environment-driven, this section must be rewritten.

### 9.5 Post-deploy verification checklist

1. Open the deployed URL → empty state visible.
2. Drag a small `.zip` onto the upload area.
3. Project summary card → file tree populates → Images tab fills in.
4. Select a detection → right panel shows asset details.
5. Drop a replacement image → click Apply → center preview updates.
6. Click **Export updated zip** → a `.zip` downloads containing `MOCKUPSWAP_CHANGES.md` and your replacement relative-paths.

---

## 10. Known architectural risks

### 10.1 Resource / runtime

- **In-memory only.** The full zip + every replacement bytes sits in JS heap. A 200 MB archive can pressure the tab. **Mitigation:** none; users must keep zips reasonable.
- **IndexedDB quota is silent.** `QuotaExceededError` during `saveSession` is logged and the save is dropped without UI surfacing — the user thinks their work is persisted but it isn't. **Mitigation:** none in v1.
- **Object-URL leaks if effects are interrupted.** Preview rebuilds revoke prior URLs on cleanup, but a hard nav away from the page mid-build can leave stragglers. **Impact:** low (browser evicts on unload).
- **Concurrency caps are tuned, not adaptive.** `THUMBNAIL_CAP = 60` and `READ_CONCURRENCY = 12` were picked empirically; very large projects can still feel slow.

### 10.2 Detection coverage

- **No JavaScript rewriting.** References built at runtime (`import.meta.url + hash + ".png"`) are not auto-detected. Users must use the **Manual Replace** tab.
- **External `.css` files are not scanned for `background-image`.** v1 only scans `<style>` inline and the same file as the containing HTML. **Impact:** background images in standalone CSS files will be rewritten for the preview (via `urlRewriter.ts` preview tokens and frame-owned blobs) but listed as separate detections only when their host HTML file references the CSS file (which we don't follow).
- **Inert HTML is intentionally skipped by detection.** `imageDetector.ts` uses `DOMParser` over `text/html`, scans the parsed element tree, and ignores images inside HTML comments, `<template>`, and `<noscript>`. Those nodes are not part of the normal rendered image surface; use **Manual Replace** for a project that later clones template markup at runtime.
- **CSS scanning is comment-aware but not a full CSS parser.** `url()` tokens inside `/* ... */` are ignored for detection and preview/patch rewrites. Malformed or non-standard nested CSS comments are not supported.
- **`<picture>` / `<source srcset>`** are scanned but the right-panel `Replace` action ONLY supports `img[src]` and `url(...)`; the `Fit & style` panel intentionally rejects `<source>`.
- **Blob URLs in source** (`blob:...`) are flagged `riskReason: 'blob-self'` and always marked broken.

### 10.3 Patch semantics

- **Handle with care:** `manual-replace` outlives a `fit-style` reorder because the per-file snapshot model assumes the patch was applied to that exact file state. The undo cascade in `App.handleUndoPatchById` accounts for this by including any descendant manual-replace against the same source file.
- **Source rewrites truncate trailing whitespace** in some interpolated cases (e.g. fit-style appendage). Cosmetic; not a correctness issue.
- **`imageReencoder.ts` is intentionally lossy for SVG, animated GIF, animated WebP**, falling back to the original bytes. UI surfaces the reason in the History pill.

### 10.4 UI / accessibility

- **Fixed 3-column layout.** Below ~1100 px viewport the layout scrolls horizontally; not optimised for phones.
- **No project-level diff.** Change History shows per-patch diffs but no "diff my zip vs the original".
- **Single-color theme.** Dark-only; vue to README "no theme toggle" explicit.
- **Preview iframe sandboxing** uses `allow-scripts allow-popups allow-forms allow-modals` and intentionally omits `allow-same-origin`, so preview documents run in an opaque origin. Inter-page navigation relies on the injected `postMessage` nav script; parent-side origin checks must explicitly allow `"null"` for those sandboxed events. Subresources must be frame-owned blobs because parent-origin blob URLs are blocked from the opaque-origin sandbox.

### 10.5 Build / deploy

- **No code-splitting.** The whole bundle ships as a single JS file. Cost on cold load is the whole tool with all features enabled.
- **No tests, no CI config.** A refactor without `npm run typecheck` is currently the only safety net.
- **No SRI.** `index.html` now declares a baseline meta-CSP, but production hosts should still enforce the stronger response-header CSP and `X-Content-Type-Options: nosniff` listed in §9.3.

### 10.6 Concurrency / determinism

- **`g`-regex state discipline.** Library code creates fresh local `RegExp`s rather than sharing module-level `g` regexes across calls. Any new regex added that uses `g` MUST follow the same discipline.
- **Race-safety effect cleanups** use `cancelled` flags; if a new effect reads from a concurrent render, the same pattern is required.

---

## Appendix A — Types worth knowing

From `src/types.ts`:

- **`LoadedProject`** — the live state of the user's zip.
- **`ImageDetection`** — one scanned image reference with status (`ok|missing|remote`), kind (`html|css|manifest`), type (`hero|logo|...`), and `riskReason`.
- **`AppliedPatch`** — discriminated union: `replace | fit-style | remove | placeholder | manual-replace`. **Every variant carries enough pre/post state to be reverted** by `undoPatchById`.
- **`LogoCandidate`** — per-role logo reference with unique id (`sourceFile::tag::attr::url#<context>`).
- **`PreviewIndex`** — a `Map<htmlPath, topLevelPreviewBlobUrl>` plus sorted HTML paths and a primary entry.
- **`ExportState`** — `'idle' | 'busy' | 'success' | 'error'` — drives the right-panel export UI.

## Appendix B — How to extend safely

When adding a new feature, follow these invariants to stay inside the architecture:

1. **Add new logic to `src/lib/*`**, not into components. Components stay presentational.
2. **Persist pre/post source text on every new `AppliedPatch` variant** so `undoStack.ts` remains the single undo primitive.
3. **Mutate only `project.zip`.** Don't keep parallel file-system state — it desyncs on undo, preview, and export.
4. **Use relative references for the source rewrite.** The export is consumed by browsers, not Node, so a `blob:` left in the patched file would break deploys.
5. **Always surface risks.** `riskReason` on `ImageDetection` exists so the Broken Images panel and export report agree. Extend `classifyRiskReason` if you add a new risk class.
6. **Add a History pill with a `data-testid`.** The History panel is the audit log; if the action isn't there it didn't happen.
7. **If persistence format changes, bump `SCHEMA_VERSION`** in `idb.ts`. Old rows are dropped on read by design.
