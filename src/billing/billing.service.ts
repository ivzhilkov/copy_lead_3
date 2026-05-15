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

  async getAdminAccounts() {
    const clients = await this.accountsService.findAllClients();
    const accounts = await this.accountsService.findAll();
    const clientRows = clients.map((client) => ({
      id: client.id,
      amoId: client.amoId,
      domain: client.domain,
      adminName: client.adminName,
      adminEmail: client.adminEmail,
      adminPhone: client.adminPhone,
      usersCount: client.usersCount || 0,
      widgets: (client.widgets || []).map((account) =>
        this.toAdminAccountRow(account),
      ),
    }));

    const knownClientIds = new Set(clientRows.map((client) => client.amoId));
    for (const account of accounts) {
      if (knownClientIds.has(account.amoId)) continue;
      clientRows.push({
        id: null,
        amoId: account.amoId,
        domain: account.domain,
        adminName: account.adminName,
        adminEmail: account.adminEmail,
        adminPhone: account.adminPhone,
        usersCount: account.usersCount || 0,
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
  }) {
    const saved = await this.accountsService.upsertIntegration({
      widgetName: String(payload.widgetName || 'Копирование сделок').trim(),
      widgetSlug: String(payload.widgetSlug || 'copy_leads').trim(),
      widgetCode: String(payload.widgetCode || '').trim(),
      amoClientId: String(payload.clientId || '').trim(),
      amoClientSecret: String(payload.clientSecret || '').trim(),
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
    body{font-family:Arial,sans-serif;background:#f5f7fb;color:#223;margin:0;padding:24px}
    h1,h2,h3{margin:0 0 12px}
    .card{background:#fff;border:1px solid #d8e0ee;border-radius:12px;padding:16px;margin-bottom:16px}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(220px,1fr));gap:10px}
    input,button{padding:8px 10px;border-radius:8px;border:1px solid #c8d2e3;font:inherit}
    input{background:#fff;color:#223}
    button{background:#2f87eb;color:#fff;border-color:#2f87eb;cursor:pointer}
    button.secondary{background:#eef4ff;color:#24528f;border-color:#c8d8f4}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #e7edf7;padding:8px;text-align:left;vertical-align:top}
    .muted{color:#60708a}
    .pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#eef4ff;color:#24528f;font-size:12px}
    .widget-row{background:#fbfdff}
    .client-row{background:#f7faff;font-weight:700}
    .secret-note{font-size:12px;color:#60708a;margin-top:8px}
    @media(max-width:900px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="card">
    <h1>Админка виджетов SimpleSales</h1>
    <div class="row">
      <label>Admin token:</label>
      <input id="token" style="min-width:320px" />
      <button onclick="loadAll()">Загрузить</button>
      <button onclick="testTelegram()">Проверить Telegram</button>
    </div>
  </div>

  <div class="card">
    <h2>Ключи приватных интеграций</h2>
    <div class="grid">
      <input id="widgetName" placeholder="Название виджета" value="Копирование сделок" />
      <input id="widgetSlug" placeholder="Код продукта" value="copy_leads" />
      <input id="widgetCode" placeholder="Widget code из amoCRM" />
      <input id="clientId" placeholder="Client ID из amoCRM" />
      <input id="clientSecret" placeholder="Client Secret из amoCRM" />
      <input id="redirectUri" placeholder="Redirect URI" />
    </div>
    <div class="row" style="margin-top:10px">
      <button onclick="saveIntegration()">Сохранить ключи</button>
      <button class="secondary" onclick="loadIntegrations()">Обновить список</button>
    </div>
    <div class="secret-note">Для второй CRM сначала создайте приватную интеграцию в amoCRM, потом внесите сюда client_id, client_secret и widget_code. После этого авторизация будет работать на этом же Railway.</div>
    <table id="integrationsTable" style="margin-top:14px">
      <thead>
        <tr>
          <th>Виджет</th>
          <th>Widget code</th>
          <th>Client ID</th>
          <th>Redirect URI</th>
          <th>Обновлено</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="card">
    <h2>Клиенты и установленные виджеты</h2>
    <table id="clientsTable">
      <thead>
        <tr>
          <th>Account ID</th>
          <th>Домен</th>
          <th>Юзеры</th>
          <th>Админ</th>
          <th>Виджеты</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <script>
    function isoToText(value){
      if(!value) return '-';
      const d = new Date(value);
      if(Number.isNaN(d.getTime())) return value;
      return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    }

    function escapeHtml(value){
      return String(value ?? '').replace(/[&<>"']/g, function(ch){
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[ch];
      });
    }

    async function loadAll(){
      await Promise.all([loadIntegrations(), loadAccounts()]);
    }

    async function loadIntegrations(){
      const token = document.getElementById('token').value.trim();
      const res = await fetch('/billing/admin/integrations', {
        headers: { 'x-admin-token': token }
      });
      if(!res.ok){
        alert('Ошибка загрузки интеграций: '+res.status);
        return;
      }
      const data = await res.json();
      const tbody = document.querySelector('#integrationsTable tbody');
      tbody.innerHTML = '';
      (data || []).forEach(function(row){
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><b>' + escapeHtml(row.widgetName || '-') + '</b><div class="muted">' + escapeHtml(row.widgetSlug || '-') + '</div></td>' +
          '<td>' + escapeHtml(row.widgetCode || '-') + '</td>' +
          '<td>' + escapeHtml(row.amoClientId || '-') + '</td>' +
          '<td>' + escapeHtml(row.redirectUri || '-') + '</td>' +
          '<td>' + isoToText(row.updatedAt) + '</td>';
        tbody.appendChild(tr);
      });
    }

    async function saveIntegration(){
      const token = document.getElementById('token').value.trim();
      const payload = {
        widgetName: document.getElementById('widgetName').value.trim(),
        widgetSlug: document.getElementById('widgetSlug').value.trim(),
        widgetCode: document.getElementById('widgetCode').value.trim(),
        clientId: document.getElementById('clientId').value.trim(),
        clientSecret: document.getElementById('clientSecret').value.trim(),
        redirectUri: document.getElementById('redirectUri').value.trim()
      };
      const res = await fetch('/billing/admin/integrations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': token
        },
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        const text = await res.text();
        alert('Ошибка сохранения ключей: ' + text);
        return;
      }
      document.getElementById('clientSecret').value = '';
      await loadIntegrations();
      alert('Ключи сохранены');
    }

    async function loadAccounts(){
      const token = document.getElementById('token').value.trim();
      const res = await fetch('/billing/admin/accounts', {
        headers: { 'x-admin-token': token }
      });
      if(!res.ok){
        alert('Ошибка загрузки: '+res.status);
        return;
      }
      const data = await res.json();
      const tbody = document.querySelector('#clientsTable tbody');
      tbody.innerHTML = '';
      (data || []).forEach(function(row){
        const tr = document.createElement('tr');
        tr.className = 'client-row';
        tr.innerHTML =
          '<td>' + escapeHtml(row.amoId ?? '-') + '</td>' +
          '<td>' + escapeHtml(row.domain || '-') + '</td>' +
          '<td>' + escapeHtml(row.usersCount || 0) + '</td>' +
          '<td>' +
            '<div>' + escapeHtml(row.adminName || '-') + '</div>' +
            '<div class="muted">' + escapeHtml(row.adminEmail || '-') + '</div>' +
            '<div class="muted">' + escapeHtml(row.adminPhone || '-') + '</div>' +
          '</td>' +
          '<td><span class="pill">' + escapeHtml((row.widgets || []).length) + '</span></td>';
        tbody.appendChild(tr);

        (row.widgets || []).forEach(function(widget){
          const wtr = document.createElement('tr');
          wtr.className = 'widget-row';
          wtr.innerHTML =
            '<td></td>' +
            '<td><b>' + escapeHtml(widget.widgetName || '-') + '</b><div class="muted">' + escapeHtml(widget.widgetCode || '-') + '</div></td>' +
            '<td colspan="2">' +
              '<div>Статус: <b>' + escapeHtml(widget.status?.title || '-') + '</b></div>' +
              '<div class="muted">Срок: ' + escapeHtml(isoToText(widget.status?.expiresAt)) + '</div>' +
              '<div class="muted">Установлен: ' + escapeHtml(isoToText(widget.installedAt)) + '</div>' +
              '<div class="muted">Legacy: ' + (widget.isLegacy ? 'да' : 'нет') + '; источник: ' + escapeHtml(widget.firstSeenSource || '-') + '</div>' +
            '</td>' +
            '<td>' +
              '<div class="row">' +
                '<input type="number" min="1" value="30" style="width:80px" id="days-widget-' + widget.id + '" />' +
                '<button onclick="extendWidget(' + widget.id + ')">Начислить</button>' +
              '</div>' +
            '</td>';
          tbody.appendChild(wtr);
        });
      });
    }

    async function extendWidget(accountId){
      const token = document.getElementById('token').value.trim();
      const days = Number(document.getElementById('days-widget-'+accountId).value || 0);
      const res = await fetch('/billing/admin/widget/'+accountId+'/extend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': token
        },
        body: JSON.stringify({ days })
      });
      if(!res.ok){
        const text = await res.text();
        alert('Ошибка: ' + text);
        return;
      }
      await loadAccounts();
    }

    async function testTelegram(){
      const token = document.getElementById('token').value.trim();
      const res = await fetch('/billing/admin/test-telegram', {
        headers: { 'x-admin-token': token }
      });
      const text = await res.text();
      if(!res.ok){
        alert('Ошибка Telegram-теста: ' + text);
        return;
      }
      try {
        const data = JSON.parse(text);
        alert(data.message || 'Готово');
      } catch (e) {
        alert(text || 'Готово');
      }
    }
  </script>
</body>
</html>`;
  }
}
