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
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  providers: [CopyService, CopyProcessor],
  controllers: [CopyController],
})
export class CopyModule {}
