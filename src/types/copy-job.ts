import { Job } from 'bull';
import { CopyPayload } from 'src/interfaces/copy-payload.interface';

export type CopyJob = Job<{
  accountId: number;
  requestId: string;
  leadId: number;
  payload: CopyPayload;
}>;
