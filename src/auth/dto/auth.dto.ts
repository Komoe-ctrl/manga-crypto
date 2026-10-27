import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const TIMEZONES = [...Intl.supportedValuesOf('timeZone'), 'UTC'];

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty({ example: 'client@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** 12 caractères minimum ; 128 maximum pour borner le coût du hachage. */
  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @ApiPropertyOptional({
    example: 'Europe/Paris',
    description: 'Fuseau IANA (Mode Nuit, digest)',
  })
  @IsOptional()
  @IsIn(TIMEZONES)
  timezone?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'client@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}

export class UserProfileDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty({ nullable: true, type: String }) displayName: string | null;
  @ApiProperty() timezone: string;
  @ApiProperty() baseCurrency: string;
  @ApiProperty({ enum: ['PAPER', 'LIVE'] }) tradingMode: string;
  @ApiProperty() killSwitchActive: boolean;
}

export class AuthResponseDto {
  @ApiProperty({ description: 'JWT à envoyer en `Authorization: Bearer`' })
  accessToken: string;

  @ApiProperty({
    description: "Durée de validité de l'access token, en secondes",
  })
  expiresIn: number;

  @ApiProperty({ type: UserProfileDto })
  user: UserProfileDto;
}
