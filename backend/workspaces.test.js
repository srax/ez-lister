import test from 'node:test';
import assert from 'node:assert/strict';
import { personalWorkspaceId, selectRooftop, selectWorkspace } from './workspaces.js';

const dealer = (id, domain, hasSeat = false) => ({
  dealership: { id, domains: [domain] },
  hasSeat,
  role: 'salesperson'
});

test('personalWorkspaceId is stable and namespaced', () => {
  assert.equal(personalWorkspaceId('user-1'), 'personal:user-1');
});

test('explicit accessible workspace wins', () => {
  const workspaces = [
    { id: 'personal:u', type: 'personal', status: 'active', rooftops: [] },
    { id: 'org:o', type: 'organization', status: 'active', rooftops: [] }
  ];
  assert.equal(selectWorkspace(workspaces, { requestedId: 'org:o' }).id, 'org:o');
  assert.equal(selectWorkspace(workspaces, { requestedId: 'missing' }), null);
});

test('matching organization seat is the inferred default over an independent personal workspace', () => {
  const workspaces = [
    { id: 'personal:u', type: 'personal', status: 'active', rooftops: [dealer('d', 'dealer.example')] },
    { id: 'org:o', type: 'organization', status: 'active', rooftops: [dealer('d', 'dealer.example', true)] }
  ];
  assert.equal(selectWorkspace(workspaces, { host: 'www.dealer.example' }).id, 'org:o');
});

test('multiple matching organization seats stay ambiguous', () => {
  const workspaces = [
    { id: 'org:a', type: 'organization', status: 'active', rooftops: [dealer('d1', 'group.example', true)] },
    { id: 'org:b', type: 'organization', status: 'active', rooftops: [dealer('d2', 'group.example', true)] }
  ];
  assert.equal(selectWorkspace(workspaces, { host: 'group.example' }), null);
});

test('no host match falls back to personal workspace', () => {
  const workspaces = [
    { id: 'org:o', type: 'organization', status: 'active', rooftops: [] },
    { id: 'personal:u', type: 'personal', status: 'active', rooftops: [] }
  ];
  assert.equal(selectWorkspace(workspaces).id, 'personal:u');
});

test('matching personal workspace wins when organization membership has no listing seat', () => {
  const workspaces = [
    { id: 'personal:u', type: 'personal', status: 'active', rooftops: [dealer('d', 'dealer.example')] },
    { id: 'org:o', type: 'organization', status: 'active', rooftops: [dealer('d', 'dealer.example', false)] }
  ];
  assert.equal(selectWorkspace(workspaces, { host: 'dealer.example' }).id, 'personal:u');
});

test('selectRooftop refuses ambiguity and honors an explicit dealership', () => {
  const workspace = {
    rooftops: [dealer('d1', 'group.example'), dealer('d2', 'group.example')]
  };
  assert.equal(selectRooftop(workspace, { host: 'group.example' }), null);
  assert.equal(selectRooftop(workspace, { dealershipId: 'd2' }).dealership.id, 'd2');
});
