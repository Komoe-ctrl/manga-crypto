import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/** Hachage des mots de passe : argon2id avec les paramètres par défaut du paquet (conformes aux recommandations OWASP). */
@Injectable()
export class PasswordService {
  /** Hash d'un mot de passe bidon, vérifié quand l'email est inconnu pour que le temps de réponse ne révèle pas l'existence du compte. */
  private readonly dummyHash = argon2.hash('mot-de-passe-factice');

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /** Vérifie le mot de passe ; sans hash (compte inconnu), effectue quand même un calcul et renvoie false. */
  async verify(
    hash: string | null | undefined,
    password: string,
  ): Promise<boolean> {
    if (!hash) {
      await argon2.verify(await this.dummyHash, password);
      return false;
    }
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
