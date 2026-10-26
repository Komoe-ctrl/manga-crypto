import {
  RealtimeBus,
  toRiskEvent,
  type RealtimeEvent,
} from './realtime-events.js';

const event: RealtimeEvent = {
  type: 'risk',
  data: {
    tradingMode: 'PAPER',
    killSwitchActive: true,
    botPausedUntil: null,
    canTrade: false,
    blockedReason: 'KILL_SWITCH',
  },
};

describe('RealtimeBus', () => {
  it('transmet l’événement et l’utilisateur à chaque abonné', () => {
    const bus = new RealtimeBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    bus.publish('u1', event);

    expect(a).toHaveBeenCalledWith('u1', event);
    expect(b).toHaveBeenCalledWith('u1', event);
  });

  it('ne lève jamais d’erreur et n’empêche pas les autres abonnés de recevoir', () => {
    const bus = new RealtimeBus();
    const after = vi.fn();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(after);

    expect(() => bus.publish('u1', event)).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
  });

  it('cesse de transmettre après désabonnement', () => {
    const bus = new RealtimeBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();

    bus.publish('u1', event);

    expect(listener).not.toHaveBeenCalled();
  });

  it('accepte une publication sans abonné', () => {
    expect(() => new RealtimeBus().publish('u1', event)).not.toThrow();
  });
});

describe('toRiskEvent', () => {
  it('ne garde que les champs de l’état du robot destinés au front', () => {
    const status = {
      ...event.data,
      tradingModeChangedAt: new Date(),
      killSwitchAt: new Date(),
    };
    expect(toRiskEvent(status as typeof event.data)).toEqual(event.data);
  });
});
