import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AccountsModule } from "src/accounts/accounts.module";
import { BillingModule } from "src/billing/billing.module";
import { MergeController } from "./merge.controller";
import { MergeHistory } from "./merge-history.entity";
import { MergeService } from "./merge.service";

@Module({
  imports: [
    AccountsModule,
    BillingModule,
    TypeOrmModule.forFeature([MergeHistory]),
  ],
  providers: [MergeService],
  controllers: [MergeController],
})
export class MergeModule {}
