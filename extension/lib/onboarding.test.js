'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectedDealerAction,
  accessRequestBlocksOnboarding,
  shouldWithdrawAccessRequest
} = require('./onboarding.js');

test('personal onboarding links a supported dealership even when a team already claimed it', () => {
  assert.equal(detectedDealerAction({ intent: 'personal', claimed: true }), 'linkDetected');
  assert.equal(detectedDealerAction({ intent: 'personal', claimed: false }), 'linkDetected');
});

test('team-oriented intents preserve claim and access boundaries', () => {
  assert.equal(detectedDealerAction({ intent: 'organization', claimed: false }), 'claimDetected');
  assert.equal(detectedDealerAction({ intent: 'organization', claimed: true }), 'requestAccess');
  assert.equal(detectedDealerAction({ intent: 'join', claimed: true }), 'requestAccess');
  assert.equal(detectedDealerAction({ intent: 'join', claimed: false }), 'joinUnavailable');
});

test('an explicit personal choice stays independent even when team access also exists', () => {
  assert.equal(detectedDealerAction({
    intent: 'personal', claimed: true, hasExistingWorkspace: true
  }), 'linkDetected');
  assert.equal(detectedDealerAction({
    intent: 'join', claimed: true, hasExistingWorkspace: true
  }), 'switchDetectedTeam');
});

test('a pending team request does not trap an explicitly personal signup', () => {
  assert.equal(accessRequestBlocksOnboarding('personal', 'pending'), false);
  assert.equal(accessRequestBlocksOnboarding('join', 'pending'), true);
  assert.equal(accessRequestBlocksOnboarding(null, 'approved_awaiting_capacity'), true);
  assert.equal(accessRequestBlocksOnboarding('personal', 'approved'), false);
});

test('a persisted personal intent withdraws stale open team requests on startup', () => {
  assert.equal(shouldWithdrawAccessRequest('personal', 'pending'), true);
  assert.equal(shouldWithdrawAccessRequest('personal', 'approved_awaiting_capacity'), true);
  assert.equal(shouldWithdrawAccessRequest('join', 'pending'), false);
  assert.equal(shouldWithdrawAccessRequest('personal', 'approved'), false);
});
