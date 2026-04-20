import { Process, Processor } from '@nestjs/bull';
import { CopyJob } from 'src/types/copy-job';
import { CopyService } from './copy.service';

@Processor('copy-queue')
export class CopyProcessor {
  constructor(private copyService: CopyService) {}
  @Process({ name: 'copy', concurrency: 1 })
  copy(job: CopyJob) {
    return this.copyService.copy(job);
  }
}
