import { ConfigService } from '@nestjs/config';
import { TelegramSender } from './telegram.sender.js';

const TOKEN = '123456:SECRET-bot-token';
const message = { title: 'Titre', body: 'Corps', critical: false };
const recipient = { telegramChatId: '987654', email: 'a@example.com' };
const sender = (env: Record<string, string> = { TELEGRAM_BOT_TOKEN: TOKEN }) =>
  new TelegramSender(new ConfigService(env));

const reply = (status = 200) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('{}', { status }));

describe('TelegramSender', () => {
  afterEach(() => vi.restoreAllMocks());

  it('envoie le message à la conversation', async () => {
    const spy = reply();
    await expect(sender().send(message, recipient)).resolves.toEqual({
      channel: 'TELEGRAM',
      status: 'SENT',
    });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: '987654',
      text: 'Titre\n\nCorps',
      disable_web_page_preview: true,
    });
  });

  it('préfixe un message critique', async () => {
    const spy = reply();
    await sender().send({ ...message, critical: true }, recipient);
    const body = JSON.parse(
      (spy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.text).toMatch(/^\[Critique\] Titre/);
  });

  it('tronque à la limite de Telegram (4096 caractères)', async () => {
    const spy = reply();
    await sender().send({ ...message, body: 'x'.repeat(10_000) }, recipient);
    const body = JSON.parse(
      (spy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.text).toHaveLength(4096);
  });

  it('échoue proprement sans jeton ou sans conversation, sans appeler Telegram', async () => {
    const spy = reply();
    await expect(sender({}).send(message, recipient)).resolves.toMatchObject({
      status: 'FAILED',
      reason: 'telegram_not_configured',
    });
    await expect(
      sender().send(message, { ...recipient, telegramChatId: null }),
    ).resolves.toMatchObject({ status: 'FAILED', reason: 'telegram_no_chat' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('traduit une erreur HTTP en code court', async () => {
    reply(401);
    await expect(sender().send(message, recipient)).resolves.toEqual({
      channel: 'TELEGRAM',
      status: 'FAILED',
      reason: 'telegram_http_401',
    });
  });

  it("ne laisse jamais le jeton dans un résultat, même si le réseau lève une erreur contenant l'URL", async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError(
        `fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`,
      ),
    );
    const result = await sender().send(message, recipient);
    expect(result).toEqual({
      channel: 'TELEGRAM',
      status: 'FAILED',
      reason: 'telegram_unreachable',
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});
