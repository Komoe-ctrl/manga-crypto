import type { Queue } from 'bullmq';
import {
  DIGEST_CHECK_INTERVAL_MS,
  DigestEngineProcessor,
  DigestEngineScheduler,
} from './digest-engine.processor.js';
import type { DigestGenerator } from './digest.generator.js';

describe('DigestEngineProcessor', () => {
  it('délègue au générateur et renvoie son résumé', async () => {
    const summary = { checked: 4, generated: 1, failed: 0 };
    const generator = { run: vi.fn(async () => summary) };
    await expect(
      new DigestEngineProcessor(
        generator as unknown as DigestGenerator,
      ).process(),
    ).resolves.toEqual(summary);
    expect(generator.run).toHaveBeenCalledTimes(1);
  });
});

describe('DigestEngineScheduler', () => {
  it('programme un job répétable toutes les 5 minutes, de façon idempotente (même identifiant)', async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await new DigestEngineScheduler(queue as unknown as Queue).onModuleInit();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'digest-check',
      { every: DIGEST_CHECK_INTERVAL_MS },
      { name: 'check' },
    );
    expect(DIGEST_CHECK_INTERVAL_MS).toBe(300_000);
  });
});
