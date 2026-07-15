import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '@libs/prisma';
import { QUEUE_NAMES } from '@libs/common';

interface RevokeApiKeyJobData {
  apiKeyId: string;
}

@Processor(QUEUE_NAMES.API_KEY_REVOCATION)
@Injectable()
export class ApiKeyRevocationProcessor extends WorkerHost {
  private readonly logger = new Logger(ApiKeyRevocationProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<RevokeApiKeyJobData>): Promise<void> {
    const { apiKeyId } = job.data;
    const result = await this.prisma.apiKey.updateMany({
      where: { id: apiKeyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      this.logger.log(`Revoked API key ${apiKeyId} after rotation grace period`);
    }
  }
}
