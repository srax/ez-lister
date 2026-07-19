import test from 'node:test';
import assert from 'node:assert/strict';
import { isManagedAuthRoute } from './auth-surface.js';

test('generic organization HTTP routes are owned by Carxprt services', () => {
  for (const path of [
    '/api/auth/organization/leave',
    '/api/auth/organization/list-members',
    '/api/auth/organization/'
  ]) assert.equal(isManagedAuthRoute(path), true);
});

test('raw subscription mutations are blocked but lifecycle routes stay reachable', () => {
  for (const path of [
    '/api/auth/subscription/upgrade',
    '/api/auth/subscription/cancel/',
    '/api/auth/subscription/restore',
    '/api/auth/subscription/billing-portal'
  ]) assert.equal(isManagedAuthRoute(path), true);

  for (const path of [
    '/api/auth/subscription/success',
    '/api/auth/subscription/list',
    '/api/auth/stripe/webhook',
    '/api/auth/sign-in/social'
  ]) assert.equal(isManagedAuthRoute(path), false);
});
