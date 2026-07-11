# MockupSwap

A single-page web app that lets you **swap images and logos inside any static website zip without touching a text editor**. Upload the zip, point at the image you want to change, drop in the replacement, and export an updated zip that is ready to re-deploy.

Everything happens locally in your browser — MockupSwap never uploads your project, your assets, or your replacement images anywhere.

---

## Features

- **Flexible onboarding** — drop a `.zip`, a whole project **folder**, or a handful of loose web files (`.html` / `.css` / `.js` / images). Folders and loose files are packaged into a zip in-browser, so nothing needs pre-zipping. On-device parsing via `JSZip`.
- **Image detection** for HTML `<img>` tags, CSS `url(...)` background images, SVG `xlink:href`, manifest icons, and Apple touch / favicon links.
- **Broken-image detection** flags assets that are missing from the zip, point at remote / Manus / CDN URLs, or use `blob:` schemes that won't export.
- **Three left-panel modes**:
  - **Images** — every detected image reference, filterable, with thumbnails and a "broken" badge.
  - **Logos** — guided header / footer / favicon / apple-touch / manifest replacement flow.
  - **Manual replace** — text-based search-and-replace across the project for assets the detector didn't catch (e.g. `<source>`, asset hashes, dynamic `<meta>`).
- **Per-image actions**:
  - **Replace** with a drag-and-drop image (PNG, JPG, WebP, SVG, GIF, AVIF, BMP, ICO).
  - **Fit & style** — generated inline-style or CSS-class block with `object-fit`, position, border-radius, optional overlay (vignette / gradient).
  - **Remove** the broken reference entirely (preserves surrounding CSS backgrounds, drops the `<img>` for HTML).
  - **Placeholder** swaps a broken `<img>` for a labelled `<div>` that retains the original id / class / width / height.
- **Live preview via an in-browser virtual server.** A scoped **service worker** serves the project from real `/preview/<id>/…` URLs, so the browser resolves every reference natively — relative and root-relative paths, **ES-module `import` / dynamic `import()`**, `fetch()`, `new URL(x, import.meta.url)`, web workers, and wasm — with correct `Content-Type` headers. Built sites shipped under a subfolder (`…/dist/index.html`, `…/build/index.html`) are served relative to that web root, so the absolute `/assets/…` paths a bundler emits resolve correctly. This is what lets modern, bundled ("active") web projects render the same way they would on a local dev server, instead of only flat HTML/CSS. Served HTML gets a tiny injected runtime (an in-memory storage shim + a link-nav bridge). On first use the app runs a one-shot capability probe; browsers that can't run a worker-controlled iframe automatically fall back to the legacy in-iframe **blob pipeline** (flat HTML/CSS/images), so a preview always renders.
  - **Security note:** because a service worker can only control a same-origin client, the preview iframe runs same-origin with `sandbox="allow-scripts allow-same-origin …"` (top-navigation is still blocked). Preview this way only for projects you trust — a previewed page shares the app's origin. This is the standard trade-off for in-browser preview tools and is the price of rendering real apps correctly.
- **Change history** panel with per-row **Undo**, plus global **Undo Last Change**, **Reset Selected Image**, and **Reset Project** buttons.
- **Export** repackages the (currently modified) zip on download, with a summary card showing zip size, files written, replaced / broken / removed / placeholder counts, and any remote refs still in the project.
- **Change report** (`MOCKUPSWAP_CHANGES.md`) is appended to the exported zip so you can review what every patch did.
- **Accessibility**: keyboard-navigable tabs, drop zones, and chips; `aria-live` on busy / error states; `aria-busy` on in-flight apply buttons.

---

## Run locally

You need **Node.js 18+** and **npm**.

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

- Click the upload area to pick file(s), use **Choose a folder instead** for a directory, **or** drag a `.zip`, a folder, or loose web files onto the drop zone.
- Folders and loose files are zipped in-browser first; a single `.zip` is used as-is.
- The app reads every file into memory and starts an **image scan**. The Images tab populates with detected references.

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

- **Local-only.** No server-side persistence — refreshing the page loses all patches. Re-upload the zip and re-apply if needed.
- **JS references aren't auto-*detected* for swapping.** The service-worker preview *renders* JavaScript correctly (imports, `fetch`, dynamic URLs), but the image **detector** still reads HTML and CSS statically — an asset whose path is built in JS (e.g. `import.meta.url + hash + ".png"`) won't appear in the Images list. Use the **Manual replace** tab to swap those.
- **Preview shows one page at a time.** The entry HTML loads first; use the page dropdown or click links in the page to switch.
- **No asset re-encoding.** Replacement files are stored as uploaded — no automatic WebP conversion, compression, or resizing.
- **CSS is rewritten as inline `<style>` tags** for the Fit & style flow. Existing external `.css` files are not folded in — only new rules are appended.
- **Cross-origin images** in the source zip are flagged as risky but not re-hosted. Whether they survive a deploy depends entirely on the destination.
- **Remote URLs are not localized.** References to `https://...` stay as external URLs on export.
- **Blob URLs in the source are not preserved** — they always fail at runtime, so MockupSwap marks them broken by default.
- **No undo persistence.** Patches live in memory until you click Reset Project or refresh the page.
- **No multi-file diff view** — the History panel shows metadata but not before/after source text.

---

## Suggested future improvements

- **Diff view** in the History panel — show the file's before/after text for each patch.
- **Multi-step undo stack** — a real history so the user can step arbitrarily far back (right now it's one-shot or per-row).
- **Asset re-encoding** — optional WebP / AVIF conversion on import with a size budget.
- **Persistent project** — `IndexedDB` storage so refreshing the tab keeps patches and lets you resume work.
- **Theme / dark-mode toggle** — the app is currently dark-only.
- **Bulk replace** — replace every detection matching a path prefix in one click.
- **CSS variable extraction** — pull the Fit & style values into `:root` CSS variables so they can be tweaked in-browser.
- **Inline image preview** of the pre-replacement vs post-replacement asset in the History panel.
- **Drop-in ZIP picker** from the OS file dialog with a remembered last-folder (browser support permitting).
- **Targeted HTML rewrites** — `<source srcset="...">` and dynamic `data-src` lazy-load attributes.
- **External CSS scanning** — read `.css` files alongside HTML so background images declared in stylesheets are caught.

---

## License

This project is a personal tool. Treat it as MIT-style for now; refine before any public release.

---

## Acknowledgements

- UI in Tailwind with custom utility classes; **JSZip** for zip I/O.
- The build chain is **Vite + TypeScript** with strict mode.
