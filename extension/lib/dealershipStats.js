'use strict';

// Pure dealership-outcome statistics. A vehicle contributes to "sold at dealership" only
// when the backend inventory scanner marked it sold. Manual/legacy sale actions never imply
// revenue or salesperson attribution.
(function attach(root) {
  const RANGE_DAYS = { '7': 7, '30': 30, '90': 90 };

  const timeOf = (value) => {
    const time = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(time) ? time : null;
  };

  function withinRange(value, range, now = Date.now()) {
    const time = timeOf(value);
    if (time == null) return false;
    if (range === 'all') return true;
    const days = RANGE_DAYS[range] || RANGE_DAYS['30'];
    const age = now - time;
    return age >= 0 && age <= days * 864e5;
  }

  function vehicleIdentity(row, index = 0) {
    const vin = String(row && row.vin || '').trim().toUpperCase();
    if (vin) return `vin:${vin}`;
    const key = String(row && (row.key || row.clientKey || row.id) || '').trim();
    return key ? `key:${key}` : `row:${index}`;
  }

  function groupsFor(rows) {
    const groups = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      const key = vehicleIdentity(row, index);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row || {});
    });
    return [...groups.values()];
  }

  const soldSource = (row) => row && (row.soldSource || row.sold_source) || null;
  const isDealershipSold = (row) => row && row.status === 'sold' && soldSource(row) === 'scan';

  function firstTime(rows, field) {
    const times = rows.map((row) => timeOf(row && row[field])).filter((value) => value != null);
    return times.length ? Math.min(...times) : null;
  }

  function dealershipSoldAt(group) {
    return firstTime(group.filter(isDealershipSold), 'soldAt');
  }

  function isLiveGroup(group) {
    if (group.some(isDealershipSold)) return false;
    return group.some((row) => row.status === 'active' && !row.dealerOutcome);
  }

  function summarize(rows, range = '30', now = Date.now()) {
    const groups = groupsFor(rows);
    const live = groups.filter(isLiveGroup);
    const sold = groups.map((group) => ({
      group,
      soldAt: dealershipSoldAt(group),
      listedAt: firstTime(group, 'listedAt')
    })).filter((item) => item.soldAt != null);
    const soldInRange = sold.filter((item) => withinRange(item.soldAt, range, now));
    const listedInRange = groups.filter((group) => group.some((row) => withinRange(row.listedAt, range, now))).length;
    const activeValue = live.reduce((sum, group) => {
      const price = group.map((row) => Number(row.price)).find(Number.isFinite);
      return sum + (price || 0);
    }, 0);
    const spans = soldInRange
      .filter((item) => item.listedAt != null && item.soldAt >= item.listedAt)
      .map((item) => (item.soldAt - item.listedAt) / 864e5);
    const avgDays = spans.length ? Math.round(spans.reduce((sum, value) => sum + value, 0) / spans.length) : null;

    let previousSoldCount = null;
    if (range !== 'all') {
      const days = RANGE_DAYS[range] || RANGE_DAYS['30'];
      previousSoldCount = sold.filter((item) => {
        const age = (now - item.soldAt) / 864e5;
        return age > days && age <= days * 2;
      }).length;
    }

    return {
      activeCount: live.length,
      activeValue,
      listedInRange,
      soldAtDealership: soldInRange.length,
      avgDays,
      previousSoldCount
    };
  }

  function monthlyActivity(rows, now = new Date()) {
    const point = now instanceof Date ? now : new Date(now);
    const buckets = [];
    for (let i = 5; i >= 0; i -= 1) {
      const date = new Date(point.getFullYear(), point.getMonth() - i, 1);
      buckets.push({
        year: date.getFullYear(),
        month: date.getMonth(),
        label: date.toLocaleString('en-US', { month: 'short' }),
        listed: 0,
        soldAtDealership: 0
      });
    }
    const bucketFor = (time) => {
      if (time == null) return null;
      const date = new Date(time);
      return buckets.find((bucket) => bucket.year === date.getFullYear() && bucket.month === date.getMonth()) || null;
    };
    for (const group of groupsFor(rows)) {
      const listedBucket = bucketFor(firstTime(group, 'listedAt'));
      if (listedBucket) listedBucket.listed += 1;
      const soldBucket = bucketFor(dealershipSoldAt(group));
      if (soldBucket) soldBucket.soldAtDealership += 1;
    }
    return buckets;
  }

  const api = { withinRange, vehicleIdentity, groupsFor, isDealershipSold, summarize, monthlyActivity };
  root.CarxpertDealershipStats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
