import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from 'src/auth/auth.module';
import { Account } from './account.entity';
import { AccountsService } from './accounts.service';
import { CrmClient } from './crm-client.entity';
import { WidgetIntegration } from './widget-integration.entity';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    TypeOrmModule.forFeature([Account, CrmClient, WidgetIntegration]),
  ],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
