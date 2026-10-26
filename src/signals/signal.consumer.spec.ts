import {
  BATCH_SIZE,
  MAX_DELIVERIES,
  SignalConsumer,
  STALE_MS,
} from './signal.consumer.js';
import type { SignalHandler, SignalSummary } from './signal.handler.js';
import { SignalStream, type SignalEntry } from './signal-stream.js';

/** Stream en mémoire : mêmes garanties que Redis (livraison, attente, reprise), sans réseau. */
class FakeStream extends SignalStream {
  fresh: SignalEntry[] = [];
  stale: SignalEntry[] = [];
  deliveries = new Map<string, number>();
  acked: string[] = [];
  dead: { id: string; reason: string }[] = [];
  readCalls: { count: number; blockMs: number }[] = [];
  claimCalls: { minIdleMs: number; count: number }[] = [];
  ensureGroupCalls = 0;
  ensureGroupError: Error | null = null;
  closed = false;
  /** Quand renseigné, `readNew` attend ce délai (simule le BLOCK) puis renvoie les messages. */
  readDelayMs = 0;

  async ensureGroup() {
    this.ensureGroupCalls++;
    if (this.ensureGroupError) {
      const error = this.ensureGroupError;
      this.ensureGroupError = null;
      throw error;
    }
  }
  async readNew(count: number, blockMs: number) {
    this.readCalls.push({ count, blockMs });
    if (this.closed) throw new Error('connexion fermée');
    if (this.readDelayMs)
      await new Promise((r) => setTimeout(r, this.readDelayMs));
    const batch = this.fresh.splice(0, count);
    batch.forEach((e) =>
      this.deliveries.set(e.id, (this.deliveries.get(e.id) ?? 0) + 1),
    );
    return batch;
  }
  async claimStale(minIdleMs: number, count: number) {
    this.claimCalls.push({ minIdleMs, count });
    const batch = this.stale.splice(0, count);
    batch.forEach((e) =>
      this.deliveries.set(e.id, (this.deliveries.get(e.id) ?? 0) + 1),
    );
    return batch;
  }
  async deliveryCount(entryId: string) {
    return this.deliveries.get(entryId) ?? 0;
  }
  async ack(entryId: string) {
    this.acked.push(entryId);
  }
  async deadLetter(entry: SignalEntry, reason: string) {
    this.dead.push({ id: entry.id, reason });
  }
  async close() {
    this.closed = true;
  }
}

const data = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    id: 'sig-1',
    ts: new Date().toISOString(),
    symbol: 'BTC',
    action: 'BUY',
    score: 0.8,
    ...over,
  });
const entry = (
  id: string,
  fields: Record<string, string> = { data: data({ id }) },
): SignalEntry => ({ id, fields });

const summary = (over: Partial<SignalSummary> = {}): SignalSummary => ({
  ignored: null,
  users: 1,
  outcomes: { submitted: 1 },
  failed: 0,
  retry: false,
  ...over,
});

function build(
  handle: (...args: never[]) => Promise<SignalSummary> = async () => summary(),
) {
  const stream = new FakeStream();
  const handler = { handle: vi.fn(handle) };
  return {
    stream,
    handler,
    consumer: new SignalConsumer(stream, handler as unknown as SignalHandler),
  };
}

describe('SignalConsumer', () => {
  describe('traitement d’un message', () => {
    it('traite un message valide puis l’acquitte', async () => {
      const { stream, handler, consumer } = build();
      await consumer.processEntry(entry('1-0'));

      expect(handler.handle).toHaveBeenCalledTimes(1);
      expect(handler.handle.mock.calls[0]).toMatchObject([
        { id: '1-0', symbol: 'BTC', action: 'BUY' },
        '1-0',
      ]);
      expect(stream.acked).toEqual(['1-0']);
      expect(stream.dead).toEqual([]);
    });

    it('acquitte aussi un signal ignoré (HOLD, périmé…) : il n’y a rien à retenter', async () => {
      const { stream, consumer } = build(async () =>
        summary({ ignored: 'hold', users: 0, outcomes: {} }),
      );
      await consumer.processEntry(entry('1-0'));
      expect(stream.acked).toEqual(['1-0']);
    });

    it.each([
      ['champ data absent', {}, 'missing_data'],
      ['JSON illisible', { data: '{oups' }, 'invalid_json'],
      ['version inconnue', { data: data({ v: 2 }) }, 'unsupported_version'],
      ['score hors limites', { data: data({ score: 3 }) }, 'invalid_score'],
    ])(
      'message invalide (%s) : signals:dead sans nouvel essai, puis acquitté',
      async (_name, fields, reason) => {
        const { stream, handler, consumer } = build();
        await consumer.processEntry({
          id: '2-0',
          fields: fields as Record<string, string>,
        });

        expect(handler.handle).not.toHaveBeenCalled();
        expect(stream.dead).toEqual([{ id: '2-0', reason }]);
        expect(stream.acked).toEqual(['2-0']); // pas de boucle infinie sur un message corrompu
      },
    );

    it('un traitement à retenter reste en attente (non acquitté), sans signals:dead', async () => {
      const { stream, consumer } = build(async () => summary({ retry: true }));
      stream.deliveries.set('3-0', 1);
      await consumer.processEntry(entry('3-0'));
      expect(stream.acked).toEqual([]);
      expect(stream.dead).toEqual([]);
    });

    it('une erreur du traitement reste en attente aussi', async () => {
      const { stream, consumer } = build(async () => {
        throw new Error('boom');
      });
      stream.deliveries.set('4-0', 2);
      await consumer.processEntry(entry('4-0'));
      expect(stream.acked).toEqual([]);
    });

    it(`après ${MAX_DELIVERIES} livraisons sans succès : signals:dead puis acquitté`, async () => {
      const { stream, consumer } = build(async () => summary({ retry: true }));
      stream.deliveries.set('5-0', MAX_DELIVERIES - 1);
      await consumer.processEntry(entry('5-0'));
      expect(stream.acked).toEqual([]); // 4 livraisons : encore un essai

      stream.deliveries.set('5-0', MAX_DELIVERIES);
      await consumer.processEntry(entry('5-0'));
      expect(stream.dead).toEqual([{ id: '5-0', reason: 'handler_failed' }]);
      expect(stream.acked).toEqual(['5-0']);
    });

    it('une erreur inattendue n’abandonne le message qu’au dernier essai', async () => {
      const { stream, consumer } = build(async () => {
        throw new Error('boom');
      });
      stream.deliveries.set('6-0', MAX_DELIVERIES);
      await consumer.processEntry(entry('6-0'));
      expect(stream.dead).toEqual([{ id: '6-0', reason: 'handler_failed' }]);
    });
  });

  describe('passage (tick)', () => {
    it('reprend d’abord les messages en attente, puis lit les nouveaux, et traite tout', async () => {
      const { stream, handler, consumer } = build();
      stream.stale = [entry('old-1')];
      stream.fresh = [entry('new-1'), entry('new-2')];

      expect(await consumer.tick(5000)).toBe(3);

      expect(stream.claimCalls).toEqual([
        { minIdleMs: STALE_MS, count: BATCH_SIZE },
      ]);
      expect(
        handler.handle.mock.calls.map(
          (c) => (c as unknown as [unknown, string])[1],
        ),
      ).toEqual(['old-1', 'new-1', 'new-2']);
      expect(stream.acked).toEqual(['old-1', 'new-1', 'new-2']);
    });

    it('bloque en attendant de nouveaux messages, sauf s’il y avait des messages à reprendre', async () => {
      const { stream, consumer } = build();
      await consumer.tick(5000);
      expect(stream.readCalls).toEqual([{ count: BATCH_SIZE, blockMs: 5000 }]);

      stream.stale = [entry('old-1')];
      await consumer.tick(5000);
      expect(stream.readCalls[1]).toEqual({ count: BATCH_SIZE, blockMs: 0 });
    });

    it('un message invalide n’empêche pas le suivant', async () => {
      const { stream, handler, consumer } = build();
      stream.fresh = [
        { id: '1-0', fields: { data: 'illisible' } },
        entry('2-0'),
      ];
      await consumer.tick(0);
      expect(stream.dead.map((d) => d.id)).toEqual(['1-0']);
      expect(handler.handle).toHaveBeenCalledTimes(1);
      expect(stream.acked).toEqual(['1-0', '2-0']);
    });

    it('renvoie 0 quand il n’y a rien', async () => {
      const { consumer } = build();
      expect(await consumer.tick(0)).toBe(0);
    });
  });

  describe('cycle de vie', () => {
    it('crée le groupe, traite les messages, et s’arrête proprement (connexion coupée, boucle terminée)', async () => {
      const { stream, handler, consumer } = build();
      stream.readDelayMs = 5;
      stream.fresh = [entry('1-0')];

      consumer.onModuleInit();
      await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledTimes(1));
      expect(stream.ensureGroupCalls).toBe(1);

      await consumer.onModuleDestroy();
      expect(stream.closed).toBe(true);
      const callsAfterStop = stream.readCalls.length;
      await new Promise((r) => setTimeout(r, 30));
      expect(stream.readCalls.length).toBe(callsAfterStop); // plus aucune lecture
    });

    it('démarrer deux fois ne lance qu’une boucle', async () => {
      const { stream, consumer } = build();
      stream.readDelayMs = 5;
      consumer.start();
      consumer.start();
      await vi.waitFor(() =>
        expect(stream.readCalls.length).toBeGreaterThan(0),
      );
      await consumer.stop();
      expect(stream.ensureGroupCalls).toBe(1);
    });

    it('une erreur Redis fait réessayer après une pause, sans arrêter le consommateur', async () => {
      vi.useFakeTimers();
      try {
        const { stream, handler, consumer } = build();
        stream.ensureGroupError = new Error('Redis indisponible');
        stream.fresh = [entry('1-0')];
        stream.readDelayMs = 0;

        consumer.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(stream.ensureGroupCalls).toBe(1);
        expect(handler.handle).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2_100); // pause de 2 s, puis nouvel essai
        expect(stream.ensureGroupCalls).toBe(2);
        expect(handler.handle).toHaveBeenCalledTimes(1);

        // L'arrêt attend la fin de la boucle, qui dort sur une horloge simulée : on la fait avancer pendant l'arrêt.
        const stopping = consumer.stop();
        await vi.advanceTimersByTimeAsync(3_000);
        await stopping;
        expect(stream.closed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
