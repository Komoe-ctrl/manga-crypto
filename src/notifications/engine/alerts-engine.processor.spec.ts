import type { Queue } from 'bullmq';
import {
  AlertsEngineProcessor,
  AlertsEngineScheduler,
  EVALUATION_INTERVAL_MS,
} from './alerts-engine.processor.js';
import type { AlertEvaluator } from './alert-evaluator.js';

describe('AlertsEngineProcessor', () => {
  it('délègue à l’évaluateur et renvoie son résumé', async () => {
    const summary = {
      evaluated: 3,
      triggered: 1,
      rearmed: 0,
      skipped: 2,
      failed: 0,
    };
    const evaluator = { run: vi.fn(async () => summary) };
    await expect(
      new AlertsEngineProcessor(
        evaluator as unknown as AlertEvaluator,
      ).process(),
    ).resolves.toEqual(summary);
    expect(evaluator.run).toHaveBeenCalledTimes(1);
  });
});

describe('AlertsEngineScheduler', () => {
  it('programme un job répétable toutes les minutes, de façon idempotente (même identifiant)', async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await new AlertsEngineScheduler(queue as unknown as Queue).onModuleInit();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'alerts-evaluation',
      { every: EVALUATION_INTERVAL_MS },
      { name: 'evaluate' },
    );
    expect(EVALUATION_INTERVAL_MS).toBe(60_000);
  });
});
