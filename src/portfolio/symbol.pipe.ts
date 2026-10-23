import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';

/** Normalise un symbole d'actif en majuscules et refuse tout ce qui n'est pas 2 à 12 caractères alphanumériques. */
@Injectable()
export class SymbolPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{2,12}$/.test(symbol))
      throw new BadRequestException('symbol invalide');
    return symbol;
  }
}
