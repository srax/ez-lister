import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidVin, normalizeVin } from './vin.js';

test('accepts real VINs with correct check digit', () => {
  assert.equal(isValidVin('JTEABFAJ9SK020209'), true); // Alexandria Toyota reference VIN
  assert.equal(isValidVin('1N4BL2EP8CC223820'), true);
  assert.equal(isValidVin('11111111111111111'), true); // classic all-ones check-digit VIN
  assert.equal(isValidVin('1M8GDM9AXKP042788'), true); // NHTSA sample (check digit X)
});

test('rejects wrong check digit', () => {
  assert.equal(isValidVin('JTEABFAJ0SK020209'), false); // pos 9 tampered
  assert.equal(isValidVin('1N4BL2EP9CC223820'), false);
});

test('rejects I, O, Q anywhere', () => {
  assert.equal(isValidVin('ITEABFAJ9SK020209'), false);
  assert.equal(isValidVin('JTEABFAJ9SO020209'), false);
  assert.equal(isValidVin('JTEABFAJ9SQ020209'), false);
});

test('rejects wrong length / non-string / junk', () => {
  assert.equal(isValidVin('JTEABFAJ9SK02020'), false); // 16
  assert.equal(isValidVin('JTEABFAJ9SK0202099'), false); // 18
  assert.equal(isValidVin(''), false);
  assert.equal(isValidVin(null), false);
  assert.equal(isValidVin(12345678901234567), false);
  assert.equal(isValidVin('JTEABFAJ9SK02020!'), false);
});

test('normalizeVin: uppercases valid, nulls invalid', () => {
  assert.equal(normalizeVin('jteabfaj9sk020209'), 'JTEABFAJ9SK020209');
  assert.equal(normalizeVin('  JTEABFAJ9SK020209  '), 'JTEABFAJ9SK020209');
  assert.equal(normalizeVin('not-a-vin'), null);
  assert.equal(normalizeVin('ITEABFAJ9SK020209'), null);
});
