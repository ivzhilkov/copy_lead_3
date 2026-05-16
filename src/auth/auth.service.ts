import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AccountsService } from 'src/accounts/accounts.service';
import { GrantTypes } from 'src/enums/grant-types.enum';
import { normalizeAmoDomain } from 'src/helpers/amo-domain';
import { AuthCallbackQuery } from 'src/interfaces/auth-callback-query.interface';
import { OAuthField } from 'src/interfaces/oauth-field.interface';
import * as jwt from 'jsonwebtoken';
import { AmoIntegrationCredentials } from 'src/accounts/accounts.service';

@Injectable()
export class AuthService {
  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => AccountsService))
    private accountService: AccountsService,
  ) {}
  async performCallBack(query: AuthCallbackQuery): Promise<string> {
    const domain = normalizeAmoDomain(query.referer);
    const credentials =
      await this.accountService.findIntegrationCredentialsByClientId(
        query.client_id,
      );
    if (!credentials) {
      throw new Error('OAuth-ключи для этой интеграции не найдены в админке');
    }

    const oauth: OAuthField = await this.getNewTokens(
      query.code,
      domain,
      GrantTypes.AuthCode,
      credentials,
    );
    const decoded = jwt.decode(oauth.accessToken, { json: true });
    const client = await this.accountService.upsertClient({
      amoId: decoded.account_id,
      domain,
    });
    const account = await this.accountService.findByAmoId(
      decoded.account_id,
      credentials.widgetCode,
    );
    if (!account) {
      await this.accountService.create({
        amoId: decoded.account_id,
        domain,
        oauth,
        clientAccountId: client.id,
        integrationId: credentials.id || null,
        widgetSlug: credentials.widgetSlug,
        widgetName: credentials.widgetName,
        widgetCode: credentials.widgetCode,
        amoClientId: credentials.amoClientId,
        installedAt: new Date(),
        lastSeenAt: new Date(),
        isLegacy: Boolean(client.isLegacy),
        firstSeenSource: client.firstSeenSource || 'oauth_callback',
      });
    } else {
      await this.accountService.update(account.id, {
        domain,
        oauth,
        clientAccountId: account.clientAccountId || client.id,
        integrationId: credentials.id || account.integrationId || null,
        widgetSlug: credentials.widgetSlug,
        widgetName: credentials.widgetName,
        widgetCode: credentials.widgetCode,
        amoClientId: credentials.amoClientId,
        lastSeenAt: new Date(),
        isLegacy: account.isLegacy || Boolean(client.isLegacy),
        firstSeenSource:
          account.firstSeenSource || client.firstSeenSource || 'oauth_callback',
      });
    }
    return `https://${domain}`;
  }

  async getNewTokens(
    i: string,
    domain: string,
    type: GrantTypes = GrantTypes.AuthCode,
    credentials?: AmoIntegrationCredentials,
  ) {
    const normalizedDomain = normalizeAmoDomain(domain);
    const clientId = credentials?.amoClientId || this.configService.get('clientId');
    const clientSecret =
      credentials?.amoClientSecret || this.configService.get('clientSecret');
    const redirectUri =
      credentials?.redirectUri || this.configService.get('redirectUri');

    const { data } = await axios.post(
      `https://${normalizedDomain}/oauth2/access_token`,
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: type,
        [type === GrantTypes.AuthCode ? 'code' : 'refresh_token']: i,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expire: Number(new Date()) + data.expires_in * 1000,
    };
  }
}
