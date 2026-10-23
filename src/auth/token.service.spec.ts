import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service.js';

const SECRET = 'x'.repeat(48);
const build = (env: Record<string, string>) =>
  new TokenService(new ConfigService(env), new JwtService());

describe('TokenService', () => {
  const service = build({ JWT_ACCESS_SECRET: SECRET });

  it('signe et vérifie un access token', async () => {
    const token = await service.signAccessToken('user-1');
    await expect(service.verifyAccessToken(token)).resolves.toMatchObject({
      sub: 'user-1',
    });
  });

  it('rejette un token signé avec un autre secret', async () => {
    const other = build({ JWT_ACCESS_SECRET: 'y'.repeat(48) });
    await expect(
      service.verifyAccessToken(await other.signAccessToken('user-1')),
    ).rejects.toThrow();
  });

  it('rejette un token expiré', async () => {
    const short = build({
      JWT_ACCESS_SECRET: SECRET,
      JWT_ACCESS_TTL_SECONDS: '-1',
    });
    await expect(
      service.verifyAccessToken(await short.signAccessToken('user-1')),
    ).rejects.toThrow();
  });

  it('rejette un token non signé (alg none)', async () => {
    const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString(
      'base64url',
    );
    const body = Buffer.from('{"sub":"user-1"}').toString('base64url');
    await expect(
      service.verifyAccessToken(`${header}.${body}.`),
    ).rejects.toThrow();
  });

  it('refuse un secret trop court ou absent', () => {
    expect(() => build({ JWT_ACCESS_SECRET: 'court' })).toThrow();
    expect(() => build({})).toThrow();
  });

  it('génère des refresh tokens uniques de 256 bits, hachés de façon stable', () => {
    const a = service.generateRefreshToken();
    const b = service.generateRefreshToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(service.hashRefreshToken(a)).toBe(service.hashRefreshToken(a));
    expect(service.hashRefreshToken(a)).not.toBe(a);
  });
});
