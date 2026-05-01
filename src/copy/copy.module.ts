import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CopyService } from './copy.service';
import { CopyController } from './copy.controller';
import { AccountsModule } from 'src/accounts/accounts.module';
import { BillingModule } from 'src/billing/billing.module';
import { CopyProcessor } from './copy.processor';
import { CopyRequest } from './copy-request.entity';

@Module({
  imports: [
    AccountsModule,
    BillingModule,
    TypeOrmModule.forFeature([CopyRequest]),
    BullModule.registerQueue({
      name: 'copy-queue',
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 1000,
        attempts: 1,
      },
      limiter: {
        max: 1,
        duration: 300,
      },
    }),
  ],
  providers: [CopyService, CopyProcessor],
  controllers: [CopyController],
})
export class CopyModule {}
