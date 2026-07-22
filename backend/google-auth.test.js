import test from 'node:test';
import assert from 'node:assert/strict';
import { googleProviderConfig } from './google-auth.js';

test('Google auth always lets an extension user choose the account', () => {
  assert.deepEqual(googleProviderConfig('client', 'secret'), {
    clientId: 'client',
    clientSecret: 'secret',
    prompt: 'select_account'
  });
});

test('Google auth remains disabled until both credentials exist', () => {
  assert.equal(googleProviderConfig('', 'secret'), null);
  assert.equal(googleProviderConfig('client', ''), null);
});
