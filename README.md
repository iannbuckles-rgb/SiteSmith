# MockupSwap

A single-page web app that lets you **swap images and logos inside any static website zip without touching a text editor**. Upload the zip, point at the image you want to change, drop in the replacement, and export an updated zip that is ready to re-deploy.

Everything happens locally in your browser — MockupSwap never uploads your project, your assets, or your replacement images anywhere.

---

## Features

- **Flexible onboarding** — drop a `.zip`, `.tar`, `.tar.gz`, `.tgz`, a whole project **folder**, or loose website files. ZIP files are recognized by signature even when a download has no extension; TAR-family archives, folders, and loose files are normalized to ZIP in-browser. Source/template formats (JS/TS/JSX/TSX, Vue, Svelte, Astro, PHP, common server languages and template syntaxes), CSS preprocessors, manifests/data, fonts, media, WebAssembly/shaders, documents, 3D/design companions, and broad visual formats are retained without a server upload.
- **Image detection** for HTML image/lazy-load attributes, `<object>` / `<embed>`, `srcset`, CSS `url(...)` and quoted `image-set(...)`, SVG references, manifest icons/screenshots, Apple touch / favicon links, framework template markup, and conservative code literals (`import`, `require`, `new URL(..., import.meta.url)`, `fetch`, and static JSX/TSX attributes).
- **Broken-image detection** flags assets that are missing from the zip, point at remote / Manus / CDN URLs, or use `blob:` schemes that won't export.
- **Five left-panel modes**:
  - **Images** — every detected image reference, filterable, with thumbnails and a "broken" badge.
  - **Logos** — guided header / footer / favicon / apple-touch / manifest replacement flow.
  - **Manual replace** — text-based search-and-replace across the project for assets the detector didn't catch (e.g. `<source>`, asset hashes, dynamic `<meta>`).
  - **History** — per-patch diffs, undo/reset controls, and named checkpoints.
  - **Projects** — named browser-local project saves that can be reopened later.
- **Per-image actions**:
  - **Replace** with a drag-and-drop image (including PNG/APNG, JPEG, WebP, SVG, GIF, AVIF, BMP, ICO/CUR, TIFF, HEIC/HEIF, and JPEG XL).
  - **Fit & style** — generated inline-style or CSS-class block with `object-fit`, position, border-radius, optional overlay (vignette / gradient).
  - **Remove** the broken reference entirely (preserves surrounding CSS backgrounds, drops the `<img>` for HTML).
  - **Placeholder** swaps a broken `<img>` for a labelled `<div>` that retains the original id / class / width / height.
- **Live preview via an in-browser virtual server.** A scoped **service worker** serves the project from real `/preview/<id>/…` URLs, so the browser resolves every reference natively — relative and root-relative paths, **ES-module `import` / dynamic `import()`**, `fetch()`, `new URL(x, import.meta.url)`, web workers, and wasm — with correct `Content-Type` headers. Built sites shipped under a subfolder (`…/dist/index.html`, `…/build/index.html`) are served relative to that web root, so the absolute `/assets/…` paths a bundler emits resolve correctly. This is what lets modern, bundled ("active") web projects render the same way they would on a local dev server, instead of only flat HTML/CSS. Served HTML gets a tiny injected runtime (an in-memory storage shim + a link-nav bridge). On first use the app runs a one-shot capability probe; browsers that can't run a worker-controlled iframe automatically fall back to the legacy in-iframe **blob pipeline** (flat HTML/CSS/images), so a preview always renders.
  - **Security note:** because a service worker can only control a same-origin client, the preview iframe runs same-origin with `sandbox="allow-scripts allow-same-origin …"` (top-navigation is still blocked). Preview this way only for projects you trust — a previewed page shares the app's origin. This is the standard trade-off for in-browser preview tools and is the price of rendering real apps correctly.
- **Change history** panel with per-row **Undo**, plus global **Undo Last Change**, **Reset Selected Image**, and **Reset Project** buttons.
- **Direct preview editor** for selecting source-backed text, images, links, form fields, and components; edit attributes, reorder/delete elements, or nudge visual position from the rendered page.
- **Browser-local persistence** via IndexedDB: recover the active session after refresh, save named projects, and create named checkpoints. Quota failures are surfaced as persistent warnings.
- **Responsive workspace and themes**: desktop columns, tablet inspector drawer, mobile pane switcher, and persisted light/dark mode.
- **Export** repackages the (currently modified) zip on download, with a summary card showing zip size, files written, replaced / broken / removed / placeholder counts, and any remote refs still in the project.
- **Change report** (`MOCKUPSWAP_CHANGES.md`) is appended to the exported zip so you can review what every patch did.
- **Accessibility**: keyboard-navigable tabs, drop zones, and chips; `aria-live` on busy / error states; `aria-busy` on in-flight apply buttons.

---

## Run locally

You need **Node.js 20.19+** and **npm** (required by the test/jsdom toolchain).

```bash
# from the project root
npm install
npm run dev          # opens http://localhost:5173 with hot reload
```

For a production build:

```bash
npm run typecheck    # strict tsc --noEmit
npm run build        # vite build → dist/
npm run preview      # serve dist/ locally at http://localhost:4173
```

Everything is browser-side — there is no backend, no API key, no environment file.

---

## Workflow

### 1. Upload a project

- Click the upload area to pick file(s), use **Choose a folder instead** for a directory, **or** drag a ZIP/TAR-family archive, folder, or loose web files onto the drop zone.
- Folders, loose files, TAR, TAR.GZ, and TGZ inputs are converted to ZIP in-browser; a single valid ZIP is used as-is.
- A worker retains the zip and performs archive-heavy work while the app scans relevant source files for image references. The Images tab populates with detected references.

### 2. Pick a detection

- Click any row in the Images list. The **Asset Details** card in the right panel shows the raw URL, resolved path, source file, and a thumbnail when the asset is present locally.
- A small dot in the row's badge area colours the reference red / amber / violet if it's **broken**, **missing**, or **remote**.

### 3. Choose an action

The right panel offers several actions per detection:

| Action      | When to use                                                                |
| ----------- | -------------------------------------------------------------------------- |
| Replace     | You have a new asset file to drop in.                                      |
| Fit & style | You want rounded corners, an overlay, or a specific `object-fit`.          |
| Remove      | The reference is broken and you want a clean deploy with no broken icon.   |
| Placeholder | The reference is broken but the layout slot matters (e.g. a hero image).   |

Each action has its own confirm step so accidental applies are easy to undo.

### 4. Use the Logo Helper (optional)

If your zip already has a header logo, footer logo, manifest icons, favicon or Apple touch icon, switch to the **Logos** tab:

1. Drop your new logo (PNG with transparency works best).
2. Tick the targets you want to update (only the ones MockupSwap found in the project are enabled).
3. For the **header logo**, choose **Image only** or **Icon + live text** — the second mode injects your business name as live HTML beside the icon (preserving any existing alt text).
4. Apply. Every selected target gets patched in one click.

### 5. Catch what the detector missed

If the detector didn't find a reference (e.g. an image hash built in JavaScript), switch to the **Manual replace** tab:

1. Pick the file to edit.
2. Enter the exact text to find (e.g. `images/hero-old-abc123.webp`).
3. Enter the replacement (e.g. `images/hero-new.png`) **or** drop a replacement file.
4. Apply. The patch is recorded in the change history and the preview reloads.

### 6. Review your changes

Switch to **History** in the left panel to see every patch you've applied, in order. Each row shows:

- Action type (Replace / Fit & style / Remove / Placeholder / Manual replace).
- The file changed.
- The old path / new path.
- A timestamp.
- A per-row **Undo** button.

The toolbar at the top of the History panel exposes three shortcuts:

- **Undo Last Change** — rolls back the most recent patch (single click).
- **Reset Selected Image** — clears every patch keyed to the current selection.
- **Reset Project** — reloads the **originally uploaded** zip and clears every patch. (Re-upload the same file to start a new pass.)

### 7. Export

Click **Export updated zip** in the right panel. The exported zip:

- Contains every replacement asset under `assets/` (or the original path the source file referenced).
- Uses **relative path references** — **no `blob:`, no `data:`, no absolute `file://`** URLs leak in.
- Includes an **`MOCKUPSWAP_CHANGES.md`** report at the root listing every patch applied, the old / new asset paths, the source file changed, and the timestamp.

A summary card shows the zip size, file count, and a breakdown of replaced / broken / removed / placeholder / remote-only references after export.

---

## Known limitations

- **Browser-local only.** Sessions, named projects, and checkpoints use IndexedDB on this device; there is no cloud sync, collaboration, or server backup. Export important work before clearing browser data.
- **Code detection is deliberately literal-only.** Static imports, `require`, `new URL(..., import.meta.url)`, `fetch`, CSS-in-JS URLs, and static JSX/TSX image attributes are detected. Computed paths, variables, aliases resolved only by a bundler, and runtime-generated URLs are not; use **Manual replace** for those.
- **Source projects are not built or transpiled.** Framework/source files are retained and scanned, but the browser preview cannot compile TypeScript, JSX, Vue, Svelte, Astro, Sass, or Less. Include the project's built output (`dist`, `build`, or `out`) when a live preview is required.
- **Intake support does not guarantee browser decoding.** MockupSwap preserves and can rewrite references for TIFF, HEIC/HEIF, JPEG XL, and other recognized assets, but whether their pixels render in the preview depends on the current browser. Exported bytes remain unchanged.
- **Preview shows one page at a time.** The entry HTML loads first; use the page dropdown or click links in the page to switch.
- **Limited asset re-encoding.** Optional WebP conversion supports eligible PNG/JPEG inputs; there is no resizing, AVIF output, or animation conversion.
- **Fit & style is targeted source surgery.** HTML image styles and detected CSS rules are patched in place; it is not a visual stylesheet designer or full CSS parser.
- **Cross-origin images** in the source zip are flagged as risky but not re-hosted. Whether they survive a deploy depends entirely on the destination.
- **Remote URLs are not localized.** References to `https://...` stay as external URLs on export.
- **Blob URLs in the source are not preserved** — they always fail at runtime, so MockupSwap marks them broken by default.
- **No project-level diff.** History shows per-patch and per-file before/after text, but there is no single whole-archive diff against the original zip.
- **Trusted active previews only.** Service-worker previews run same-origin so modern modules and fetches work. Do not preview arbitrary hostile projects in the editor; a public untrusted-upload deployment needs a separate preview origin.

---

## Suggested future improvements

- **Dedicated preview origin** for safely rendering arbitrary untrusted active projects.
- **Archive expansion limits** for entry count, uncompressed bytes, individual source size, and compression ratio.
- **Project-level diff** against the pristine upload, with file-by-file export review.
- **AVIF/resizing pipeline** with explicit output dimensions and a user-set size budget.
- **AST-backed code detection** for computed asset maps, framework aliases, and bundler-specific transforms beyond the current conservative literal scan.
- **Virtualized image lists** so projects with hundreds of detections can retain more than the current thumbnail cap.
- **CSS variable extraction** — pull the Fit & style values into `:root` CSS variables so they can be tweaked in-browser.
- **Inline image preview** of the pre-replacement vs post-replacement asset in the History panel.
- **Drop-in ZIP picker** from the OS file dialog with a remembered last-folder (browser support permitting).

---

## License

This project is a personal tool. Treat it as MIT-style for now; refine before any public release.

---

## Acknowledgements

- UI in Tailwind with custom utility classes; **JSZip** for zip I/O.
- The build chain is **Vite + TypeScript** with strict mode.
