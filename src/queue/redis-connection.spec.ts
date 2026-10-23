import { redisOptions } from './redis-connection.js';

describe('redisOptions', () => {
  it('lit hôte, port et base', () => {
    expect(redisOptions('redis://localhost:6379')).toMatchObject({
      host: 'localhost',
      port: 6379,
      db: undefined,
    });
    expect(redisOptions('redis://cache.internal:6380/2')).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      db: 2,
    });
  });

  it('utilise le port par défaut', () => {
    expect(redisOptions('redis://localhost')).toMatchObject({ port: 6379 });
  });

  it('décode les identifiants et active TLS pour rediss://', () => {
    expect(redisOptions('rediss://user:p%40ss@host:6379')).toMatchObject({
      username: 'user',
      password: 'p@ss',
      tls: {},
    });
  });
});
