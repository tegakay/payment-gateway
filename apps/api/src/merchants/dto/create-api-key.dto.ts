import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn } from 'class-validator';
import { API_KEY_SCOPES, ApiKeyScope } from '@libs/common';

export class CreateApiKeyDto {
  @ApiProperty({ enum: API_KEY_SCOPES, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(API_KEY_SCOPES, { each: true })
  scopes!: ApiKeyScope[];
}
