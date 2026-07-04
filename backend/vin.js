// VIN validation via the ISO 3779 / FMVSS check digit (position 9). A valid VIN is 17 chars,
// excludes I/O/Q, and its computed check digit matches. Only valid VINs participate in the
// sold-scan roster match; invalid ones are stored with vin=null but still counted in stats.

const TRANSLIT = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function isValidVin(vin) {
  if (typeof vin !== 'string') return false;
  const v = vin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false; // 17 chars, no I/O/Q

  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const value = TRANSLIT[v[i]];
    if (value === undefined) return false;
    sum += value * WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return v[8] === expected;
}

// Normalize to a stored VIN (uppercase) if valid, else null.
export function normalizeVin(vin) {
  if (typeof vin !== 'string') return null;
  const v = vin.trim().toUpperCase();
  return isValidVin(v) ? v : null;
}
