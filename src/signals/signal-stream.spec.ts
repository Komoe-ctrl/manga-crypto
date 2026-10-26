import type { Redis } from 'ioredis';
import { RedisSignalStream } from './signal-stream.js';

/** Faux client ioredis : enregistre les appels et rejoue des réponses. */
function fakeRedis(over: Record<string, unknown> = {}) {
  const redis = {
    xgroup: vi.fn(async () => 'OK'),
    call: vi.fn(async (): Promise<unknown> => null),
    xautoclaim: vi.fn(async (): Promise<unknown> => ['0-0', [], []]),
    xpending: vi.fn(async (): Promise<unknown> => []),
    xack: vi.fn(async () => 1),
    xadd: vi.fn(async () => '1-0'),
    disconnect: vi.fn(),
    ...over,
  };
  return { redis, stream: new RedisSignalStream(redis as unknown as Redis) };
}

describe('RedisSignalStream', () => {
  describe('ensureGroup', () => {
    it('crée le groupe depuis le début du stream, en créant le stream au besoin', async () => {
      const { redis, stream } = fakeRedis();
      await stream.ensureGroup();
      expect(redis.xgroup).toHaveBeenCalledWith(
        'CREATE',
        'signals',
        'api',
        '0',
        'MKSTREAM',
      );
    });

    it('accepte un groupe déjà existant (BUSYGROUP)', async () => {
      const { stream } = fakeRedis({
        xgroup: vi.fn(async () => {
          throw new Error('BUSYGROUP Consumer Group name already exists');
        }),
      });
      await expect(stream.ensureGroup()).resolves.toBeUndefined();
    });

    it('propage les autres erreurs', async () => {
      const { stream } = fakeRedis({
        xgroup: vi.fn(async () => {
          throw new Error('NOAUTH Authentication required');
        }),
      });
      await expect(stream.ensureGroup()).rejects.toThrow('NOAUTH');
    });
  });

  describe('readNew', () => {
    it('lit avec BLOCK et convertit les champs plats en objet', async () => {
      const { redis, stream } = fakeRedis({
        call: vi.fn(async () => [
          [
            'signals',
            [
              ['1729-0', ['data', '{"v":1}']],
              ['1729-1', ['data', '{"v":2}', 'extra', 'x']],
            ],
          ],
        ]),
      });

      const entries = await stream.readNew(10, 5000);

      expect(entries).toEqual([
        { id: '1729-0', fields: { data: '{"v":1}' } },
        { id: '1729-1', fields: { data: '{"v":2}', extra: 'x' } },
      ]);
      const args = redis.call.mock.calls[0] as unknown as (string | number)[];
      expect(args[0]).toBe('XREADGROUP');
      expect(args.slice(1, 3)).toEqual(['GROUP', 'api']);
      expect(args[3]).toMatch(/^api-.+-\d+$/); // consommateur : machine et processus
      expect(args.slice(4)).toEqual([
        'COUNT',
        10,
        'BLOCK',
        5000,
        'STREAMS',
        'signals',
        '>',
      ]);
    });

    it('lit la réponse RESP3 (ioredis 6 négocie RESP3 : `call` aplatit la table en [flux, entrées])', async () => {
      // Forme réellement observée sur Redis 8 avec ioredis 6.
      const { stream } = fakeRedis({
        call: vi.fn(async () => [
          'signals',
          [
            ['1793001993240-0', ['data', '{"v":1}']],
            ['1793001993242-0', ['data', '{"v":2}']],
          ],
        ]),
      });
      await expect(stream.readNew(10, 5000)).resolves.toEqual([
        { id: '1793001993240-0', fields: { data: '{"v":1}' } },
        { id: '1793001993242-0', fields: { data: '{"v":2}' } },
      ]);
    });

    it('lit une réponse RESP3 à plusieurs flux et une réponse vide', async () => {
      const { stream } = fakeRedis({
        call: vi.fn(async () => [
          'signals',
          [['1-0', ['data', 'a']]],
          'autre',
          [['2-0', ['data', 'b']]],
        ]),
      });
      expect((await stream.readNew(10, 0)).map((e) => e.id)).toEqual([
        '1-0',
        '2-0',
      ]);

      const empty = fakeRedis({ call: vi.fn(async () => []) });
      await expect(empty.stream.readNew(10, 0)).resolves.toEqual([]);
    });

    it('ne plante pas sur une réponse inattendue', async () => {
      for (const reply of [
        {},
        'OK',
        42,
        [null],
        ['signals', null],
        ['signals', 'pas un tableau'],
      ]) {
        const { stream } = fakeRedis({ call: vi.fn(async () => reply) });
        await expect(stream.readNew(10, 0)).resolves.toEqual([]);
      }
    });

    it('ne bloque pas quand blockMs vaut 0 (BLOCK 0 attendrait indéfiniment sous Redis)', async () => {
      const { redis, stream } = fakeRedis();
      await stream.readNew(10, 0);
      const args = redis.call.mock.calls[0] as unknown as (string | number)[];
      expect(args).not.toContain('BLOCK');
      expect(args.slice(4)).toEqual(['COUNT', 10, 'STREAMS', 'signals', '>']);
    });

    it('renvoie une liste vide quand rien n’est arrivé', async () => {
      const { stream } = fakeRedis({ call: vi.fn(async () => null) });
      await expect(stream.readNew(10, 100)).resolves.toEqual([]);
    });
  });

  describe('claimStale', () => {
    it('reprend les messages restés en attente et ignore ceux qui ont été supprimés du stream', async () => {
      const { redis, stream } = fakeRedis({
        xautoclaim: vi.fn(async () => [
          '0-0',
          [
            ['1-0', ['data', 'a']],
            ['2-0', null],
          ],
          ['2-0'],
        ]),
      });

      const entries = await stream.claimStale(60_000, 10);

      expect(entries).toEqual([{ id: '1-0', fields: { data: 'a' } }]);
      expect(redis.xautoclaim).toHaveBeenCalledWith(
        'signals',
        'api',
        expect.stringMatching(/^api-/),
        60_000,
        '0-0',
        'COUNT',
        10,
      );
    });
  });

  describe('deliveryCount / ack / deadLetter / close', () => {
    it('lit le nombre de livraisons d’un message', async () => {
      const { redis, stream } = fakeRedis({
        xpending: vi.fn(async () => [['1-0', 'api-x-1', 61_000, 3]]),
      });
      await expect(stream.deliveryCount('1-0')).resolves.toBe(3);
      expect(redis.xpending).toHaveBeenCalledWith(
        'signals',
        'api',
        '1-0',
        '1-0',
        1,
      );
    });

    it('renvoie 0 pour un message qui n’est pas en attente', async () => {
      const { stream } = fakeRedis();
      await expect(stream.deliveryCount('9-0')).resolves.toBe(0);
    });

    it('acquitte', async () => {
      const { redis, stream } = fakeRedis();
      await stream.ack('1-0');
      expect(redis.xack).toHaveBeenCalledWith('signals', 'api', '1-0');
    });

    it('copie un message refusé dans signals:dead avec son motif, en bornant la taille', async () => {
      const { redis, stream } = fakeRedis();
      await stream.deadLetter(
        { id: '1-0', fields: { data: 'x'.repeat(10_000) } },
        'invalid_json',
      );

      const args = redis.xadd.mock.calls[0] as unknown as (string | number)[];
      expect(args.slice(0, 5)).toEqual([
        'signals:dead',
        'MAXLEN',
        '~',
        1000,
        '*',
      ]);
      expect(args.slice(5, 9)).toEqual([
        'reason',
        'invalid_json',
        'entry',
        '1-0',
      ]);
      expect(args[9]).toBe('raw');
      expect((args[10] as string).length).toBe(2048);
    });

    it('coupe la connexion au lieu d’attendre un BLOCK en cours', async () => {
      const { redis, stream } = fakeRedis();
      await stream.close();
      expect(redis.disconnect).toHaveBeenCalled();
    });
  });
});
