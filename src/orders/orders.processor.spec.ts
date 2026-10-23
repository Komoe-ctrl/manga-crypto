import type { Job, Queue } from 'bullmq';
import { ExitMonitor } from './exit-monitor.js';
import { OrderExecutor } from './order-executor.js';
import {
  BullOrderDispatcher,
  EXITS_CHECK_INTERVAL_MS,
  ORDER_JOB_OPTIONS,
  OrderExitsProcessor,
  OrderExitsScheduler,
  OrdersProcessor,
  type OrderJobData,
} from './orders.processor.js';

const job = (attemptsMade: number, attempts = 5): Job<OrderJobData> =>
  ({
    data: { tradeLogId: 'order-1' },
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job<OrderJobData>;

describe('BullOrderDispatcher', () => {
  it('met l’ordre en file avec son identifiant comme jobId, 5 essais et un délai exponentiel', async () => {
    const queue = { add: vi.fn(async () => undefined) };
    await new BullOrderDispatcher(
      queue as unknown as Queue<OrderJobData>,
    ).dispatch('order-1');
    expect(queue.add).toHaveBeenCalledWith(
      'execute',
      { tradeLogId: 'order-1' },
      { ...ORDER_JOB_OPTIONS, jobId: 'order-1' },
    );
    expect(ORDER_JOB_OPTIONS).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  });
});

describe('OrdersProcessor', () => {
  const build = () => {
    const executor = {
      execute: vi.fn(async () => undefined),
      giveUp: vi.fn(async () => undefined),
    };
    return {
      executor,
      processor: new OrdersProcessor(executor as unknown as OrderExecutor),
    };
  };

  it('exécute l’ordre de la tâche', async () => {
    const { processor, executor } = build();
    await processor.process(job(0));
    expect(executor.execute).toHaveBeenCalledWith('order-1');
  });

  it('laisse remonter une erreur transitoire pour que BullMQ réessaie', async () => {
    const { processor, executor } = build();
    executor.execute.mockRejectedValueOnce(new Error('réessayer'));
    await expect(processor.process(job(0))).rejects.toThrow('réessayer');
  });

  it('n’abandonne l’ordre qu’au dernier essai', async () => {
    const { processor, executor } = build();
    await processor.onFailed(job(1));
    await processor.onFailed(job(4));
    expect(executor.giveUp).not.toHaveBeenCalled();

    await processor.onFailed(job(5));
    expect(executor.giveUp).toHaveBeenCalledWith('order-1');
  });

  it('ignore un échec sans tâche', async () => {
    const { processor, executor } = build();
    await processor.onFailed(undefined);
    expect(executor.giveUp).not.toHaveBeenCalled();
  });
});

describe('surveillance des sorties', () => {
  it('le processeur délègue à la surveillance et renvoie son résumé', async () => {
    const summary = { watched: 3, triggered: 1, blocked: 0, failed: 0 };
    const monitor = { run: vi.fn(async () => summary) };
    await expect(
      new OrderExitsProcessor(monitor as unknown as ExitMonitor).process(),
    ).resolves.toEqual(summary);
  });

  it('le planificateur programme un job répétable toutes les minutes, de façon idempotente', async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await new OrderExitsScheduler(queue as unknown as Queue).onModuleInit();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'order-exits-check',
      { every: EXITS_CHECK_INTERVAL_MS },
      { name: 'check' },
    );
    expect(EXITS_CHECK_INTERVAL_MS).toBe(60_000);
  });
});
