import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { DigestPeriod } from '../../generated/prisma/enums.js';

export class DigestDto {
  @ApiProperty() id: string;

  @ApiProperty({
    enum: [DigestPeriod.TODAY, DigestPeriod.WEEK],
    description:
      'TODAY : rapport du matin (24 h), un par jour ; WEEK : rapport des 7 jours, le lundi. « Hier » est le rapport TODAY de la veille.',
  })
  period: DigestPeriod;

  @ApiProperty() periodStart: Date;
  @ApiProperty() periodEnd: Date;
  @ApiProperty({ description: 'Synthèse en une ou deux phrases' })
  summary: string;
  @ApiProperty({
    type: [String],
    description: 'Points clés affichés sous la synthèse',
  })
  points: string[];

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Variation du portefeuille sur la période, en % (chaîne décimale)',
    example: '1.2',
  })
  portfolioDeltaPct: string | null;

  @ApiProperty({
    description:
      'Alertes non urgentes mises en attente par le Mode Nuit et reprises dans ce rapport',
  })
  queuedAlertsCount: number;

  @ApiProperty({ nullable: true, type: Date }) readAt: Date | null;
  @ApiProperty() generatedAt: Date;
}

export class DigestListDto {
  @ApiProperty({ type: [DigestDto] }) items: DigestDto[];
  @ApiProperty() unreadCount: number;
}

export class ListDigestsQuery {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Pagination : rapports générés avant cette date (ISO 8601)',
  })
  @IsOptional()
  @IsISO8601()
  before?: string;

  @ApiPropertyOptional({ enum: [DigestPeriod.TODAY, DigestPeriod.WEEK] })
  @IsOptional()
  @IsEnum(DigestPeriod)
  period?: DigestPeriod;
}
