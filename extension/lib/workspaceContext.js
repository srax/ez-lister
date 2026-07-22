'use strict';

// Pure workspace-context helpers shared by the MV3 worker and Node tests. The extension keeps
// its historical global storage keys as a compatibility shadow for the active workspace while
// `ezlistWorkspaceStores` holds the authoritative per-workspace buckets.
(function attach(root) {
  const SHADOW_KEYS = [
    'ezlistListings',
    'ezlistListedVins',
    'ezlistEventQueue',
    'ezlistDraft',
    'ezlistAutoFill',
    'ezlistLastExtractedAt',
    'ezlistInFlight',
    'ezlistClPendingPhotos'
  ];

  function normalizeContext(value) {
    if (!value || !value.workspaceId) return null;
    return {
      workspaceId: String(value.workspaceId),
      dealershipId: value.dealershipId ? String(value.dealershipId) : null,
      workspaceType: value.workspaceType || null,
      organizationId: value.organizationId || null
    };
  }

  function contextFromMe(me) {
    const workspace = me && me.activeWorkspace;
    const rooftop = me && me.activeRooftop;
    if (!workspace || !workspace.id) return null;
    return normalizeContext({
      workspaceId: workspace.id,
      dealershipId: rooftop && rooftop.dealership && rooftop.dealership.id,
      workspaceType: workspace.type,
      organizationId: workspace.organization && workspace.organization.id
    });
  }

  function contextKey(value) {
    const context = normalizeContext(value);
    return context ? `${context.workspaceId}::${context.dealershipId || 'none'}` : '';
  }

  function contextFromKey(value) {
    const key = String(value || '');
    const splitAt = key.lastIndexOf('::');
    if (splitAt < 1) return null;
    const workspaceId = key.slice(0, splitAt);
    const dealerPart = key.slice(splitAt + 2);
    const organization = workspaceId.startsWith('organization:');
    return normalizeContext({
      workspaceId,
      dealershipId: dealerPart && dealerPart !== 'none' ? dealerPart : null,
      workspaceType: organization ? 'organization' : 'personal',
      organizationId: organization ? workspaceId.slice('organization:'.length) : null
    });
  }

  function sameContext(a, b) {
    return contextKey(a) === contextKey(b);
  }

  function shadowBucket(store) {
    const source = store || {};
    const bucket = {};
    for (const key of SHADOW_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) bucket[key] = source[key];
    }
    return bucket;
  }

  function hasShadowData(bucket) {
    return SHADOW_KEYS.some((key) => {
      const value = bucket && bucket[key];
      if (value == null || value === false || value === '') return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    });
  }

  function stampDraft(draft, value) {
    const context = normalizeContext(value);
    if (!draft || !context) return draft;
    return {
      ...draft,
      _carxpertContext: {
        ...context,
        key: contextKey(context)
      }
    };
  }

  function draftMatchesContext(draft, value) {
    if (!draft || !draft._carxpertContext) return true; // grandfather pre-V2 drafts
    return contextKey(draft._carxpertContext) === contextKey(value);
  }

  function normalizeHost(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    try {
      return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
        .replace(/^www\./, '');
    } catch {
      return raw.split('/')[0].replace(/^www\./, '').replace(/:\d+$/, '');
    }
  }

  function hostMatchesDomains(host, domains) {
    const cleanHost = normalizeHost(host);
    return !!cleanHost && (domains || []).some((value) => {
      const domain = normalizeHost(value);
      return !!domain && (cleanHost === domain || cleanHost.endsWith(`.${domain}`));
    });
  }

  // Provisional workspaces still belong to the claim-before-checkout flow. Established teams
  // remain selectable while active, in a payment grace period, or suspended for renewal.
  function eligibleOrganizationWorkspaces(me) {
    const eligibleStatuses = new Set(['active', 'past_due', 'suspended']);
    return ((me && me.workspaces) || []).filter((workspace) =>
      workspace
      && workspace.type === 'organization'
      && eligibleStatuses.has(workspace.status)
      && workspace.member
      && workspace.member.status === 'active'
    );
  }

  function defaultRooftop(workspace, host = '') {
    const rooftops = (workspace && workspace.rooftops || [])
      .filter((item) => item && item.dealership && item.status !== 'archived');
    if (!rooftops.length) return null;

    if (host) {
      const matches = rooftops.filter((item) =>
        hostMatchesDomains(host, item.dealership.domains || [])
      );
      if (matches.length) return matches.find((item) => item.hasSeat) || matches[0];
    }

    const operational = rooftops.filter((item) =>
      !item.status || ['active', 'past_due', 'pending_removal'].includes(item.status)
    );
    const pool = operational.length ? operational : rooftops;
    return pool.find((item) => item.hasSeat) || pool[0];
  }

  function contextForOrganizationWorkspace(workspace, { host = '' } = {}) {
    if (!workspace || workspace.type !== 'organization') return null;
    const rooftop = defaultRooftop(workspace, host);
    const organizationId = workspace.organization && workspace.organization.id
      ? String(workspace.organization.id)
      : String(workspace.id || '').replace(/^organization:/, '');
    return normalizeContext({
      workspaceId: workspace.id,
      dealershipId: rooftop && rooftop.dealership && rooftop.dealership.id,
      workspaceType: 'organization',
      organizationId
    });
  }

  function uniqueHostContext(workspaces, host) {
    if (!normalizeHost(host)) return null;
    const matching = (workspaces || []).map((workspace) => {
      const rooftops = (workspace.rooftops || []).filter((item) =>
        item && item.dealership
        && item.status !== 'archived'
        && hostMatchesDomains(host, item.dealership.domains || [])
      );
      if (!rooftops.length) return null;
      const rooftop = rooftops.find((item) => item.hasSeat) || rooftops[0];
      return {
        context: contextForOrganizationWorkspace({ ...workspace, rooftops: [rooftop] }, { host }),
        hasSeat: Boolean(rooftop.hasSeat)
      };
    }).filter(Boolean);
    const seated = matching.filter((item) => item.hasSeat);
    const pool = seated.length ? seated : matching;
    return pool.length === 1 ? pool[0].context : null;
  }

  function personalContextNeedsReplacement(me) {
    const active = me && me.activeWorkspace;
    if (!active) return true;
    if (active.type !== 'personal') return false;
    const access = me.workspaceAccess || {};
    return !access.paid && !access.canList;
  }

  // Repair only inferred defaults. Once a person deliberately chooses Personal or a team, that
  // choice is sticky. A dealer host can disambiguate team/rooftop membership; without one, a
  // single established team wins only when Personal has no usable access.
  function recommendAutomaticContext(me, { selectionExplicit = false, host = '' } = {}) {
    if (selectionExplicit) return null;
    const organizations = eligibleOrganizationWorkspaces(me);
    if (!organizations.length) return null;

    // Auto-repair exists to rescue a user stranded in the unusable Personal default. Once any
    // usable Personal or organization context is active, dealer tabs must not silently switch the
    // global workspace behind each other. Multi-team users choose explicitly in the panel.
    if (!personalContextNeedsReplacement(me)) return null;

    const hostContext = uniqueHostContext(organizations, host);
    const current = contextFromMe(me);
    if (hostContext && !sameContext(hostContext, current)) return hostContext;
    if (organizations.length !== 1) return null;

    const recommendation = contextForOrganizationWorkspace(organizations[0], { host });
    return recommendation && !sameContext(recommendation, current) ? recommendation : null;
  }

  function needsOrganizationChoice(me, { selectionExplicit = false, host = '' } = {}) {
    if (selectionExplicit || !personalContextNeedsReplacement(me)) return false;
    const organizations = eligibleOrganizationWorkspaces(me);
    if (organizations.length < 2) return false;
    return !uniqueHostContext(organizations, host);
  }

  const api = {
    SHADOW_KEYS,
    normalizeContext,
    contextFromMe,
    contextKey,
    contextFromKey,
    contextForOrganizationWorkspace,
    sameContext,
    shadowBucket,
    hasShadowData,
    eligibleOrganizationWorkspaces,
    needsOrganizationChoice,
    recommendAutomaticContext,
    stampDraft,
    draftMatchesContext
  };
  root.CarxpertWorkspaceContext = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
