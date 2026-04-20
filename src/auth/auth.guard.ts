import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as _ from 'lodash';
import { AccountsService } from 'src/accounts/accounts.service';
import { Request } from 'src/types/request';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private configService: ConfigService,
    private accountsService: AccountsService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const req: Request = context.switchToHttp().getRequest();
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (
        !token &&
        _.get(req, 'body.action.settings.widget_info.code') ===
          this.configService.get('widgetCode')
      ) {
        const account = await this.accountsService.findByAmoId(
          req.body.account_id,
        );
        if (!account) return false;
        req.params.account = account;
        return true;
      }
      const { account_id } = jwt.verify(
        token,
        this.configService.get('clientSecret'),
      ) as any;
      const account = await this.accountsService.findByAmoId(account_id);
      if (!account) return false;
      req.params.account = account;
      return true;
    } catch (e) {
      return false;
    }
  }
}
