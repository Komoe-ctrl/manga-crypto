import { Prisma } from '../generated/prisma/client.js';
import { formatNumber, formatSigned } from './format.js';

const D = (value: string | number) => new Prisma.Decimal(value);

describe('formatNumber', () => {
  it.each([
    ['12.5', '12,5'],
    ['1234567.891', '1 234 567,89'],
    ['0', '0'],
    ['-3.456', '-3,46'],
  ])('%s → %s', (value, expected) => {
    expect(formatNumber(D(value))).toBe(expected);
  });

  it('garde des chiffres significatifs sous 1 (0,0001 ne devient pas 0)', () => {
    expect(formatNumber(D('0.0001'))).toBe('0,0001');
    expect(formatNumber(D('0.00001234'))).toBe('0,00001234');
    expect(formatNumber(D('0.06069'))).toBe('0,06069');
  });

  it('n’utilise que des espaces simples', () => {
    expect(formatNumber(D(9999999))).not.toMatch(/[^\S ]/);
    expect(formatNumber(D(9999999))).toBe('9 999 999');
  });
});

describe('formatSigned', () => {
  it('ajoute le signe explicite, avec un vrai signe moins', () => {
    expect(formatSigned(D('1.2'))).toBe('+1,2');
    expect(formatSigned(D('-3.4'))).toBe('−3,4');
    expect(formatSigned(D(0))).toBe('0');
  });
});
