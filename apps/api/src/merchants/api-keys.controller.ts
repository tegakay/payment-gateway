import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard';
import { CurrentMerchant, CurrentMerchantPayload } from '../auth/decorators/current-merchant.decorator';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { ApiKeyCreatedDto, ApiKeyRotatedDto, ApiKeySummaryDto } from './dto/api-key.dto';

@ApiTags('Merchants')
@ApiBearerAuth('jwt')
@UseGuards(JwtAccessGuard)
@Controller('merchants/me/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new API key; the raw key is shown exactly once' })
  create(
    @CurrentMerchant() merchant: CurrentMerchantPayload,
    @Body() dto: CreateApiKeyDto,
  ): Promise<ApiKeyCreatedDto> {
    return this.apiKeysService.create(merchant.id, dto.scopes);
  }

  @Get()
  @ApiOperation({ summary: 'List API keys for the current merchant (never returns key material)' })
  list(@CurrentMerchant() merchant: CurrentMerchantPayload): Promise<ApiKeySummaryDto[]> {
    return this.apiKeysService.list(merchant.id);
  }

  @Post(':id/rotate')
  @ApiOperation({ summary: 'Issue a replacement key; the old key stays valid for a grace window' })
  rotate(
    @CurrentMerchant() merchant: CurrentMerchantPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiKeyRotatedDto> {
    return this.apiKeysService.rotate(merchant.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Immediately hard-revoke an API key' })
  async revoke(
    @CurrentMerchant() merchant: CurrentMerchantPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.apiKeysService.revoke(merchant.id, id);
  }
}
