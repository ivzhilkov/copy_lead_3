import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { AxiosError, AxiosInstance } from 'axios';
import { Queue } from 'bull';
import { Account } from 'src/accounts/account.entity';
import { AccountsService } from 'src/accounts/accounts.service';
import { CopyPayload } from 'src/interfaces/copy-payload.interface';
import { CopyJob } from 'src/types/copy-job';
import * as uniqid from 'uniqid';

const ARCHIVED_STATUS_IDS = new Set([142, 143]);
const EDITABLE_NOTE_TYPES = new Set([
  'common',
  'call_in',
  'call_out',
  'service_message',
  'message_cashier',
  'geolocation',
  'sms_in',
  'sms_out',
  'extended_service_message',
  'attachment',
]);

@Injectable()
export class CopyService {
  private readonly logger = new Logger(CopyService.name);

  constructor(
    @InjectQueue('copy-queue')
    private copyQueue: Queue,
    private accountsService: AccountsService,
  ) {}

  private jobsMap: Record<string, CopyJob[]> = {};
  private requestOwnerMap: Record<string, number> = {};

  async addToQueue(leadIds: number[], payload: CopyPayload, account: Account) {
    const normalizedLeadIds = Array.from(
      new Set(
        (leadIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );
    if (!normalizedLeadIds.length) {
      throw new Error('Не переданы сделки для копирования');
    }

    const normalizedPayload = this.normalizePayload(payload);
    const requestId = uniqid();
    this.requestOwnerMap[requestId] = account.amoId;
    this.jobsMap[requestId] = await this.copyQueue.addBulk(
      normalizedLeadIds.map((leadId) => ({
        name: 'copy',
        data: { account, requestId, leadId, payload: normalizedPayload },
      })),
    );

    return requestId;
  }

  async check(requestId: string, accountId?: number) {
    const jobs = this.jobsMap[requestId];
    if (!jobs || !jobs.length) {
      return {
        total: 0,
        completed: 0,
        failed: 0,
        progress: 100,
        results: [],
      };
    }

    if (
      Number.isFinite(accountId) &&
      this.requestOwnerMap[requestId] &&
      this.requestOwnerMap[requestId] !== accountId
    ) {
      throw new Error('Некорректный запрос статуса');
    }

    let completed = 0;
    let failed = 0;
    const total = jobs.length;
    const results = await Promise.all(
      jobs.map(async (job) => {
        const state = await job.getState();
        if (state === 'failed') {
          failed++;
        } else if (state === 'completed') {
          completed++;
          return job.finished();
        }
        return null;
      }),
    );

    const done = completed + failed;
    if (done >= total) {
      delete this.jobsMap[requestId];
      delete this.requestOwnerMap[requestId];
    }

    return {
      total,
      completed,
      failed,
      progress: total ? (done / total) * 100 : 100,
      results: results.filter((i) => i),
    };
  }

  async copy(job: CopyJob) {
    const {
      data: { account, leadId, payload },
    } = job;
    const api = this.accountsService.createConnector(account.amoId);
    const { pipelineId, statusId } = this.parseStatus(payload.statusId);

    const lead = await this.requestWithRetry(() =>
      api.get(`/api/v4/leads/${leadId}`, {
        params: {
          with: 'contacts,companies,tags',
        },
      }),
    ).then(({ data }) => data);

    const contactIds = (lead._embedded?.contacts || []).map(({ id }) =>
      Number(id),
    );
    if (
      !payload.createIfContactHasDeal &&
      contactIds.length &&
      (await this.hasActiveLeadInPipeline(api, contactIds, pipelineId, leadId))
    ) {
      return {
        sourceLeadId: leadId,
        skipped: true,
        reason: 'active_lead_exists_for_contact',
      };
    }

    const body: any = {
      name: `Копия - ${lead.name || `Сделка ${leadId}`}`,
      responsible_user_id: Number.isFinite(payload.responsibleId)
        ? payload.responsibleId
        : lead.responsible_user_id,
      pipeline_id: pipelineId,
      status_id: statusId,
      price: payload.budget ? Number(lead.price || 0) : 0,
      custom_fields_values: (lead.custom_fields_values || [])
        .filter((cf) => payload.customFields.includes(Number(cf.field_id)))
        .map((cf) => ({
          field_code: cf.field_code,
          field_id: cf.field_id,
          values: (cf.values || []).map((value) => {
            const mapped: any = {};
            if (Object.prototype.hasOwnProperty.call(value, 'value')) {
              mapped.value = value.value;
            }
            if (Object.prototype.hasOwnProperty.call(value, 'enum_id')) {
              mapped.enum_id = value.enum_id;
            }
            if (Object.prototype.hasOwnProperty.call(value, 'enum_code')) {
              mapped.enum_code = value.enum_code;
            }
            if (Object.prototype.hasOwnProperty.call(value, 'currency')) {
              mapped.currency = value.currency;
            }
            return mapped;
          }),
        })),
    };

    const embedded: Record<string, any[]> = {};
    if (payload.tags) {
      embedded.tags = (lead._embedded?.tags || [])
        .map(({ id }) => Number(id))
        .filter((id) => Number.isFinite(id))
        .map((id) => ({ id }));
    }

    if (payload.linkedEntities) {
      embedded.contacts = (lead._embedded?.contacts || [])
        .map(({ id }) => Number(id))
        .filter((id) => Number.isFinite(id))
        .map((id) => ({ id }));
      embedded.companies = (lead._embedded?.companies || [])
        .map(({ id }) => Number(id))
        .filter((id) => Number.isFinite(id))
        .map((id) => ({ id }));
    }

    if (Object.keys(embedded).length) {
      body._embedded = embedded;
    }

    const newLeadId = await this.requestWithRetry(() =>
      api.post('/api/v4/leads', [body]),
    ).then(({ data }) => data?._embedded?.leads?.[0]?.id);

    if (payload.notes && newLeadId) {
      try {
        const noteBodies = (await this.getAllLeadNotes(api, leadId))
          .filter((note) => EDITABLE_NOTE_TYPES.has(note.note_type))
          .map((note) => ({
            note_type: note.note_type,
            params: note.params,
            responsible_user_id: note.responsible_user_id,
          }));

        for (const chunk of this.chunk(noteBodies, 100)) {
          if (!chunk.length) continue;
          await this.requestWithRetry(() =>
            api.post(`/api/v4/leads/${newLeadId}/notes`, chunk),
          );
        }
      } catch (e) {
        this.logger.warn(
          `Не удалось скопировать примечания для сделки ${leadId} -> ${newLeadId}: ${
            (e as Error).message
          }`,
        );
      }
    }

    return {
      sourceLeadId: leadId,
      newLeadId,
      skipped: false,
    };
  }

  private normalizePayload(payload: CopyPayload): CopyPayload {
    const parsedResponsibleId = Number(payload?.responsibleId);
    return {
      statusId: payload?.statusId || '',
      responsibleId: Number.isFinite(parsedResponsibleId) ? parsedResponsibleId : 0,
      customFields: Array.isArray(payload?.customFields)
        ? payload.customFields
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id))
        : [],
      budget: Boolean(payload?.budget),
      linkedEntities: Boolean(payload?.linkedEntities),
      tags: payload?.tags !== false,
      notes: Boolean(payload?.notes),
      createIfContactHasDeal: payload?.createIfContactHasDeal !== false,
    };
  }

  private parseStatus(statusId: string) {
    const [pipelineIdRaw, statusIdRaw] = String(statusId || '').split('_');
    const pipelineId = Number(pipelineIdRaw);
    const parsedStatusId = Number(statusIdRaw);
    if (!Number.isFinite(pipelineId) || !Number.isFinite(parsedStatusId)) {
      throw new Error('Некорректно выбран этап для копирования');
    }
    return { pipelineId, statusId: parsedStatusId };
  }

  private async hasActiveLeadInPipeline(
    api: AxiosInstance,
    contactIds: number[],
    pipelineId: number,
    sourceLeadId: number,
  ) {
    const visitedLeadIds = new Set<number>();

    for (const contactId of contactIds) {
      const contact = await this.requestWithRetry(() =>
        api.get(`/api/v4/contacts/${contactId}`, {
          params: {
            with: 'leads',
          },
        }),
      ).then(({ data }) => data);

      const leadIds = (contact?._embedded?.leads || [])
        .map(({ id }) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0);

      for (const linkedLeadId of leadIds) {
        if (linkedLeadId === sourceLeadId || visitedLeadIds.has(linkedLeadId)) {
          continue;
        }
        visitedLeadIds.add(linkedLeadId);

        try {
          const linkedLead = await this.requestWithRetry(() =>
            api.get(`/api/v4/leads/${linkedLeadId}`),
          ).then(({ data }) => data);

          if (
            Number(linkedLead?.pipeline_id) === pipelineId &&
            !ARCHIVED_STATUS_IDS.has(Number(linkedLead?.status_id))
          ) {
            return true;
          }
        } catch (e) {
          const error = e as AxiosError;
          if (error?.response?.status === 404) continue;
          throw e;
        }
      }
    }

    return false;
  }

  private async getAllLeadNotes(api: AxiosInstance, leadId: number) {
    const notes: any[] = [];
    const limit = 250;
    let page = 1;

    while (true) {
      const data = await this.requestWithRetry(() =>
        api.get(`/api/v4/leads/${leadId}/notes`, {
          params: { page, limit },
        }),
      ).then(({ data }) => data);

      const current = data?._embedded?.notes || [];
      notes.push(...current);

      const hasNext = Boolean(data?._links?.next?.href);
      if (!hasNext || current.length < limit) break;
      page += 1;
    }

    return notes;
  }

  private chunk<T>(items: T[], size: number) {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  private async requestWithRetry<T>(
    requestFn: () => Promise<T>,
    maxAttempts = 7,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error;
        const axiosError = error as AxiosError;
        const status = axiosError?.response?.status;
        const shouldRetry =
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504;

        if (!shouldRetry || attempt === maxAttempts) {
          throw error;
        }

        const retryAfterHeader =
          axiosError?.response?.headers?.['retry-after'] ||
          axiosError?.response?.headers?.['Retry-After'];
        const retryAfterSeconds = Number(retryAfterHeader);
        const delayMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 15000);

        await this.sleep(delayMs);
      }
    }

    throw lastError;
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
