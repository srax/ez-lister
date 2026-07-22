import { Router } from 'express';
import { requireUser } from '../mw.js';
import { requireOrganizationsEnabled } from '../features.js';
import { createClaims, getClaimForUser, listClaimsForUser } from '../claims.js';

const router = Router();
router.use('/api/claims', requireOrganizationsEnabled, requireUser);

router.post('/api/claims', async (req, res, next) => {
  try {
    const claims = await createClaims(req.user, req.body || {});
    res.status(201).json({ ok: true, claims });
  } catch (err) { next(err); }
});

router.get('/api/claims/mine', async (req, res, next) => {
  try {
    res.json({ ok: true, claims: await listClaimsForUser(req.user.id) });
  } catch (err) { next(err); }
});

router.get('/api/claims/:id', async (req, res, next) => {
  try {
    res.json({ ok: true, claim: await getClaimForUser(req.user.id, req.params.id) });
  } catch (err) { next(err); }
});

export default router;
