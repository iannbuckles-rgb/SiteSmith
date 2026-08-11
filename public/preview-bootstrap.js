/* ============================================================================
 * MockupSwap compatibility preview bootstrap
 * ============================================================================
 * This static script runs inside a blob:-URL preview document. The blob
 * document inherits the creating page's CSP (script-src 'self'), so inline
 * scripts are blocked. Instead, the project payload lives in a
 * <script type="application/json"> data block that is NOT executable and
 * therefore not subject to CSP. This script reads that block and bootstraps
 * the preview identically to how the former inline script did.
 *
 * The payload shape is produced by buildSandboxedDocument() in
 * src/lib/previewService.ts and mirrors the SandboxAssetPayload interface:
 *   { assets: Array<{ token, mime, base64, text }>, html: string }
 * ==========================================================================*/

(function () {
  var el = document.getElementById('mockswap-payload');
  if (!el || !el.textContent) return;

  var payload;
  try {
    payload = JSON.parse(el.textContent);
  } catch (_) {
    return;
  }

  var assets = payload.assets;
  var html = payload.html;
  if (!Array.isArray(assets) || typeof html !== 'string') return;

  var urls = Object.create(null);

  function bytes(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var out = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function text(b64) {
    return new TextDecoder().decode(bytes(b64));
  }

  function replaceTokens(value) {
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i];
      var url = urls[a.token];
      if (url) {
        value = value.split(a.token).join(url);
      }
    }
    return value;
  }

  // Pass 1: create blob URLs for binary assets.
  for (var i = 0; i < assets.length; i++) {
    var a = assets[i];
    if (a.text) continue;
    urls[a.token] = URL.createObjectURL(new Blob([bytes(a.base64)], { type: a.mime }));
  }

  // Pass 2: create blob URLs for text assets (CSS etc.), rewriting token
  // references so CSS url() calls resolve to already-created blob URLs.
  for (var j = 0; j < assets.length; j++) {
    var b = assets[j];
    if (!b.text) continue;
    urls[b.token] = URL.createObjectURL(new Blob([replaceTokens(text(b.base64))], { type: b.mime }));
  }

  document.open();
  document.write(replaceTokens(html));
  document.close();
})();
