'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONTENT_FILES, sendToTab } = require('./facebookBridge.js');

test('description delivery reconnects an open Facebook form after its receiver was invalidated', async () => {
  let receiverReady = false;
  let sendCount = 0;
  let injectionCount = 0;
  const chromeApi = {
    tabs: {
      async sendMessage(tabId, message) {
        sendCount += 1;
        assert.equal(tabId, 42);
        assert.equal(message.type, 'EZLIST_UPDATE_DESCRIPTION');
        if (!receiverReady) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true, updated: true };
      }
    },
    scripting: {
      async executeScript(details) {
        injectionCount += 1;
        assert.deepEqual(details.target, { tabId: 42 });
        assert.deepEqual(details.files, CONTENT_FILES);
        receiverReady = true;
      }
    }
  };

  const result = await sendToTab(chromeApi, 42, {
    type: 'EZLIST_UPDATE_DESCRIPTION',
    key: 'TESTVIN',
    description: 'Translated description'
  });

  assert.equal(result.updated, true);
  assert.equal(sendCount, 2);
  assert.equal(injectionCount, 1);
});

test('description delivery fails safely when the tab cannot be reconnected', async () => {
  const chromeApi = {
    tabs: { async sendMessage() { throw new Error('no receiver'); } },
    scripting: { async executeScript() { throw new Error('tab closed'); } }
  };

  assert.equal(await sendToTab(chromeApi, 99, { type: 'EZLIST_UPDATE_DESCRIPTION' }), null);
});
