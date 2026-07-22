function enabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

export function organizationsEnabled() {
  return enabled(process.env.ORGANIZATIONS_ENABLED);
}

export function dealershipAutoOnboardEnabled() {
  return enabled(process.env.DEALERSHIP_AUTO_ONBOARD_ENABLED);
}

export function requireOrganizationsEnabled(req, res, next) {
  if (!organizationsEnabled()) {
    res.status(404).json({ ok: false, error: 'Not found' });
    return;
  }
  next();
}

export { enabled as featureEnabled };
