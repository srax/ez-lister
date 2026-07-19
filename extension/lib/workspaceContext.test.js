'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SHADOW_KEYS,
  contextFromMe,
  contextFromKey,
  contextKey,
  draftMatchesContext,
  hasShadowData,
  shadowBucket,
  stampDraft
} = require('./workspaceContext.js');

const personal = { workspaceId: 'personal:u1', dealershipId: 'd1', workspaceType: 'personal' };
const organization = { workspaceId: 'organization:o1', dealershipId: 'd1', workspaceType: 'organization', organizationId: 'o1' };

test('context key isolates personal and organization activity at the same rooftop', () => {
  assert.equal(contextKey(personal), 'personal:u1::d1');
  assert.equal(contextKey(organization), 'organization:o1::d1');
  assert.notEqual(contextKey(personal), contextKey(organization));
  assert.deepEqual(contextFromKey('organization:o1::d1'), organization);
});

test('contextFromMe derives the selected workspace and rooftop', () => {
  assert.deepEqual(contextFromMe({
    activeWorkspace: { id: 'organization:o1', type: 'organization', organization: { id: 'o1' } },
    activeRooftop: { dealership: { id: 'd2' } }
  }), {
    workspaceId: 'organization:o1',
    dealershipId: 'd2',
    workspaceType: 'organization',
    organizationId: 'o1'
  });
});

test('draft stamps are immutable attribution guards while legacy drafts remain readable', () => {
  const draft = stampDraft({ vin: 'VIN1' }, organization);
  assert.equal(draft._carxpertContext.key, 'organization:o1::d1');
  assert.equal(draftMatchesContext(draft, organization), true);
  assert.equal(draftMatchesContext(draft, personal), false);
  assert.equal(draftMatchesContext({ vin: 'LEGACY' }, personal), true);
});

test('shadowBucket copies only compatibility keys and detects meaningful data', () => {
  const bucket = shadowBucket({ ezlistListings: { A: { key: 'A' } }, unrelated: 1 });
  assert.deepEqual(bucket, { ezlistListings: { A: { key: 'A' } } });
  assert.equal(hasShadowData(bucket), true);
  assert.equal(hasShadowData({ ezlistListings: {}, ezlistAutoFill: false }), false);
  assert.ok(SHADOW_KEYS.includes('ezlistEventQueue'));
});
