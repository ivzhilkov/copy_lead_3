import { Request as ExpressReq } from 'express';
import { Account } from 'src/accounts/account.entity';

export type Request = ExpressReq<{
  account: Account;
}>;
