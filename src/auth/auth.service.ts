import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AccountsService } from 'src/accounts/accounts.service';
import { GrantTypes } from 'src/enums/grant-types.enum';
import { AuthCallbackQuery } from 'src/interfaces/auth-callback-query.interface';
import { OAuthField } from 'src/interfaces/oauth-field.interface';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class AuthService {
  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => AccountsService))
    private accountService: AccountsService,
  ) {}
  async performCallBack(query: AuthCallbackQuery): Promise<string> {
    const oauth: OAuthField = await this.getNewTokens(
      query.code,
      query.referer,
    );
    const decoded = jwt.decode(oauth.accessToken, { json: true });
    const account = await this.accountService.findByAmoId(decoded.account_id);
    if (!account) {
      await this.accountService.create({
        amoId: decoded.account_id,
        domain: query.referer,
        oauth,
        installedAt: new Date(),
        lastSeenAt: new Date(),
      });
    } else {
      await this.accountService.update(account.id, {
        domain: query.referer,
        oauth,
        lastSeenAt: new Date(),
      });
    }
    return `https://${query.referer}`;
  }

  async getNewTokens(
    i: string,
    domain: string,
    type: GrantTypes = GrantTypes.AuthCode,
  ) {
    const { data } = await axios.post(
      `https://${domain}/oauth2/access_token`,
      {
        client_id: this.configService.get('clientId'),
        client_secret: this.configService.get('clientSecret'),
        redirect_uri: this.configService.get('redirectUri'),
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
