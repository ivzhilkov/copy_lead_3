import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('/public/install')
  async installPing(
    @Body('account_id') accountIdRaw: string | number,
    @Body('widget_code') widgetCode: string,
    @Body('profile') profile: any,
  ) {
    return this.billingService.trackInstall({
      accountId: Number(accountIdRaw),
      widgetCode,
      profile,
    });
  }

  @Get('/public/status')
  async getPublicStatus(
    @Query('account_id') accountIdRaw: string | number,
    @Query('widget_code') widgetCode: string,
  ) {
    return this.billingService.getPublicStatus(Number(accountIdRaw), widgetCode);
  }

  @Post('/public/activate-trial')
  async activateTrial(
    @Body('account_id') accountIdRaw: string | number,
    @Body('widget_code') widgetCode: string,
    @Body('client_email') clientEmail: string,
    @Body('client_phone') clientPhone: string,
    @Body('profile') profile: any,
  ) {
    return this.billingService.activateTrial({
      accountId: Number(accountIdRaw),
      widgetCode,
      clientEmail,
      clientPhone,
      profile,
    });
  }

  @Post('/public/request-payment')
  async requestPayment(
    @Body('account_id') accountIdRaw: string | number,
    @Body('widget_code') widgetCode: string,
    @Body('source') source: 'settings' | 'manual_copy' | 'unknown',
    @Body('profile') profile: any,
  ) {
    return this.billingService.requestPayment({
      accountId: Number(accountIdRaw),
      widgetCode,
      source,
      profile,
    });
  }

  @Get('/admin/panel')
  @Header('Content-Type', 'text/html; charset=utf-8')
  adminPanel() {
    return this.billingService.getAdminPanelHtml();
  }

  @Get('/admin/accounts')
  async getAdminAccounts(@Req() req: Request) {
    this.billingService.ensureAdminTokenOrThrow(String(req.headers['x-admin-token'] || ''));
    return this.billingService.getAdminAccounts();
  }

  @Post('/admin/account/:amoId/extend')
  async extendByDays(
    @Req() req: Request,
    @Param('amoId') amoIdRaw: string,
    @Body('days') daysRaw: string | number,
  ) {
    this.billingService.ensureAdminTokenOrThrow(String(req.headers['x-admin-token'] || ''));
    return this.billingService.extendByDays(Number(amoIdRaw), Number(daysRaw));
  }
}
