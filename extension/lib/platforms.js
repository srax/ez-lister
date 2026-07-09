'use strict';

// The platform registry — the background worker's half of the platform-adapter contract.
//
// Each entry describes WHERE a platform's "create a listing" page lives and how to
// recognize it, so the router (background.js) can open/reuse/prewarm the right tab and
// hand off to the right content script without any Facebook-specific branching. The
// content-script half of the contract (mapDraft/fillForm/publish-detect) lives in each
// platform's *Content.js; the two halves meet at the create URL + the EZLIST_FILL message.
//
// Adding a platform = one entry here + a *Content.js + a lib/mappers.<platform>.js + a
// manifest host/content-script block. Loaded via importScripts in background.js (DOM-free)
// and requireable in node:test.

(function attach(root) {
  const PLATFORMS = {
    fb: {
      id: 'fb',
      label: 'Facebook Marketplace',
      // Where the worker opens/prewarms to start a listing.
      createUrl: 'https://www.facebook.com/marketplace/create/vehicle',
      // True when a tab URL is that platform's create page (guards prewarm reuse).
      isCreateUrl: (url) => /\/marketplace\/create\/vehicle/i.test(url || ''),
    },
    craigslist: {
      id: 'craigslist',
      label: 'Craigslist',
      // Craigslist's posting flow starts here; the human picks area + category first, then
      // the vehicle attribute form renders (all on post.craigslist.org). We fill that form;
      // the human handles verification/fees/publish. Prewarm isn't used for CL (login/area
      // steps make a hidden prewarm pointless), so isCreateUrl just recognizes the host.
      createUrl: 'https://post.craigslist.org/',
      isCreateUrl: (url) => /(^|\/\/)post\.craigslist\.org\//i.test(url || ''),
    },
    // offerup entry lands here as its adapter ships (P5).
  };

  const DEFAULT_PLATFORM = 'fb';

  // Resolve an id to its entry; unknown/empty ids fall back to the default (Facebook), so
  // every legacy caller that sends no `platform` keeps working unchanged.
  const getPlatform = (id) => PLATFORMS[id] || PLATFORMS[DEFAULT_PLATFORM];

  const api = { PLATFORMS, DEFAULT_PLATFORM, getPlatform };
  root.CarxpertPlatforms = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
