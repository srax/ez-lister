'use strict';

// Pure onboarding decisions shared by the side panel and Node tests. Keep intent routing here so
// a claimed rooftop cannot silently turn an explicitly personal signup into a team-seat request.
(function attach(root) {
  function detectedDealerAction({ intent, claimed = false, hasExistingWorkspace = false } = {}) {
    if (intent === 'personal') return 'linkDetected';
    if (hasExistingWorkspace) return 'switchDetectedTeam';
    if (intent === 'organization') return claimed ? 'requestAccess' : 'claimDetected';
    if (intent === 'join') return claimed ? 'requestAccess' : 'joinUnavailable';
    return null;
  }

  function accessRequestBlocksOnboarding(intent, status) {
    if (!['pending', 'approved_awaiting_capacity'].includes(String(status || ''))) return false;
    return intent !== 'personal';
  }

  function shouldWithdrawAccessRequest(intent, status) {
    return intent === 'personal'
      && ['pending', 'approved_awaiting_capacity'].includes(String(status || ''));
  }

  const api = { detectedDealerAction, accessRequestBlocksOnboarding, shouldWithdrawAccessRequest };
  root.CarxpertOnboarding = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
