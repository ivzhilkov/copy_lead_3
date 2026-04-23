import { Module } from '@nestjs/common';
import { CopyService } from './copy.service';
import { CopyController } from './copy.controller';
import { AccountsModule } from 'src/accounts/accounts.module';
import { BillingModule } from 'src/billing/billing.module';

@Module({
  imports: [AccountsModule, BillingModule],
  providers: [CopyService],
  controllers: [CopyController],
})
export class CopyModule {}
