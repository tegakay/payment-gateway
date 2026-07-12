import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  if (process.env['PROCESS_TYPE'] !== 'worker') {
    throw new Error('Worker process requires PROCESS_TYPE=worker');
  }

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });

  app.enableShutdownHooks();

  console.log('BullMQ worker started');
}

bootstrap();
