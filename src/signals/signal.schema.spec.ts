import {
  MAX_MESSAGE_BYTES,
  parseSignal,
  type InvalidSignalReason,
} from './signal.schema.js';

const NOW = new Date('2026-10-24T08:00:30Z');

const valid = (over: Record<string, unknown> = {}) => ({
  v: 1,
  id: '6f2b4d58-3c7f-4b6a-9d52-1c5d2b1f0a11',
  ts: '2026-10-24T08:00:00Z',
  symbol: 'BTC',
  action: 'BUY',
  score: 0.82,
  price: '81700.5',
  reason: 'EMA20 > EMA50, RSI 41',
  indicators: { rsi: 41, ema20: 81500 },
  ...over,
});
const parse = (message: unknown, now = NOW) =>
  parseSignal(
    { data: typeof message === 'string' ? message : JSON.stringify(message) },
    now,
  );
const reason = (message: unknown, now = NOW) => {
  const result = parse(message, now);
  return result.ok ? null : result.reason;
};

describe('parseSignal', () => {
  describe('message valide', () => {
    it('accepte le message complet du contrat', () => {
      const result = parse(valid());
      expect(result).toEqual({
        ok: true,
        signal: {
          v: 1,
          id: '6f2b4d58-3c7f-4b6a-9d52-1c5d2b1f0a11',
          ts: new Date('2026-10-24T08:00:00Z'),
          symbol: 'BTC',
          action: 'BUY',
          score: 0.82,
          price: '81700.5',
          reason: 'EMA20 > EMA50, RSI 41',
          indicators: { rsi: 41, ema20: 81500 },
        },
      });
    });

    it('accepte le message minimal (champs facultatifs absents)', () => {
      const result = parse({
        v: 1,
        id: 'a',
        ts: '2026-10-24T08:00:00Z',
        symbol: 'ETH',
        action: 'SELL',
        score: 0,
      });
      expect(result).toMatchObject({
        ok: true,
        signal: {
          price: null,
          reason: null,
          indicators: null,
          action: 'SELL',
          score: 0,
        },
      });
    });

    it('accepte des champs facultatifs à null', () => {
      expect(
        parse(valid({ price: null, reason: null, indicators: null })),
      ).toMatchObject({ ok: true });
    });

    it('ignore les champs inconnus (évolution compatible)', () => {
      const result = parse(valid({ futur: 'x', autre: { a: 1 } }));
      expect(result.ok).toBe(true);
      expect(result.ok && Object.keys(result.signal)).not.toContain('futur');
    });

    it.each(['BUY', 'SELL', 'HOLD'])('accepte l’action %s', (action) => {
      expect(parse(valid({ action })).ok).toBe(true);
    });

    it.each([0, 1, 0.6, 0.999])('accepte le score %s', (score) => {
      expect(parse(valid({ score })).ok).toBe(true);
    });

    it.each([
      '2026-10-24T08:00:00Z',
      '2026-10-24T08:00:00.123Z',
      '2026-10-24T08:00:00.123456789Z',
    ])('accepte l’instant %s', (ts) => {
      expect(parse(valid({ ts })).ok).toBe(true);
    });

    it('accepte un id de 64 caractères et tous les caractères autorisés', () => {
      expect(parse(valid({ id: 'a'.repeat(64) })).ok).toBe(true);
      expect(parse(valid({ id: 'Az09-_.:' })).ok).toBe(true);
    });

    it('accepte 500 caractères de justification et 2 Ko d’indicateurs', () => {
      expect(parse(valid({ reason: 'x'.repeat(500) })).ok).toBe(true);
      // {"k":"…"} : 2048 octets au total.
      expect(parse(valid({ indicators: { k: 'x'.repeat(2048 - 8) } })).ok).toBe(
        true,
      );
    });

    it('accepte un stablecoin (c’est le traitement du signal qui l’ignore, pas le contrat)', () => {
      expect(parse(valid({ symbol: 'USDT' })).ok).toBe(true);
    });
  });

  describe('message invalide : motif précis, jamais deviné', () => {
    it.each<[string, unknown, InvalidSignalReason]>([
      ['version absente', { ...valid(), v: undefined }, 'unsupported_version'],
      ['version 2', valid({ v: 2 }), 'unsupported_version'],
      ['version en chaîne', valid({ v: '1' }), 'unsupported_version'],
      ['id absent', valid({ id: undefined }), 'invalid_id'],
      ['id vide', valid({ id: '' }), 'invalid_id'],
      ['id trop long', valid({ id: 'a'.repeat(65) }), 'invalid_id'],
      ['id avec espace', valid({ id: 'a b' }), 'invalid_id'],
      ['id numérique', valid({ id: 42 }), 'invalid_id'],
      ['instant absent', valid({ ts: undefined }), 'invalid_ts'],
      ['instant sans Z', valid({ ts: '2026-10-24T08:00:00' }), 'invalid_ts'],
      [
        'instant avec décalage',
        valid({ ts: '2026-10-24T08:00:00+02:00' }),
        'invalid_ts',
      ],
      ['instant en nombre', valid({ ts: 1729756800 }), 'invalid_ts'],
      ['instant en date seule', valid({ ts: '2026-10-24' }), 'invalid_ts'],
      [
        'instant impossible',
        valid({ ts: '2026-13-45T25:61:61Z' }),
        'invalid_ts',
      ],
      ['symbole absent', valid({ symbol: undefined }), 'invalid_symbol'],
      ['symbole en minuscules', valid({ symbol: 'btc' }), 'invalid_symbol'],
      ['symbole trop court', valid({ symbol: 'B' }), 'invalid_symbol'],
      [
        'symbole trop long',
        valid({ symbol: 'ABCDEFGHIJKLM' }),
        'invalid_symbol',
      ],
      ['symbole avec paire', valid({ symbol: 'BTC/USDT' }), 'invalid_symbol'],
      ['action absente', valid({ action: undefined }), 'invalid_action'],
      ['action en minuscules', valid({ action: 'buy' }), 'invalid_action'],
      ['action inconnue', valid({ action: 'SHORT' }), 'invalid_action'],
      ['score absent', valid({ score: undefined }), 'invalid_score'],
      ['score négatif', valid({ score: -0.01 }), 'invalid_score'],
      ['score supérieur à 1', valid({ score: 1.01 }), 'invalid_score'],
      ['score en chaîne', valid({ score: '0.8' }), 'invalid_score'],
      ['score nul (null)', valid({ score: null }), 'invalid_score'],
      ['prix en nombre', valid({ price: 81700.5 }), 'invalid_price'],
      ['prix nul', valid({ price: '0' }), 'invalid_price'],
      ['prix négatif', valid({ price: '-5' }), 'invalid_price'],
      [
        'prix en notation scientifique',
        valid({ price: '1e5' }),
        'invalid_price',
      ],
      ['prix non numérique', valid({ price: 'cher' }), 'invalid_price'],
      [
        'justification trop longue',
        valid({ reason: 'x'.repeat(501) }),
        'invalid_reason',
      ],
      ['justification non textuelle', valid({ reason: 42 }), 'invalid_reason'],
      [
        'indicateurs en tableau',
        valid({ indicators: [1, 2] }),
        'invalid_indicators',
      ],
      [
        'indicateurs en chaîne',
        valid({ indicators: 'rsi=41' }),
        'invalid_indicators',
      ],
      [
        'indicateurs trop gros',
        valid({ indicators: { k: 'x'.repeat(2048) } }),
        'invalid_indicators',
      ],
    ])('refuse : %s', (_name, message, expected) => {
      expect(reason(message)).toBe(expected);
    });

    it('refuse un instant trop loin dans le futur (60 s de tolérance d’horloge)', () => {
      expect(reason(valid({ ts: '2026-10-24T08:01:30Z' }))).toBeNull(); // +60 s : toléré
      expect(reason(valid({ ts: '2026-10-24T08:01:31Z' }))).toBe(
        'ts_in_future',
      ); // +61 s
    });

    it('ne refuse pas un vieux signal : c’est le traitement qui l’ignore (péremption)', () => {
      expect(parse(valid({ ts: '2020-01-01T00:00:00Z' })).ok).toBe(true);
    });

    it.each([
      ['champ data absent', {}, 'missing_data'],
      ['champ data vide', { data: '' }, 'missing_data'],
      ['autre nom de champ', { payload: '{}' }, 'missing_data'],
      ['JSON illisible', { data: '{pas du json' }, 'invalid_json'],
      ['JSON tronqué', { data: '{"v":1,"id":"a"' }, 'invalid_json'],
      ['tableau JSON', { data: '[1,2,3]' }, 'not_an_object'],
      ['valeur JSON simple', { data: '42' }, 'not_an_object'],
      ['null JSON', { data: 'null' }, 'not_an_object'],
    ] as [string, Record<string, string>, InvalidSignalReason][])(
      'refuse : %s',
      (_name, fields, expected) => {
        const result = parseSignal(fields, NOW);
        expect(result.ok ? null : result.reason).toBe(expected);
      },
    );

    it('refuse un message de plus de 8 Ko, mesuré en octets', () => {
      const big = JSON.stringify(valid({ reason: 'x'.repeat(10_000) }));
      expect(parseSignal({ data: big }, NOW)).toEqual({
        ok: false,
        reason: 'too_large',
      });

      // 8 Ko en octets, pas en caractères : un texte multi-octets dépasse avant 8 192 caractères.
      const multibyte = JSON.stringify({
        filler: 'é'.repeat(MAX_MESSAGE_BYTES / 2),
      });
      expect(multibyte.length).toBeLessThan(MAX_MESSAGE_BYTES + 100);
      expect(parseSignal({ data: multibyte }, NOW)).toEqual({
        ok: false,
        reason: 'too_large',
      });
    });

    it('un id d’attaque (injection) est refusé', () => {
      for (const id of [
        'a;DROP TABLE',
        'a\nb',
        '<script>',
        '../../x',
        'a'.repeat(1000),
      ]) {
        expect(reason(valid({ id }))).toBe('invalid_id');
      }
    });
  });
});
