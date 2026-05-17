import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { Account } from 'src/accounts/account.entity';
import { AccountsService } from 'src/accounts/accounts.service';
import { normalizeAmoDomain } from 'src/helpers/amo-domain';
import { Repository } from 'typeorm';
import { AdminCredential } from './admin-credential.entity';
import { BillingInvoice } from './billing-invoice.entity';

export type LicenseState =
  | 'not_activated'
  | 'legacy_not_activated'
  | 'trial'
  | 'paid'
  | 'grace'
  | 'paid_expired'
  | 'expired';

export type PublicProfilePayload = {
  domain?: string;
  email?: string;
  phone?: string;
  userName?: string;
  userId?: number;
  usersCount?: number;
  isAmoAdmin?: boolean;
  userRank?: string;
};

type InstallPayload = {
  accountId: number;
  widgetCode: string;
  profile?: PublicProfilePayload;
};

type CopyAttemptPayload = {
  accountId: number;
  widgetCode: string;
  profile?: PublicProfilePayload;
};

type ActivateTrialPayload = {
  accountId: number;
  widgetCode: string;
  clientEmail?: string;
  clientPhone?: string;
  profile?: PublicProfilePayload;
};

type RequestPaymentPayload = {
  accountId: number;
  widgetCode: string;
  source?: 'settings' | 'manual_copy' | 'unknown';
  profile?: PublicProfilePayload;
};

type CreateInvoicePayload = {
  accountId: number;
  widgetCode: string;
  inn?: string;
  email?: string;
  phone?: string;
  legalName?: string;
  source?: 'settings' | 'manual_copy' | 'unknown';
  profile?: PublicProfilePayload;
};

type LookupCompanyPayload = {
  accountId: number;
  widgetCode: string;
  inn?: string;
  profile?: PublicProfilePayload;
};

type AdminLoginPayload = {
  login?: string;
  password?: string;
};

type AdminSetupPayload = {
  login?: string;
  password?: string;
};

type LicenseView = {
  state: LicenseState;
  title: string;
  message: string;
  expiresAt: string | null;
  isExpired: boolean;
  canCopy: boolean;
  trialActivated: boolean;
  trialEndsAt: string | null;
  paidUntil: string | null;
  graceExtendedUntil: string | null;
  graceExtensionUsed: boolean;
  isLegacy: boolean;
  firstSeenSource: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  billingInn: string | null;
  billingLegalName: string | null;
  billingOgrn: string | null;
  latestInvoiceNumber: string | null;
  latestInvoiceStatus: string | null;
  latestInvoiceCreatedAt: string | null;
  latestInvoicePaidAt: string | null;
};

type PaidLicensesCacheEntry = {
  value: number | null;
  expiresAt: number;
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly paidLicensesCache = new Map<number, PaidLicensesCacheEntry>();

  constructor(
    private readonly accountsService: AccountsService,
    private readonly configService: ConfigService,
    @InjectRepository(AdminCredential)
    private readonly adminCredentialRepo: Repository<AdminCredential>,
    @InjectRepository(BillingInvoice)
    private readonly invoiceRepo: Repository<BillingInvoice>,
  ) {}

  private getNow() {
    return new Date();
  }

  private getMskTimestamp(date = new Date()) {
    return `${new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date)} (МСК)`;
  }

  private safeString(value: unknown) {
    const normalized = String(value || '').trim();
    return normalized || '-';
  }

  private toIso(value?: Date | string | null) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString();
  }

  private serializeProfile(profile?: PublicProfilePayload) {
    return {
      domain: this.safeString(profile?.domain),
      email: this.safeString(profile?.email),
      phone: this.safeString(profile?.phone),
      userName: this.safeString(profile?.userName),
      userId: Number.isFinite(Number(profile?.userId))
        ? Number(profile?.userId)
        : null,
      usersCount: Number.isFinite(Number(profile?.usersCount))
        ? Number(profile?.usersCount)
        : 0,
      isAmoAdmin: this.toBoolean(profile?.isAmoAdmin),
      userRank: this.safeString(profile?.userRank),
    };
  }

  private toBoolean(value: unknown) {
    if (value === true) return true;
    if (value === false) return false;
    const normalized = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'admin'].includes(normalized);
  }

  private getAdminLogin() {
    return String(this.configService.get<string>('adminLogin') || 'admin').trim();
  }

  private getAdminPassword() {
    return String(
      this.configService.get<string>('adminPassword') ||
        this.configService.get<string>('adminToken') ||
        '',
    ).trim();
  }

  private getAdminSessionSecret() {
    return String(
      this.configService.get<string>('adminToken') ||
        this.configService.get<string>('adminPassword') ||
        '',
    ).trim();
  }

  private getAdminSessionToken(login: string, secret: string) {
    const normalizedLogin = String(login || '').trim();
    const hash = createHash('sha256')
      .update(`${normalizedLogin}:${secret}:${this.getAdminSessionSecret()}`)
      .digest('hex');
    return `${normalizedLogin}.${hash}`;
  }

  private hashAdminPassword(password: string, salt: string) {
    return scryptSync(password, salt, 64).toString('hex');
  }

  private verifyAdminPassword(password: string, salt: string, hash: string) {
    const incoming = Buffer.from(this.hashAdminPassword(password, salt), 'hex');
    const saved = Buffer.from(hash, 'hex');
    return incoming.length === saved.length && timingSafeEqual(incoming, saved);
  }

  private async getStoredAdminCredential() {
    return this.adminCredentialRepo.findOne({
      order: { id: 'DESC' },
    } as any);
  }

  async getAdminSetupStatus() {
    const credential = await this.getStoredAdminCredential();
    return {
      needsSetup: !credential,
      login: credential?.login || this.getAdminLogin(),
    };
  }

  async setupAdminPassword(payload: AdminSetupPayload) {
    const existing = await this.getStoredAdminCredential();
    if (existing) {
      throw new ForbiddenException('Пароль администратора уже задан');
    }

    const login = String(payload?.login || this.getAdminLogin() || 'admin').trim();
    const password = String(payload?.password || '').trim();
    if (!login) {
      throw new BadRequestException('Введите логин');
    }
    if (password.length < 8) {
      throw new BadRequestException('Пароль должен быть не короче 8 символов');
    }

    const salt = randomBytes(16).toString('hex');
    const saved = await this.adminCredentialRepo.save({
      login,
      salt,
      passwordHash: this.hashAdminPassword(password, salt),
    });

    return {
      session: this.getAdminSessionToken(saved.login, saved.passwordHash),
      login: saved.login,
    };
  }

  async loginAdmin(payload: AdminLoginPayload) {
    const stored = await this.getStoredAdminCredential();
    if (stored) {
      const login = String(payload?.login || '').trim();
      const password = String(payload?.password || '').trim();
      if (
        login !== stored.login ||
        !this.verifyAdminPassword(password, stored.salt, stored.passwordHash)
      ) {
        throw new UnauthorizedException('Неверный логин или пароль');
      }

      return {
        session: this.getAdminSessionToken(stored.login, stored.passwordHash),
        login: stored.login,
      };
    }

    const expectedLogin = this.getAdminLogin();
    const expectedPassword = this.getAdminPassword();
    if (!expectedPassword) {
      throw new UnauthorizedException('Сначала задайте пароль администратора');
    }

    const login = String(payload?.login || '').trim();
    const password = String(payload?.password || '').trim();
    if (login !== expectedLogin || password !== expectedPassword) {
      throw new UnauthorizedException('Неверный логин или пароль');
    }

    return {
      session: this.getAdminSessionToken(login, expectedPassword),
      login,
    };
  }

  private calculateState(account: Account) {
    const now = this.getNow().getTime();
    const paidUntil = account?.paidUntil
      ? new Date(account.paidUntil).getTime()
      : null;
    const trialEndsAt = account?.trialEndsAt
      ? new Date(account.trialEndsAt).getTime()
      : null;
    const graceExtendedUntil = account?.graceExtendedUntil
      ? new Date(account.graceExtendedUntil).getTime()
      : null;

    if (paidUntil && paidUntil > now) {
      return {
        state: 'paid' as LicenseState,
        expiresAt: account.paidUntil,
      };
    }

    if (paidUntil && paidUntil <= now) {
      return {
        state: 'paid_expired' as LicenseState,
        expiresAt: null,
      };
    }

    if (trialEndsAt && trialEndsAt > now) {
      return {
        state: 'trial' as LicenseState,
        expiresAt: account.trialEndsAt,
      };
    }

    if (graceExtendedUntil && graceExtendedUntil > now) {
      return {
        state: 'grace' as LicenseState,
        expiresAt: account.graceExtendedUntil,
      };
    }

    if (account?.trialActivatedAt || account?.trialEndsAt || account?.graceExtensionUsed) {
      return {
        state: 'expired' as LicenseState,
        expiresAt: null,
      };
    }

    return {
      state: account?.isLegacy
        ? ('legacy_not_activated' as LicenseState)
        : ('not_activated' as LicenseState),
      expiresAt: null,
    };
  }

  private toPublicLicenseView(account: Account): LicenseView {
    const { state, expiresAt } = this.calculateState(account);
    const contact = this.getPublicLicenseContact(account);

    if (state === 'paid') {
      return {
        state,
        title: 'Активная подписка',
        message: `Виджет оплачен до ${this.getMskTimestamp(new Date(expiresAt))}`,
        expiresAt: this.toIso(expiresAt),
        isExpired: false,
        canCopy: true,
        trialActivated: Boolean(account?.trialActivatedAt),
        trialEndsAt: this.toIso(account?.trialEndsAt),
        paidUntil: this.toIso(account?.paidUntil),
        graceExtendedUntil: this.toIso(account?.graceExtendedUntil),
        graceExtensionUsed: Boolean(account?.graceExtensionUsed),
        isLegacy: Boolean(account?.isLegacy),
        firstSeenSource: account?.firstSeenSource || null,
        ...contact,
      };
    }

    if (state === 'trial') {
      return {
        state,
        title: 'Пробный период',
        message: `Пробный период активен до ${this.getMskTimestamp(new Date(expiresAt))}`,
        expiresAt: this.toIso(expiresAt),
        isExpired: false,
        canCopy: true,
        trialActivated: true,
        trialEndsAt: this.toIso(account?.trialEndsAt),
        paidUntil: this.toIso(account?.paidUntil),
        graceExtendedUntil: this.toIso(account?.graceExtendedUntil),
        graceExtensionUsed: Boolean(account?.graceExtensionUsed),
        isLegacy: Boolean(account?.isLegacy),
        firstSeenSource: account?.firstSeenSource || null,
        ...contact,
      };
    }

    if (state === 'grace') {
      return {
        state,
        title: 'Продление на 1 день',
        message: `Виджет временно продлен до ${this.getMskTimestamp(new Date(expiresAt))}`,
        expiresAt: this.toIso(expiresAt),
        isExpired: false,
        canCopy: true,
        trialActivated: Boolean(account?.trialActivatedAt),
        trialEndsAt: this.toIso(account?.trialEndsAt),
        paidUntil: this.toIso(account?.paidUntil),
        graceExtendedUntil: this.toIso(account?.graceExtendedUntil),
        graceExtensionUsed: Boolean(account?.graceExtensionUsed),
        isLegacy: Boolean(account?.isLegacy),
        firstSeenSource: account?.firstSeenSource || null,
        ...contact,
      };
    }

    if (state === 'paid_expired') {
      return {
        state,
        title: 'Платный период закончился',
        message: 'Платный период закончился. Администратор аккаунта может продлить доступ в разделе оплаты.',
        expiresAt: null,
        isExpired: true,
        canCopy: false,
        trialActivated: Boolean(account?.trialActivatedAt),
        trialEndsAt: this.toIso(account?.trialEndsAt),
        paidUntil: this.toIso(account?.paidUntil),
        graceExtendedUntil: this.toIso(account?.graceExtendedUntil),
        graceExtensionUsed: Boolean(account?.graceExtensionUsed),
        isLegacy: Boolean(account?.isLegacy),
        firstSeenSource: account?.firstSeenSource || null,
        ...contact,
      };
    }

    if (state === 'expired') {
      return {
        state,
        title: 'Пробный период закончился',
        message: 'Пробный период закончился. Администратор аккаунта может запросить оплату или обсудить продление с менеджером.',
        expiresAt: null,
        isExpired: true,
        canCopy: false,
        trialActivated: Boolean(account?.trialActivatedAt),
        trialEndsAt: this.toIso(account?.trialEndsAt),
        paidUntil: this.toIso(account?.paidUntil),
        graceExtendedUntil: this.toIso(account?.graceExtendedUntil),
        graceExtensionUsed: Boolean(account?.graceExtensionUsed),
        isLegacy: Boolean(account?.isLegacy),
        firstSeenSource: account?.firstSeenSource || null,
        ...contact,
      };
    }

    return {
      state,
      title: account?.isLegacy ? 'Виджет обновился' : 'Пробный период не активирован',
      message: account?.isLegacy
        ? 'Мы добавили новые функции и перевели виджет на платную модель. Для текущих пользователей доступен пробный период 7 дней.'
        : 'Администратор аккаунта может активировать пробный период на 7 дней в настройках виджета.',
      expiresAt: null,
      isExpired: true,
      canCopy: false,
      trialActivated: false,
      trialEndsAt: this.toIso(account?.trialEndsAt),
      paidUntil: this.toIso(account?.paidUntil),
      graceExtendedUntil: this.toIso(account?.graceExtendedUntil),
      graceExtensionUsed: Boolean(account?.graceExtensionUsed),
      isLegacy: Boolean(account?.isLegacy),
      firstSeenSource: account?.firstSeenSource || null,
      ...contact,
    };
  }

  private getPublicLicenseContact(account?: Account | null) {
    return {
      clientEmail: account?.trialRequestedEmail || account?.adminEmail || null,
      clientPhone: account?.trialRequestedPhone || account?.adminPhone || null,
      billingInn: account?.billingInn || null,
      billingLegalName: account?.billingLegalName || null,
      billingOgrn: account?.billingOgrn || null,
      latestInvoiceNumber: account?.latestInvoiceNumber || null,
      latestInvoiceStatus: account?.latestInvoiceStatus || null,
      latestInvoiceCreatedAt: this.toIso(account?.latestInvoiceCreatedAt),
      latestInvoicePaidAt: this.toIso(account?.latestInvoicePaidAt),
    };
  }

  private toPendingAccountView(
    client?: { isLegacy?: boolean; firstSeenSource?: string | null },
  ): LicenseView {
    return {
      state: 'not_activated',
      title: 'Требуется авторизация',
      message:
        'Интеграция еще не получила доступ к amoCRM. Завершите установку и откройте настройки виджета.',
      expiresAt: null,
      isExpired: true,
      canCopy: false,
      trialActivated: false,
      trialEndsAt: null,
      paidUntil: null,
      graceExtendedUntil: null,
      graceExtensionUsed: false,
      isLegacy: Boolean(client?.isLegacy),
      firstSeenSource: client?.firstSeenSource || null,
      clientEmail: null,
      clientPhone: null,
      billingInn: null,
      billingLegalName: null,
      billingOgrn: null,
      latestInvoiceNumber: null,
      latestInvoiceStatus: null,
      latestInvoiceCreatedAt: null,
      latestInvoicePaidAt: null,
    };
  }

  private async sendTelegramMessage(text: string) {
    const token = this.configService.get<string>('telegramBotToken');
    const chatId = this.configService.get<string>('telegramChatId');

    if (!token || !chatId) {
      this.logger.warn('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы, сообщение не отправлено');
      return false;
    }

    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
      });
      return true;
    } catch (e) {
      this.logger.error(`Ошибка отправки telegram сообщения: ${(e as Error)?.message || e}`);
      return false;
    }
  }

  private async getIntegrationOrFail(widgetCode: string) {
    const integration =
      await this.accountsService.findIntegrationCredentialsByWidgetCode(
        widgetCode,
      );
    if (!integration) {
      throw new ForbiddenException('Неверный код виджета');
    }

    return integration;
  }

  private async getAccountOrFail(accountId: number, widgetCode?: string) {
    const normalizedAccountId = Number(accountId);
    if (!Number.isFinite(normalizedAccountId) || normalizedAccountId <= 0) {
      throw new BadRequestException('Некорректный account_id');
    }

    const integration = widgetCode
      ? await this.getIntegrationOrFail(widgetCode)
      : null;
    const account = await this.accountsService.findByAmoId(
      normalizedAccountId,
      integration?.widgetCode,
    );
    if (!account) {
      throw new NotFoundException('Аккаунт интеграции не найден');
    }

    return account;
  }

  private async getAccountOrNull(accountId: number, widgetCode: string) {
    const normalizedAccountId = Number(accountId);
    if (!Number.isFinite(normalizedAccountId) || normalizedAccountId <= 0) {
      throw new BadRequestException('Некорректный account_id');
    }

    const integration = await this.getIntegrationOrFail(widgetCode);
    return this.accountsService.findByAmoId(
      normalizedAccountId,
      integration.widgetCode,
    );
  }

  private async upsertPendingClient(
    accountId: number,
    profile?: PublicProfilePayload,
    options?: { isLegacy?: boolean; firstSeenSource?: string },
  ) {
    const normalized = this.serializeProfile(profile);
    const domain = normalizeAmoDomain(
      normalized.domain !== '-' ? normalized.domain : '',
    );

    if (!domain) return null;

    return this.accountsService.upsertClient({
      amoId: Number(accountId),
      domain,
      adminName: normalized.userName !== '-' ? normalized.userName : null,
      adminEmail: normalized.email !== '-' ? normalized.email : null,
      adminPhone: normalized.phone !== '-' ? normalized.phone : null,
      adminUserId: normalized.userId !== null ? normalized.userId : null,
      usersCount: normalized.usersCount > 0 ? normalized.usersCount : 0,
      ...(options?.isLegacy !== undefined ? { isLegacy: options.isLegacy } : {}),
      ...(options?.firstSeenSource ? { firstSeenSource: options.firstSeenSource } : {}),
    });
  }

  private async upsertProfile(account: Account, profile?: PublicProfilePayload) {
    const normalized = this.serializeProfile(profile);
    const normalizedDomain = normalizeAmoDomain(
      normalized.domain !== '-' ? normalized.domain : account.domain,
    );
    const updatePayload: Partial<Account> = {
      domain: normalizedDomain || account.domain,
      adminName: normalized.userName !== '-' ? normalized.userName : account.adminName,
      adminEmail: normalized.email !== '-' ? normalized.email : account.adminEmail,
      adminPhone: normalized.phone !== '-' ? normalized.phone : account.adminPhone,
      adminUserId:
        normalized.userId !== null ? normalized.userId : account.adminUserId,
      usersCount:
        normalized.usersCount > 0 ? normalized.usersCount : account.usersCount || 0,
      lastSeenAt: this.getNow(),
    };

    const saved = await this.accountsService.update(account.id, updatePayload);
    await this.accountsService.upsertClient({
      amoId: saved.amoId,
      domain: saved.domain,
      adminName: saved.adminName,
      adminEmail: saved.adminEmail,
      adminPhone: saved.adminPhone,
      adminUserId: saved.adminUserId,
      usersCount: saved.usersCount || 0,
    });
    return saved;
  }

  private async ensureAmoAdminOrThrow(
    account: Account,
    profile?: PublicProfilePayload,
  ) {
    const normalized = this.serializeProfile(profile);
    if (normalized.isAmoAdmin) return;

    if (normalized.userId) {
      try {
        const api = this.accountsService.createConnector(
          account.amoId,
          account.widgetCode || undefined,
        );
        const response = await api.get(`/api/v4/users/${normalized.userId}`, {
          params: { with: 'role,group' },
        });
        const user = response.data || {};
        const rights = user.rights || {};
        if (
          rights.is_admin === true ||
          user.is_admin === true ||
          user.user_rank === 'master' ||
          user.role?.type === 'admin'
        ) {
          return;
        }
      } catch (e) {
        this.logger.warn(
          `Не удалось проверить права пользователя ${normalized.userId} в amoCRM: ${(e as Error)?.message || e}`,
        );
      }
    }

    throw new ForbiddenException(
      'Активировать пробный период может только администратор аккаунта amoCRM',
    );
  }

  private getDomain(account: Account, profile?: PublicProfilePayload) {
    return normalizeAmoDomain(profile?.domain || account.domain);
  }

  private normalizeInn(value?: string) {
    return String(value || '').replace(/\D/g, '');
  }

  private normalizeContact(value?: string) {
    const normalized = String(value || '').trim();
    return normalized || null;
  }

  private formatRubles(kopecks: number) {
    return (Number(kopecks || 0) / 100)
      .toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
      .replace(/\u00a0/g, ' ');
  }

  private getInvoiceDate(date = this.getNow()) {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(date);
  }

  private getDadataApiKey() {
    return String(
      this.configService.get<string>('dadataApiKey') ||
        process.env.DADATA_API_KEY ||
        '',
    ).trim();
  }

  private getDadataSecretKey() {
    return String(
      this.configService.get<string>('dadataSecretKey') ||
        process.env.DADATA_SECRET_KEY ||
        '',
    ).trim();
  }

  private async resolveCompanyByInn(
    inn: string,
    manualLegalName?: string,
  ): Promise<{ legalName: string; ogrn: string | null; status: string }> {
    const apiKey = this.getDadataApiKey();
    const secretKey = this.getDadataSecretKey();
    const manualName = String(manualLegalName || '').trim();

    if (!apiKey) {
      if (manualName) {
        return { legalName: manualName, ogrn: null, status: 'manual_no_dadata_key' };
      }
      throw new BadRequestException({
        code: 'dadata_unavailable',
        message:
          'DaData не настроена. Введите название организации вручную или напишите менеджеру.',
      });
    }

    try {
      const { data } = await axios.post(
        'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party',
        { query: inn },
        {
          timeout: 8000,
          headers: {
            Authorization: `Token ${apiKey}`,
            ...(secretKey ? { 'X-Secret': secretKey } : {}),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      const suggestion = Array.isArray(data?.suggestions)
        ? data.suggestions[0]
        : null;
      const legalName =
        suggestion?.data?.name?.short_with_opf ||
        suggestion?.data?.name?.full_with_opf ||
        suggestion?.value ||
        '';

      if (!legalName) {
        throw new BadRequestException({
          code: 'dadata_not_found',
          message:
            'Компания по этому ИНН не найдена. Проверьте ИНН или напишите менеджеру.',
        });
      }

      return {
        legalName,
        ogrn: suggestion?.data?.ogrn || null,
        status: 'found',
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`DaData не ответила по ИНН ${inn}: ${e?.message || e}`);
      if (manualName) {
        return { legalName: manualName, ogrn: null, status: 'manual_dadata_error' };
      }
      throw new BadRequestException({
        code: 'dadata_unavailable',
        message:
          'DaData временно не отвечает. Введите название организации вручную или напишите менеджеру.',
      });
    }
  }

  private buildPaymentQr(invoice: BillingInvoice, dateText: string) {
    const purpose = `Оплата по Счет-оферта №${invoice.invoiceNumber} от ${dateText}, amoCRM Account ID ${invoice.amoId}. В том числе НДС 5%`;
    return [
      'ST00012',
      'Name=ИП Жилков Иван Вячеславович',
      'PersonalAcc=40802810203500039167',
      'BankName=ООО "Банк Точка"',
      'BIC=044525104',
      'CorrespAcc=30101810745374525104',
      'PayeeINN=667116903111',
      `PayerINN=${invoice.inn}`,
      `Sum=${invoice.amountKopecks}`,
      `Purpose=${purpose}`,
    ].join('|');
  }

  private getPdfMake() {
    const pdfMake = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMake.vfs = pdfFonts.pdfMake?.vfs || pdfFonts;
    return pdfMake;
  }

  private async renderInvoicePdf(invoice: BillingInvoice) {
    const pdfMake = this.getPdfMake();
    const dateText = this.getInvoiceDate(invoice.createdAt);
    const amount = this.formatRubles(invoice.amountKopecks);
    const vat = this.formatRubles(invoice.vatKopecks);
    const purpose = `Оплата по Счет-оферта №${invoice.invoiceNumber} от ${dateText}, amoCRM Account ID ${invoice.amoId}. В том числе НДС 5%`;
    const licensee = [
      invoice.legalName,
      `ИНН: ${invoice.inn}`,
      invoice.ogrn ? `ОГРН: ${invoice.ogrn}` : '',
      invoice.email ? `email: ${invoice.email}` : '',
      invoice.phone ? `тел.: ${invoice.phone}` : '',
    ].filter(Boolean).join(', ');

    const offerText =
      'Настоящий Счет-оферта (далее - "Счет") направляется Лицензиату в соответствии со ст.435 Гражданского Кодекса РФ (далее "ГК РФ"), является письменным предложением Лицензиара заключить настоящий Лицензионный договор (неисключительная лицензия) путем принятия (акцепта) оферты Лицензиатом в установленном порядке (п.3 ст.438 ГК РФ) и считается соблюдением письменной формы договора (п.3 ст.434 ГК РФ). Под указанными в оферте следующими терминами понимаются их нижеуказанные значения: Лицензиар - лицо, обладающее исключительным правом на ПО. Лицензионное соглашение - соглашение между Лицензиаром и Лицензиатом, которое предусматривает полномочия и ограничения использования Лицензиатом ПО, и условия которого безоговорочно принимаются Лицензиатом с момента начала использования ПО.';

    const conditions = [
      'Предметом Лицензионного договора является предоставление Лицензиаром неисключительного права на использование указанного в Счете программного обеспечения для ЭВМ (ПО) и/или расширение прав на использование соответствующего ПО.',
      'Вознаграждением Лицензиара по Лицензионному договору является сумма, указанная в Счете-оферте.',
      'Существенным условием заключения Лицензионного договора является полная единовременная оплата Лицензиатом настоящего Счета, которая будет считаться единственно возможным надлежащим акцептом данной оферты (п.3 ст.438 ГК РФ).',
      'Лицензиар гарантирует, что правомерно обладает всем необходимым объемом прав, которые предоставляются Лицензиату по Лицензионному договору.',
      'Лицензиат имеет право в рамках каждой лицензии использовать только один Аккаунт в порядке, предусмотренном Лицензионным соглашением на соответствующее ПО и исключительно для самостоятельного использования Лицензиатом, без права сублицензирования третьих лиц.',
      'Принимая настоящую оферту, Лицензиат подтверждает, что ознакомлен и согласен с положениями Лицензионного соглашения по соответствующему ПО, расположенному в свободном доступе по адресу: https://clients.simsales.ru/offerta',
      'Оплата по настоящему Счету должна поступить на расчетный счет Лицензиара в течение 30 (тридцати) календарных дней со дня выставления Счета.',
      'В день поступления оплаты на расчетный счет Лицензиара осуществляется Прием-передача неисключительного права на использование ПО для ЭВМ.',
      'В течение 5-ти рабочих дней со дня Приема-передачи Лицензиар отправляет на электронный адрес Лицензиата копию УПД, подписанную со своей стороны.',
      'Лицензиат обязуется не нарушать авторские права Лицензиара. Любые споры подлежат рассмотрению по месту нахождения Лицензиара.',
    ];

    const docDefinition = {
      pageSize: 'A4',
      pageMargins: [28, 26, 28, 26],
      defaultStyle: {
        font: 'Roboto',
        fontSize: 8.5,
        lineHeight: 1.15,
      },
      styles: {
        title: { fontSize: 14, bold: true, margin: [0, 0, 0, 8] },
        label: { bold: true },
        small: { fontSize: 7.5, color: '#333333' },
      },
      content: [
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: `Счет-оферта №${invoice.invoiceNumber} от ${dateText}`, style: 'title' },
                {
                  table: {
                    widths: [95, '*'],
                    body: [
                      [{ text: 'Получатель', style: 'label' }, 'ИП Жилков Иван Вячеславович'],
                      [{ text: 'Банк получателя', style: 'label' }, 'ООО "Банк Точка"'],
                      [{ text: 'ИНН', style: 'label' }, '667116903111'],
                      [{ text: 'БИК', style: 'label' }, '044525104'],
                      [{ text: 'Расчетный счет', style: 'label' }, '40802810203500039167'],
                      [{ text: 'Кор. счет', style: 'label' }, '30101810745374525104'],
                    ],
                  },
                  layout: 'lightHorizontalLines',
                },
              ],
            },
            {
              width: 116,
              stack: [
                { qr: this.buildPaymentQr(invoice, dateText), fit: 106, alignment: 'right', margin: [0, 0, 0, 4] },
                { text: 'QR для оплаты в банке', alignment: 'right', style: 'small' },
              ],
            },
          ],
          columnGap: 12,
        },
        { text: `Назначение платежа: ${purpose}`, margin: [0, 8, 0, 8] },
        {
          table: {
            widths: [72, '*'],
            body: [
              [{ text: 'Лицензиар:', style: 'label' }, 'ИП Жилков Иван Вячеславович, ИНН 667116903111, г. Курган'],
              [{ text: 'Лицензиат:', style: 'label' }, licensee],
              [{ text: 'ID аккаунта:', style: 'label' }, String(invoice.amoId)],
              [{ text: 'Основание:', style: 'label' }, 'Основной'],
            ],
          },
          layout: 'noBorders',
          margin: [0, 0, 0, 8],
        },
        {
          table: {
            headerRows: 1,
            widths: [18, '*', 38, 30, 58, 58],
            body: [
              [
                { text: '№', bold: true, alignment: 'center' },
                { text: 'Товары (работы, услуги)', bold: true },
                { text: 'Кол-во', bold: true, alignment: 'center' },
                { text: 'Ед.', bold: true, alignment: 'center' },
                { text: 'Цена', bold: true, alignment: 'right' },
                { text: 'Сумма', bold: true, alignment: 'right' },
              ],
              [
                { text: '1', alignment: 'center' },
                'Виджет “Копирование сделок” на 12 месяцев',
                { text: '1', alignment: 'center' },
                { text: 'шт', alignment: 'center' },
                { text: amount, alignment: 'right' },
                { text: amount, alignment: 'right' },
              ],
            ],
          },
          margin: [0, 0, 0, 8],
        },
        { text: `Итого: ${amount}`, alignment: 'right', bold: true },
        { text: `В том числе НДС 5%: ${vat}`, alignment: 'right' },
        { text: `Всего одно наименование на сумму ${amount} руб.`, margin: [0, 6, 0, 0] },
        { text: 'десять тысяч рублей 00 копеек', bold: true, margin: [0, 0, 0, 8] },
        { text: offerText, margin: [0, 0, 0, 6] },
        { text: 'Условия оферты:', bold: true, margin: [0, 0, 0, 4] },
        {
          ol: conditions.map((text) => ({ text, margin: [0, 0, 0, 2] })),
          margin: [10, 0, 0, 8],
        },
        {
          columns: [
            { width: 120, text: 'Руководитель', bold: true },
            { width: '*', text: 'ИП Жилков И.В.', bold: true },
          ],
          margin: [0, 8, 0, 0],
        },
      ],
    };

    return new Promise<Buffer>((resolve, reject) => {
      try {
        pdfMake.createPdf(docDefinition).getBuffer((raw: Uint8Array) => {
          resolve(Buffer.from(raw));
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  private async createInvoiceNumber() {
    const today = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
    })
      .format(this.getNow())
      .replace(/\D/g, '');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = randomBytes(2).toString('hex').toUpperCase();
      const number = `CL-${today}-${suffix}`;
      const exists = await this.invoiceRepo.findOne({ invoiceNumber: number });
      if (!exists) return number;
    }

    return `CL-${today}-${Date.now().toString(36).toUpperCase()}`;
  }

  async trackInstall(payload: InstallPayload) {
    const account = await this.getAccountOrNull(
      payload.accountId,
      payload.widgetCode,
    );

    if (!account) {
      const pendingClient = await this.upsertPendingClient(payload.accountId, payload.profile, {
        firstSeenSource: 'settings',
      });
      const normalized = this.serializeProfile(payload.profile);
      if (pendingClient && !pendingClient.pendingInstallNotifiedAt) {
        await this.sendTelegramMessage(
          [
            '🚀 Новая установка виджета Копирование сделок!',
            '',
            `🌐 Домен: ${normalized.domain}`,
            `📧 Email: ${normalized.email}`,
            `📱 Телефон: ${normalized.phone}`,
            `👤 Пользователь: ${normalized.userName}`,
            `🏢 Account ID: ${payload.accountId}`,
            '',
            'OAuth-авторизация еще не завершена.',
            '',
            `⏰ ${this.getMskTimestamp()}`,
          ].join('\n'),
        );
        await this.accountsService.upsertClient({
          ...pendingClient,
          pendingInstallNotifiedAt: this.getNow(),
        });
      }
      return this.toPendingAccountView();
    }

    let updated = await this.upsertProfile(account, payload.profile);
    if (!updated.firstSeenSource) {
      updated = await this.accountsService.update(updated.id, {
        firstSeenSource: 'settings',
      });
    }

    if (!updated.installNotifiedAt) {
      const normalized = this.serializeProfile(payload.profile);
      const domain = this.getDomain(updated, payload.profile);

      await this.sendTelegramMessage(
        [
          '🚀 Новая установка виджета Копирование сделок!',
          '',
          `🌐 Домен: ${domain || '-'}`,
          `📧 Email: ${normalized.email !== '-' ? normalized.email : this.safeString(updated.adminEmail)}`,
          `📱 Телефон: ${normalized.phone !== '-' ? normalized.phone : this.safeString(updated.adminPhone)}`,
          `👤 Пользователь: ${normalized.userName !== '-' ? normalized.userName : this.safeString(updated.adminName)}`,
          `🏢 Account ID: ${updated.amoId}`,
          '',
          `⏰ ${this.getMskTimestamp()}`,
        ].join('\n'),
      );

      return this.accountsService.update(updated.id, {
        installedAt: updated.installedAt || this.getNow(),
        installNotifiedAt: this.getNow(),
      }).then((saved) => this.toPublicLicenseView(saved));
    }

    return this.toPublicLicenseView(updated);
  }

  async trackCopyAttempt(payload: CopyAttemptPayload) {
    const account = await this.getAccountOrNull(
      payload.accountId,
      payload.widgetCode,
    );

    if (!account) {
      const pendingClient = await this.upsertPendingClient(payload.accountId, payload.profile, {
        isLegacy: true,
        firstSeenSource: 'manual_copy',
      });
      return this.toPendingAccountView(pendingClient);
    }

    let updated = await this.upsertProfile(account, payload.profile);
    const hasBillingHistory = Boolean(
      updated.trialActivatedAt ||
        updated.trialEndsAt ||
        updated.paidUntil ||
        updated.graceExtensionUsed,
    );
    const shouldMarkLegacy =
      !updated.isLegacy &&
      !hasBillingHistory;

    if (shouldMarkLegacy) {
      updated = await this.accountsService.update(updated.id, {
        isLegacy: true,
        firstSeenSource: 'manual_copy',
      });
    } else if (!updated.firstSeenSource) {
      updated = await this.accountsService.update(updated.id, {
        firstSeenSource: 'manual_copy',
      });
    }

    return this.toPublicLicenseView(updated);
  }

  async getPublicStatus(accountId: number, widgetCode: string) {
    const account = await this.getAccountOrNull(accountId, widgetCode);
    if (!account) return this.toPendingAccountView();
    return this.toPublicLicenseView(account);
  }

  async activateTrial(payload: ActivateTrialPayload) {
    const account = await this.getAccountOrNull(
      payload.accountId,
      payload.widgetCode,
    );
    if (!account) {
      await this.upsertPendingClient(payload.accountId, payload.profile);
      return this.toPendingAccountView();
    }
    const profileUpdated = await this.upsertProfile(account, payload.profile);
    await this.ensureAmoAdminOrThrow(profileUpdated, payload.profile);

    const { state } = this.calculateState(profileUpdated);
    if (state === 'paid' || state === 'trial' || state === 'grace') {
      return this.toPublicLicenseView(profileUpdated);
    }
    if (
      profileUpdated.trialActivatedAt ||
      profileUpdated.trialEndsAt ||
      profileUpdated.graceExtensionUsed ||
      profileUpdated.paidUntil
    ) {
      return this.toPublicLicenseView(profileUpdated);
    }

    const now = this.getNow();
    const trialEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const normalized = this.serializeProfile(payload.profile);

    const saved = await this.accountsService.update(profileUpdated.id, {
      trialActivatedAt: now,
      trialEndsAt,
      trialRequestedEmail: payload.clientEmail || null,
      trialRequestedPhone: payload.clientPhone || null,
      graceExtendedUntil: null,
      graceExtensionUsed: false,
      paymentRequestedAt: null,
      paymentRequestedBy: null,
      paymentRequestContext: null,
    });

    const domain = this.getDomain(saved, payload.profile);
    await this.sendTelegramMessage(
      [
        '🚀Активация пробного периода',
        `🌐 Домен: ${domain || '-'}`,
        `📧 Email: ${normalized.email !== '-' ? normalized.email : this.safeString(saved.adminEmail)}`,
        `📱 Телефон: ${normalized.phone !== '-' ? normalized.phone : this.safeString(saved.adminPhone)}`,
        '',
        `✏️ Клиент ввёл e-mail: ${this.safeString(payload.clientEmail)}`,
        `✏️ Клиент указал телефон: ${this.safeString(payload.clientPhone)}`,
        '',
        `⏰ ${this.getMskTimestamp()}`,
      ].join('\n'),
    );

    return this.toPublicLicenseView(saved);
  }

  async requestPayment(payload: RequestPaymentPayload) {
    const account = await this.getAccountOrNull(
      payload.accountId,
      payload.widgetCode,
    );
    if (!account) {
      await this.upsertPendingClient(payload.accountId, payload.profile);
      return {
        extended: false,
        status: this.toPendingAccountView(),
        message:
          'Сначала нужно завершить авторизацию виджета в amoCRM, потом можно запросить оплату.',
      };
    }
    const profileUpdated = await this.upsertProfile(account, payload.profile);
    await this.ensureAmoAdminOrThrow(profileUpdated, payload.profile);
    const statusBefore = this.toPublicLicenseView(profileUpdated);

    const normalized = this.serializeProfile(payload.profile);
    const now = this.getNow();

    let updated = profileUpdated;
    let extended = false;

    if (
      payload.source === 'manual_copy' &&
      statusBefore.state === 'expired' &&
      !profileUpdated.graceExtensionUsed
    ) {
      extended = true;
      updated = await this.accountsService.update(profileUpdated.id, {
        graceExtendedUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        graceExtensionUsed: true,
      });
    }

    updated = await this.accountsService.update(updated.id, {
      paymentRequestedAt: now,
      paymentRequestedBy:
        normalized.userName !== '-' ? normalized.userName : updated.adminName,
      paymentRequestContext: payload.source || 'unknown',
      trialRequestedEmail:
        normalized.email !== '-' ? normalized.email : updated.trialRequestedEmail,
      trialRequestedPhone:
        normalized.phone !== '-' ? normalized.phone : updated.trialRequestedPhone,
    });

    const domain = this.getDomain(updated, payload.profile);
    await this.sendTelegramMessage(
      [
        '💳 Запрос на оплату виджета Копирование сделок',
        `🌐 Домен: ${domain || '-'}`,
        `🏢 Account ID: ${updated.amoId}`,
        `👤 Пользователь: ${this.safeString(normalized.userName !== '-' ? normalized.userName : updated.adminName)}`,
        `📧 Email: ${this.safeString(normalized.email !== '-' ? normalized.email : updated.adminEmail)}`,
        `📱 Телефон: ${this.safeString(normalized.phone !== '-' ? normalized.phone : updated.adminPhone)}`,
        `📍 Источник: ${payload.source || 'unknown'}`,
        '',
        `⏰ ${this.getMskTimestamp()}`,
      ].join('\n'),
    );

    const current = this.toPublicLicenseView(updated);

    return {
      extended,
      status: current,
      message: extended
        ? 'Мы продлили виджет на 1 день и скоро с вами свяжемся для оплаты.'
        : 'Запрос на оплату отправлен, скоро с вами свяжемся.',
    };
  }

  async lookupCompanyByInn(payload: LookupCompanyPayload) {
    const inn = this.normalizeInn(payload.inn);
    if (!/^\d{10}$|^\d{12}$/.test(inn)) {
      throw new BadRequestException({
        code: 'invalid_inn',
        message: 'Введите корректный ИНН: 10 или 12 цифр.',
      });
    }

    const account = await this.getAccountOrNull(
      payload.accountId,
      payload.widgetCode,
    );
    if (!account) {
      await this.upsertPendingClient(payload.accountId, payload.profile, {
        firstSeenSource: 'settings',
      });
      throw new BadRequestException({
        code: 'not_authorized',
        message:
          'Сначала нужно завершить авторизацию виджета в amoCRM, затем можно скачать счёт.',
      });
    }

    const profileUpdated = await this.upsertProfile(account, payload.profile);
    await this.ensureAmoAdminOrThrow(profileUpdated, payload.profile);

    const company = await this.resolveCompanyByInn(inn);
    return {
      inn,
      legalName: company.legalName,
      ogrn: company.ogrn,
      dadataStatus: company.status,
    };
  }

  async createInvoicePdf(payload: CreateInvoicePayload) {
    const inn = this.normalizeInn(payload.inn);
    if (!/^\d{10}$|^\d{12}$/.test(inn)) {
      throw new BadRequestException({
        code: 'invalid_inn',
        message: 'Введите корректный ИНН: 10 или 12 цифр.',
      });
    }

    const email = this.normalizeContact(payload.email);
    const phone = this.normalizeContact(payload.phone);
    if (!email) {
      throw new BadRequestException({
        code: 'email_required',
        message: 'Введите email для счёта.',
      });
    }
    if (!phone) {
      throw new BadRequestException({
        code: 'phone_required',
        message: 'Введите телефон для счёта.',
      });
    }

    const account = await this.getAccountOrNull(
      payload.accountId,
      payload.widgetCode,
    );
    if (!account) {
      await this.upsertPendingClient(payload.accountId, payload.profile, {
        firstSeenSource: payload.source || 'settings',
      });
      throw new BadRequestException({
        code: 'not_authorized',
        message:
          'Сначала нужно завершить авторизацию виджета в amoCRM, затем можно скачать счёт.',
      });
    }

    const profileUpdated = await this.upsertProfile(account, payload.profile);
    await this.ensureAmoAdminOrThrow(profileUpdated, payload.profile);

    const company = await this.resolveCompanyByInn(inn, payload.legalName);
    const invoice = await this.invoiceRepo.save({
      invoiceNumber: await this.createInvoiceNumber(),
      amoId: profileUpdated.amoId,
      accountId: profileUpdated.id,
      widgetCode: profileUpdated.widgetCode || payload.widgetCode,
      inn,
      legalName: company.legalName,
      ogrn: company.ogrn,
      phone,
      email,
      amountKopecks: 1000000,
      vatRate: 5,
      vatKopecks: 47619,
      source: payload.source || 'settings',
      dadataStatus: company.status,
      status: 'issued',
    });

    await this.accountsService.update(profileUpdated.id, {
      billingInn: inn,
      billingLegalName: company.legalName,
      billingOgrn: company.ogrn,
      trialRequestedEmail: email,
      trialRequestedPhone: phone,
      latestInvoiceNumber: invoice.invoiceNumber,
      latestInvoiceStatus: invoice.status,
      latestInvoiceCreatedAt: invoice.createdAt,
      latestInvoicePaidAt: null,
    });

    await this.accountsService.upsertClient({
      amoId: profileUpdated.amoId,
      domain: profileUpdated.domain,
      billingInn: inn,
      billingLegalName: company.legalName,
      billingOgrn: company.ogrn,
    });

    const buffer = await this.renderInvoicePdf(invoice);
    return {
      invoice,
      buffer,
      filename: `schet-${invoice.invoiceNumber}.pdf`,
    };
  }

  async getAdminInvoicePdf(invoiceNumber: string) {
    const normalized = String(invoiceNumber || '').trim();
    if (!normalized) {
      throw new BadRequestException('Нужно передать номер счёта');
    }
    const invoice = await this.invoiceRepo.findOne({
      where: { invoiceNumber: normalized },
    } as any);
    if (!invoice) {
      throw new NotFoundException('Счёт не найден');
    }
    const buffer = await this.renderInvoicePdf(invoice);
    return {
      invoice,
      buffer,
      filename: `schet-${invoice.invoiceNumber}.pdf`,
    };
  }

  async updateAdminInvoiceStatus(invoiceNumber: string, statusRaw: string) {
    const invoiceNumberNormalized = String(invoiceNumber || '').trim();
    const status = String(statusRaw || '').trim();
    if (!invoiceNumberNormalized) {
      throw new BadRequestException('Нужно передать номер счёта');
    }
    if (!['issued', 'paid'].includes(status)) {
      throw new BadRequestException('Статус счёта должен быть issued или paid');
    }

    const invoice = await this.invoiceRepo.findOne({
      where: { invoiceNumber: invoiceNumberNormalized },
    } as any);
    if (!invoice) {
      throw new NotFoundException('Счёт не найден');
    }

    const paidAt = status === 'paid' ? invoice.paidAt || this.getNow() : null;
    const saved = await this.invoiceRepo.save({
      ...invoice,
      status,
      paidAt,
    });

    if (saved.accountId) {
      const account = await this.accountsService.findById(saved.accountId);
      if (account?.latestInvoiceNumber === saved.invoiceNumber) {
        await this.accountsService.update(saved.accountId, {
          latestInvoiceStatus: status,
          latestInvoicePaidAt: paidAt,
        });
      }
    }

    return {
      invoiceNumber: saved.invoiceNumber,
      status: saved.status,
      paidAt: this.toIso(saved.paidAt),
    };
  }

  async sendTestTelegramMessage() {
    const sent = await this.sendTelegramMessage(
      [
        'Тестовое сообщение виджета Копирование сделок',
        '',
        'Если вы видите это сообщение, Telegram-уведомления настроены корректно.',
        '',
        `Время: ${this.getMskTimestamp()}`,
      ].join('\n'),
    );

    return {
      ok: sent,
      message: sent
        ? 'Тестовое сообщение отправлено в Telegram'
        : 'Не удалось отправить тестовое сообщение. Проверьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в Railway.',
    };
  }

  ensureCanCopyOrThrow(account: Account) {
    const status = this.toPublicLicenseView(account);
    if (status.canCopy) return status;

    throw new ForbiddenException({
      code: 'billing_expired',
      message:
        status.state === 'not_activated' || status.state === 'legacy_not_activated'
          ? 'Пробный период не активирован'
          : status.state === 'paid_expired'
            ? 'Платный период закончился'
            : 'Пробный период закончился',
      status,
    });
  }

  canCopy(account: Account) {
    const status = this.toPublicLicenseView(account);
    return status.canCopy;
  }

  private normalizeDays(days: number) {
    const parsed = Number(days);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException('Некорректное количество дней');
    }
    return Math.floor(parsed);
  }

  ensureAdminTokenOrThrow(token: string) {
    const expected = String(this.configService.get<string>('adminToken') || '').trim();
    if (!expected) {
      throw new UnauthorizedException('ADMIN_TOKEN не задан');
    }
    if (!token || token !== expected) {
      throw new UnauthorizedException('Неверный admin token');
    }
  }

  async ensureAdminSessionOrThrow(session: string) {
    const stored = await this.getStoredAdminCredential();
    if (stored) {
      if (!session || session !== this.getAdminSessionToken(stored.login, stored.passwordHash)) {
        throw new UnauthorizedException('Сессия администратора истекла');
      }
      return;
    }

    const expectedLogin = this.getAdminLogin();
    const expectedPassword = this.getAdminPassword();
    if (!expectedPassword) {
      throw new UnauthorizedException('Сначала задайте пароль администратора');
    }
    if (!session || session !== this.getAdminSessionToken(expectedLogin, expectedPassword)) {
      throw new UnauthorizedException('Сессия администратора истекла');
    }
  }

  async ensureAdminAccessOrThrow(token: string, session: string) {
    if (session) {
      await this.ensureAdminSessionOrThrow(session);
      return;
    }
    this.ensureAdminTokenOrThrow(token);
  }

  private getCrmKind() {
    return 'amo';
  }

  private toCrmSubdomain(domain?: string | null) {
    const normalized = normalizeAmoDomain(domain || '');
    return normalized
      .replace(/\.amocrm\.ru$/i, '')
      .replace(/\.kommo\.com$/i, '')
      .replace(/\.kommo\.ru$/i, '');
  }

  private isPaidAmoLicenseUser(user: any) {
    const rights = user?.rights || {};
    const explicitInactive =
      user?.is_active === false ||
      user?.active === false ||
      user?.isActive === false ||
      user?.is_deleted === true ||
      user?.isDeleted === true ||
      rights?.is_active === false ||
      rights?.active === false ||
      rights?.isActive === false;
    const explicitFree =
      user?.is_free === true ||
      user?.isFree === true ||
      rights?.is_free === true ||
      rights?.isFree === true;
    const botType = String(user?.type || user?.user_type || '').toLowerCase();
    return !explicitInactive && !explicitFree && botType !== 'bot';
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>,
  ) {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async getCurrentAmoPaidLicensesCount(account?: Account | null) {
    if (!account) return null;
    const cached = this.paidLicensesCache.get(account.amoId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      const api = this.accountsService.createConnector(
        account.amoId,
        account.widgetCode || undefined,
      );
      const users = [];
      for (let page = 1; page <= 20; page += 1) {
        const response = await api.get('/api/v4/users', {
          params: { limit: 250, page },
        });
        const pageUsers =
          response.data?._embedded?.users ||
          response.data?.users ||
          (Array.isArray(response.data) ? response.data : []);
        if (!Array.isArray(pageUsers) || pageUsers.length === 0) break;
        users.push(...pageUsers);
        if (pageUsers.length < 250) break;
      }
      const count = users.filter((user) => this.isPaidAmoLicenseUser(user)).length;
      this.paidLicensesCache.set(account.amoId, {
        value: count,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      return count;
    } catch (e) {
      this.logger.warn(
        `Не удалось получить текущие лицензии amoCRM для ${account.amoId}: ${
          e?.response?.status || e?.message || e
        }`,
      );
      this.paidLicensesCache.set(account.amoId, {
        value: null,
        expiresAt: Date.now() + 60 * 1000,
      });
      return null;
    }
  }

  async getAdminAccounts() {
    const clients = await this.accountsService.findAllClients();
    const accounts = await this.accountsService.findAll();
    const invoices = await this.invoiceRepo.find({
      order: { createdAt: 'DESC' },
    } as any);
    const invoicesByAccount = new Map<number, BillingInvoice[]>();
    invoices.forEach((invoice) => {
      if (!invoice.accountId) return;
      const list = invoicesByAccount.get(invoice.accountId) || [];
      list.push(invoice);
      invoicesByAccount.set(invoice.accountId, list);
    });
    const clientRows = await this.mapWithConcurrency(clients, 5, async (client) => {
      const widgets = client.widgets || [];
      const liveUsersCount = await this.getCurrentAmoPaidLicensesCount(widgets[0]);
      const paidLicensesCount = liveUsersCount ?? (client.usersCount || 0);
      return {
        id: client.id,
        amoId: client.amoId,
        crm: this.getCrmKind(),
        domain: client.domain,
        domainShort: this.toCrmSubdomain(client.domain),
        adminName: client.adminName,
        adminEmail: client.adminEmail,
        adminPhone: client.adminPhone,
        billingInn: client.billingInn,
        billingLegalName: client.billingLegalName,
        billingOgrn: client.billingOgrn,
        isLegacy: Boolean(client.isLegacy),
        firstSeenSource: client.firstSeenSource || null,
        paidLicensesCount,
        usersCount: paidLicensesCount,
        usersCountSource: liveUsersCount === null ? 'stored' : 'amo_paid_active',
        widgets: widgets.map((account) =>
          this.toAdminAccountRow(account, invoicesByAccount.get(account.id) || []),
        ),
      };
    });

    const knownClientIds = new Set(clientRows.map((client) => client.amoId));
    const orphanAccounts = accounts.filter((account) => !knownClientIds.has(account.amoId));
    const orphanRows = await this.mapWithConcurrency(orphanAccounts, 5, async (account) => {
      const liveUsersCount = await this.getCurrentAmoPaidLicensesCount(account);
      const paidLicensesCount = liveUsersCount ?? (account.usersCount || 0);
      return {
        id: null,
        amoId: account.amoId,
        crm: this.getCrmKind(),
        domain: account.domain,
        domainShort: this.toCrmSubdomain(account.domain),
        adminName: account.adminName,
        adminEmail: account.adminEmail,
        adminPhone: account.adminPhone,
        billingInn: account.billingInn,
        billingLegalName: account.billingLegalName,
        billingOgrn: account.billingOgrn,
        paidLicensesCount,
        usersCount: paidLicensesCount,
        usersCountSource: liveUsersCount === null ? 'stored' : 'amo_paid_active',
        widgets: [this.toAdminAccountRow(account, invoicesByAccount.get(account.id) || [])],
      };
    });

    return [...clientRows, ...orphanRows];
  }

  async getAdminIntegrations() {
    const integrations = await this.accountsService.findIntegrations();
    return integrations.map((integration) => ({
      id: integration.id,
      widgetName: integration.widgetName,
      widgetSlug: integration.widgetSlug,
      widgetCode: integration.widgetCode,
      amoClientId: integration.amoClientId,
      amoDomain: integration.amoDomain,
      redirectUri: integration.redirectUri,
      isDefault: integration.isDefault,
      createdAt: this.toIso(integration.createdAt),
      updatedAt: this.toIso(integration.updatedAt),
    }));
  }

  async saveAdminIntegration(payload: {
    widgetName?: string;
    widgetSlug?: string;
    widgetCode?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    amoDomain?: string;
  }) {
    const saved = await this.accountsService.upsertIntegration({
      widgetName: String(payload.widgetName || 'Копирование сделок').trim(),
      widgetSlug: String(payload.widgetSlug || 'copy_leads').trim(),
      widgetCode: String(payload.widgetCode || '').trim(),
      amoClientId: String(payload.clientId || '').trim(),
      amoClientSecret: String(payload.clientSecret || '').trim(),
      amoDomain: normalizeAmoDomain(payload.amoDomain || ''),
      redirectUri: String(
        payload.redirectUri || this.configService.get<string>('redirectUri') || '',
      ).trim(),
    });

    return {
      id: saved.id,
      widgetName: saved.widgetName,
      widgetSlug: saved.widgetSlug,
      widgetCode: saved.widgetCode,
      amoClientId: saved.amoClientId,
      amoDomain: saved.amoDomain,
      redirectUri: saved.redirectUri,
    };
  }

  async deleteAdminIntegration(widgetCode: string) {
    return this.accountsService.deleteIntegrationCompletelyByWidgetCode(widgetCode);
  }

  async deleteAdminClientInstallations(amoIdOrDomain: string) {
    return this.accountsService.deleteClientInstallations(amoIdOrDomain);
  }

  async deleteAdminWidgetInstallation(accountId: number) {
    return this.accountsService.deleteAccountInstallation(accountId);
  }

  async getAdminAmoWidgetInfo(accountId: number) {
    const account = await this.accountsService.findById(Number(accountId));
    if (!account) {
      throw new NotFoundException('Установка виджета не найдена');
    }

    const widgetCode = String(account.widgetCode || '').trim();
    if (!widgetCode) {
      throw new BadRequestException('У установки не задан widgetCode');
    }

    const api = this.accountsService.createConnector(account.amoId, widgetCode);
    const response = await api.get(`/api/v4/widgets/${widgetCode}`);
    const widget = response.data || {};

    return {
      account: {
        id: account.id,
        amoId: account.amoId,
        domain: account.domain,
        widgetCode,
      },
      widget: {
        id: widget.id,
        code: widget.code,
        version: widget.version,
        is_work_with_dp: widget.is_work_with_dp,
        locations: widget.locations,
        name: widget.name,
      },
      raw: widget,
    };
  }

  private toAdminInvoiceRow(invoice: BillingInvoice) {
    return {
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status || 'issued',
      inn: invoice.inn,
      legalName: invoice.legalName,
      ogrn: invoice.ogrn,
      email: invoice.email,
      phone: invoice.phone,
      amountKopecks: invoice.amountKopecks,
      createdAt: this.toIso(invoice.createdAt),
      paidAt: this.toIso(invoice.paidAt),
    };
  }

  private toAdminAccountRow(account: Account, invoices: BillingInvoice[] = []) {
    const status = this.toPublicLicenseView(account);
    return {
      id: account.id,
      amoId: account.amoId,
      crm: this.getCrmKind(),
      domain: account.domain,
      domainShort: this.toCrmSubdomain(account.domain),
      widgetName:
        account.widgetName || account.integration?.widgetName || 'Копирование сделок',
      widgetSlug: account.widgetSlug || account.integration?.widgetSlug || 'copy_leads',
      widgetCode: account.widgetCode || account.integration?.widgetCode,
      amoClientId: account.amoClientId || account.integration?.amoClientId,
      adminName: account.adminName,
      adminEmail: account.adminEmail,
      adminPhone: account.adminPhone,
      billingInn: account.billingInn,
      billingLegalName: account.billingLegalName,
      billingOgrn: account.billingOgrn,
      latestInvoiceNumber: account.latestInvoiceNumber,
      latestInvoiceStatus: account.latestInvoiceStatus,
      latestInvoiceCreatedAt: this.toIso(account.latestInvoiceCreatedAt),
      latestInvoicePaidAt: this.toIso(account.latestInvoicePaidAt),
      invoices: invoices.map((invoice) => this.toAdminInvoiceRow(invoice)),
      usersCount: account.usersCount || 0,
      installedAt: this.toIso(account.installedAt),
      isLegacy: Boolean(account.isLegacy),
      firstSeenSource: account.firstSeenSource || null,
      status,
    };
  }

  async extendByDays(amoId: number, days: number) {
    const account = await this.getAccountOrFail(amoId);
    return this.extendAccount(account, days);
  }

  async extendAccountById(accountId: number, days: number) {
    const account = await this.accountsService.findById(Number(accountId));
    if (!account) {
      throw new NotFoundException('Установка виджета не найдена');
    }
    return this.extendAccount(account, days);
  }

  async updateAdminWidgetLicense(
    accountId: number,
    payload: {
      status?: LicenseState;
      paidUntil?: string | null;
    },
  ) {
    const account = await this.accountsService.findById(Number(accountId));
    if (!account) {
      throw new NotFoundException('Установка виджета не найдена');
    }

    const status = String(payload?.status || '').trim() as LicenseState | '';
    const rawPaidUntil = String(payload?.paidUntil || '').trim();
    const updates: Partial<Account> = {};
    let manualDate: Date | null = null;

    if (rawPaidUntil) {
      const paidUntil = new Date(`${rawPaidUntil}T23:59:59+03:00`);
      if (!Number.isFinite(paidUntil.getTime())) {
        throw new BadRequestException('Некорректная дата окончания');
      }
      manualDate = paidUntil;
      updates.paidUntil = paidUntil;
      updates.trialEndsAt = null;
      updates.graceExtendedUntil = null;
    }

    if (status) {
      const now = this.getNow();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const defaultPaidUntil =
        updates.paidUntil ||
        account.paidUntil ||
        new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      if (status === 'paid') {
        updates.paidUntil = manualDate
          ? manualDate
          : new Date(defaultPaidUntil).getTime() > now.getTime()
            ? new Date(defaultPaidUntil)
            : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        updates.trialEndsAt = null;
        updates.graceExtendedUntil = null;
      } else if (status === 'paid_expired') {
        updates.paidUntil =
          rawPaidUntil && updates.paidUntil ? updates.paidUntil : yesterday;
        updates.trialEndsAt = null;
        updates.graceExtendedUntil = null;
      } else if (status === 'trial') {
        updates.paidUntil = null;
        updates.trialActivatedAt = account.trialActivatedAt || now;
        updates.trialEndsAt =
          manualDate || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        updates.graceExtendedUntil = null;
      } else if (status === 'expired') {
        updates.paidUntil = null;
        updates.trialActivatedAt = account.trialActivatedAt || yesterday;
        updates.trialEndsAt = yesterday;
        updates.graceExtendedUntil = null;
      } else if (status === 'grace') {
        updates.graceExtendedUntil =
          manualDate || new Date(now.getTime() + 24 * 60 * 60 * 1000);
        updates.paidUntil = null;
      } else if (status === 'not_activated' || status === 'legacy_not_activated') {
        updates.paidUntil = null;
        updates.trialActivatedAt = null;
        updates.trialEndsAt = null;
        updates.graceExtendedUntil = null;
        updates.graceExtensionUsed = false;
        updates.isLegacy = status === 'legacy_not_activated';
      } else {
        throw new BadRequestException('Некорректный статус');
      }
    }

    if (!Object.keys(updates).length) {
      throw new BadRequestException('Нужно передать статус или дату');
    }

    const updated = await this.accountsService.update(account.id, updates);
    return {
      amoId: updated.amoId,
      paidUntil: this.toIso(updated.paidUntil),
      trialEndsAt: this.toIso(updated.trialEndsAt),
      graceExtendedUntil: this.toIso(updated.graceExtendedUntil),
      status: this.toPublicLicenseView(updated),
    };
  }

  private async extendAccount(account: Account, days: number) {
    const normalizedDays = this.normalizeDays(days);

    const now = this.getNow();
    const base = account.paidUntil && new Date(account.paidUntil).getTime() > now.getTime()
      ? new Date(account.paidUntil)
      : now;

    const paidUntil = new Date(base.getTime() + normalizedDays * 24 * 60 * 60 * 1000);

    const updated = await this.accountsService.update(account.id, {
      paidUntil,
      graceExtendedUntil: null,
      trialEndsAt:
        account.trialEndsAt && new Date(account.trialEndsAt).getTime() > paidUntil.getTime()
          ? account.trialEndsAt
          : account.trialEndsAt,
    });

    return {
      amoId: updated.amoId,
      paidUntil: this.toIso(updated.paidUntil),
      status: this.toPublicLicenseView(updated),
    };
  }

  getAdminPanelHtml() {
    return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SimpleSales Admin</title>
  <style>
    :root{color-scheme:light;--bg:#f4f5f7;--surface:#fff;--surface-soft:#f8f9fb;--line:#e5e7eb;--line-strong:#d1d5db;--text:#111827;--muted:#6b7280;--muted-2:#9ca3af;--blue:#2563eb;--blue-dark:#1d4ed8;--green:#15803d;--green-bg:#eaf7ee;--red:#dc2626;--red-bg:#fef2f2;--orange:#b45309;--orange-bg:#fff7ed;--shadow:0 18px 44px rgba(17,24,39,.08)}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Arial,sans-serif;font-size:14px}
    button,input,select{font:inherit}
    button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid transparent;border-radius:10px;background:var(--blue);color:#fff;min-height:38px;padding:8px 13px;font-weight:650;cursor:pointer;transition:background .14s ease,border .14s ease,box-shadow .14s ease,transform .08s ease}
    button:hover{background:var(--blue-dark);box-shadow:0 8px 18px rgba(37,99,235,.2)}
    button:active{transform:translateY(1px)}
    button:disabled{opacity:.52;cursor:not-allowed;box-shadow:none;transform:none}
    button.secondary{background:#fff;color:var(--text);border-color:var(--line)}
    button.secondary:hover{background:var(--surface-soft);box-shadow:none}
    button.danger{background:#fff;color:var(--red);border-color:#fecaca}
    button.danger:hover{background:var(--red-bg);box-shadow:none}
    input,select{width:100%;min-height:38px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--text);padding:8px 10px;outline:none}
    input:focus,select:focus{border-color:#93c5fd;box-shadow:0 0 0 4px rgba(37,99,235,.12)}
    label{display:block;margin:0 0 6px;color:var(--muted);font-size:12px;font-weight:700}
    h1,h2{margin:0;letter-spacing:0}
    h1{font-size:26px;line-height:1.16}
    h2{font-size:17px;line-height:1.25}
    .hidden{display:none!important}
    .page{width:min(1500px,calc(100% - 32px));margin:0 auto;padding:22px 0 42px}
    .topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:16px}
    .subtitle{margin-top:6px;color:var(--muted);font-size:13px}
    .toolbar{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
    .panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);margin-bottom:14px}
    .panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px;border-bottom:1px solid var(--line)}
    .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px;align-items:stretch}
    .kpi{display:block;background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 15px;text-align:left;color:var(--text);box-shadow:0 8px 22px rgba(17,24,39,.04);min-height:96px}
    .kpi:hover{border-color:#bfdbfe;background:#fbfdff;box-shadow:none}
    .kpi span{display:block;min-height:32px;color:var(--muted);font-size:12px;font-weight:800;line-height:1.3}
    .kpi strong{display:block;margin-top:8px;font-size:28px;line-height:1}
    .kpi small{display:block;margin-top:6px;color:var(--muted-2);font-size:11px;font-weight:650}
    .searchbar{display:flex;gap:10px;align-items:center;min-width:min(520px,100%)}
    .searchbar input{min-width:320px}
    .table-wrap{overflow:auto}
    table{width:100%;border-collapse:separate;border-spacing:0;min-width:1220px}
    th,td{border-bottom:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:middle}
    thead th{position:sticky;top:0;background:#fff;z-index:2;color:var(--muted);font-size:12px;font-weight:800;white-space:nowrap}
    thead tr.filters th{top:39px;background:var(--surface-soft);padding:7px 8px}
    thead input,thead select{min-height:30px;border-radius:8px;font-size:12px;padding:5px 8px}
    tbody tr:hover td{background:#fbfdff}
    tbody tr:last-child td{border-bottom:0}
    .sort{border:0;background:transparent;color:inherit;padding:0;min-height:auto;font-size:12px;font-weight:800}
    .sort:hover{background:transparent;color:var(--text);box-shadow:none}
    .sortmark{display:inline-block;width:12px;color:var(--blue)}
    .domain-main{font-weight:760}
    .micro{color:var(--muted);font-size:12px;margin-top:2px}
    .muted{color:var(--muted)}
    .pill{display:inline-flex;align-items:center;justify-content:center;min-height:24px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--text);font-size:12px;font-weight:750;padding:3px 8px;white-space:nowrap}
    .pill.amo{text-transform:uppercase;letter-spacing:.02em}
    .pill.ok{background:var(--green-bg);border-color:#bbf7d0;color:var(--green)}
    .pill.bad{background:var(--red-bg);border-color:#fecaca;color:var(--red)}
    .pill.warn{background:var(--orange-bg);border-color:#fed7aa;color:var(--orange)}
    .pill.gray{background:#f3f4f6;color:var(--muted)}
    .extend{display:flex;align-items:center;gap:7px}
    .extend input{width:72px;min-height:34px}
    .extend button{min-height:34px;padding:7px 10px}
    .license-actions{display:grid;grid-template-columns:128px 132px auto auto auto;gap:7px;align-items:center;min-width:520px}
    .license-actions select,.license-actions input{min-height:34px;border-radius:9px;font-size:12px}
    .license-actions button{min-height:34px;padding:7px 10px;white-space:nowrap}
    .invoice-history{display:flex;flex-direction:column;gap:10px}
    .invoice-history__item{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--line);border-radius:12px;background:#fff}
    .invoice-history__item .license-actions{grid-template-columns:128px auto auto;min-width:0}
    .client-toggle{width:30px;height:30px;min-height:30px;padding:0;border-radius:9px;margin-right:8px}
    .details-row td{background:var(--surface-soft)!important;color:var(--muted);font-size:13px}
    .details-grid{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:10px}
    .detail-label{font-size:11px;text-transform:uppercase;color:var(--muted-2);font-weight:800;margin-bottom:3px}
    .state{padding:22px;text-align:center;color:var(--muted)}
    .state.error{color:var(--red);background:var(--red-bg);border:1px solid #fecaca;border-radius:12px;margin:12px}
    .skeleton{height:15px;border-radius:999px;background:linear-gradient(90deg,#eef0f3,#fff,#eef0f3);background-size:220% 100%;animation:pulse 1.15s linear infinite}
    @keyframes pulse{to{background-position:-220% 0}}
    .login-wrap{min-height:100vh;display:grid;place-items:center;padding:20px}
    .login{width:min(420px,100%);background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:22px}
    .field{margin-top:14px}
    .login-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:18px}
    .status-line{min-height:20px;margin-top:10px;color:var(--muted);font-size:13px}
    .status-line.error{color:var(--red)}
    .status-line.ok{color:var(--green)}
    .modal-backdrop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(17,24,39,.34);padding:18px;z-index:20}
    .modal-backdrop.open{display:flex}
    .modal{width:min(620px,100%);background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 26px 80px rgba(17,24,39,.28);padding:18px}
    .modal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
    .modal-close{width:32px;height:32px;min-height:32px;padding:0;border-radius:999px;background:var(--surface-soft);border-color:var(--line);color:var(--muted)}
    .modal-close:hover{background:#eef0f3;color:var(--text);box-shadow:none}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .modal-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:14px}
    @media(max-width:860px){.page{width:calc(100% - 20px);padding-top:14px}.topbar,.panel-head{flex-direction:column}.toolbar,.searchbar{width:100%;justify-content:flex-start}.searchbar input{min-width:0}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.grid,.details-grid{grid-template-columns:1fr}h1{font-size:23px}}
  </style>
</head>
<body>
  <section id="setupView" class="login-wrap hidden">
    <form class="login" onsubmit="submitSetupPassword(event)">
      <h1>Задайте пароль</h1>
      <div class="subtitle">Первый вход в админку. Дальше пароль будет сохранён на сервере.</div>
      <div class="field"><label for="setupLogin">Логин</label><input id="setupLogin" autocomplete="username" value="admin" /></div>
      <div class="field"><label for="setupPasswordInput">Новый пароль</label><input id="setupPasswordInput" type="password" autocomplete="new-password" /></div>
      <div class="field"><label for="setupPasswordRepeatInput">Повторите пароль</label><input id="setupPasswordRepeatInput" type="password" autocomplete="new-password" /></div>
      <div class="login-actions"><div id="setupStatus" class="status-line"></div><button id="setupButton" type="submit">Сохранить</button></div>
    </form>
  </section>

  <section id="loginView" class="login-wrap">
    <form class="login" onsubmit="submitLogin(event)">
      <h1>SimpleSales Admin</h1>
      <div class="subtitle">Кабинет клиентов, лицензий и приватных виджетов.</div>
      <div class="field"><label for="adminLoginInput">Логин</label><input id="adminLoginInput" autocomplete="username" /></div>
      <div class="field"><label for="adminPasswordInput">Пароль</label><input id="adminPasswordInput" type="password" autocomplete="current-password" /></div>
      <div class="login-actions"><div id="loginStatus" class="status-line"></div><button id="loginButton" type="submit">Войти</button></div>
    </form>
  </section>

  <main id="appView" class="page hidden">
    <div class="topbar">
      <div>
        <h1>Клиенты и виджеты</h1>
        <div class="subtitle">Основная строка — установленный виджет. Даты, legacy и продление относятся к конкретному виджету.</div>
      </div>
      <div class="toolbar">
        <button onclick="openManualModal()">Добавить пользователя</button>
        <button class="secondary" onclick="loadAll()">Обновить</button>
        <button class="secondary" onclick="testTelegram()">Проверить Telegram</button>
        <button class="secondary" onclick="logout()">Выйти</button>
      </div>
    </div>

    <div class="kpis">
      <button class="kpi" onclick="setQuickFilter('')"><span>Клиентов</span><strong id="kpiClients">0</strong><small>Всего аккаунтов</small></button>
      <button class="kpi" onclick="setQuickFilter('')"><span>Виджетов</span><strong id="kpiWidgets">0</strong><small>Установки в CRM</small></button>
      <button class="kpi" onclick="setQuickFilter('')"><span>Платных лицензий amo</span><strong id="kpiLicenses">0</strong><small>Активные, не free</small></button>
      <button class="kpi" onclick="setQuickFilter('ending')"><span>Истекают за 14 дней</span><strong id="kpiEnding">0</strong><small>Нажми для фильтра</small></button>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Установленные виджеты</h2>
          <div id="clientsMeta" class="subtitle">Загрузка...</div>
        </div>
        <div class="searchbar">
          <input id="globalSearch" placeholder="Поиск по любому столбцу" oninput="applyTable()" />
          <button class="secondary" onclick="clearFilters()">Сбросить</button>
        </div>
      </div>
      <div id="clientsError" class="state error hidden"></div>
      <div class="table-wrap">
        <table id="clientsTable">
          <thead>
            <tr>
              <th><button class="sort" onclick="setSort('crm')">CRM <span class="sortmark" id="sort-crm"></span></button></th>
              <th><button class="sort" onclick="setSort('domain')">Домен <span class="sortmark" id="sort-domain"></span></button></th>
              <th><button class="sort" onclick="setSort('client')">Клиент <span class="sortmark" id="sort-client"></span></button></th>
              <th><button class="sort" onclick="setSort('licenses')">Оплачено <span class="sortmark" id="sort-licenses"></span></button></th>
              <th><button class="sort" onclick="setSort('widget')">Виджет <span class="sortmark" id="sort-widget"></span></button></th>
              <th><button class="sort" onclick="setSort('status')">Статус <span class="sortmark" id="sort-status"></span></button></th>
              <th><button class="sort" onclick="setSort('expires')">Дата окончания <span class="sortmark" id="sort-expires"></span></button></th>
              <th><button class="sort" onclick="setSort('installed')">Дата установки <span class="sortmark" id="sort-installed"></span></button></th>
              <th><button class="sort" onclick="setSort('legacy')">Legacy <span class="sortmark" id="sort-legacy"></span></button></th>
              <th>Управление</th>
            </tr>
            <tr class="filters">
              <th><select data-filter="crm" onchange="applyTable()"><option value="">Все</option><option value="amo">amo</option></select></th>
              <th><input data-filter="domain" oninput="applyTable()" placeholder="Домен" /></th>
              <th><input data-filter="client" oninput="applyTable()" placeholder="Клиент" /></th>
              <th><input data-filter="licenses" oninput="applyTable()" placeholder="Лицензии" /></th>
              <th><input data-filter="widget" oninput="applyTable()" placeholder="Виджет" /></th>
              <th><input data-filter="status" oninput="applyTable()" placeholder="Статус" /></th>
              <th><input data-filter="expires" oninput="applyTable()" placeholder="Дата" /></th>
              <th><input data-filter="installed" oninput="applyTable()" placeholder="Дата" /></th>
              <th><select data-filter="legacy" onchange="applyTable()"><option value="">Все</option><option value="да">Да</option><option value="нет">Нет</option></select></th>
              <th></th>
            </tr>
          </thead>
          <tbody><tr><td colspan="10"><div class="state"><div class="skeleton"></div></div></td></tr></tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Ключи приватных интеграций</h2>
          <div class="subtitle">Технический блок ниже кабинета. Адрес возврата берётся из настроек сервера.</div>
        </div>
        <button class="secondary" onclick="loadIntegrations()">Обновить список</button>
      </div>
      <div class="table-wrap">
        <table id="integrationsTable" style="min-width:820px">
          <thead><tr><th>Виджет</th><th>Домен</th><th>Widget code</th><th>Client ID</th><th>Обновлено</th></tr></thead>
          <tbody><tr><td colspan="5"><div class="state">Загрузка...</div></td></tr></tbody>
        </table>
      </div>
    </section>
  </main>

  <div id="manualModal" class="modal-backdrop" onclick="closeManualModal(event)">
    <form class="modal" onsubmit="saveManualUser(event)">
      <div class="modal-head">
        <div>
          <h2>Добавить пользователя</h2>
          <div class="subtitle">Пока доступен один виджет. Введите домен, секрет, ID и widget code.</div>
        </div>
        <button class="modal-close" type="button" onclick="closeManualModal()">×</button>
      </div>
      <div class="grid">
        <div><label for="manualWidget">Виджет</label><select id="manualWidget"><option value="copy_leads">Копирование сделок</option></select></div>
        <div><label for="manualDomain">Домен</label><input id="manualDomain" placeholder="subdomain или subdomain.amocrm.ru" /></div>
        <div><label for="manualClientId">ID</label><input id="manualClientId" placeholder="Client ID" required /></div>
        <div><label for="manualClientSecret">Секрет</label><input id="manualClientSecret" type="password" placeholder="Client Secret" required /></div>
        <div><label for="manualWidgetCode">Виджет код</label><input id="manualWidgetCode" placeholder="Widget code" required /></div>
      </div>
      <div id="manualStatus" class="status-line"></div>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeManualModal()">Отмена</button>
        <button id="manualSaveButton" type="submit">Сохранить</button>
      </div>
    </form>
  </div>

  <script>
    const state = { accounts: [], integrations: [], rows: [], expanded: {}, sortKey: 'expires', sortDir: 'asc', quickFilter: '', loadingAccounts: false };
    const sessionKey = 'simplesales_admin_session';
    const loginKey = 'simplesales_admin_login';
    const widgetCatalog = [{ widgetSlug: 'copy_leads', widgetName: 'Копирование сделок' }];

    function authHeaders(){ return { 'x-admin-session': localStorage.getItem(sessionKey) || '' }; }
    function normalizeText(value){ return String(value == null ? '' : value).toLowerCase().trim(); }
    function escapeHtml(value){ return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[ch]; }); }
    function cleanError(text){ try{ const parsed = JSON.parse(text || '{}'); return parsed.message || text; }catch(e){ return text || 'Ошибка'; } }
    function setStatus(id,text,mode){ const el=document.getElementById(id); if(!el) return; el.textContent=text||''; el.className='status-line'+(mode?' '+mode:''); }
    function isoToText(value){ if(!value) return '-'; const d=new Date(value); if(Number.isNaN(d.getTime())) return value; return d.toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}); }
    function dateValue(value){ if(!value) return 0; const d=new Date(value); return Number.isNaN(d.getTime()) ? 0 : d.getTime(); }
    function dateInputValue(value){ if(!value) return ''; const d=new Date(value); if(Number.isNaN(d.getTime())) return ''; const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return y+'-'+m+'-'+day; }
    function shortDomain(value){ return String(value || '').replace(/^https?:\\/\\//i,'').replace(/\\/.*$/,'').replace(/\\.amocrm\\.ru$/i,'').replace(/\\.kommo\\.com$/i,'').replace(/\\.kommo\\.ru$/i,''); }

    async function apiFetch(url, options){
      const res = await fetch(url, Object.assign({}, options || {}, { headers: Object.assign({}, authHeaders(), (options && options.headers) || {}) }));
      if(res.status === 401){ logout(); throw new Error('Нужно войти заново'); }
      return res;
    }

    function showSetup(login){
      document.getElementById('setupView').classList.remove('hidden');
      document.getElementById('loginView').classList.add('hidden');
      document.getElementById('appView').classList.add('hidden');
      document.getElementById('setupLogin').value = login || 'admin';
    }
    function showApp(){
      document.getElementById('setupView').classList.add('hidden');
      document.getElementById('loginView').classList.add('hidden');
      document.getElementById('appView').classList.remove('hidden');
    }
    function logout(){
      localStorage.removeItem(sessionKey);
      document.getElementById('setupView').classList.add('hidden');
      document.getElementById('appView').classList.add('hidden');
      document.getElementById('loginView').classList.remove('hidden');
      setStatus('loginStatus','','');
    }

    async function checkSetup(){
      const res = await fetch('/billing/admin/setup-status');
      if(!res.ok) return { needsSetup:false, login:'admin' };
      return res.json();
    }
    async function submitSetupPassword(event){
      event.preventDefault();
      const login = document.getElementById('setupLogin').value.trim() || 'admin';
      const password = document.getElementById('setupPasswordInput').value.trim();
      const repeat = document.getElementById('setupPasswordRepeatInput').value.trim();
      if(password.length < 6){ setStatus('setupStatus','Пароль минимум 6 символов','error'); return; }
      if(password !== repeat){ setStatus('setupStatus','Пароли не совпадают','error'); return; }
      const button = document.getElementById('setupButton');
      button.disabled = true;
      setStatus('setupStatus','Сохраняю...','');
      try{
        const res = await fetch('/billing/admin/setup',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ login, password }) });
        if(!res.ok) throw new Error(await res.text());
        const data = await res.json();
        localStorage.setItem(sessionKey, data.session);
        localStorage.setItem(loginKey, data.login || login);
        document.getElementById('setupPasswordInput').value = '';
        document.getElementById('setupPasswordRepeatInput').value = '';
        showApp();
        await loadAll();
      }catch(e){ setStatus('setupStatus', cleanError(e.message), 'error'); }
      finally{ button.disabled = false; }
    }
    async function submitLogin(event){
      event.preventDefault();
      const button=document.getElementById('loginButton');
      button.disabled=true;
      setStatus('loginStatus','Проверяю...','');
      try{
        const login=document.getElementById('adminLoginInput').value.trim();
        const password=document.getElementById('adminPasswordInput').value.trim();
        const res=await fetch('/billing/admin/login',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ login, password }) });
        if(!res.ok) throw new Error(await res.text());
        const data=await res.json();
        localStorage.setItem(sessionKey,data.session);
        localStorage.setItem(loginKey,data.login||login);
        showApp();
        await loadAll();
      }catch(e){ setStatus('loginStatus', cleanError(e.message), 'error'); }
      finally{ button.disabled=false; }
    }

    async function loadAll(){ await Promise.all([loadIntegrations(), loadAccounts()]); }
    async function loadIntegrations(){
      const tbody=document.querySelector('#integrationsTable tbody');
      tbody.innerHTML='<tr><td colspan="5"><div class="state">Загрузка...</div></td></tr>';
      try{
        const res=await apiFetch('/billing/admin/integrations');
        if(!res.ok) throw new Error(await res.text());
        state.integrations=await res.json();
        renderIntegrations();
      }catch(e){ tbody.innerHTML='<tr><td colspan="5"><div class="state">'+escapeHtml(cleanError(e.message))+'</div></td></tr>'; }
    }
    function renderIntegrations(){
      const tbody=document.querySelector('#integrationsTable tbody');
      tbody.innerHTML='';
      if(!state.integrations.length){ tbody.innerHTML='<tr><td colspan="5"><div class="state">Пока нет приватных интеграций.</div></td></tr>'; return; }
      state.integrations.forEach(function(row){
        const tr=document.createElement('tr');
        tr.innerHTML='<td><b>'+escapeHtml(row.widgetName||'-')+'</b><div class="micro">'+escapeHtml(row.widgetSlug||'-')+'</div></td>'+
          '<td>'+escapeHtml(shortDomain(row.amoDomain||''))+'</td>'+
          '<td>'+escapeHtml(row.widgetCode||'-')+'</td>'+
          '<td>'+escapeHtml(row.amoClientId||'-')+'</td>'+
          '<td>'+escapeHtml(isoToText(row.updatedAt))+'</td>';
        tbody.appendChild(tr);
      });
    }
    async function loadAccounts(){
      state.loadingAccounts=true;
      document.getElementById('clientsError').classList.add('hidden');
      document.querySelector('#clientsTable tbody').innerHTML='<tr><td colspan="10"><div class="state"><div class="skeleton"></div></div></td></tr>';
      try{
        const res=await apiFetch('/billing/admin/accounts');
        if(!res.ok) throw new Error(await res.text());
        state.accounts=await res.json();
        state.rows=flattenRows(state.accounts);
        state.loadingAccounts=false;
        applyTable();
      }catch(e){
        state.loadingAccounts=false;
        document.querySelector('#clientsTable tbody').innerHTML='';
        const box=document.getElementById('clientsError');
        box.textContent=cleanError(e.message);
        box.classList.remove('hidden');
      }
    }

    function flattenRows(accounts){
      const rows=[];
      (accounts||[]).forEach(function(client){
        const widgets=client.widgets&&client.widgets.length?client.widgets:[{}];
        widgets.forEach(function(widget){
          const status=widget.status||{};
          const pendingWithoutWidget=!widget.id;
          const legacy=Boolean(widget.isLegacy || client.isLegacy || pendingWithoutWidget);
          const firstSeenSource=widget.firstSeenSource || client.firstSeenSource || (pendingWithoutWidget ? 'manual_copy' : '');
          const pendingStatusTitle=pendingWithoutWidget ? 'Не активирован' : '-';
          const pendingStatusState=pendingWithoutWidget ? 'not_activated' : '';
          const row={
            id: widget.id || client.amoId,
            clientKey: String(client.amoId || client.domain || ''),
            crm: widget.crm || client.crm || 'amo',
            domain: widget.domainShort || client.domainShort || shortDomain(widget.domain || client.domain),
            client: String(client.amoId || widget.amoId || ''),
            adminName: widget.adminName || client.adminName || '',
            adminEmail: widget.adminEmail || client.adminEmail || '',
            adminPhone: widget.adminPhone || client.adminPhone || '',
            billingInn: widget.billingInn || client.billingInn || '',
            billingLegalName: widget.billingLegalName || client.billingLegalName || '',
            billingOgrn: widget.billingOgrn || client.billingOgrn || '',
            latestInvoiceNumber: widget.latestInvoiceNumber || '',
            latestInvoiceStatus: widget.latestInvoiceStatus || '',
            latestInvoiceCreatedAt: widget.latestInvoiceCreatedAt || '',
            latestInvoicePaidAt: widget.latestInvoicePaidAt || '',
            invoices: widget.invoices || [],
            licenses: Number(client.paidLicensesCount != null ? client.paidLicensesCount : client.usersCount || 0),
            licenseSource: client.usersCountSource || 'stored',
            widget: widget.widgetName || 'Копирование сделок',
            widgetSlug: widget.widgetSlug || 'copy_leads',
            status: status.title || pendingStatusTitle,
            statusState: status.state || pendingStatusState,
            dateSource: status.expiresAt || status.paidUntil || status.trialEndsAt || status.graceExtendedUntil,
            expires: isoToText(status.expiresAt || status.paidUntil || status.trialEndsAt || status.graceExtendedUntil),
            expiresRaw: dateValue(status.expiresAt || status.paidUntil || status.trialEndsAt || status.graceExtendedUntil),
            installed: isoToText(widget.installedAt),
            installedRaw: dateValue(widget.installedAt),
            legacy: legacy ? 'да' : 'нет',
            firstSeenSource: firstSeenSource,
            accountId: widget.id
          };
          row.search = normalizeText([row.crm,row.domain,row.client,row.adminName,row.adminEmail,row.adminPhone,row.billingInn,row.billingLegalName,row.latestInvoiceNumber,row.latestInvoiceStatus,row.licenses,row.widget,row.widgetSlug,row.status,row.expires,row.installed,row.legacy,row.firstSeenSource].join(' '));
          rows.push(row);
        });
      });
      return rows;
    }
    function getFilters(){
      const filters={};
      document.querySelectorAll('[data-filter]').forEach(function(input){ filters[input.dataset.filter]=normalizeText(input.value); });
      return filters;
    }
    function setQuickFilter(value){ state.quickFilter=value||''; applyTable(); }
    function clearFilters(){
      document.getElementById('globalSearch').value='';
      document.querySelectorAll('[data-filter]').forEach(function(input){ input.value=''; });
      state.quickFilter='';
      applyTable();
    }
    function rowValue(row,key){
      if(key==='expires') return row.expiresRaw;
      if(key==='installed') return row.installedRaw;
      if(key==='licenses') return row.licenses;
      return row[key] || '';
    }
    function applyTable(){
      if(state.loadingAccounts) return;
      const global=normalizeText(document.getElementById('globalSearch').value);
      const filters=getFilters();
      const now=Date.now();
      const fourteenDays=14*24*60*60*1000;
      let rows=(state.rows||[]).filter(function(row){
        if(global && !row.search.includes(global)) return false;
        if(state.quickFilter==='ending' && (!row.expiresRaw || row.expiresRaw < now || row.expiresRaw > now + fourteenDays)) return false;
        return Object.keys(filters).every(function(key){
          if(!filters[key]) return true;
          return normalizeText(String(rowValue(row,key))).includes(filters[key]);
        });
      });
      rows.sort(function(a,b){
        const av=rowValue(a,state.sortKey);
        const bv=rowValue(b,state.sortKey);
        if(typeof av==='number' || typeof bv==='number') return (Number(av||0)-Number(bv||0))*(state.sortDir==='asc'?1:-1);
        return String(av||'').localeCompare(String(bv||''),'ru')*(state.sortDir==='asc'?1:-1);
      });
      updateKpis();
      updateSortMarks();
      renderRows(rows);
      document.getElementById('clientsMeta').textContent='Показано '+rows.length+' из '+state.rows.length+'. “Оплачено” — активные пользователи amoCRM, которые не являются бесплатными.';
    }
    function updateKpis(){
      const clients=new Set((state.rows||[]).map(function(row){ return row.clientKey; }));
      const licensesByClient={};
      let ending=0;
      const now=Date.now();
      const fourteenDays=14*24*60*60*1000;
      (state.rows||[]).forEach(function(row){
        licensesByClient[row.clientKey]=row.licenses;
        if(row.expiresRaw && row.expiresRaw >= now && row.expiresRaw <= now + fourteenDays) ending += 1;
      });
      document.getElementById('kpiClients').textContent=clients.size;
      document.getElementById('kpiWidgets').textContent=(state.rows||[]).length;
      document.getElementById('kpiLicenses').textContent=Object.keys(licensesByClient).reduce(function(sum,key){ return sum + Number(licensesByClient[key]||0); },0);
      document.getElementById('kpiEnding').textContent=ending;
    }
    function setSort(key){
      if(state.sortKey===key) state.sortDir=state.sortDir==='asc'?'desc':'asc';
      else { state.sortKey=key; state.sortDir='asc'; }
      applyTable();
    }
    function updateSortMarks(){
      ['crm','domain','client','licenses','widget','status','expires','installed','legacy'].forEach(function(key){
        const el=document.getElementById('sort-'+key);
        if(el) el.textContent=state.sortKey===key?(state.sortDir==='asc'?'↑':'↓'):'';
      });
    }
    function statusPill(row){
      const stateName=row.statusState;
      const cls=(stateName==='paid'||stateName==='trial'||stateName==='grace')?'ok':(stateName==='paid_expired'||stateName==='expired')?'bad':(stateName==='not_activated'||stateName==='legacy_not_activated')?'warn':'gray';
      return '<span class="pill '+cls+'">'+escapeHtml(row.status)+'</span>';
    }
    function renderRows(rows){
      const tbody=document.querySelector('#clientsTable tbody');
      tbody.innerHTML='';
      if(!rows.length){ tbody.innerHTML='<tr><td colspan="10"><div class="state">Ничего не найдено. Измените поиск или фильтры.</div></td></tr>'; return; }
      rows.forEach(function(row){
        const opened=state.expanded[row.clientKey]===true;
        const tr=document.createElement('tr');
        tr.innerHTML='<td><span class="pill amo">'+escapeHtml(row.crm)+'</span></td>'+
          '<td><div class="domain-main">'+escapeHtml(row.domain||'-')+'</div><div class="micro">ID '+escapeHtml(row.client||'-')+'</div></td>'+
          '<td><button class="secondary client-toggle" onclick="toggleClient(\\''+escapeHtml(row.clientKey)+'\\')">'+(opened?'−':'+')+'</button>'+escapeHtml(row.adminName||'Клиент')+'</td>'+
          '<td><span class="pill">'+escapeHtml(row.licenses)+'</span><div class="micro">'+(row.licenseSource==='amo_paid_active'?'amoCRM':'сохранено')+'</div></td>'+
          '<td><b>'+escapeHtml(row.widget)+'</b><div class="micro">'+escapeHtml(row.widgetSlug)+'</div></td>'+
          '<td>'+statusPill(row)+invoiceSummary(row)+'</td>'+
          '<td>'+escapeHtml(row.expires)+'</td>'+
          '<td>'+escapeHtml(row.installed)+'</td>'+
          '<td>'+escapeHtml(row.legacy)+'<div class="micro">'+escapeHtml(row.firstSeenSource||'')+'</div></td>'+
          '<td>'+licenseControls(row)+'</td>';
        tbody.appendChild(tr);
        if(opened){
          const details=document.createElement('tr');
          details.className='details-row';
          details.innerHTML='<td colspan="10"><div class="details-grid">'+
            '<div><div class="detail-label">Админ</div><div>'+escapeHtml(row.adminName||'-')+'</div></div>'+
            '<div><div class="detail-label">Email</div><div>'+escapeHtml(row.adminEmail||'-')+'</div></div>'+
            '<div><div class="detail-label">Телефон</div><div>'+escapeHtml(row.adminPhone||'-')+'</div></div>'+
            '<div><div class="detail-label">Домен</div><div>'+escapeHtml(row.domain||'-')+'</div></div>'+
            '<div><div class="detail-label">Юрлицо</div><div>'+escapeHtml(row.billingLegalName||'-')+'</div><div class="micro">ИНН '+escapeHtml(row.billingInn||'-')+(row.billingOgrn ? ', ОГРН '+escapeHtml(row.billingOgrn) : '')+'</div></div>'+
            '<div><div class="detail-label">Счета</div>'+invoiceControls(row)+'</div>'+
            '</div></td>';
          tbody.appendChild(details);
        }
      });
    }
    function invoiceStatusText(status){
      if(status==='paid') return 'оплачен';
      if(status==='issued') return 'выставлен';
      return 'нет';
    }
    function invoiceSummary(row){
      if(!row.latestInvoiceNumber) return '<div class="micro">Счёт: нет</div>';
      return '<div class="micro">Счёт: '+escapeHtml(invoiceStatusText(row.latestInvoiceStatus))+' · '+escapeHtml(row.latestInvoiceNumber)+'</div>';
    }
    function invoiceControls(row){
      const invoices=row.invoices||[];
      if(!invoices.length) return '<div>-</div>';
      return '<div class="invoice-history">'+invoices.map(function(invoice){
        const number=invoice.invoiceNumber||'';
        const options=[
          ['issued','Выставлен'],
          ['paid','Оплачен']
        ].map(function(item){
          return '<option value="'+item[0]+'" '+(invoice.status===item[0]?'selected':'')+'>'+item[1]+'</option>';
        }).join('');
        return '<div class="invoice-history__item">'+
          '<div><b>'+escapeHtml(number)+'</b> <span class="pill '+(invoice.status==='paid'?'ok':'warn')+'">'+escapeHtml(invoiceStatusText(invoice.status))+'</span>'+
          '<div class="micro">'+escapeHtml(invoice.legalName||'-')+' · ИНН '+escapeHtml(invoice.inn||'-')+'</div>'+
          '<div class="micro">Создан: '+escapeHtml(isoToText(invoice.createdAt))+(invoice.paidAt ? ' · оплачен: '+escapeHtml(isoToText(invoice.paidAt)) : '')+'</div></div>'+
          '<div class="license-actions">'+
          '<select id="invoice-status-'+escapeHtml(number)+'">'+options+'</select>'+
          '<button onclick="saveInvoiceStatus(\\''+escapeHtml(number)+'\\')">Сохранить</button>'+
          '<button class="secondary" onclick="downloadInvoice(\\''+escapeHtml(number)+'\\')">PDF</button>'+
          '</div></div>';
      }).join('')+'</div>';
    }
    function licenseControls(row){
      if(!row.accountId) return '<span class="muted">Нет установки</span>';
      const statusOptions=[
        ['paid','Оплачен'],
        ['paid_expired','Платный истёк'],
        ['trial','Триал'],
        ['expired','Триал истёк'],
        ['grace','+1 день'],
        ['not_activated','Не активирован'],
        ['legacy_not_activated','Legacy']
      ].map(function(item){
        return '<option value="'+item[0]+'" '+(row.statusState===item[0]?'selected':'')+'>'+item[1]+'</option>';
      }).join('');
      return '<div class="license-actions">'+
        '<select id="status-widget-'+escapeHtml(row.accountId)+'">'+statusOptions+'</select>'+
        '<input type="date" id="date-widget-'+escapeHtml(row.accountId)+'" value="'+escapeHtml(dateInputValue(row.dateSource))+'" />'+
        '<button onclick="saveWidgetLicense('+escapeHtml(row.accountId)+')">Сохранить</button>'+
        '<button class="secondary" onclick="extendWidget('+escapeHtml(row.accountId)+')">+30 дней</button>'+
        '<button class="danger" onclick="deleteWidget('+escapeHtml(row.accountId)+')">Удалить</button>'+
        '</div>';
    }
    function toggleClient(key){ state.expanded[key]=state.expanded[key]!==true; applyTable(); }

    function openManualModal(){
      const select=document.getElementById('manualWidget');
      select.innerHTML=widgetCatalog.map(function(item){ return '<option value="'+escapeHtml(item.widgetSlug)+'">'+escapeHtml(item.widgetName)+'</option>'; }).join('');
      setStatus('manualStatus','','');
      document.getElementById('manualClientSecret').value='';
      document.getElementById('manualModal').classList.add('open');
    }
    function closeManualModal(event){
      if(event && event.target.id !== 'manualModal') return;
      document.getElementById('manualModal').classList.remove('open');
    }
    async function saveManualUser(event){
      event.preventDefault();
      const button=document.getElementById('manualSaveButton');
      button.disabled=true;
      setStatus('manualStatus','Сохраняю...','');
      const selected=widgetCatalog[0];
      const payload={
        widgetName:selected.widgetName,
        widgetSlug:selected.widgetSlug,
        amoDomain:document.getElementById('manualDomain').value.trim(),
        widgetCode:document.getElementById('manualWidgetCode').value.trim(),
        clientId:document.getElementById('manualClientId').value.trim(),
        clientSecret:document.getElementById('manualClientSecret').value.trim()
      };
      try{
        const res=await apiFetch('/billing/admin/integrations',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        if(!res.ok) throw new Error(await res.text());
        setStatus('manualStatus','Сохранено','ok');
        await loadIntegrations();
        closeManualModal();
      }catch(e){ setStatus('manualStatus',cleanError(e.message),'error'); }
      finally{ button.disabled=false; }
    }
    async function extendWidget(accountId){
      const days=30;
      if(!Number.isFinite(days) || days < 1){ alert('Введите количество дней'); return; }
      const res=await apiFetch('/billing/admin/widget/'+accountId+'/extend',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ days:days }) });
      if(!res.ok){ alert('Ошибка: '+cleanError(await res.text())); return; }
      await loadAccounts();
    }
    async function saveInvoiceStatus(invoiceNumber){
      const status=document.getElementById('invoice-status-'+invoiceNumber).value;
      const res=await apiFetch('/billing/admin/invoice/'+encodeURIComponent(invoiceNumber),{ method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ status:status }) });
      if(!res.ok){ alert(cleanError(await res.text())); return; }
      await loadAccounts();
    }
    async function downloadInvoice(invoiceNumber){
      const res=await apiFetch('/billing/admin/invoice/'+encodeURIComponent(invoiceNumber)+'/pdf');
      if(!res.ok){ alert(cleanError(await res.text())); return; }
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');
      link.href=url;
      link.download='schet-'+invoiceNumber+'.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); },1000);
    }
    async function saveWidgetLicense(accountId){
      const status=document.getElementById('status-widget-'+accountId).value;
      const paidUntil=document.getElementById('date-widget-'+accountId).value;
      const res=await apiFetch('/billing/admin/widget/'+accountId+'/license',{ method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ status:status, paidUntil:paidUntil || null }) });
      if(!res.ok){ alert('Ошибка: '+cleanError(await res.text())); return; }
      await loadAccounts();
    }
    async function deleteWidget(accountId){
      if(!confirm('Удалить эту установку виджета из админки полностью? Действие нельзя отменить.')) return;
      const res=await apiFetch('/billing/admin/widget/'+accountId,{ method:'DELETE' });
      if(!res.ok){ alert('Ошибка: '+cleanError(await res.text())); return; }
      await loadAccounts();
      await loadIntegrations();
    }
    async function testTelegram(){
      const res=await apiFetch('/billing/admin/test-telegram');
      const text=await res.text();
      if(!res.ok){ alert('Ошибка Telegram-теста: '+cleanError(text)); return; }
      try{ const data=JSON.parse(text); alert(data.message || 'Готово'); }catch(e){ alert(text || 'Готово'); }
    }

    (async function boot(){
      const savedLogin=localStorage.getItem(loginKey);
      if(savedLogin) document.getElementById('adminLoginInput').value=savedLogin;
      const setup=await checkSetup();
      if(setup.needsSetup){ localStorage.removeItem(sessionKey); showSetup(setup.login); return; }
      if(localStorage.getItem(sessionKey)){ showApp(); await loadAll(); }
    })();
  </script>
</body>
</html>`;
  }

}
