import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionPersonalToTeam,
  personalSubscriptionState
} from './index.js';

test('personalSubscriptionState exposes live and pending-cancellation state', async () => {
  const db = {
    async query() {
      return {
        rows: [{
          status: 'active',
          periodEnd: new Date(Date.now() + 86_400_000),
          cancelAtPeriodEnd: true,
          cancelAt: new Date(Date.now() + 86_400_000),
          stripeSubscriptionId: 'sub_private'
        }]
      };
    }
  };
  const state = await personalSubscriptionState('user-1', db);
  assert.equal(state.active, true);
  assert.equal(state.cancelAtPeriodEnd, true);
  assert.equal(state.stripeSubscriptionId, 'sub_private');
});

test('personal-to-team billing transition requires a live personal plan and paid team seat', () => {
  const ready = {
    personal: { active: true, cancelAtPeriodEnd: false },
    teamSeat: { active: true }
  };
  assert.equal(canTransitionPersonalToTeam(ready), true);
  assert.equal(canTransitionPersonalToTeam({ ...ready, teamSeat: { active: false } }), false);
  assert.equal(canTransitionPersonalToTeam({ ...ready, personal: { active: false } }), false);
  assert.equal(canTransitionPersonalToTeam({
    ...ready,
    personal: { active: true, cancelAtPeriodEnd: true }
  }), false);
});
