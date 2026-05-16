import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from 'src/accounts/accounts.module';
import { AdminCredential } from './admin-credential.entity';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({
  imports: [AccountsModule, TypeOrmModule.forFeature([AdminCredential])],
  providers: [BillingService],
  controllers: [BillingController],
  exports: [BillingService],
})
export class BillingModule {}
