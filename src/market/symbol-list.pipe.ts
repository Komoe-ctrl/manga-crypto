import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';

export const MAX_SYMBOLS = 25;

/** « btc, eth » → `['BTC', 'ETH']` : sans doublon, 1 à 25 symboles de 2 à 12 caractères alphanumériques. */
@Injectable()
export class SymbolListPipe implements PipeTransform<unknown, string[]> {
  transform(value: unknown): string[] {
    const symbols = [
      ...new Set(
        (typeof value === 'string' ? value : '')
          .split(',')
          .map((part) => part.trim().toUpperCase())
          .filter((part) => part !== ''),
      ),
    ];
    if (symbols.length === 0 || symbols.length > MAX_SYMBOLS)
      throw new BadRequestException(
        `symbols : entre 1 et ${MAX_SYMBOLS} symboles séparés par des virgules`,
      );
    if (!symbols.every((symbol) => /^[A-Z0-9]{2,12}$/.test(symbol)))
      throw new BadRequestException('symbols contient un symbole invalide');
    return symbols;
  }
}
