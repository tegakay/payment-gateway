import { ApiProperty } from '@nestjs/swagger';

export class ApiKeySummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() keyPrefix!: string;
  @ApiProperty({ type: [String] }) scopes!: string[];
  @ApiProperty({ nullable: true }) lastUsedAt!: Date | null;
  @ApiProperty({ nullable: true }) revokedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class ApiKeyCreatedDto extends ApiKeySummaryDto {
  @ApiProperty({ description: 'Raw API key — shown exactly once, never persisted in plaintext' })
  key!: string;

  @ApiProperty({ example: true })
  shownOnce!: true;
}

export class ApiKeyRotatedDto extends ApiKeyCreatedDto {
  @ApiProperty({ description: 'The previous key remains valid until this timestamp (grace window)' })
  previousKeyGraceExpiresAt!: Date;
}
