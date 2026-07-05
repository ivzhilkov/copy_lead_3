import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
} from "@nestjs/common";
import { AccountsService } from "src/accounts/accounts.service";
import { Account } from "src/accounts/account.entity";
import { BillingService } from "src/billing/billing.service";
import { MergeService } from "./merge.service";

@Controller("merge")
export class MergeController {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly billingService: BillingService,
    private readonly mergeService: MergeService
  ) {}

  private async resolvePublicAccount(
    accountIdRaw: string | number,
    widgetCode: string
  ): Promise<Account> {
    const integration =
      await this.accountsService.findIntegrationCredentialsByWidgetCode(
        widgetCode
      );
    if (!integration) {
      throw new ForbiddenException("Неверный код виджета");
    }

    const accountId = Number(accountIdRaw);
    if (!Number.isFinite(accountId)) {
      throw new BadRequestException("Некорректный account_id");
    }

    const account = await this.accountsService.findByAmoId(
      accountId,
      integration.widgetCode
    );
    if (!account) {
      throw new BadRequestException("Аккаунт интеграции не найден");
    }

    this.billingService.ensureCanCopyOrThrow(account);
    return account;
  }

  @Get("/public/search")
  async searchPublic(
    @Query("account_id") accountIdRaw: string | number,
    @Query("widget_code") widgetCode: string,
    @Query("source_lead_id") sourceLeadIdRaw: string | number,
    @Query("q") query: string
  ) {
    const account = await this.resolvePublicAccount(accountIdRaw, widgetCode);
    return this.mergeService.searchLeads(
      account,
      Number(sourceLeadIdRaw),
      query
    );
  }

  @Post("/public/preview")
  async previewPublic(
    @Body("account_id") accountIdRaw: string | number,
    @Body("widget_code") widgetCode: string,
    @Body("source_lead_id") sourceLeadIdRaw: string | number,
    @Body("target_lead_id") targetLeadIdRaw: string | number
  ) {
    const account = await this.resolvePublicAccount(accountIdRaw, widgetCode);
    return this.mergeService.buildPreview(
      account,
      Number(sourceLeadIdRaw),
      Number(targetLeadIdRaw)
    );
  }

  @Post("/public/execute")
  async executePublic(
    @Body("account_id") accountIdRaw: string | number,
    @Body("widget_code") widgetCode: string,
    @Body() body: any
  ) {
    const account = await this.resolvePublicAccount(accountIdRaw, widgetCode);
    return this.mergeService.execute(account, body);
  }

  @Get("/public/history")
  async historyPublic(
    @Query("account_id") accountIdRaw: string | number,
    @Query("widget_code") widgetCode: string,
    @Query("limit") limitRaw: string | number
  ) {
    const account = await this.resolvePublicAccount(accountIdRaw, widgetCode);
    return this.mergeService.getHistory(account, Number(limitRaw));
  }
}
