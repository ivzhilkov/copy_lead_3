import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosInstance } from 'axios';
import { ConfigService } from '@nestjs/config';
import { AuthService } from 'src/auth/auth.service';
import { GrantTypes } from 'src/enums/grant-types.enum';
import { normalizeAmoDomain } from 'src/helpers/amo-domain';
import { Repository } from 'typeorm';
import { Account } from './account.entity';
import { CrmClient } from './crm-client.entity';
import { WidgetIntegration } from './widget-integration.entity';

export type AmoIntegrationCredentials = {
  id?: number | null;
  widgetCode: string;
  amoClientId: string;
  amoClientSecret: string;
  redirectUri: string;
  amoDomain?: string | null;
  widgetSlug: string;
  widgetName: string;
};

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private readonly accountsRepo: Repository<Account>,
    @InjectRepository(CrmClient)
    private readonly clientsRepo: Repository<CrmClient>,
    @InjectRepository(WidgetIntegration)
    private readonly integrationsRepo: Repository<WidgetIntegration>,
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private getDefaultCredentials(): AmoIntegrationCredentials | null {
    const widgetCode = this.configService.get<string>('widgetCode');
    const amoClientId = this.configService.get<string>('clientId');
    const amoClientSecret = this.configService.get<string>('clientSecret');
    const redirectUri = this.configService.get<string>('redirectUri');

    if (!widgetCode || !amoClientId || !amoClientSecret || !redirectUri) {
      return null;
    }

    return {
      widgetCode,
      amoClientId,
      amoClientSecret,
      redirectUri,
      amoDomain: null,
      widgetSlug: 'copy_leads',
      widgetName: 'Копирование сделок',
    };
  }

  async findByAmoId(amoId: number, widgetCode?: string): Promise<Account> {
    const normalizedAmoId = Number(amoId);
    if (!Number.isFinite(normalizedAmoId)) return null;

    const where: any = { amoId: normalizedAmoId };
    if (widgetCode) where.widgetCode = widgetCode;

    return this.accountsRepo.findOne({
      where,
      relations: ['client', 'integration'],
      order: { id: 'DESC' },
    } as any);
  }

  findById(id: number): Promise<Account> {
    return this.accountsRepo.findOne(id, {
      relations: ['client', 'integration'],
    });
  }

  findAll(): Promise<Account[]> {
    return this.accountsRepo.find({
      order: { id: 'DESC' },
      relations: ['client', 'integration'],
    });
  }

  findAllClients(): Promise<CrmClient[]> {
    return this.clientsRepo.find({
      order: { id: 'DESC' },
      relations: ['widgets', 'widgets.integration'],
    });
  }

  findIntegrations(): Promise<WidgetIntegration[]> {
    return this.integrationsRepo.find({
      order: { id: 'DESC' },
    });
  }

  async findIntegrationByClientId(clientId: string) {
    const normalized = String(clientId || '').trim();
    if (!normalized) return null;
    return this.integrationsRepo.findOne({ amoClientId: normalized });
  }

  async findIntegrationByWidgetCode(widgetCode: string) {
    const normalized = String(widgetCode || '').trim();
    if (!normalized) return null;
    return this.integrationsRepo.findOne({ widgetCode: normalized });
  }

  async findIntegrationCredentialsByClientId(
    clientId: string,
  ): Promise<AmoIntegrationCredentials | null> {
    const integration = await this.findIntegrationByClientId(clientId);
    if (integration) return this.toCredentials(integration);

    const defaults = this.getDefaultCredentials();
    if (defaults?.amoClientId === String(clientId || '').trim()) {
      return defaults;
    }

    return null;
  }

  async findIntegrationCredentialsByWidgetCode(
    widgetCode: string,
  ): Promise<AmoIntegrationCredentials | null> {
    const integration = await this.findIntegrationByWidgetCode(widgetCode);
    if (integration) return this.toCredentials(integration);

    const defaults = this.getDefaultCredentials();
    if (defaults?.widgetCode === String(widgetCode || '').trim()) {
      return defaults;
    }

    return null;
  }

  async getCredentialsForAccount(
    account: Account,
  ): Promise<AmoIntegrationCredentials> {
    if (account.integration) return this.toCredentials(account.integration);

    if (account.integrationId) {
      const integration = await this.integrationsRepo.findOne(account.integrationId);
      if (integration) return this.toCredentials(integration);
    }

    if (account.widgetCode) {
      const byWidgetCode = await this.findIntegrationCredentialsByWidgetCode(
        account.widgetCode,
      );
      if (byWidgetCode) return byWidgetCode;
    }

    const defaults = this.getDefaultCredentials();
    if (defaults) return defaults;

    throw new Error('Не найдены OAuth-ключи для виджета');
  }

  async upsertClient(data: Partial<CrmClient>) {
    const amoId = Number(data.amoId);
    if (!Number.isFinite(amoId)) {
      throw new Error('Некорректный amoId клиента');
    }

    const current = await this.clientsRepo.findOne({ amoId });
    const next = {
      ...(current || {}),
      ...data,
      amoId,
    };
    if (current?.firstSeenSource && data.firstSeenSource === 'settings') {
      next.firstSeenSource = current.firstSeenSource;
    }
    if (current?.isLegacy && data.isLegacy === undefined) {
      next.isLegacy = current.isLegacy;
    }
    return this.clientsRepo.save(next);
  }

  async upsertIntegration(data: Partial<WidgetIntegration>) {
    const widgetCode = String(data.widgetCode || '').trim();
    const amoClientId = String(data.amoClientId || '').trim();
    const amoClientSecret = String(data.amoClientSecret || '').trim();

    if (!widgetCode || !amoClientId || !amoClientSecret) {
      throw new Error('Нужно заполнить widgetCode, clientId и clientSecret');
    }

    const byWidgetCode = await this.findIntegrationByWidgetCode(widgetCode);
    const byClientId = await this.findIntegrationByClientId(amoClientId);
    const current = byWidgetCode || byClientId || null;

    return this.integrationsRepo.save({
      ...(current || {}),
      ...data,
      widgetCode,
      amoClientId,
      amoClientSecret,
      widgetSlug: data.widgetSlug || current?.widgetSlug || 'copy_leads',
      widgetName: data.widgetName || current?.widgetName || 'Копирование сделок',
      redirectUri:
        data.redirectUri ||
        current?.redirectUri ||
        this.configService.get<string>('redirectUri'),
      amoDomain:
        data.amoDomain !== undefined
          ? normalizeAmoDomain(data.amoDomain)
          : current?.amoDomain || null,
    });
  }

  async deleteIntegrationCompletelyByWidgetCode(widgetCode: string) {
    const normalizedWidgetCode = String(widgetCode || '').trim();
    if (!normalizedWidgetCode) {
      throw new Error('Нужно передать widgetCode');
    }

    const integration = await this.findIntegrationByWidgetCode(normalizedWidgetCode);
    const accounts = await this.accountsRepo.find({
      where: { widgetCode: normalizedWidgetCode },
    } as any);
    const clientIds = Array.from(
      new Set(
        accounts
          .map((account) => account.clientAccountId)
          .filter((id): id is number => id !== null && id !== undefined),
      ),
    );

    await this.accountsRepo.delete({ widgetCode: normalizedWidgetCode } as any);
    if (integration) {
      await this.integrationsRepo.delete(integration.id);
    }

    let removedClients = 0;
    for (const clientId of clientIds) {
      const widgetsLeft = await this.accountsRepo.count({
        where: { clientAccountId: clientId },
      } as any);
      if (widgetsLeft === 0) {
        await this.clientsRepo.delete(clientId);
        removedClients += 1;
      }
    }

    return {
      widgetCode: normalizedWidgetCode,
      removedAccounts: accounts.length,
      removedIntegration: Boolean(integration),
      removedClients,
    };
  }

  async deleteClientInstallations(amoIdOrDomain: string | number) {
    const raw = String(amoIdOrDomain || '').trim();
    if (!raw) {
      throw new Error('Нужно передать amoId или домен клиента');
    }

    const normalizedAmoId = Number(raw);
    const byAmoId = Number.isFinite(normalizedAmoId) && normalizedAmoId > 0;
    const normalizedDomain = byAmoId ? null : normalizeAmoDomain(raw);
    const where = byAmoId
      ? { amoId: normalizedAmoId }
      : { domain: normalizedDomain };
    const client = await this.clientsRepo.findOne({
      where,
    } as any);

    const accounts = await this.accountsRepo.find({ where } as any);
    const clientIds = Array.from(
      new Set(
        accounts
          .map((account) => account.clientAccountId)
          .filter((id): id is number => id !== null && id !== undefined),
      ),
    );
    if (client?.id && !clientIds.includes(client.id)) {
      clientIds.push(client.id);
    }
    const widgetCodes = accounts
      .map((account) => account.widgetCode)
      .filter(Boolean);

    await this.accountsRepo.delete(where as any);

    let removedClients = 0;
    for (const clientId of clientIds) {
      const widgetsLeft = await this.accountsRepo.count({
        where: { clientAccountId: clientId },
      } as any);
      if (widgetsLeft === 0) {
        await this.clientsRepo.delete(clientId);
        removedClients += 1;
      }
    }

    return {
      target: raw,
      removedAccounts: accounts.length,
      removedClients,
      keptIntegrations: true,
      widgetCodes,
    };
  }

  async deleteAccountInstallation(accountId: number) {
    const id = Number(accountId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('Нужно передать ID установки');
    }

    const account = await this.findById(id);
    if (!account) {
      return {
        accountId: id,
        removedAccount: false,
        removedClient: false,
      };
    }

    const clientId = account.clientAccountId;
    await this.accountsRepo.delete(id);

    let removedClient = false;
    if (clientId) {
      const widgetsLeft = await this.accountsRepo.count({
        where: { clientAccountId: clientId },
      } as any);
      if (widgetsLeft === 0) {
        await this.clientsRepo.delete(clientId);
        removedClient = true;
      }
    }

    return {
      accountId: id,
      amoId: account.amoId,
      domain: account.domain,
      removedAccount: true,
      removedClient,
    };
  }

  create(data: Partial<Account>): Promise<Account> {
    return this.accountsRepo.save(data);
  }

  async update(id: number, data: Partial<Account>): Promise<Account> {
    await this.accountsRepo.save({ ...data, id });
    return this.findById(id);
  }

  createConnector(amoId: number, widgetCode?: string): AxiosInstance {
    // console.log(amoId);
    const api = axios.create({ timeout: 30000 });
    let account: Account;
    api.interceptors.request.use(
      async (config) => {
        if (!account) {
          account = await this.findByAmoId(amoId, widgetCode);
        }
        const { oauth } = account;
        const accountDomain = normalizeAmoDomain(account.domain);
        if (oauth.expire - 60 * 1000 < Number(new Date())) {
          const credentials = await this.getCredentialsForAccount(account);
          account = await this.update(account.id, {
            oauth: await this.authService.getNewTokens(
              oauth.refreshToken,
              accountDomain,
              GrantTypes.RefreshToken,
              credentials,
            ),
            domain: accountDomain,
          });
        }
        config.baseURL = account.url;
        config.headers.Authorization = `Bearer ${account.oauth.accessToken}`;
        return config;
      },
      (e) => Promise.reject(e),
    );
    return api;
  }

  private toCredentials(
    integration: WidgetIntegration,
  ): AmoIntegrationCredentials {
    return {
      id: integration.id,
      widgetCode: integration.widgetCode,
      amoClientId: integration.amoClientId,
      amoClientSecret: integration.amoClientSecret,
      redirectUri:
        integration.redirectUri || this.configService.get<string>('redirectUri'),
      amoDomain: integration.amoDomain || null,
      widgetSlug: integration.widgetSlug || 'copy_leads',
      widgetName: integration.widgetName || 'Копирование сделок',
    };
  }
}
