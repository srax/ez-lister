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

  const api = {
    SHADOW_KEYS,
    normalizeContext,
    contextFromMe,
    contextKey,
    contextFromKey,
    sameContext,
    shadowBucket,
    hasShadowData,
    stampDraft,
    draftMatchesContext
  };
  root.CarxpertWorkspaceContext = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
