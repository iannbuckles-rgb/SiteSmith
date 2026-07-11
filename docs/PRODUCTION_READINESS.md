# MockupSwap — Production Readiness Audit & Implementation Prompts

> Audit date: 2026-07-11. Basis: full read of `docs/architecture.md`, `App.tsx`,
> and the `src/lib/*` core (asset/export/preview/url/idb). `npm run typecheck`
> passes clean. The codebase is mature and carefully commented; the items below
> are the gaps between "works on my machine" and "stable, scalable, shippable."
>
> Each prompt is self-contained: hand it to an implementer (or an agent) as-is.
> Ordered by priority. **Do P0 before any public deploy.**

---

## Findings summary

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | **P0 · Security** | Preview | Preview `<iframe>` has **no `sandbox` attribute**; untrusted uploaded HTML/JS runs same-origin with access to `window.parent`, IndexedDB, and blob URLs. Docs/README falsely claim it is "sandboxed." |
| 2 | **P0 · Bug** | Build | `index.html` favicon points at `/vite.svg`, which does not exist (`no public dir`) → 404 on every production load. |
| 3 | **P0 · Maintainability** | Replace | Image-replacement HTML/CSS rewrite is **duplicated** in `App.tsx` (`handleApplyReplacement`) and `assetReplacer.ts` (`applyReplacement`). In-code comment admits the two must be hand-synced. Guaranteed to drift. |
| 4 | **P1 · Stability** | Everything | **Zero automated tests.** The core is regex surgery on HTML/CSS — the highest-risk code to change without a safety net. 14 files already carry `data-testid`, so testing was intended but never wired. |
| 5 | **P1 · Resilience** | App shell | No React **error boundary**. Any render-time throw white-screens the entire app with no recovery. |
| 6 | **P1 · Data-loss UX** | Persistence | `QuotaExceededError` in `saveSession` is swallowed with only a `console.warn`. User believes work is persisted when it silently is not. |
| 7 | **P1 · Product** | Layout | Fixed `360px / 1fr / 320px` grid. Below ~1100px it clips/scrolls horizontally. A "comprehensive easy website editor" needs a responsive shell. |
| 8 | **P2 · Robustness** | Parsing | Detection & rewrite rely on hand-rolled regex. Known blind spots: multi-line tags, `>` inside attribute values, HTML/CSS comments, `<template>`/`<noscript>` content. Consider `DOMParser`/`CSSOM` for the detection pass. |
| 9 | **P2 · Perf/scale** | Build | Single JS bundle, no code-splitting; whole tool ships on cold load. Large zips pin the main thread (detection, thumbnails, export all run on it). |
| 10 | **P2 · Hardening** | Deploy | No CSP. For a tool that renders untrusted markup, a meta-CSP (or documented host headers) meaningfully reduces blast radius. |
| 11 | **P3 · Polish** | A11y/UX | Dark-only, no reduced-motion handling, `window.confirm` for Reset, no visible toast on export success beyond the summary card. |

---

## P0 — Must fix before deploy

### Prompt 1 — Sandbox the preview iframe (security)

> **Context.** `src/components/CenterPanel.tsx` (~line 525) renders the live
> preview with `<iframe src={blobUrl} allow="clipboard-read; clipboard-write">`
> and **no `sandbox` attribute**. The iframe loads arbitrary user-uploaded
> website HTML, CSS, and JS via `blob:` URLs. Blob-URL documents are
> **same-origin with the host app**, so uploaded JS can reach `window.parent`,
> read/write the app's IndexedDB session, and tamper with the editor. The
> README and `docs/architecture.md` both describe the preview as "sandboxed,"
> which is currently false.
>
> **Task.**
> 1. Add `sandbox="allow-scripts allow-popups allow-forms allow-modals"` to the
>    preview iframe. **Deliberately omit `allow-same-origin`** so the framed
>    document runs in a null (opaque) origin and cannot touch the parent's
>    origin, storage, or DOM.
> 2. Verify the injected navigation script still works: it communicates via
>    `window.parent.postMessage(..., '*')`, which is allowed from a sandboxed
>    null-origin frame, and the parent listener in `App.tsx` does not check
>    `event.origin` (it validates message shape instead) — confirm this still
>    receives events. If origin checking is later added, account for `"null"`.
> 3. Confirm sub-resource loading (images/CSS/JS via `blob:` URLs) still renders
>    under the sandbox — these are fetches, not same-origin script access, so
>    they should be unaffected. Test with a multi-page zip that has inline
>    `<script>`, external CSS, and `<a href>` inter-page links.
> 4. Update the "sandbox" language in `README.md` and `docs/architecture.md`
>    (§6.2 and §10.4) to describe the actual sandbox flags now in place.
>
> **Acceptance.** Uploaded JS can no longer read `window.parent.location` or the
> app's IndexedDB; inter-page nav, images, inline styles, and clipboard-copy
> still work; docs match reality. `npm run typecheck` clean.

### Prompt 2 — Fix the broken production favicon

> **Context.** `index.html` line 5 is the stock Vite tag
> `<link rel="icon" type="image/svg+xml" href="/vite.svg" />`, but there is no
> `public/` directory and no `vite.svg`, so the reference 404s in `dev` and in
> the built `dist/`.
>
> **Task.** Add a real MockupSwap favicon. Create `public/favicon.svg` (a simple
> mark consistent with the in-app "M" gradient badge in `TopBar` — violet→fuchsia
> rounded square with an "M", or a swap/arrows glyph) and point the `<link>` at
> `/favicon.svg`. Optionally add an `apple-touch-icon` and a small PNG fallback.
> Confirm it resolves in `npm run build && npm run preview`.
>
> **Acceptance.** No favicon 404 in the network tab of the built app; tab shows
> the MockupSwap mark.

### Prompt 3 — De-duplicate the replacement rewrite into one shared lib path

> **Context.** `App.tsx > handleApplyReplacement` (~lines 608–753) re-implements
> the exact HTML/CSS URL-rewrite surgery that already lives in
> `src/lib/assetReplacer.ts` (`applyReplacement`, `patchHtml`, `patchCss`,
> `uniqueAssetPath`, live-collision walk over `project.zip.files`). The only
> reason App has its own copy is to inject an **optional WebP re-encode** step
> before writing bytes. A comment in App.tsx explicitly warns that any change to
> `patchHtml`/`patchCss` must be mirrored in both places — a latent
> correctness-drift bug.
>
> **Task.** Refactor so there is a single rewrite implementation.
> 1. Extend `applyReplacement` in `assetReplacer.ts` to accept an optional
>    pre-processing hook or an already-resolved `{ bytes, filename, reencoded }`
>    payload, so the WebP re-encode decision stays in `App.tsx`/a small lib
>    helper but the **zip mutation + source rewrite + patch construction** live
>    only in `assetReplacer.ts`. Suggested shape:
>    `applyReplacement(project, detection, { bytes, filename, reencoded, previousSourceValue })`.
> 2. Rewrite `handleApplyReplacement` to: compute bytes/name (with the existing
>    WebP branch), call the shared `applyReplacement`, then do only React-state
>    bookkeeping (patch map, preview bump, toast). Delete the duplicated
>    `ATTR_RE_LOCAL`/`TAG_RE`/`CSS_URL_RE` block and the second live-collision
>    walk from `App.tsx`.
> 3. Keep the `newAssetReencoded` flag and the "Saved X% on disk" toast behavior
>    identical.
> 4. This refactor is the natural place to seed the test suite from Prompt 4 —
>    write the `applyReplacement` unit tests first, then refactor against them.
>
> **Acceptance.** `App.tsx` contains no regex HTML/CSS rewriting; one code path
> produces `replace` patches; WebP re-encode + toast unchanged; typecheck clean;
> a manual replace + undo + re-export round-trips correctly.

---

## P1 — Required for "stable, scalable"

### Prompt 4 — Stand up a test suite (Vitest) around the fragile core

> **Context.** No test framework is configured. The riskiest code is pure and
> highly testable: `assetReplacer.ts`, `urlRewriter.ts`, `urlResolver.ts`,
> `pathRelative.ts`, `filenameSanitizer.ts`, `imageDetector.ts`, `manualReplace.ts`,
> `fitStyles.ts`, `lineDiff.ts`, `exportService.ts` (report builder). The
> architecture doc's "Extend safely" invariants (undo reversibility, relative
> refs, no blob leaks in exports) are exactly the properties tests should lock in.
>
> **Task.**
> 1. Add `vitest` + `jsdom` (dev deps), a `vitest.config.ts` (jsdom env, globals),
>    and scripts: `"test": "vitest run"`, `"test:watch": "vitest"`. Wire
>    `npm test` into the build/CI gate.
> 2. Write focused unit tests, prioritized:
>    - **`pathRelative` / `urlResolver`**: `../`, root, sibling, nested, query/hash preservation, remote pass-through.
>    - **`assetReplacer`**: replace rewrites only the matching tag/attr/url and nothing else; remove drops `<img>` vs strips `url()` from `background` shorthand while keeping color/position; placeholder preserves `id/class/width/height/alt`; every returned patch's `previousSourceText` reverts to the exact original (round-trip via `undoStack`).
>    - **`urlRewriter`**: relative → blob, absolute/`data:`/`//` left alone, `srcset` descriptors preserved, nav-script injection is idempotent and XSS-safe (`</script>` in a path cannot break out).
>    - **`filenameSanitizer` / `uniqueAssetPath`**: collision suffixing, unsafe-char stripping, path-traversal (`../`) neutralized.
>    - **`manualReplace`**: replace-once vs replace-all, multi-file scope, per-file snapshot undo, no-match error.
>    - **`exportService.buildReport`**: no double-reporting of removed-then-missing; caps respected.
> 3. Add one jsdom-level test per apply flow that exercises a tiny in-memory
>    JSZip (`replace → export`, `remove → undo`) to guard the zip round-trip.
>
> **Acceptance.** `npm test` green with meaningful coverage of the libs above;
> tests fail if a regex is loosened incorrectly. Target ≥80% line coverage on
> `src/lib/`.

### Prompt 5 — Add a React error boundary around the app shell

> **Context.** `src/main.tsx` mounts `<App/>` under `StrictMode` with no error
> boundary. A throw in any render (e.g. a malformed persisted patch, an
> unexpected detection shape) white-screens the app with no path back.
>
> **Task.** Create `src/components/ErrorBoundary.tsx` (class component with
> `getDerivedStateFromError` + `componentDidCatch`). Fallback UI, styled to match
> the dark theme, shows a friendly message, the error text in a collapsible
> block, and two actions: **Reload page** and **Start fresh** (calls
> `clearSession()` from `idb.ts` then reloads — so a poison-pill persisted
> session can't brick the app on every boot). Wrap `<App/>` in `main.tsx`.
> Consider a nested boundary around just `<CenterPanel/>` so a preview crash
> doesn't take down the editor.
>
> **Acceptance.** Throwing inside a panel shows the fallback, not a blank page;
> "Start fresh" clears IndexedDB and recovers.

### Prompt 6 — Surface IndexedDB quota / persistence failures to the user

> **Context.** `src/lib/idb.ts > saveSession` catches `QuotaExceededError` (and
> other write errors) and resolves silently with a `console.warn`. `App.tsx`'s
> debounced save also swallows errors. The user is told nothing, so they believe
> a refresh is safe when it will lose all patches. Flagged in architecture §10.1.
>
> **Task.**
> 1. Change `saveSession` to report outcome instead of silently resolving — e.g.
>    return `Promise<'ok' | 'quota-exceeded' | 'error'>` (or throw a typed error).
> 2. In `App.tsx`'s save effect, on a non-ok outcome push a **persistent** toast
>    (reuse the existing `pushToast`, but this one should not auto-dismiss):
>    "Couldn't save your session — this browser is out of storage. Your changes
>    are safe in memory but a refresh will lose them. Export your zip to keep
>    them." Debounce so it shows once per failure streak, not per keystroke.
> 3. Optionally add a lightweight "unsaved/at-risk" indicator in the TopBar when
>    the last save failed.
>
> **Acceptance.** Simulating a quota failure (temporarily throw in `saveSession`)
> surfaces a visible, non-auto-dismissing warning; normal saves stay silent.

### Prompt 7 — Make the layout responsive

> **Context.** `App.tsx` render uses
> `grid grid-cols-[360px_minmax(0,1fr)_320px]`. Below ~1100px the side panels
> squeeze the preview and the page scrolls horizontally (architecture §10.4).
> The product goal is a "comprehensive easy website editor," which implies usable
> on laptops and tablets at minimum.
>
> **Task.** Introduce a responsive shell without rewriting the panels:
> - **≥1280px:** current three-column grid.
> - **~768–1280px:** collapse the right panel into a drawer/toggle, or stack it
>   under the preview; keep the file tree + preview primary.
> - **<768px:** single-column stacked with a top tab/segmented control to switch
>   Left / Preview / Right, or an off-canvas pattern.
>
> Prefer Tailwind responsive variants and a small amount of local UI state in
> `App.tsx` (e.g. `activeMobilePane`) over a layout library. Ensure the preview
> iframe still gets a real box at every breakpoint. Add a `min-w-0` guard on the
> preview column (already partly present) so long filenames don't force overflow.
>
> **Acceptance.** No horizontal page scroll at 1366/1024/768/375 widths; all
> three panes reachable at every breakpoint; preview renders correctly.

---

## P2 — Robustness, scale, hardening

### Prompt 8 — Harden HTML/CSS parsing (reduce regex blind spots)

> **Context.** Detection (`imageDetector.ts`) and rewriting (`urlRewriter.ts`,
> `assetReplacer.ts`) parse HTML/CSS with hand-rolled regex. Known failure modes:
> attributes spanning multiple lines, `>` inside a quoted attribute value,
> `<img>` inside HTML comments / `<template>` / `<noscript>`, and `url()` inside
> CSS comments. These produce false detections or missed rewrites on real-world
> exports.
>
> **Task.** Move the **detection/preview read pass** to browser-native parsing
> where it's safe to do so: use `DOMParser` (`text/html`) to enumerate elements
> and attributes for `imageDetector.ts`, and strip CSS comments before the
> `url()` scan. Keep the **write/patch** path minimal-diff (string surgery is
> intentional there to preserve formatting), but add guards: skip matches inside
> `<!-- -->` and `/* */`. Add regression tests (Prompt 4) for each blind spot
> with a real-world-shaped fixture. Document any intentionally-unsupported cases
> in architecture §10.2.
>
> **Acceptance.** Fixtures for multi-line tags, commented-out images, and
> `<template>` content detect/rewrite correctly or are provably skipped; no
> regressions in existing behavior.

### Prompt 9 — Offload heavy work to a Web Worker + split the bundle

> **Context.** Detection, thumbnail decode, WebP re-encode, and export
> `generateAsync` all run on the main thread (architecture §10.1, §10.5). Large
> zips (100–200MB) freeze the UI. The app also ships as one JS chunk.
>
> **Task.**
> 1. Move zip parsing + `detectImages`/`detectLogos` + export packaging into a
>    Web Worker (Comlink or a hand-rolled `postMessage` protocol). Keep the pure
>    lib functions worker-agnostic so they stay unit-testable. Surface progress
>    through the existing `busyPhase` channel.
> 2. Add basic route/feature-level code-splitting via dynamic `import()` for the
>    heaviest, rarely-first-used paths (e.g. `imageReencoder`, export). Confirm
>    Vite emits multiple chunks.
> 3. Add a soft size guard: warn (don't block) when an uploaded zip exceeds a
>    configurable threshold (e.g. 150MB).
>
> **Acceptance.** UI stays responsive (can scroll/switch tabs) during detection
> and export of a large zip; `dist/` shows more than one JS chunk; a large-zip
> warning appears.

### Prompt 10 — Add a Content-Security-Policy

> **Context.** `index.html` declares no CSP; the app renders untrusted markup.
> Architecture §10.5 flags this as operator responsibility with nothing in place.
>
> **Task.** Add a meta-CSP to `index.html` appropriate for a Vite SPA that must
> allow `blob:` for the preview and app assets. Start from:
> `default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src blob:; connect-src 'self'; object-src 'none'; base-uri 'self'`.
> Because the preview iframe is now sandboxed to a null origin (Prompt 1), its
> inline `<script>` runs under the frame's own (relaxed) policy, not the host's —
> verify the injected nav script still executes and tune `frame-src`/`script-src`
> minimally. Document recommended **host response headers** (the stronger,
> non-meta CSP + `X-Content-Type-Options: nosniff`) for Netlify/Vercel/Cloudflare
> in `docs/architecture.md` §9.3.
>
> **Acceptance.** App and preview function with the CSP active (no console CSP
> violations in normal flows); docs list host-header guidance.

---

## P3 — Polish

### Prompt 11 — UX & accessibility pass

> **Context.** Dark-only theme; `window.confirm` for Reset Project;
> no `prefers-reduced-motion` handling; export success relies on the summary card
> only. Minor but visible in a "comprehensive easy" tool.
>
> **Task.** (a) Replace `window.confirm` in `handleResetProject` with an in-app
> modal matching `BulkConfirmModal`. (b) Respect `prefers-reduced-motion` for the
> progress/spinner/toast transitions. (c) Optional light-theme via a
> `data-theme` toggle persisted alongside the session. (d) Add a success toast on
> export completion. (e) Audit focus management on the modals (focus trap +
> restore, `Esc` to close).
>
> **Acceptance.** No native `confirm()` dialogs; modals are keyboard-trappable
> and `Esc`-dismissible; motion respects the OS setting.

---

## Suggested execution order

1. **P0** prompts 1 → 2 → 3 (3 pairs with 4).
2. **P1** prompt 4 (tests) alongside/just after 3, then 5, 6, 7.
3. **P2** 8 → 9 → 10 as capacity allows.
4. **P3** 11 for final polish.

Run `npm run typecheck` and (once Prompt 4 lands) `npm test` after every prompt.
Keep `docs/architecture.md` updated per its own maintenance rule whenever a
prompt changes architecture (notably 1, 8, 9, 10).
