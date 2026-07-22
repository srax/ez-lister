import test from 'node:test';
import assert from 'node:assert/strict';
import { requireTeamManagement } from './organization-authz.js';

const manager = {
  member_id: 'member-1',
  organization_id: 'org-1',
  role: 'manager',
  all_rooftops: false,
  status: 'active'
};

test('scoped managers need a manager-role access row for the requested rooftop', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [{ '?column?': 1 }] };
    }
  };
  await requireTeamManagement(manager, 'dealer-1', 'salesperson', db);
  assert.match(calls[0].sql, /a\.role='manager'/);
  assert.deepEqual(calls[0].params, ['member-1', 'org-1', 'dealer-1']);
});

test('a profile manager cannot manage a rooftop carrying no scoped manager grant', async () => {
  const db = { async query() { return { rows: [] }; } };
  await assert.rejects(
    requireTeamManagement(manager, 'dealer-2', 'salesperson', db),
    (error) => error.reason === 'wrong_rooftop'
  );
});

test('managers cannot approve or manage another manager', async () => {
  let queried = false;
  const db = { async query() { queried = true; return { rows: [{ '?column?': 1 }] }; } };
  await assert.rejects(
    requireTeamManagement(manager, 'dealer-1', 'manager', db),
    (error) => error.reason === 'owner_required'
  );
  assert.equal(queried, false);
});

test('owners retain organization-wide team management', async () => {
  let queried = false;
  await requireTeamManagement({ ...manager, role: 'owner' }, 'dealer-2', 'manager', {
    async query() { queried = true; return { rows: [] }; }
  });
  assert.equal(queried, false);
});
