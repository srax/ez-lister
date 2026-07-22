import test from 'node:test';
import assert from 'node:assert/strict';
import { dealershipAutoOnboardEnabled, featureEnabled } from './features.js';

test('featureEnabled accepts only explicit truthy flags', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(featureEnabled(value), true);
  for (const value of ['', '0', 'false', 'no', null, undefined]) assert.equal(featureEnabled(value), false);
});

test('dealership auto-onboarding is disabled unless explicitly enabled', () => {
  const before = process.env.DEALERSHIP_AUTO_ONBOARD_ENABLED;
  try {
    delete process.env.DEALERSHIP_AUTO_ONBOARD_ENABLED;
    assert.equal(dealershipAutoOnboardEnabled(), false);
    process.env.DEALERSHIP_AUTO_ONBOARD_ENABLED = 'true';
    assert.equal(dealershipAutoOnboardEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.DEALERSHIP_AUTO_ONBOARD_ENABLED;
    else process.env.DEALERSHIP_AUTO_ONBOARD_ENABLED = before;
  }
});
