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

export type LicenseState =
  | 'not_activated'
  | 'trial'
  | 'paid'
  | 'grace'
  | 'expired';

export type PublicProfilePayload = {
  domain?: string;
  email?: string;
  phone?: string;
  userName?: string;
  userId?: number;
  usersCount?: number;
};

type InstallPayload = {
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
      state: 'not_activated' as LicenseState,
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
      };
    }

    if (state === 'expired') {
      return {
        state,
        title: 'Пробный период закончился',
        message: 'Пробный период закончился. Нажмите «Оплатить», чтобы запросить продление.',
        expiresAt: null,
        isExpired: true,
        canCopy: false,
        trialActivated: Boolean(account?.trialActivatedAt),
        trialEndsAt: this.toIso(account?.trialEndsAt),
        paidUntil: this.toIso(account?.paidUntil),
        graceExtendedUntil: this.toIso(account?.graceExtendedUntil),
        graceExtensionUsed: Boolean(account?.graceExtensionUsed),
      };
    }

    return {
      state: 'not_activated',
      title: 'Пробный период не активирован',
      message: 'Введите email и телефон и нажмите «Активировать пробный период».',
      expiresAt: null,
      isExpired: true,
      canCopy: false,
      trialActivated: false,
      trialEndsAt: this.toIso(account?.trialEndsAt),
      paidUntil: this.toIso(account?.paidUntil),
      graceExtendedUntil: this.toIso(account?.graceExtendedUntil),
      graceExtensionUsed: Boolean(account?.graceExtensionUsed),
    };
  }

  private async sendTelegramMessage(text: string) {
    const token = this.configService.get<string>('telegramBotToken');
    const chatId = this.configService.get<string>('telegramChatId');

    if (!token || !chatId) {
      this.logger.warn('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы, сообщение не отправлено');
      return;
    }

    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
      });
    } catch (e) {
      this.logger.error(`Ошибка отправки telegram сообщения: ${(e as Error)?.message || e}`);
    }
  }

  private assertWidgetCode(widgetCode: string) {
    const expected = this.configService.get<string>('widgetCode');
    if (!expected || widgetCode !== expected) {
      throw new ForbiddenException('Неверный код виджета');
    }
  }

  private async getAccountOrFail(accountId: number) {
    const normalizedAccountId = Number(accountId);
    if (!Number.isFinite(normalizedAccountId) || normalizedAccountId <= 0) {
      throw new BadRequestException('Некорректный account_id');
    }

    const account = await this.accountsService.findByAmoId(normalizedAccountId);
    if (!account) {
      throw new NotFoundException('Аккаунт интеграции не найден');
    }

    return account;
  }

  private async upsertProfile(account: Account, profile?: PublicProfilePayload) {
    const normalized = this.serializeProfile(profile);
    const updatePayload: Partial<Account> = {
      domain:
        normalized.domain !== '-' ? normalized.domain : account.domain,
      adminName: normalized.userName !== '-' ? normalized.userName : account.adminName,
      adminEmail: normalized.email !== '-' ? normalized.email : account.adminEmail,
      adminPhone: normalized.phone !== '-' ? normalized.phone : account.adminPhone,
      adminUserId:
        normalized.userId !== null ? normalized.userId : account.adminUserId,
      usersCount:
        normalized.usersCount > 0 ? normalized.usersCount : account.usersCount || 0,
      lastSeenAt: this.getNow(),
    };

    return this.accountsService.update(account.id, updatePayload);
  }

  private getDomain(account: Account, profile?: PublicProfilePayload) {
    const raw = String(profile?.domain || account.domain || '').trim();
    return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  async trackInstall(payload: InstallPayload) {
    this.assertWidgetCode(payload.widgetCode);
    const account = await this.getAccountOrFail(payload.accountId);
    const updated = await this.upsertProfile(account, payload.profile);

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

  async getPublicStatus(accountId: number, widgetCode: string) {
    this.assertWidgetCode(widgetCode);
    const account = await this.getAccountOrFail(accountId);
    return this.toPublicLicenseView(account);
  }

  async activateTrial(payload: ActivateTrialPayload) {
    this.assertWidgetCode(payload.widgetCode);
    const account = await this.getAccountOrFail(payload.accountId);
    const profileUpdated = await this.upsertProfile(account, payload.profile);

    const { state } = this.calculateState(profileUpdated);
    if (state === 'paid' || state === 'trial' || state === 'grace') {
      return this.toPublicLicenseView(profileUpdated);
    }

    const now = this.getNow();
    const trialEndsAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
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
    this.assertWidgetCode(payload.widgetCode);
    const account = await this.getAccountOrFail(payload.accountId);
    const profileUpdated = await this.upsertProfile(account, payload.profile);
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

  ensureCanCopyOrThrow(account: Account) {
    const status = this.toPublicLicenseView(account);
    if (status.canCopy) return status;

    throw new ForbiddenException({
      code: 'billing_expired',
      message: status.state === 'not_activated'
        ? 'Пробный период не активирован'
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
    const accounts = await this.accountsService.findAll();
    return accounts.map((account) => {
      const status = this.toPublicLicenseView(account);
      return {
        id: account.id,
        amoId: account.amoId,
        domain: account.domain,
        adminName: account.adminName,
        adminEmail: account.adminEmail,
        adminPhone: account.adminPhone,
        usersCount: account.usersCount || 0,
        installedAt: this.toIso(account.installedAt),
        status,
      };
    });
  }

  async extendByDays(amoId: number, days: number) {
    const account = await this.getAccountOrFail(amoId);
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
    .card{background:#fff;border:1px solid #d8e0ee;border-radius:12px;padding:16px;margin-bottom:16px}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    input,button{padding:8px 10px;border-radius:8px;border:1px solid #c8d2e3}
    button{background:#2f87eb;color:#fff;border-color:#2f87eb;cursor:pointer}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #e7edf7;padding:8px;text-align:left;vertical-align:top}
    .muted{color:#60708a}
  </style>
</head>
<body>
  <div class="card">
    <h2>Клиенты виджета</h2>
    <div class="row">
      <label>Admin token:</label>
      <input id="token" style="min-width:320px" />
      <button onclick="loadAccounts()">Загрузить</button>
    </div>
  </div>

  <div class="card">
    <table id="table">
      <thead>
        <tr>
          <th>Account ID</th>
          <th>Домен</th>
          <th>Статус</th>
          <th>Срок</th>
          <th>Юзеры</th>
          <th>Админ</th>
          <th>Продлить</th>
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
      const tbody = document.querySelector('#table tbody');
      tbody.innerHTML = '';
      (data || []).forEach((row)=>{
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + (row.amoId ?? '-') + '</td>' +
          '<td>' + (row.domain || '-') + '</td>' +
          '<td>' + (row.status?.title || '-') + '</td>' +
          '<td>' + isoToText(row.status?.expiresAt) + '</td>' +
          '<td>' + (row.usersCount || 0) + '</td>' +
          '<td>' +
            '<div>' + (row.adminName || '-') + '</div>' +
            '<div class="muted">' + (row.adminEmail || '-') + '</div>' +
            '<div class="muted">' + (row.adminPhone || '-') + '</div>' +
          '</td>' +
          '<td>' +
            '<div class="row">' +
              '<input type="number" min="1" value="30" style="width:80px" id="days-' + row.amoId + '" />' +
              '<button onclick="extend(' + row.amoId + ')">Начислить</button>' +
            '</div>' +
          '</td>';
        tbody.appendChild(tr);
      })
    }

    async function extend(amoId){
      const token = document.getElementById('token').value.trim();
      const days = Number(document.getElementById('days-'+amoId).value || 0);
      const res = await fetch('/billing/admin/account/'+amoId+'/extend', {
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
  </script>
</body>
</html>`;
  }
}
