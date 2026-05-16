import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHash } from 'crypto';
import { Account } from 'src/accounts/account.entity';
import { AccountsService } from 'src/accounts/accounts.service';
import { normalizeAmoDomain } from 'src/helpers/amo-domain';

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

type AdminLoginPayload = {
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
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly accountsService: AccountsService,
    private readonly configService: ConfigService,
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

  private createAdminSessionToken(login: string) {
    const normalizedLogin = String(login || '').trim();
    const password = this.getAdminPassword();
    const secret = this.getAdminSessionSecret();
    const hash = createHash('sha256')
      .update(`${normalizedLogin}:${password}:${secret}`)
      .digest('hex');
    return `${normalizedLogin}.${hash}`;
  }

  loginAdmin(payload: AdminLoginPayload) {
    const expectedLogin = this.getAdminLogin();
    const expectedPassword = this.getAdminPassword();
    if (!expectedPassword) {
      throw new UnauthorizedException('ADMIN_PASSWORD или ADMIN_TOKEN не задан');
    }

    const login = String(payload?.login || '').trim();
    const password = String(payload?.password || '').trim();
    if (login !== expectedLogin || password !== expectedPassword) {
      throw new UnauthorizedException('Неверный логин или пароль');
    }

    return {
      session: this.createAdminSessionToken(login),
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
    };
  }

  private toPendingAccountView(): LicenseView {
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
      isLegacy: false,
      firstSeenSource: null,
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
    if (normalized.isAmoAdmin || normalized.userRank === 'master') return;

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

  async trackInstall(payload: InstallPayload) {
    const account = await this.getAccountOrNull(
      payload.accountId,
      payload.widgetCode,
    );

    if (!account) {
      await this.upsertPendingClient(payload.accountId, payload.profile);
      const normalized = this.serializeProfile(payload.profile);
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
      await this.upsertPendingClient(payload.accountId, payload.profile);
      return this.toPendingAccountView();
    }

    let updated = await this.upsertProfile(account, payload.profile);
    const shouldMarkLegacy =
      !updated.firstSeenSource &&
      !updated.trialActivatedAt &&
      !updated.trialEndsAt &&
      !updated.paidUntil;

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

    if (statusBefore.isExpired && !profileUpdated.graceExtensionUsed) {
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

  ensureAdminSessionOrThrow(session: string) {
    const expectedLogin = this.getAdminLogin();
    const expectedPassword = this.getAdminPassword();
    if (!expectedPassword) {
      throw new UnauthorizedException('ADMIN_PASSWORD или ADMIN_TOKEN не задан');
    }
    if (!session || session !== this.createAdminSessionToken(expectedLogin)) {
      throw new UnauthorizedException('Сессия администратора истекла');
    }
  }

  ensureAdminAccessOrThrow(token: string, session: string) {
    if (session) {
      this.ensureAdminSessionOrThrow(session);
      return;
    }
    this.ensureAdminTokenOrThrow(token);
  }

  private isActiveAmoUser(user: any) {
    const rights = user?.rights || {};
    const explicitInactive =
      user?.is_active === false ||
      user?.active === false ||
      user?.isActive === false ||
      user?.is_deleted === true ||
      user?.isDeleted === true ||
      rights?.is_active === false ||
      rights?.active === false;
    const explicitFree =
      user?.is_free === true ||
      user?.isFree === true ||
      rights?.is_free === true ||
      rights?.isFree === true;
    const botType = String(user?.type || user?.user_type || '').toLowerCase();
    return !explicitInactive && !explicitFree && botType !== 'bot';
  }

  private async getCurrentAmoPaidUsersCount(account?: Account | null) {
    if (!account) return null;
    try {
      const api = this.accountsService.createConnector(
        account.amoId,
        account.widgetCode || undefined,
      );
      const response = await api.get('/api/v4/users', {
        params: { limit: 250 },
      });
      const users =
        response.data?._embedded?.users ||
        response.data?.users ||
        (Array.isArray(response.data) ? response.data : []);
      if (!Array.isArray(users)) return null;
      return users.filter((user) => this.isActiveAmoUser(user)).length;
    } catch (e) {
      this.logger.warn(
        `Не удалось получить текущие лицензии amoCRM для ${account.amoId}: ${
          e?.response?.status || e?.message || e
        }`,
      );
      return null;
    }
  }

  async getAdminAccounts() {
    const clients = await this.accountsService.findAllClients();
    const accounts = await this.accountsService.findAll();
    const clientRows = [];

    for (const client of clients) {
      const widgets = client.widgets || [];
      const liveUsersCount = await this.getCurrentAmoPaidUsersCount(widgets[0]);
      clientRows.push({
        id: client.id,
        amoId: client.amoId,
        domain: client.domain,
        adminName: client.adminName,
        adminEmail: client.adminEmail,
        adminPhone: client.adminPhone,
        usersCount: liveUsersCount ?? (client.usersCount || 0),
        usersCountSource: liveUsersCount === null ? 'stored' : 'amo',
        widgets: widgets.map((account) => this.toAdminAccountRow(account)),
      });
    }

    const knownClientIds = new Set(clientRows.map((client) => client.amoId));
    for (const account of accounts) {
      if (knownClientIds.has(account.amoId)) continue;
      const liveUsersCount = await this.getCurrentAmoPaidUsersCount(account);
      clientRows.push({
        id: null,
        amoId: account.amoId,
        domain: account.domain,
        adminName: account.adminName,
        adminEmail: account.adminEmail,
        adminPhone: account.adminPhone,
        usersCount: liveUsersCount ?? (account.usersCount || 0),
        usersCountSource: liveUsersCount === null ? 'stored' : 'amo',
        widgets: [this.toAdminAccountRow(account)],
      });
    }

    return clientRows;
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

  private toAdminAccountRow(account: Account) {
      const status = this.toPublicLicenseView(account);
      return {
        id: account.id,
        amoId: account.amoId,
        domain: account.domain,
        widgetName: account.widgetName || account.integration?.widgetName || 'Копирование сделок',
        widgetSlug: account.widgetSlug || account.integration?.widgetSlug || 'copy_leads',
        widgetCode: account.widgetCode || account.integration?.widgetCode,
        amoClientId: account.amoClientId || account.integration?.amoClientId,
        adminName: account.adminName,
        adminEmail: account.adminEmail,
        adminPhone: account.adminPhone,
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
  <title>Админка виджета</title>
  <style>
    :root{color-scheme:light;--bg:#f5f5f7;--surface:rgba(255,255,255,.82);--surface-solid:#fff;--line:rgba(60,60,67,.14);--line-strong:rgba(60,60,67,.24);--text:#1d1d1f;--muted:#6e6e73;--blue:#007aff;--green:#34c759;--red:#ff3b30;--orange:#ff9500;--shadow:0 18px 45px rgba(0,0,0,.08)}
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;background:linear-gradient(180deg,#fbfbfd 0%,var(--bg) 42%,#ededf1 100%);color:var(--text);margin:0;min-height:100vh}
    button,input,select{font:inherit}
    button{border:0;border-radius:10px;background:var(--blue);color:#fff;padding:9px 13px;cursor:pointer;transition:transform .12s ease,background .12s ease,opacity .12s ease,box-shadow .12s ease}
    button:hover{box-shadow:0 8px 22px rgba(0,122,255,.22)}
    button:active{transform:scale(.98)}
    button:disabled{cursor:not-allowed;opacity:.48;box-shadow:none}
    button.secondary{background:#fff;color:var(--text);border:1px solid var(--line-strong)}
    button.secondary:hover{box-shadow:0 8px 22px rgba(0,0,0,.07)}
    button.danger{background:#fff;color:var(--red);border:1px solid rgba(255,59,48,.32)}
    input,select{width:100%;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.9);color:var(--text);padding:9px 11px;outline:none;transition:border .12s ease,box-shadow .12s ease}
    input:focus,select:focus{border-color:rgba(0,122,255,.58);box-shadow:0 0 0 4px rgba(0,122,255,.12)}
    label{display:block;font-size:12px;font-weight:650;color:var(--muted);margin:0 0 6px}
    h1,h2{margin:0}
    h1{font-size:28px;line-height:1.1;letter-spacing:0}
    h2{font-size:18px;line-height:1.2}
    .page{width:min(1480px,calc(100% - 36px));margin:0 auto;padding:26px 0 42px}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
    .subtitle{margin-top:7px;color:var(--muted);font-size:14px}
    .panel{background:var(--surface);backdrop-filter:blur(22px);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:16px;margin-bottom:16px}
    .panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
    .toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
    .search{min-width:320px;max-width:520px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:12px}
    .login-wrap{min-height:100vh;display:grid;place-items:center;padding:20px}
    .login{width:min(420px,100%);background:rgba(255,255,255,.86);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:22px}
    .login h1{font-size:24px;margin-bottom:8px}
    .login .field{margin-top:14px}
    .login-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:18px}
    .status-line{min-height:20px;color:var(--muted);font-size:13px}
    .status-line.error{color:var(--red)}
    .status-line.ok{color:var(--green)}
    .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.62)}
    table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;min-width:1180px}
    th,td{border-bottom:1px solid var(--line);padding:10px 11px;text-align:left;vertical-align:top}
    thead th{position:sticky;top:0;background:rgba(246,246,248,.96);z-index:1;color:var(--muted);font-size:12px;font-weight:700}
    thead .filter-row th{top:39px;background:rgba(250,250,252,.96);padding:7px}
    thead input,thead select{height:30px;padding:5px 8px;border-radius:8px;font-size:12px}
    tbody tr:hover{background:rgba(0,122,255,.045)}
    tbody tr:last-child td{border-bottom:0}
    .sort{display:inline-flex;align-items:center;gap:5px;background:transparent;color:inherit;border:0;padding:0;box-shadow:none;font-weight:700}
    .sort:hover{box-shadow:none;color:var(--text)}
    .chevron{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:8px;background:#fff;border:1px solid var(--line);color:var(--text);margin-right:8px}
    .client-title{display:flex;align-items:center;gap:4px;font-weight:760}
    .domain{color:var(--muted);font-size:12px;margin-top:3px}
    .widget-row td{background:rgba(255,255,255,.48)}
    .widget-name{padding-left:45px;font-weight:650}
    .muted{color:var(--muted)}
    .pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 8px;background:#fff;border:1px solid var(--line);font-size:12px;font-weight:650;white-space:nowrap}
    .pill.green{color:#0a7c2f;background:rgba(52,199,89,.12);border-color:rgba(52,199,89,.24)}
    .pill.red{color:#bd1d15;background:rgba(255,59,48,.1);border-color:rgba(255,59,48,.22)}
    .pill.orange{color:#9a5a00;background:rgba(255,149,0,.12);border-color:rgba(255,149,0,.24)}
    .pill.gray{color:var(--muted)}
    .actions{display:flex;align-items:center;gap:8px}
    .actions input{width:76px}
    .state{padding:18px;color:var(--muted);text-align:center}
    .skeleton{height:15px;border-radius:999px;background:linear-gradient(90deg,#ececf0,#fafafa,#ececf0);background-size:220% 100%;animation:pulse 1.2s linear infinite}
    @keyframes pulse{to{background-position:-220% 0}}
    .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.22);backdrop-filter:blur(10px);display:none;align-items:center;justify-content:center;padding:18px;z-index:20}
    .modal-backdrop.open{display:flex}
    .modal{width:min(620px,100%);background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.22);padding:18px}
    .modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
    .modal-close{width:32px;height:32px;border-radius:50%;padding:0;background:#e5e5ea;color:var(--text)}
    .modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
    .hidden{display:none!important}
    @media(max-width:760px){.page{width:min(100% - 20px,1480px);padding-top:16px}.topbar,.panel-head{align-items:flex-start;flex-direction:column}.toolbar{width:100%}.search{min-width:0;width:100%}.grid{grid-template-columns:1fr}h1{font-size:24px}}
  </style>
</head>
<body>
  <section id="loginView" class="login-wrap">
    <form class="login" onsubmit="login(event)">
      <h1>SimpleSales Admin</h1>
      <div class="subtitle">Вход в кабинет управления клиентами и приватными виджетами.</div>
      <div class="field">
        <label for="login">Логин</label>
        <input id="login" autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">Пароль</label>
        <input id="password" type="password" autocomplete="current-password" />
      </div>
      <div class="login-actions">
        <div id="loginStatus" class="status-line"></div>
        <button id="loginButton" type="submit">Войти</button>
      </div>
    </form>
  </section>

  <main id="appView" class="page hidden">
    <div class="topbar">
      <div>
        <h1>Админка виджетов SimpleSales</h1>
        <div class="subtitle">Клиенты, лицензии amoCRM и установленные приватные виджеты.</div>
      </div>
      <div class="toolbar">
        <button onclick="openManualModal()">Добавить пользователя</button>
        <button class="secondary" onclick="loadAll()">Обновить</button>
        <button class="secondary" onclick="testTelegram()">Проверить Telegram</button>
        <button class="secondary" onclick="logout()">Выйти</button>
      </div>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Клиенты и установленные виджеты</h2>
          <div id="clientsMeta" class="subtitle">Загрузка...</div>
        </div>
        <input id="globalSearch" class="search" placeholder="Поиск по любому столбцу" oninput="applyTable()" />
      </div>
      <div id="clientsError" class="state hidden"></div>
      <div class="table-wrap">
        <table id="clientsTable">
          <thead>
            <tr>
              <th><button class="sort" onclick="setSort('client')">Клиент <span id="sort-client"></span></button></th>
              <th><button class="sort" onclick="setSort('domain')">Домен <span id="sort-domain"></span></button></th>
              <th><button class="sort" onclick="setSort('users')">Юзеры <span id="sort-users"></span></button></th>
              <th><button class="sort" onclick="setSort('admin')">Админ <span id="sort-admin"></span></button></th>
              <th><button class="sort" onclick="setSort('widgets')">Виджеты <span id="sort-widgets"></span></button></th>
              <th><button class="sort" onclick="setSort('status')">Статус <span id="sort-status"></span></button></th>
              <th><button class="sort" onclick="setSort('expires')">Дата окончания <span id="sort-expires"></span></button></th>
              <th><button class="sort" onclick="setSort('installed')">Дата установки <span id="sort-installed"></span></button></th>
              <th><button class="sort" onclick="setSort('legacy')">Legacy <span id="sort-legacy"></span></button></th>
              <th>Действие</th>
            </tr>
            <tr class="filter-row">
              <th><input data-filter="client" oninput="applyTable()" placeholder="Фильтр" /></th>
              <th><input data-filter="domain" oninput="applyTable()" placeholder="Фильтр" /></th>
              <th><input data-filter="users" oninput="applyTable()" placeholder="Фильтр" /></th>
              <th><input data-filter="admin" oninput="applyTable()" placeholder="Фильтр" /></th>
              <th><input data-filter="widgets" oninput="applyTable()" placeholder="Фильтр" /></th>
              <th><input data-filter="status" oninput="applyTable()" placeholder="Фильтр" /></th>
              <th><input data-filter="expires" oninput="applyTable()" placeholder="Фильтр" /></th>
              <th><input data-filter="installed" oninput="applyTable()" placeholder="Фильтр" /></th>
              <th>
                <select data-filter="legacy" onchange="applyTable()">
                  <option value="">Все</option>
                  <option value="да">Да</option>
                  <option value="нет">Нет</option>
                </select>
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="10"><div class="state"><div class="skeleton"></div></div></td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Ключи приватных интеграций</h2>
          <div class="subtitle">Секрет хранится зашифрованно и не показывается после сохранения.</div>
        </div>
        <button class="secondary" onclick="loadIntegrations()">Обновить список</button>
      </div>
      <div class="table-wrap">
        <table id="integrationsTable" style="min-width:860px">
          <thead>
            <tr>
              <th>Виджет</th>
              <th>Домен</th>
              <th>Widget code</th>
              <th>Client ID</th>
              <th>Redirect URI</th>
              <th>Обновлено</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="6"><div class="state">Загрузка...</div></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <div id="manualModal" class="modal-backdrop" onclick="closeManualModal(event)">
    <form class="modal" onsubmit="saveManualUser(event)">
      <div class="modal-head">
        <div>
          <h2>Добавить пользователя</h2>
          <div class="subtitle">Выберите виджет и внесите ключи приватной интеграции.</div>
        </div>
        <button class="modal-close" type="button" onclick="closeManualModal()">×</button>
      </div>
      <div class="grid">
        <div>
          <label for="manualWidget">Виджет</label>
          <select id="manualWidget"></select>
        </div>
        <div>
          <label for="manualDomain">Домен</label>
          <input id="manualDomain" placeholder="company.amocrm.ru" />
        </div>
        <div>
          <label for="manualClientId">ID</label>
          <input id="manualClientId" placeholder="Client ID" required />
        </div>
        <div>
          <label for="manualClientSecret">Секрет</label>
          <input id="manualClientSecret" type="password" placeholder="Client Secret" required />
        </div>
        <div>
          <label for="manualWidgetCode">Виджет код</label>
          <input id="manualWidgetCode" placeholder="Widget code" required />
        </div>
        <div>
          <label for="manualRedirectUri">Redirect URI</label>
          <input id="manualRedirectUri" placeholder="По умолчанию из сервера" />
        </div>
      </div>
      <div id="manualStatus" class="status-line"></div>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeManualModal()">Отмена</button>
        <button id="manualSaveButton" type="submit">Сохранить</button>
      </div>
    </form>
  </div>

  <script>
    const state = {
      accounts: [],
      integrations: [],
      expanded: {},
      sortKey: 'domain',
      sortDir: 'asc',
      loadingAccounts: false
    };

    const sessionKey = 'simplesales_admin_session';
    const loginKey = 'simplesales_admin_login';

    function authHeaders(){
      return { 'x-admin-session': localStorage.getItem(sessionKey) || '' };
    }

    function setStatus(id, text, mode){
      const el = document.getElementById(id);
      if(!el) return;
      el.textContent = text || '';
      el.className = 'status-line' + (mode ? ' ' + mode : '');
    }

    async function login(event){
      if(event) event.preventDefault();
      const button = document.getElementById('loginButton');
      button.disabled = true;
      setStatus('loginStatus', 'Проверяю...', '');
      try{
        const login = document.getElementById('login').value.trim();
        const password = document.getElementById('password').value.trim();
        const res = await fetch('/billing/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login, password })
        });
        if(!res.ok) throw new Error(await res.text());
        const data = await res.json();
        localStorage.setItem(sessionKey, data.session);
        localStorage.setItem(loginKey, data.login || login);
        showApp();
        await loadAll();
      }catch(e){
        setStatus('loginStatus', cleanError(e.message), 'error');
      }finally{
        button.disabled = false;
      }
    }

    function logout(){
      localStorage.removeItem(sessionKey);
      document.getElementById('appView').classList.add('hidden');
      document.getElementById('loginView').classList.remove('hidden');
      setStatus('loginStatus', '', '');
    }

    function showApp(){
      document.getElementById('loginView').classList.add('hidden');
      document.getElementById('appView').classList.remove('hidden');
    }

    function cleanError(text){
      try{
        const parsed = JSON.parse(text || '{}');
        return parsed.message || text;
      }catch(e){
        return text || 'Ошибка';
      }
    }

    function isoToText(value){
      if(!value) return '-';
      const d = new Date(value);
      if(Number.isNaN(d.getTime())) return value;
      return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    }

    function dateValue(value){
      if(!value) return 0;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    }

    function escapeHtml(value){
      return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[ch];
      });
    }

    function normalizeText(value){
      return String(value == null ? '' : value).toLowerCase().trim();
    }

    async function apiFetch(url, options){
      const res = await fetch(url, Object.assign({}, options || {}, {
        headers: Object.assign({}, authHeaders(), (options && options.headers) || {})
      }));
      if(res.status === 401){
        logout();
        throw new Error('Нужно войти заново');
      }
      return res;
    }

    async function loadAll(){
      await Promise.all([loadIntegrations(), loadAccounts()]);
    }

    async function loadIntegrations(){
      const tbody = document.querySelector('#integrationsTable tbody');
      tbody.innerHTML = '<tr><td colspan="6"><div class="state">Загрузка...</div></td></tr>';
      try{
        const res = await apiFetch('/billing/admin/integrations');
        if(!res.ok) throw new Error(await res.text());
        state.integrations = await res.json();
        renderIntegrations();
        renderWidgetSelect();
      }catch(e){
        tbody.innerHTML = '<tr><td colspan="6"><div class="state">' + escapeHtml(cleanError(e.message)) + '</div></td></tr>';
      }
    }

    function renderIntegrations(){
      const tbody = document.querySelector('#integrationsTable tbody');
      tbody.innerHTML = '';
      if(!state.integrations.length){
        tbody.innerHTML = '<tr><td colspan="6"><div class="state">Пока нет приватных интеграций.</div></td></tr>';
        return;
      }
      state.integrations.forEach(function(row){
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><b>' + escapeHtml(row.widgetName || '-') + '</b><div class="muted">' + escapeHtml(row.widgetSlug || '-') + '</div></td>' +
          '<td>' + escapeHtml(row.amoDomain || '-') + '</td>' +
          '<td>' + escapeHtml(row.widgetCode || '-') + '</td>' +
          '<td>' + escapeHtml(row.amoClientId || '-') + '</td>' +
          '<td>' + escapeHtml(row.redirectUri || '-') + '</td>' +
          '<td>' + escapeHtml(isoToText(row.updatedAt)) + '</td>';
        tbody.appendChild(tr);
      });
    }

    function renderWidgetSelect(){
      const select = document.getElementById('manualWidget');
      const previous = select.value;
      const options = state.integrations.length ? state.integrations : [{
        widgetName: 'Копирование сделок',
        widgetSlug: 'copy_leads',
        widgetCode: ''
      }];
      select.innerHTML = options.map(function(item, index){
        const value = item.widgetCode || 'new-' + index;
        return '<option value="' + escapeHtml(value) + '">' + escapeHtml(item.widgetName || 'Копирование сделок') + '</option>';
      }).join('');
      if(previous) select.value = previous;
    }

    async function loadAccounts(){
      state.loadingAccounts = true;
      document.getElementById('clientsError').classList.add('hidden');
      document.querySelector('#clientsTable tbody').innerHTML = '<tr><td colspan="10"><div class="state"><div class="skeleton"></div></div></td></tr>';
      try{
        const res = await apiFetch('/billing/admin/accounts');
        if(!res.ok) throw new Error(await res.text());
        state.accounts = await res.json();
        state.loadingAccounts = false;
        applyTable();
      }catch(e){
        state.loadingAccounts = false;
        document.querySelector('#clientsTable tbody').innerHTML = '';
        const box = document.getElementById('clientsError');
        box.textContent = cleanError(e.message);
        box.classList.remove('hidden');
      }
    }

    function getClientAggregate(row){
      const widgets = row.widgets || [];
      const primary = widgets[0] || {};
      const status = primary.status || {};
      const installedAt = widgets.reduce(function(acc, widget){
        const value = dateValue(widget.installedAt);
        return !acc || (value && value < acc) ? value : acc;
      }, 0);
      const legacy = widgets.some(function(widget){ return Boolean(widget.isLegacy); });
      return {
        client: String(row.amoId || ''),
        domain: row.domain || '',
        users: String(row.usersCount || 0),
        admin: [row.adminName, row.adminEmail, row.adminPhone].filter(Boolean).join(' '),
        widgets: String(widgets.length || 0),
        status: status.title || '-',
        expires: isoToText(status.expiresAt),
        expiresRaw: dateValue(status.expiresAt),
        installed: installedAt ? isoToText(new Date(installedAt).toISOString()) : '-',
        installedRaw: installedAt,
        legacy: legacy ? 'да' : 'нет'
      };
    }

    function collectSearchText(row){
      const aggregate = getClientAggregate(row);
      const widgetText = (row.widgets || []).map(function(widget){
        return [
          widget.widgetName,
          widget.widgetSlug,
          widget.amoClientId,
          widget.status && widget.status.title,
          isoToText(widget.status && widget.status.expiresAt),
          isoToText(widget.installedAt),
          widget.isLegacy ? 'да legacy' : 'нет',
          widget.firstSeenSource
        ].join(' ');
      }).join(' ');
      return normalizeText(Object.keys(aggregate).map(function(key){ return aggregate[key]; }).join(' ') + ' ' + widgetText);
    }

    function getFilters(){
      const filters = {};
      document.querySelectorAll('[data-filter]').forEach(function(input){
        filters[input.dataset.filter] = normalizeText(input.value);
      });
      return filters;
    }

    function applyTable(){
      if(state.loadingAccounts) return;
      const global = normalizeText(document.getElementById('globalSearch').value);
      const filters = getFilters();
      let rows = (state.accounts || []).filter(function(row){
        const aggregate = getClientAggregate(row);
        if(global && !collectSearchText(row).includes(global)) return false;
        return Object.keys(filters).every(function(key){
          if(!filters[key]) return true;
          return normalizeText(aggregate[key]).includes(filters[key]);
        });
      });
      rows.sort(function(a,b){
        const aa = getClientAggregate(a);
        const bb = getClientAggregate(b);
        let av = aa[state.sortKey];
        let bv = bb[state.sortKey];
        if(state.sortKey === 'expires'){
          av = aa.expiresRaw;
          bv = bb.expiresRaw;
        }
        if(state.sortKey === 'installed'){
          av = aa.installedRaw;
          bv = bb.installedRaw;
        }
        if(state.sortKey === 'users' || state.sortKey === 'widgets'){
          av = Number(av || 0);
          bv = Number(bv || 0);
        }
        if(typeof av === 'number' || typeof bv === 'number'){
          return (Number(av || 0) - Number(bv || 0)) * (state.sortDir === 'asc' ? 1 : -1);
        }
        return String(av || '').localeCompare(String(bv || ''), 'ru') * (state.sortDir === 'asc' ? 1 : -1);
      });
      renderAccounts(rows);
      updateSortMarks();
      document.getElementById('clientsMeta').textContent = 'Показано ' + rows.length + ' из ' + state.accounts.length + '. Юзеры считаются по текущим платным лицензиям amoCRM.';
    }

    function setSort(key){
      if(state.sortKey === key){
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      }else{
        state.sortKey = key;
        state.sortDir = 'asc';
      }
      applyTable();
    }

    function updateSortMarks(){
      ['client','domain','users','admin','widgets','status','expires','installed','legacy'].forEach(function(key){
        const el = document.getElementById('sort-' + key);
        if(el) el.textContent = state.sortKey === key ? (state.sortDir === 'asc' ? '↑' : '↓') : '';
      });
    }

    function statusPill(status){
      const stateName = status && status.state;
      const cls = stateName === 'paid' || stateName === 'trial' || stateName === 'grace'
        ? 'green'
        : stateName === 'paid_expired' || stateName === 'expired'
          ? 'red'
          : stateName === 'not_activated' || stateName === 'legacy_not_activated'
            ? 'orange'
            : 'gray';
      return '<span class="pill ' + cls + '">' + escapeHtml(status && status.title || '-') + '</span>';
    }

    function renderAccounts(rows){
      const tbody = document.querySelector('#clientsTable tbody');
      tbody.innerHTML = '';
      if(!rows.length){
        tbody.innerHTML = '<tr><td colspan="10"><div class="state">Ничего не найдено. Проверьте поиск или фильтры.</div></td></tr>';
        return;
      }
      rows.forEach(function(row){
        const aggregate = getClientAggregate(row);
        const key = String(row.amoId || row.domain || Math.random());
        const widgets = row.widgets || [];
        const opened = state.expanded[key] === true;
        const tr = document.createElement('tr');
        tr.className = 'client-row';
        tr.innerHTML =
          '<td><div class="client-title"><button class="chevron" onclick="toggleClient(\\'' + escapeHtml(key) + '\\')">' + (opened ? '⌄' : '›') + '</button>' + escapeHtml(row.amoId || '-') + '</div></td>' +
          '<td><b>' + escapeHtml(row.domain || '-') + '</b></td>' +
          '<td><span class="pill">' + escapeHtml(row.usersCount || 0) + '</span><div class="domain">' + (row.usersCountSource === 'amo' ? 'amoCRM' : 'сохранено') + '</div></td>' +
          '<td><div>' + escapeHtml(row.adminName || '-') + '</div><div class="muted">' + escapeHtml(row.adminEmail || '-') + '</div><div class="muted">' + escapeHtml(row.adminPhone || '-') + '</div></td>' +
          '<td><span class="pill">' + escapeHtml(widgets.length) + '</span></td>' +
          '<td>' + statusPill(widgets[0] && widgets[0].status) + '</td>' +
          '<td>' + escapeHtml(aggregate.expires) + '</td>' +
          '<td>' + escapeHtml(aggregate.installed) + '</td>' +
          '<td>' + escapeHtml(aggregate.legacy) + '</td>' +
          '<td></td>';
        tbody.appendChild(tr);
        if(opened){
          widgets.forEach(function(widget){
            const wtr = document.createElement('tr');
            wtr.className = 'widget-row';
            wtr.innerHTML =
              '<td><div class="widget-name">' + escapeHtml(widget.widgetName || '-') + '<div class="muted">' + escapeHtml(widget.widgetSlug || '-') + '</div></div></td>' +
              '<td>' + escapeHtml(widget.domain || row.domain || '-') + '</td>' +
              '<td>' + escapeHtml(widget.usersCount || row.usersCount || 0) + '</td>' +
              '<td><div>' + escapeHtml(widget.adminName || row.adminName || '-') + '</div><div class="muted">' + escapeHtml(widget.adminEmail || row.adminEmail || '-') + '</div></td>' +
              '<td>1</td>' +
              '<td>' + statusPill(widget.status) + '</td>' +
              '<td>' + escapeHtml(isoToText(widget.status && widget.status.expiresAt)) + '</td>' +
              '<td>' + escapeHtml(isoToText(widget.installedAt)) + '</td>' +
              '<td>' + (widget.isLegacy ? 'да' : 'нет') + '<div class="muted">' + escapeHtml(widget.firstSeenSource || '-') + '</div></td>' +
              '<td><div class="actions"><input type="number" min="1" value="30" id="days-widget-' + widget.id + '" /><button onclick="extendWidget(' + widget.id + ')">Начислить</button></div></td>';
            tbody.appendChild(wtr);
          });
        }
      });
    }

    function toggleClient(key){
      state.expanded[key] = state.expanded[key] !== true;
      applyTable();
    }

    function openManualModal(){
      renderWidgetSelect();
      setStatus('manualStatus', '', '');
      document.getElementById('manualClientSecret').value = '';
      document.getElementById('manualModal').classList.add('open');
    }

    function closeManualModal(event){
      if(event && event.target.id !== 'manualModal') return;
      document.getElementById('manualModal').classList.remove('open');
    }

    function selectedIntegration(){
      const code = document.getElementById('manualWidget').value;
      return state.integrations.find(function(item){ return item.widgetCode === code; }) || null;
    }

    async function saveManualUser(event){
      event.preventDefault();
      const button = document.getElementById('manualSaveButton');
      button.disabled = true;
      setStatus('manualStatus', 'Сохраняю...', '');
      const selected = selectedIntegration();
      const payload = {
        widgetName: selected && selected.widgetName || 'Копирование сделок',
        widgetSlug: selected && selected.widgetSlug || 'copy_leads',
        amoDomain: document.getElementById('manualDomain').value.trim(),
        widgetCode: document.getElementById('manualWidgetCode').value.trim(),
        clientId: document.getElementById('manualClientId').value.trim(),
        clientSecret: document.getElementById('manualClientSecret').value.trim(),
        redirectUri: document.getElementById('manualRedirectUri').value.trim()
      };
      try{
        const res = await apiFetch('/billing/admin/integrations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if(!res.ok) throw new Error(await res.text());
        setStatus('manualStatus', 'Сохранено', 'ok');
        await loadIntegrations();
        closeManualModal();
      }catch(e){
        setStatus('manualStatus', cleanError(e.message), 'error');
      }finally{
        button.disabled = false;
      }
    }

    async function extendWidget(accountId){
      const daysInput = document.getElementById('days-widget-' + accountId);
      const days = Number(daysInput && daysInput.value || 0);
      const res = await apiFetch('/billing/admin/widget/' + accountId + '/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: days })
      });
      if(!res.ok){
        alert('Ошибка: ' + cleanError(await res.text()));
        return;
      }
      await loadAccounts();
    }

    async function testTelegram(){
      const res = await apiFetch('/billing/admin/test-telegram');
      const text = await res.text();
      if(!res.ok){
        alert('Ошибка Telegram-теста: ' + cleanError(text));
        return;
      }
      try {
        const data = JSON.parse(text);
        alert(data.message || 'Готово');
      } catch (e) {
        alert(text || 'Готово');
      }
    }

    (function boot(){
      const savedLogin = localStorage.getItem(loginKey);
      if(savedLogin) document.getElementById('login').value = savedLogin;
      if(localStorage.getItem(sessionKey)){
        showApp();
        loadAll();
      }
    })();
  </script>
</body>
</html>`;
  }
}
