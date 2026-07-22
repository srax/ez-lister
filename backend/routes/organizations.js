import { Router } from 'express';
import { requireUser } from '../mw.js';
import { requireOrganizationsEnabled } from '../features.js';
import {
  acceptInvitation,
  assignSeat,
  cancelAccessRequest,
  createAccessRequest,
  createInvitation,
  decideAccessRequest,
  getCapacity,
  listAccessRequests,
  listUserAccessRequests,
  listMembers,
  listNotifications,
  markNotificationRead,
  releaseSeat,
  removeMember,
  setOwnerListingPreference,
  updateMemberRole
} from '../organizations.js';
import { requireMembership, requireRooftopAccess } from '../organization-authz.js';
import { organizationPaidState } from '../entitlement/index.js';
import { getOrganizationDashboard } from '../organization-dashboard.js';
import { acceptOwnershipTransfer, initiateOwnershipTransfer } from '../ownership-transfers.js';

const router = Router();
router.use('/api/organizations', requireOrganizationsEnabled, requireUser);
router.use('/api/access-requests', requireOrganizationsEnabled, requireUser);
router.use('/api/invitations', requireOrganizationsEnabled, requireUser);
router.use('/api/notifications', requireOrganizationsEnabled, requireUser);
router.use('/api/ownership-transfers', requireOrganizationsEnabled, requireUser);

async function requirePaidOrganization(req, res, next) {
  try {
    const organizationId = req.params.organizationId;
    await requireMembership(req.user.id, organizationId);
    const paid = await organizationPaidState(organizationId);
    if (!paid.paid) {
      res.status(402).json({ ok: false, error: 'subscription required', reason: paid.reason });
      return;
    }
    next();
  } catch (err) { next(err); }
}

router.post('/api/access-requests', async (req, res, next) => {
  try {
    const request = await createAccessRequest(req.user, req.body || {});
    res.status(201).json({ ok: true, request });
  } catch (err) { next(err); }
});

router.get('/api/access-requests/mine', async (req, res, next) => {
  try {
    res.json({ ok: true, requests: await listUserAccessRequests(req.user.id) });
  } catch (err) { next(err); }
});

router.delete('/api/access-requests/:requestId', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await cancelAccessRequest(req.user.id, req.params.requestId)) });
  } catch (err) { next(err); }
});

router.get('/api/organizations/:organizationId/access-requests', requirePaidOrganization, async (req, res, next) => {
  try {
    res.json({ ok: true, requests: await listAccessRequests(req.user.id, req.params.organizationId) });
  } catch (err) { next(err); }
});

router.post('/api/organizations/:organizationId/access-requests/:requestId/decision', requirePaidOrganization, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await decideAccessRequest(
      req.user.id,
      req.params.organizationId,
      req.params.requestId,
      req.body || {}
    )) });
  } catch (err) { next(err); }
});

router.post('/api/organizations/:organizationId/invitations', requirePaidOrganization, async (req, res, next) => {
  try {
    const invitation = await createInvitation(req.user.id, req.params.organizationId, req.body || {});
    res.status(201).json({ ok: true, invitation });
  } catch (err) { next(err); }
});

router.post('/api/invitations/accept', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await acceptInvitation(req.user, (req.body || {}).token)) });
  } catch (err) { next(err); }
});

router.get('/api/organizations/:organizationId/members', requirePaidOrganization, async (req, res, next) => {
  try {
    res.json({ ok: true, members: await listMembers(req.user.id, req.params.organizationId) });
  } catch (err) { next(err); }
});

router.patch('/api/organizations/:organizationId/members/:memberId', requirePaidOrganization, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await updateMemberRole(
      req.user.id,
      req.params.organizationId,
      req.params.memberId,
      req.body || {}
    )) });
  } catch (err) { next(err); }
});

router.delete('/api/organizations/:organizationId/members/:memberId', requirePaidOrganization, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await removeMember(
      req.user.id,
      req.params.organizationId,
      req.params.memberId,
      req.body || {}
    )) });
  } catch (err) { next(err); }
});

router.post('/api/organizations/:organizationId/ownership-transfer', requirePaidOrganization, async (req, res, next) => {
  try {
    const transfer = await initiateOwnershipTransfer(
      req.user.id,
      req.params.organizationId,
      String((req.body || {}).targetMemberId || ''),
      { sessionCreatedAt: req.session && req.session.createdAt }
    );
    res.status(201).json({ ok: true, transfer });
  } catch (err) { next(err); }
});

router.post('/api/ownership-transfers/accept', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await acceptOwnershipTransfer(
      req.user.id,
      String((req.body || {}).token || '')
    )) });
  } catch (err) { next(err); }
});

router.get('/api/organizations/:organizationId/rooftops/:dealershipId/capacity', requirePaidOrganization, async (req, res, next) => {
  try {
    const member = await requireMembership(req.user.id, req.params.organizationId);
    await requireRooftopAccess(member, req.params.dealershipId);
    res.json({ ok: true, capacity: await getCapacity(req.params.organizationId, req.params.dealershipId) });
  } catch (err) { next(err); }
});

router.post('/api/organizations/:organizationId/rooftops/:dealershipId/seats/:memberId', requirePaidOrganization, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await assignSeat(
      req.user.id,
      req.params.organizationId,
      req.params.dealershipId,
      req.params.memberId
    )) });
  } catch (err) { next(err); }
});

router.delete('/api/organizations/:organizationId/rooftops/:dealershipId/seats/:memberId', requirePaidOrganization, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await releaseSeat(
      req.user.id,
      req.params.organizationId,
      req.params.dealershipId,
      req.params.memberId
    )) });
  } catch (err) { next(err); }
});

router.post('/api/organizations/:organizationId/owner-listing-preference', requirePaidOrganization, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await setOwnerListingPreference(
      req.user.id,
      req.params.organizationId,
      { willList: (req.body || {}).willList }
    )) });
  } catch (err) { next(err); }
});

router.get('/api/notifications', async (req, res, next) => {
  try {
    res.json({ ok: true, notifications: await listNotifications(req.user.id) });
  } catch (err) { next(err); }
});

router.post('/api/notifications/:id/read', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await markNotificationRead(req.user.id, req.params.id)) });
  } catch (err) { next(err); }
});

router.get('/api/organizations/:organizationId/dashboard', requirePaidOrganization, async (req, res, next) => {
  try {
    const dashboard = await getOrganizationDashboard(req.user.id, req.params.organizationId, {
      dealershipId: req.query.dealershipId || null,
      memberId: req.query.memberId || null,
      from: req.query.from || null,
      to: req.query.to || null
    });
    res.json({ ok: true, dashboard });
  } catch (err) { next(err); }
});

export default router;
