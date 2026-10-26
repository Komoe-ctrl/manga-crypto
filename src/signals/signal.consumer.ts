import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SignalHandler } from './signal.handler.js';
import { parseSignal } from './signal.schema.js';
import { SignalStream, type SignalEntry } from './signal-stream.js';

/** Messages lus par passage. */
export const BATCH_SIZE = 10;
/** Attente maximale d'un nouveau message avant de revérifier l'arrêt et les messages en attente. */
export const BLOCK_MS = 5_000;
/** Un message livré mais jamais acquitté est repris après ce délai (plantage du consommateur, signal à retenter). */
export const STALE_MS = 60_000;
/** Après ce nombre de livraisons sans succès, le message part dans `signals:dead`. */
export const MAX_DELIVERIES = 5;
/** Pause après une erreur Redis, avant de réessayer. */
const ERROR_BACKOFF_MS = 2_000;
/** Pause après un passage qui n'a rien traité (négligeable face au BLOCK de 5 s, mais empêche toute boucle active). */
const IDLE_PAUSE_MS = 50;

/**
 * Consomme le stream `signals` : un message à la fois, acquitté **après** traitement (au moins une fois ; la
 * déduplication du `SignalHandler` rend un retraitement inoffensif).
 * - message invalide : `signals:dead` immédiatement, sans nouvel essai ;
 * - traitement à retenter (prix indisponible, erreur) : reste en attente, repris après `STALE_MS` ;
 * - `MAX_DELIVERIES` essais sans succès : `signals:dead`.
 */
@Injectable()
export class SignalConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SignalConsumer.name);
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly stream: SignalStream,
    private readonly handler: SignalHandler,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.stream.close();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  /** Un passage : reprend les messages restés en attente, puis lit les nouveaux. Renvoie le nombre de messages traités. */
  async tick(blockMs: number = BLOCK_MS): Promise<number> {
    const stale = await this.stream.claimStale(STALE_MS, BATCH_SIZE);
    // Des messages à reprendre : on ne bloque pas en attendant les nouveaux.
    const fresh = await this.stream.readNew(
      BATCH_SIZE,
      stale.length > 0 ? 0 : blockMs,
    );
    const entries = [...stale, ...fresh];
    for (const entry of entries) await this.processEntry(entry);
    return entries.length;
  }

  async processEntry(entry: SignalEntry): Promise<void> {
    const parsed = parseSignal(entry.fields);
    if (!parsed.ok) {
      this.logger.warn(`Message ${entry.id} refusé : ${parsed.reason}`);
      await this.stream.deadLetter(entry, parsed.reason);
      await this.stream.ack(entry.id);
      return;
    }

    try {
      const summary = await this.handler.handle(parsed.signal, entry.id);
      if (!summary.retry) {
        await this.stream.ack(entry.id);
        return;
      }
    } catch (error) {
      // Nom de l'erreur seulement : un message d'erreur peut embarquer des données.
      this.logger.error(
        `Signal ${entry.id} en échec : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
      );
    }

    // À retenter : on ne l'acquitte pas (il sera repris), sauf après trop de livraisons.
    if ((await this.stream.deliveryCount(entry.id)) >= MAX_DELIVERIES) {
      this.logger.error(
        `Signal ${entry.id} abandonné après ${MAX_DELIVERIES} livraisons`,
      );
      await this.stream.deadLetter(entry, 'handler_failed');
      await this.stream.ack(entry.id);
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.stream.ensureGroup();
        while (this.running) {
          // Un passage vide fait une courte pause : si Redis répondait instantanément à vide (BLOCK ignoré, mauvaise
          // configuration), la boucle ne doit jamais tourner à 100 % du processeur.
          if ((await this.tick()) === 0)
            await new Promise((resolve) => setTimeout(resolve, IDLE_PAUSE_MS));
        }
      } catch (error) {
        if (!this.running) return; // arrêt demandé : la connexion coupée fait échouer la lecture en cours
        this.logger.error(
          `Lecture des signaux en erreur : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
        );
        await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
      }
    }
  }
}
