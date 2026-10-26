import type { ConfigService } from '@nestjs/config';
import { chromeSubscription } from '../../../test/support/push-keys.js';
import type { ChannelRecipient } from '../channels/channel-sender.js';
import type { PushSubscriptionService } from './push-subscription.service.js';
import type { PushSubscriptionRecord } from './push-subscription.js';
import { PushSender } from './push.sender.js';
import {
  PushHttpError,
  WebPushClient,
  type PushSendOptions,
} from './web-push.client.js';
import type { VapidConfig } from './push-config.js';

const VAPID = {
  VAPID_PUBLIC_KEY: 'BPublicKeyDeTest',
  VAPID_PRIVATE_KEY: 'cle-privee-de-test',
  VAPID_SUBJECT: 'mailto:admin@example.com',
};

const record = (): PushSubscriptionRecord => ({
  ...chromeSubscription(),
  createdAt: '2026-10-26T08:00:00.000Z',
});

class FakeClient extends WebPushClient {
  calls: {
    subscription: PushSubscriptionRecord;
    payload: string;
    vapid: VapidConfig;
    options: PushSendOptions;
  }[] = [];
  /** Erreur à lever par endpoint (sinon : succès). */
  failures = new Map<string, Error>();

  send(
    subscription: PushSubscriptionRecord,
    payload: string,
    vapid: VapidConfig,
    options: PushSendOptions,
  ): Promise<void> {
    this.calls.push({ subscription, payload, vapid, options });
    const failure = this.failures.get(subscription.endpoint);
    return failure ? Promise.reject(failure) : Promise.resolve();
  }
}

function build(env: Record<string, string> = VAPID) {
  const client = new FakeClient();
  const expired: { userId: string; endpoint: string }[] = [];
  const subscriptions = {
    removeExpired: (userId: string, endpoint: string) => {
      expired.push({ userId, endpoint });
      return Promise.resolve();
    },
  } as unknown as PushSubscriptionService;
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return {
    client,
    expired,
    sender: new PushSender(config, client, subscriptions),
  };
}

const recipient = (
  pushSubscriptions: PushSubscriptionRecord[],
): ChannelRecipient => ({
  userId: 'u1',
  telegramChatId: null,
  email: 'a@example.com',
  pushSubscriptions,
});

const message = {
  title: 'Stop-loss exécuté',
  body: 'BTC vendu à 79 000',
  critical: true,
};

describe('PushSender', () => {
  it('envoie à chaque appareil un message JSON lisible par le service worker', async () => {
    const { sender, client } = build();
    const [a, b] = [record(), record()];

    const result = await sender.send(message, recipient([a, b]));

    expect(result).toEqual({ channel: 'PUSH', status: 'SENT' });
    expect(client.calls.map((c) => c.subscription.endpoint)).toEqual([
      a.endpoint,
      b.endpoint,
    ]);
    expect(JSON.parse(client.calls[0].payload)).toEqual({
      title: 'Stop-loss exécuté',
      body: 'BTC vendu à 79 000',
      critical: true,
    });
    expect(client.calls[0].vapid).toEqual({
      publicKey: 'BPublicKeyDeTest',
      privateKey: 'cle-privee-de-test',
      subject: 'mailto:admin@example.com',
    });
  });

  it('un message critique est urgent et conservé 24 h ; un autre, 1 h', async () => {
    const { sender, client } = build();
    await sender.send(message, recipient([record()]));
    await sender.send({ ...message, critical: false }, recipient([record()]));

    expect(client.calls[0].options).toEqual({
      ttlSeconds: 86_400,
      urgency: 'high',
    });
    expect(client.calls[1].options).toEqual({
      ttlSeconds: 3_600,
      urgency: 'normal',
    });
  });

  it('borne le titre et le texte pour rester sous la limite du message Push', async () => {
    const { sender, client } = build();
    await sender.send(
      { title: 't'.repeat(500), body: 'b'.repeat(5000), critical: false },
      recipient([record()]),
    );
    const payload = JSON.parse(client.calls[0].payload) as {
      title: string;
      body: string;
    };
    expect(payload.title).toHaveLength(120);
    expect(payload.body).toHaveLength(1000);
  });

  it.each([
    ['sans clés VAPID', {}],
    ['sans clé privée', { ...VAPID, VAPID_PRIVATE_KEY: '' }],
    [
      'avec un sujet invalide',
      { ...VAPID, VAPID_SUBJECT: 'admin@example.com' },
    ],
    ['avec un sujet http', { ...VAPID, VAPID_SUBJECT: 'http://example.com' }],
  ])("%s : push_not_configured, rien n'est envoyé", async (_label, env) => {
    const { sender, client } = build(env as Record<string, string>);
    await expect(sender.send(message, recipient([record()]))).resolves.toEqual({
      channel: 'PUSH',
      status: 'FAILED',
      reason: 'push_not_configured',
    });
    expect(client.calls).toEqual([]);
  });

  it('accepte un sujet https', async () => {
    const { sender } = build({
      ...VAPID,
      VAPID_SUBJECT: 'https://veille.example.com/contact',
    });
    await expect(
      sender.send(message, recipient([record()])),
    ).resolves.toMatchObject({ status: 'SENT' });
  });

  it('sans appareil abonné : push_no_subscription', async () => {
    const { sender, client } = build();
    await expect(sender.send(message, recipient([]))).resolves.toEqual({
      channel: 'PUSH',
      status: 'FAILED',
      reason: 'push_no_subscription',
    });
    expect(client.calls).toEqual([]);
  });

  it.each([404, 410])(
    'un abonnement révoqué (%i) est retiré et signalé',
    async (status) => {
      const { sender, client, expired } = build();
      const dead = record();
      client.failures.set(dead.endpoint, new PushHttpError(status));

      const result = await sender.send(message, recipient([dead]));

      expect(result).toEqual({
        channel: 'PUSH',
        status: 'FAILED',
        reason: 'push_subscription_gone',
      });
      expect(expired).toEqual([{ userId: 'u1', endpoint: dead.endpoint }]);
    },
  );

  it("livré si au moins un appareil répond : un appareil en panne ne rend pas l'alerte échouée", async () => {
    const { sender, client, expired } = build();
    const [dead, broken, ok] = [record(), record(), record()];
    client.failures.set(dead.endpoint, new PushHttpError(410));
    client.failures.set(broken.endpoint, new PushHttpError(500));

    const result = await sender.send(message, recipient([dead, broken, ok]));

    expect(result).toEqual({ channel: 'PUSH', status: 'SENT' });
    expect(expired).toEqual([{ userId: 'u1', endpoint: dead.endpoint }]); // seul l'abonnement révoqué est retiré
  });

  it.each([
    [new PushHttpError(403), 'push_http_403'], // clés VAPID refusées
    [new PushHttpError(413), 'push_http_413'],
    [new PushHttpError(429), 'push_http_429'],
    [new PushHttpError(503), 'push_http_503'],
    [new Error('push_unreachable'), 'push_unreachable'],
  ])('tous les appareils en échec : code court %#', async (error, reason) => {
    const { sender, client, expired } = build();
    const device = record();
    client.failures.set(device.endpoint, error);

    await expect(sender.send(message, recipient([device]))).resolves.toEqual({
      channel: 'PUSH',
      status: 'FAILED',
      reason,
    });
    expect(expired).toEqual([]); // une panne passagère ne retire jamais l'abonnement
  });

  it("ne révèle jamais l'adresse d'un appareil, ses clés ni le texte d'une erreur", async () => {
    const { sender, client } = build();
    const device = record();
    client.failures.set(
      device.endpoint,
      new Error(`connect ECONNREFUSED ${device.endpoint} ${device.auth}`),
    );

    const result = JSON.stringify(
      await sender.send(message, recipient([device])),
    );

    expect(result).not.toContain(device.endpoint);
    expect(result).not.toContain(device.auth);
    expect(result).not.toContain(device.p256dh);
    expect(result).not.toContain('ECONNREFUSED');
  });

  it("un nettoyage en échec ne masque pas le résultat de l'envoi", async () => {
    const client = new FakeClient();
    const dead = record();
    client.failures.set(dead.endpoint, new PushHttpError(410));
    const sender = new PushSender(
      {
        get: (k: string) => VAPID[k as keyof typeof VAPID],
      } as unknown as ConfigService,
      client,
      {
        removeExpired: () => Promise.reject(new Error('base indisponible')),
      } as unknown as PushSubscriptionService,
    );

    await expect(
      sender.send(message, recipient([dead])),
    ).resolves.toMatchObject({
      reason: 'push_subscription_gone',
    });
  });
});
