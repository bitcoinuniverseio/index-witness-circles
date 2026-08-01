import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const HEX64 = /^[0-9a-fA-F]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;

export class CursorPaginationDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @ApiPropertyOptional({ maxLength: 256 })
  @IsOptional()
  @IsString()
  @Matches(CURSOR)
  cursor?: string;
}

export class LineageHistoryQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ maxLength: 256 })
  @IsOptional()
  @IsString()
  @Matches(CURSOR)
  cursor?: string;
}

export class AddressPaginationDto extends CursorPaginationDto {
  @ApiPropertyOptional({ default: 500, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  override limit = 500;
}

export class CirclesQueryDto extends CursorPaginationDto {
  @ApiPropertyOptional({ enum: ['confirmed', 'orphaned'], default: 'confirmed' })
  @IsOptional()
  @IsIn(['confirmed', 'orphaned'])
  status = 'confirmed';

  @ApiPropertyOptional({ minimum: 2, maximum: 16 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(16)
  participantCount?: number;

  @ApiPropertyOptional({ pattern: '^[0-9a-fA-F]{64}$' })
  @IsOptional()
  @Matches(HEX64)
  contextHash?: string;

  @ApiPropertyOptional({ enum: ['recent', 'oldest'], default: 'recent' })
  @IsOptional()
  @IsIn(['recent', 'oldest'])
  sort = 'recent';
}

export class LineagesQueryDto extends CursorPaginationDto {
  @ApiPropertyOptional({ enum: ['active', 'closed'] })
  @IsOptional()
  @IsIn(['active', 'closed'])
  status?: string;

  @ApiPropertyOptional({ pattern: '^[0-9a-fA-F]{64}$' })
  @IsOptional()
  @Matches(HEX64)
  scriptHash?: string;
}

export class GraphQueryDto extends CursorPaginationDto {
  @ApiPropertyOptional({ pattern: '^[0-9a-fA-F]{64}$' })
  @IsOptional()
  @Matches(HEX64)
  txid?: string;

  @ApiPropertyOptional({ pattern: '^[0-9a-fA-F]{64}$' })
  @IsOptional()
  @Matches(HEX64)
  lineageId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 12, default: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  depth = 4;
}

export class MempoolQueryDto extends CursorPaginationDto {
  @ApiPropertyOptional({
    enum: ['active', 'removed', 'evicted', 'replaced', 'conflicted', 'confirmed'],
  })
  @IsOptional()
  @IsIn(['active', 'removed', 'evicted', 'replaced', 'conflicted', 'confirmed'])
  status?: string;

  @ApiPropertyOptional({ enum: ['none', 'valid', 'invalid', 'observed'] })
  @IsOptional()
  @IsIn(['none', 'valid', 'invalid', 'observed'])
  protocolStatus?: string;
}

export class InvalidEventsQueryDto extends CursorPaginationDto {
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  errorCode?: string;

  @ApiPropertyOptional({ enum: ['invalid', 'observed'] })
  @IsOptional()
  @IsIn(['invalid', 'observed'])
  classification?: string;
}

export class TrendingQueryDto {
  @ApiPropertyOptional({ enum: ['24h', '7d', '30d'], default: '24h' })
  @IsOptional()
  @IsIn(['24h', '7d', '30d'])
  window: '24h' | '7d' | '30d' = '24h';

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 100;
}

export class SearchQueryDto extends CursorPaginationDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  q: string;
}

export class FeesQueryDto {
  @ApiPropertyOptional({ minimum: 2, maximum: 16, default: 8 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(16)
  participants = 8;

  @ApiPropertyOptional({ minimum: 1, maximum: 1008, default: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1008)
  targetBlocks = 6;
}

export class ValidateTransactionDto {
  @ApiProperty({ description: 'Complete raw Bitcoin transaction in hexadecimal form' })
  @IsString()
  @MinLength(20)
  @MaxLength(400_000)
  @Matches(/^(?:[0-9a-fA-F]{2})+$/)
  rawHex: string;
}

export class SafetyOutpointDto {
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  txid: string;

  @ApiProperty({ minimum: 0, maximum: 0xffff_ffff })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(0xffff_ffff)
  vout: number;
}

export class SafetyOutpointsDto {
  @ApiProperty({ type: [SafetyOutpointDto], minItems: 1, maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique((item: SafetyOutpointDto) => `${item.txid}:${item.vout}`)
  @ValidateNested({ each: true })
  @Type(() => SafetyOutpointDto)
  outpoints: SafetyOutpointDto[];
}

export class ReindexDto {
  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fromHeight?: number;
}

export class ReindexRangeDto {
  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fromHeight: number;

  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  toHeight: number;
}

export class VerifyCoreDto {
  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fromHeight?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  toHeight?: number;
}

export class AddressPathDto {
  @Transform(({ value }) => String(value))
  @IsString()
  @Length(8, 128)
  address: string;
}
