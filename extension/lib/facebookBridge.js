'use strict';

// Delivery bridge from the MV3 worker to an already-open Facebook composer. Reloading/updating an
// MV3 extension invalidates the receiver in pages that were already open. Re-inject the exact
// manifest content-script stack and retry once, so a Description-only edit never needs to reload
// or reopen the Facebook form.
(function attach(root) {
  const CONTENT_FILES = [
    'lib/mappers.core.js',
    'lib/mappers.fb.js',
    'lib/fillkit.js',
    'facebookContent.js'
  ];

  async function sendToTab(chromeApi, tabId, message) {
    try {
      return await chromeApi.tabs.sendMessage(tabId, message);
    } catch {
      if (!chromeApi.scripting || !chromeApi.scripting.executeScript) return null;
      try {
        await chromeApi.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
        return await chromeApi.tabs.sendMessage(tabId, message);
      } catch {
        return null;
      }
    }
  }

  const api = { CONTENT_FILES, sendToTab };
  root.CarxpertFacebookBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
