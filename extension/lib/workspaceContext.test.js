'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SHADOW_KEYS,
  contextFromMe,
  contextFromKey,
  contextKey,
  draftMatchesContext,
  eligibleOrganizationWorkspaces,
  hasShadowData,
  needsOrganizationChoice,
  recommendAutomaticContext,
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

const rooftop = (id, domain, { hasSeat = true, status = 'active' } = {}) => ({
  dealership: { id, name: id, domains: [domain] },
  hasSeat,
  role: 'salesperson',
  status
});

const orgWorkspace = (id, rooftops, options = {}) => ({
  id: `organization:${id}`,
  type: 'organization',
  status: options.status || 'active',
  organization: { id, name: options.name || id },
  member: {
    id: `member:${id}`,
    role: options.role || 'salesperson',
    status: options.memberStatus || 'active'
  },
  rooftops
});

const strandedPersonal = (organizations) => ({
  activeWorkspace: { id: 'personal:u1', type: 'personal', status: 'active', rooftops: [] },
  activeRooftop: null,
  workspaceAccess: { paid: false, canList: false, reason: 'no_dealership' },
  workspaces: [
    { id: 'personal:u1', type: 'personal', status: 'active', rooftops: [] },
    ...organizations
  ]
});

test('an inferred empty personal context yields to one active organization workspace', () => {
  const org = orgWorkspace('dealer-1', [rooftop('alexandria', 'alexandriatoyota.com')], { role: 'owner' });
  assert.deepEqual(recommendAutomaticContext(strandedPersonal([org])), {
    workspaceId: 'organization:dealer-1',
    dealershipId: 'alexandria',
    workspaceType: 'organization',
    organizationId: 'dealer-1'
  });
});

test('an explicit personal selection is never overridden', () => {
  const org = orgWorkspace('dealer-1', [rooftop('alexandria', 'alexandriatoyota.com')]);
  assert.equal(recommendAutomaticContext(strandedPersonal([org]), { selectionExplicit: true }), null);
});

test('a usable personal subscription stays selected even when a dealer tab is open', () => {
  const org = orgWorkspace('dealer-1', [rooftop('alexandria', 'alexandriatoyota.com')]);
  const me = strandedPersonal([org]);
  me.workspaceAccess = { paid: true, canList: true, reason: 'ok' };
  assert.equal(
    recommendAutomaticContext(me, { host: 'www.alexandriatoyota.com' }),
    null
  );
});

test('dealer tabs never silently switch an already-active organization workspace', () => {
  const alexandria = orgWorkspace('dealer-1', [rooftop('alexandria', 'alexandriatoyota.com')]);
  const stevens = orgWorkspace('dealer-2', [rooftop('stevens', 'stevenstoyota.com')]);
  const me = {
    activeWorkspace: alexandria,
    activeRooftop: alexandria.rooftops[0],
    workspaceAccess: { paid: true, canList: true, reason: 'ok' },
    workspaces: [alexandria, stevens]
  };
  assert.equal(
    recommendAutomaticContext(me, { host: 'www.stevenstoyota.com' }),
    null
  );
});

test('a matching dealer host disambiguates multiple organization workspaces', () => {
  const alexandria = orgWorkspace('dealer-1', [rooftop('alexandria', 'alexandriatoyota.com')]);
  const stevens = orgWorkspace('dealer-2', [rooftop('stevens', 'stevenstoyota.com')]);
  assert.deepEqual(
    recommendAutomaticContext(strandedPersonal([alexandria, stevens]), { host: 'www.alexandriatoyota.com' }),
    {
      workspaceId: 'organization:dealer-1',
      dealershipId: 'alexandria',
      workspaceType: 'organization',
      organizationId: 'dealer-1'
    }
  );
});

test('a dealer host shared by two memberships prefers the only listing seat', () => {
  const observer = orgWorkspace('observer', [rooftop('shared-a', 'dealer.example', { hasSeat: false })]);
  const lister = orgWorkspace('lister', [rooftop('shared-b', 'dealer.example', { hasSeat: true })]);
  assert.equal(
    recommendAutomaticContext(strandedPersonal([observer, lister]), { host: 'www.dealer.example' }).workspaceId,
    'organization:lister'
  );
});

test('multiple active teams require a chooser instead of arbitrary auto-selection', () => {
  const one = orgWorkspace('dealer-1', [rooftop('alexandria', 'alexandriatoyota.com')]);
  const two = orgWorkspace('dealer-2', [rooftop('stevens', 'stevenstoyota.com')]);
  const me = strandedPersonal([one, two]);
  assert.equal(recommendAutomaticContext(me), null);
  assert.equal(needsOrganizationChoice(me), true);
});

test('provisional workspaces and inactive members remain in their existing claim/access flows', () => {
  const provisional = orgWorkspace('pending', [rooftop('pending', 'pending.example')], { status: 'provisional' });
  const removed = orgWorkspace('removed', [rooftop('removed', 'removed.example')], { memberStatus: 'removed' });
  const me = strandedPersonal([provisional, removed]);
  assert.deepEqual(eligibleOrganizationWorkspaces(me), []);
  assert.equal(recommendAutomaticContext(me), null);
  assert.equal(needsOrganizationChoice(me), false);
});

test('an active member without a seat still enters the team to see the correct no-seat state', () => {
  const org = orgWorkspace('dealer-1', [rooftop('alexandria', 'alexandriatoyota.com', { hasSeat: false })]);
  assert.deepEqual(recommendAutomaticContext(strandedPersonal([org])), {
    workspaceId: 'organization:dealer-1',
    dealershipId: 'alexandria',
    workspaceType: 'organization',
    organizationId: 'dealer-1'
  });
});
