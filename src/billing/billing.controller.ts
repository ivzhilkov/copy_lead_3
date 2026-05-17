import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  private async ensureAdmin(req: Request) {
    await this.billingService.ensureAdminAccessOrThrow(
      String(req.headers['x-admin-token'] || ''),
      String(req.headers['x-admin-session'] || ''),
    );
  }

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

  @Post('/public/copy-attempt')
  async copyAttempt(
    @Body('account_id') accountIdRaw: string | number,
    @Body('widget_code') widgetCode: string,
    @Body('profile') profile: any,
  ) {
    return this.billingService.trackCopyAttempt({
      accountId: Number(accountIdRaw),
      widgetCode,
      profile,
    });
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

  @Post('/public/invoice')
  async createInvoice(
    @Body('account_id') accountIdRaw: string | number,
    @Body('widget_code') widgetCode: string,
    @Body('inn') inn: string,
    @Body('email') email: string,
    @Body('phone') phone: string,
    @Body('legal_name') legalName: string,
    @Body('source') source: 'settings' | 'manual_copy' | 'unknown',
    @Body('profile') profile: any,
    @Res() res: Response,
  ) {
    const result = await this.billingService.createInvoicePdf({
      accountId: Number(accountIdRaw),
      widgetCode,
      inn,
      email,
      phone,
      legalName,
      source,
      profile,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    res.send(result.buffer);
  }

  @Get('/admin/panel')
  @Header('Content-Type', 'text/html; charset=utf-8')
  adminPanel() {
    return this.billingService.getAdminPanelHtml();
  }

  @Post('/admin/login')
  async adminLogin(
    @Body() body: {
      login?: string;
      password?: string;
    },
  ) {
    return this.billingService.loginAdmin(body);
  }

  @Get('/admin/setup-status')
  async adminSetupStatus() {
    return this.billingService.getAdminSetupStatus();
  }

  @Post('/admin/setup')
  async adminSetup(
    @Body() body: {
      login?: string;
      password?: string;
    },
  ) {
    return this.billingService.setupAdminPassword(body);
  }

  @Get('/admin/accounts')
  async getAdminAccounts(@Req() req: Request) {
    await this.ensureAdmin(req);
    return this.billingService.getAdminAccounts();
  }

  @Get('/admin/integrations')
  async getAdminIntegrations(@Req() req: Request) {
    await this.ensureAdmin(req);
    return this.billingService.getAdminIntegrations();
  }

  @Get('/admin/widget/:accountId/amo-info')
  async getAdminAmoWidgetInfo(
    @Req() req: Request,
    @Param('accountId') accountIdRaw: string,
  ) {
    await this.ensureAdmin(req);
    return this.billingService.getAdminAmoWidgetInfo(Number(accountIdRaw));
  }

  @Post('/admin/integrations')
  async saveAdminIntegration(
    @Req() req: Request,
    @Body() body: {
      widgetName?: string;
      widgetSlug?: string;
      widgetCode?: string;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      amoDomain?: string;
    },
  ) {
    await this.ensureAdmin(req);
    return this.billingService.saveAdminIntegration(body);
  }

  @Delete('/admin/integrations/:widgetCode')
  async deleteAdminIntegration(
    @Req() req: Request,
    @Param('widgetCode') widgetCode: string,
  ) {
    await this.ensureAdmin(req);
    return this.billingService.deleteAdminIntegration(widgetCode);
  }

  @Delete('/admin/clients/:amoIdOrDomain/installations')
  async deleteAdminClientInstallations(
    @Req() req: Request,
    @Param('amoIdOrDomain') amoIdOrDomain: string,
  ) {
    await this.ensureAdmin(req);
    return this.billingService.deleteAdminClientInstallations(amoIdOrDomain);
  }

  @Get('/admin/test-telegram')
  async testTelegram(@Req() req: Request) {
    await this.ensureAdmin(req);
    return this.billingService.sendTestTelegramMessage();
  }

  @Get('/admin/invoice/:invoiceNumber/pdf')
  async getAdminInvoicePdf(
    @Req() req: Request,
    @Param('invoiceNumber') invoiceNumber: string,
    @Res() res: Response,
  ) {
    await this.ensureAdmin(req);
    const result = await this.billingService.getAdminInvoicePdf(invoiceNumber);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    res.send(result.buffer);
  }

  @Post('/admin/account/:amoId/extend')
  async extendByDays(
    @Req() req: Request,
    @Param('amoId') amoIdRaw: string,
    @Body('days') daysRaw: string | number,
  ) {
    await this.ensureAdmin(req);
    return this.billingService.extendByDays(Number(amoIdRaw), Number(daysRaw));
  }

  @Post('/admin/widget/:accountId/extend')
  async extendWidgetByDays(
    @Req() req: Request,
    @Param('accountId') accountIdRaw: string,
    @Body('days') daysRaw: string | number,
  ) {
    await this.ensureAdmin(req);
    return this.billingService.extendAccountById(
      Number(accountIdRaw),
      Number(daysRaw),
    );
  }

  @Patch('/admin/widget/:accountId/license')
  async updateWidgetLicense(
    @Req() req: Request,
    @Param('accountId') accountIdRaw: string,
    @Body() body: {
      status?: any;
      paidUntil?: string | null;
    },
  ) {
    await this.ensureAdmin(req);
    return this.billingService.updateAdminWidgetLicense(Number(accountIdRaw), body);
  }

  @Delete('/admin/widget/:accountId')
  async deleteWidgetInstallation(
    @Req() req: Request,
    @Param('accountId') accountIdRaw: string,
  ) {
    await this.ensureAdmin(req);
    return this.billingService.deleteAdminWidgetInstallation(Number(accountIdRaw));
  }
}
