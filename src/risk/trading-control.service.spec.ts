import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { LIVE_CONFIRMATION } from './dto/risk.dto.js';
import { RiskSettingsService } from './risk-settings.service.js';
import { TradingControlService } from './trading-control.service.js';

const PASSWORD = 'un-mot-de-passe-solide';
const live = { password: PASSWORD, confirmation: LIVE_CONFIRMATION };

async function build() {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const passwords = new PasswordService();
  const audit = new AuditService(asPrisma);
  const user = await prisma.user.create({
    data: {
      email: 'a@example.com',
      passwordHash: await passwords.hash(PASSWORD),
    },
    select: { id: true },
  });
  const verifiedExchange = (over: Record<string, unknown> = {}) =>
    prisma.exchangeConfigs.push({
      id: 'ex-1',
      userId: user.id,
      status: 'ACTIVE',
      sandbox: false,
      verifiedAt: new Date(),
      ...over,
    });
  return {
    prisma,
    userId: user.id as string,
    verifiedExchange,
    control: new TradingControlService(asPrisma, passwords, audit),
    settings: new RiskSettingsService(asPrisma, audit),
  };
}

describe('TradingControlService', () => {
  describe('status', () => {
    it('autorise le robot par défaut, en mode PAPER', async () => {
      const { control, userId } = await build();
      await expect(control.status(userId)).resolves.toMatchObject({
        tradingMode: 'PAPER',
        canTrade: true,
        blockedReason: null,
      });
    });

    it('bloque pendant une pause pour perte journalière, puis relâche', async () => {
      const { control, prisma, userId } = await build();
      prisma.users[0].botPausedUntil = new Date(Date.now() + 60_000);
      await expect(control.status(userId)).resolves.toMatchObject({
        canTrade: false,
        blockedReason: 'PAUSED_DAILY_LOSS',
      });
      prisma.users[0].botPausedUntil = new Date(Date.now() - 1000);
      await expect(control.status(userId)).resolves.toMatchObject({
        canTrade: true,
      });
    });
  });

  describe('kill switch', () => {
    it('arrête le robot et audite', async () => {
      const { control, prisma, userId } = await build();
      const status = await control.activateKillSwitch(userId, {
        ipAddress: '1.2.3.4',
      });
      expect(status).toMatchObject({
        killSwitchActive: true,
        canTrade: false,
        blockedReason: 'KILL_SWITCH',
      });
      expect(status.killSwitchAt).toBeInstanceOf(Date);
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'kill_switch.activated',
        ipAddress: '1.2.3.4',
      });
    });

    it('est idempotent : pas de second audit', async () => {
      const { control, prisma, userId } = await build();
      await control.activateKillSwitch(userId, {});
      await control.activateKillSwitch(userId, {});
      expect(
        prisma.auditLogs.filter((l) => l.action === 'kill_switch.activated'),
      ).toHaveLength(1);
    });

    it('se désactive et audite', async () => {
      const { control, prisma, userId } = await build();
      await control.activateKillSwitch(userId, {});
      await expect(
        control.deactivateKillSwitch(userId, {}),
      ).resolves.toMatchObject({ canTrade: true });
      expect(prisma.auditLogs.at(-1)?.action).toBe('kill_switch.deactivated');
    });
  });

  describe('passage en LIVE', () => {
    it('réussit avec le bon mot de passe et une configuration vérifiée, et audite', async () => {
      const { control, prisma, userId, verifiedExchange } = await build();
      verifiedExchange();
      const status = await control.switchToLive(userId, live, {});
      expect(status.tradingMode).toBe('LIVE');
      expect(status.tradingModeChangedAt).toBeInstanceOf(Date);
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'mode.live_enabled',
        metadata: { exchangeConfigId: 'ex-1' },
      });
    });

    it('refuse un mauvais mot de passe (403, pas 401) et audite sans le journaliser', async () => {
      const { control, prisma, userId, verifiedExchange } = await build();
      verifiedExchange();
      await expect(
        control.switchToLive(
          userId,
          { ...live, password: 'mauvais-mot-de-passe' },
          {},
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.users[0].tradingMode).toBe('PAPER');
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'mode.live_denied',
        metadata: { reason: 'bad_password' },
      });
      expect(JSON.stringify(prisma.auditLogs)).not.toContain(
        'mauvais-mot-de-passe',
      );
    });

    it.each([
      ['aucune configuration', null],
      ['configuration testnet', { sandbox: true }],
      ['configuration non vérifiée', { verifiedAt: null }],
      ['configuration désactivée', { status: 'DISABLED' }],
      ['configuration rejetée', { status: 'REJECTED' }],
    ])('refuse sans échange éligible : %s', async (_name, exchange) => {
      const { control, prisma, userId, verifiedExchange } = await build();
      if (exchange) verifiedExchange(exchange);
      await expect(control.switchToLive(userId, live, {})).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prisma.users[0].tradingMode).toBe('PAPER');
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        metadata: { reason: 'no_verified_exchange' },
      });
    });

    it('refuse tant que le kill switch est actif', async () => {
      const { control, prisma, userId, verifiedExchange } = await build();
      verifiedExchange();
      await control.activateKillSwitch(userId, {});
      await expect(control.switchToLive(userId, live, {})).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        metadata: { reason: 'kill_switch' },
      });
    });

    it('est idempotent quand le mode est déjà LIVE', async () => {
      const { control, prisma, userId, verifiedExchange } = await build();
      verifiedExchange();
      await control.switchToLive(userId, live, {});
      await control.switchToLive(userId, live, {});
      expect(
        prisma.auditLogs.filter((l) => l.action === 'mode.live_enabled'),
      ).toHaveLength(1);
    });
  });

  describe('retour en PAPER', () => {
    it('est immédiat et audité, même avec le kill switch actif', async () => {
      const { control, prisma, userId, verifiedExchange } = await build();
      verifiedExchange();
      await control.switchToLive(userId, live, {});
      await control.activateKillSwitch(userId, {});
      await expect(control.switchToPaper(userId, {})).resolves.toMatchObject({
        tradingMode: 'PAPER',
      });
      expect(prisma.auditLogs.at(-1)?.action).toBe('mode.paper_enabled');
    });
  });
});

describe('RiskSettingsService', () => {
  it('renvoie les valeurs par défaut en nombres', async () => {
    const { settings, userId } = await build();
    await expect(settings.get(userId)).resolves.toEqual({
      maxExposurePct: 5,
      maxDailyLossPct: 3,
      defaultStopLossPct: 3,
      defaultTakeProfitPct: 6,
    });
  });

  it("met à jour les champs fournis et audite l'ancienne et la nouvelle valeur", async () => {
    const { settings, prisma, userId } = await build();
    const updated = await settings.update(
      userId,
      { maxExposurePct: 2.5, defaultStopLossPct: 4 },
      {},
    );
    expect(updated).toMatchObject({
      maxExposurePct: 2.5,
      defaultStopLossPct: 4,
      maxDailyLossPct: 3,
    });
    expect(prisma.auditLogs.at(-1)).toMatchObject({
      action: 'risk.settings_updated',
      metadata: {
        changes: {
          maxExposurePct: { from: 5, to: 2.5 },
          defaultStopLossPct: { from: 3, to: 4 },
        },
      },
    });
  });

  it("n'audite rien quand rien ne change", async () => {
    const { settings, prisma, userId } = await build();
    await settings.update(userId, { maxExposurePct: 5 }, {});
    await settings.update(userId, {}, {});
    expect(prisma.auditLogs).toHaveLength(0);
  });
});
