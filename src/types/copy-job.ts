import { Job } from 'bull';
import { Account } from 'src/accounts/account.entity';
import { CopyPayload } from 'src/interfaces/copy-payload.interface';

export type CopyJob = Job<{
  account: Account;
  requestId: string;
  leadId: number;
  payload: CopyPayload;
}>;
