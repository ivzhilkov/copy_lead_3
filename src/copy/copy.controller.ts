import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountsService } from 'src/accounts/accounts.service';
import { AuthGuard } from 'src/auth/auth.guard';
import { BillingService } from 'src/billing/billing.service';
import { CopyPayload } from 'src/interfaces/copy-payload.interface';
import { Request } from 'src/types/request';
import { CopyService } from './copy.service';

@Controller('copy')
export class CopyController {
  constructor(
    private copyService: CopyService,
    private accountsService: AccountsService,
    private configService: ConfigService,
    private billingService: BillingService,
  ) {}

  @UseGuards(AuthGuard)
  @Post('/')
  async addToQueue(
    @Body('leadIds') leadIds: number[],
    @Body('payload') payload: CopyPayload,
    @Req() req: Request,
  ) {
    this.billingService.ensureCanCopyOrThrow(req.params.account);

    const requestId = await this.copyService.addToQueue(
      leadIds,
      payload,
      req.params.account,
    );

    return { requestId };
  }

  @UseGuards(AuthGuard)
  @Get('/check')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  check(@Query('requestId') requestId: string, @Req() req: Request) {
    return this.copyService.check(requestId, req.params.account?.amoId);
  }

  @Post('/public')
  async addToQueuePublic(
    @Body('leadIds') leadIds: number[],
    @Body('payload') payload: CopyPayload,
    @Body('account_id') accountIdRaw: string | number,
    @Body('widget_code') widgetCode: string,
  ) {
    if (widgetCode !== this.configService.get('widgetCode')) {
      throw new ForbiddenException('Неверный код виджета');
    }

    const accountId = Number(accountIdRaw);
    if (!Number.isFinite(accountId)) {
      throw new BadRequestException('Некорректный account_id');
    }

    const account = await this.accountsService.findByAmoId(accountId);
    if (!account) {
      throw new BadRequestException('Аккаунт интеграции не найден');
    }

    this.billingService.ensureCanCopyOrThrow(account);

    const requestId = await this.copyService.addToQueue(leadIds, payload, account);
    return { requestId };
  }

  @Get('/public/check')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  checkPublic(
    @Query('requestId') requestId: string,
    @Query('account_id') accountIdRaw: string,
  ) {
    const accountId = Number(accountIdRaw);
    if (!Number.isFinite(accountId)) {
      throw new BadRequestException('Некорректный account_id');
    }

    return this.copyService.check(requestId, accountId);
  }

  @UseGuards(AuthGuard)
  @Post('/dp')
  async dp(
    @Body()
    body: {
      event: { type: string; data: { id: string } };
      action: {
        code: string;
        settings: { widget: { settings: { config: string | CopyPayload } }; widget_info: any };
      };
      account_id: string;
    },
    @Req() req: Request,
  ) {
    const leadId = Number(body?.event?.data?.id);
    if (!Number.isFinite(leadId)) {
      throw new BadRequestException('Некорректный ID сделки в событии');
    }

    const rawConfig = body?.action?.settings?.widget?.settings?.config;
    if (!rawConfig) {
      throw new BadRequestException('Не переданы настройки виджета в Digital Pipeline');
    }

    let payload: CopyPayload;
    try {
      payload =
        typeof rawConfig === 'string'
          ? (JSON.parse(rawConfig) as CopyPayload)
          : (rawConfig as CopyPayload);
    } catch (e) {
      throw new BadRequestException('Некорректный JSON настроек Digital Pipeline');
    }

    if (!this.billingService.canCopy(req.params.account)) {
      return {
        skipped: true,
        reason: 'billing_expired',
      };
    }

    const requestId = await this.copyService.addToQueue(
      [leadId],
      payload,
      req.params.account,
    );

    return { requestId };
  }
}
