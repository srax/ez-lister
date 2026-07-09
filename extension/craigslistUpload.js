'use strict';

// Carxpert — Craigslist photo-upload bridge (runs in the PAGE's JS world: manifest world:MAIN).
//
// The modern CL image uploader is plupload/moxie. From an extension's isolated world, injecting
// files into its <input> does nothing. Running here in the page world, we try two things:
//   1. Drive plupload's API directly (uploader.addFile + start), if the instance is reachable.
//   2. Fall back to setting the moxie file <input>'s files + dispatching change IN THE PAGE
//      world — moxie's own change handler reads input.files, which a cross-world dispatch misses.
//
// No chrome.* here (MAIN world) — it talks to isolated craigslistContent.js over a private
// CustomEvent channel with JSON-string detail (NOT postMessage; CL JSON.parses window messages).

(function () {
  if (!/(^|\.)craigslist\.org$/i.test(location.hostname)) return;

  function dataUrlToFile(dataUrl, name) {
    try {
      const [meta, b64] = dataUrl.split(',');
      const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      return new File([arr], name || 'photo.jpg', { type: mime });
    } catch { return null; }
  }

  // Search the page for a plupload-like uploader. Every access is wrapped because window's own
  // properties include cross-origin frames (reading them throws SecurityError).
  function findUploader() {
    const found = [];
    const consider = (v) => {
      try {
        if (!v || typeof v !== 'object') return;
        if (typeof v.addFile === 'function' && typeof v.start === 'function') { found.push(v); return; }
        const inst = v.instances;
        if (inst && typeof inst === 'object') {
          for (const id in inst) {
            const u = inst[id];
            if (u && typeof u.addFile === 'function') found.push(u);
          }
        }
      } catch (_) { /* cross-origin frame / exotic getter — skip */ }
    };
    try { consider(window.plupload); } catch (_) {}
    try { consider(window.mOxie); } catch (_) {}
    let keys = [];
    try { keys = Object.keys(window); } catch (_) { keys = []; }
    for (const k of keys) {
      let v;
      try { v = window[k]; } catch (_) { continue; }
      consider(v);
    }
    return found[0] || null;
  }

  const reply = (ok, count, error) => {
    document.dispatchEvent(new CustomEvent('carxpert-cl-upload-result', {
      detail: JSON.stringify({ ok, count: count || 0, error: error || '' }),
    }));
  };

  document.addEventListener('carxpert-cl-upload', (e) => {
    let payload;
    try { payload = JSON.parse(e.detail); } catch { reply(false, 0, 'bad payload'); return; }
    const files = (payload.images || []).map((im) => dataUrlToFile(im.dataUrl, im.name)).filter(Boolean);
    if (!files.length) { reply(false, 0, 'no files built'); return; }

    // 1) Preferred: plupload's public API.
    const up = findUploader();
    if (up) {
      try {
        up.addFile(files);
        try { up.start(); } catch (_) {}
        reply(true, files.length, '');
        return;
      } catch (_) { /* fall through to the input approach */ }
    }

    // 2) Fallback: assign files to the moxie file input and fire change, in the page world.
    try {
      const input = document.querySelector('input[type="file"][accept*="image"]');
      if (!input) { reply(false, 0, 'no plupload instance and no file input'); return; }
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      reply(true, files.length, 'input-fallback');
    } catch (err) {
      reply(false, 0, (err && err.message) || 'upload error');
    }
  });
})();
