import { ApiProperty } from '@nestjs/swagger';
import { MerchantStatus } from '@prisma/client';

export class MerchantProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() businessName!: string;
  @ApiProperty({ enum: MerchantStatus }) status!: MerchantStatus;
  @ApiProperty() createdAt!: Date;
}

export class TokenPairDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: 'Bearer';
  @ApiProperty({ description: 'Access token TTL in seconds' }) expiresIn!: number;
}
