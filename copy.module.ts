import { Module } from '@nestjs/common';
import { CopyService } from './copy.service';
import { CopyController } from './copy.controller';
import { BullModule } from '@nestjs/bull';
import { AccountsModule } from 'src/accounts/accounts.module';
import { CopyProcessor } from './copy.processor';

@Module({
  imports: [
    AccountsModule,
    BullModule.registerQueue({
      name: 'copy-queue',
      limiter: {
        max: 1,
        duration: 1000,
      },
      defaultJobOptions: {
        attempts: 8,
        timeout: 120000,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        // Keep completed jobs until status polling sees them, otherwise
        // frontend can stay at 0% forever if job is removed too early.
        removeOnComplete: false,
        removeOnFail: false,
      },
    }),
  ],
  providers: [CopyService, CopyProcessor],
  controllers: [CopyController],
})
export class CopyModule {}
