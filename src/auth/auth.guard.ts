import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as _ from 'lodash';
import { AccountsService } from 'src/accounts/accounts.service';
import { Request } from 'src/types/request';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private accountsService: AccountsService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const req: Request = context.switchToHttp().getRequest();
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (
        !token &&
        _.get(req, 'body.action.settings.widget_info.code')
      ) {
        const widgetCode = _.get(req, 'body.action.settings.widget_info.code');
        const credentials =
          await this.accountsService.findIntegrationCredentialsByWidgetCode(
            widgetCode,
          );
        if (!credentials) return false;

        const account = await this.accountsService.findByAmoId(
          req.body.account_id,
          credentials.widgetCode,
        );
        if (!account) return false;
        req.params.account = account;
        return true;
      }
      const decoded = jwt.decode(token, { json: true }) as any;
      const account = await this.accountsService.findByAmoId(
        decoded?.account_id,
      );
      if (!account) return false;
      const credentials = await this.accountsService.getCredentialsForAccount(
        account,
      );
      jwt.verify(token, credentials.amoClientSecret);
      req.params.account = account;
      return true;
    } catch (e) {
      return false;
    }
  }
}
