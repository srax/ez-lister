'use strict';

// Dealership-outcome logic (Part 2): when a listed car disappears from the dealership's own site
// (detected by the inventory presence check — lib/inventoryCheck.js), the user classifies what
// happened to it. This is SEPARATE from the salesperson's personal "Mark sold" button:
//
//   • dealerOutcome 'fb' / 'craigslist'  → the DEALERSHIP sold it (someone other than this user).
//   • dealerOutcome 'delisted'           → removed for any other reason; NOT a sale.
//
// An outcome'd car is removed from the user's Active-listings tally and personal stats, and counted
// only in the yellow "Sold by dealership" card. A car the user already marked personally sold is
// exempt — they already know it's gone. Pure + framework-free so it's unit-testable in node and
// also loadable in the side panel via a plain <script> (attaches to globalThis).

(function attach(root) {
  const OUTCOMES = ['fb', 'craigslist', 'delisted'];

  // Display metadata for the popup options, row badges, and the yellow card columns.
  const OUTCOME_META = {
    fb:         { label: 'Sold at Facebook',  badge: 'Sold by dealership', col: 'Sold at FB',        sale: true  },
    craigslist: { label: 'Sold at Craigslist', badge: 'Sold by dealership', col: 'Sold at Craigslist', sale: true  },
    delisted:   { label: 'Delisted',           badge: 'Delisted',           col: 'Delisted',           sale: false }
  };

  const isOutcome = (v) => OUTCOMES.indexOf(v) !== -1;
  const outcomeOf = (l) => (l && isOutcome(l.dealerOutcome) ? l.dealerOutcome : null);

  // Already handled a dealership outcome?
  const hasOutcome = (l) => outcomeOf(l) != null;

  // A car needs the user's attention iff it's confirmed gone from the dealership site, not already
  // classified, and not already personally sold (a personal sale means the user knows it's gone).
  function needsAction(l) {
    if (!l) return false;
    if (l.status === 'sold') return false;
    if (hasOutcome(l)) return false;
    return !!l.inventoryGone;
  }

  // Live inventory = active, not personally sold, not a dealership outcome (sold/delisted both drop
  // out of Active). Used by the Active-listings tile + active-value so those numbers exclude them.
  function isActiveLive(l) {
    if (!l) return false;
    if (l.status !== 'active') return false;
    return !hasOutcome(l);
  }

  // Counts for the yellow "Sold by dealership" card: one bucket per outcome.
  function dealerCounts(rows) {
    const c = { fb: 0, craigslist: 0, delisted: 0, sold: 0, total: 0 };
    for (const l of Array.isArray(rows) ? rows : []) {
      const o = outcomeOf(l);
      if (!o) continue;
      c[o] += 1;
      c.total += 1;
      if (OUTCOME_META[o].sale) c.sold += 1; // fb+craigslist are sales; delisted is not
    }
    return c;
  }

  // "Your listings" ordering: needs-action cars first (most urgent), then the rest newest-first.
  function sortForList(rows) {
    return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
      const na = needsAction(a) ? 1 : 0;
      const nb = needsAction(b) ? 1 : 0;
      if (na !== nb) return nb - na; // needs-action to the top
      return new Date(b && b.listedAt || 0) - new Date(a && a.listedAt || 0);
    });
  }

  const needsActionCount = (rows) => (Array.isArray(rows) ? rows : []).filter(needsAction).length;

  const api = {
    OUTCOMES, OUTCOME_META, isOutcome, outcomeOf, hasOutcome,
    needsAction, isActiveLive, dealerCounts, sortForList, needsActionCount
  };
  root.CarxpertDealerOutcome = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
