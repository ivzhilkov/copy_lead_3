import { Injectable, Logger } from '@nestjs/common';
import { AxiosError, AxiosInstance } from 'axios';
import { Account } from 'src/accounts/account.entity';
import { AccountsService } from 'src/accounts/accounts.service';
import { CopyPayload } from 'src/interfaces/copy-payload.interface';
import { CopyJob } from 'src/types/copy-job';
import * as uniqid from 'uniqid';

const ARCHIVED_STATUS_IDS = new Set([142, 143]);
const BUDGET_FIELD_TOKEN = -1000001;
const CHAT_EVENT_TYPES = [
  'incoming_chat_message',
  'outgoing_chat_message',
  'entity_direct_message',
] as const;
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

type CopyRequestState = {
  accountId: number;
  total: number;
  completed: number;
  failed: number;
  results: any[];
  createdAt: number;
  finishedAt?: number;
};

@Injectable()
export class CopyService {
  private readonly logger = new Logger(CopyService.name);

  constructor(private accountsService: AccountsService) {}

  private requestsMap: Record<string, CopyRequestState> = {};
  private requestOwnerMap: Record<string, number> = {};
  private executionChain: Promise<void> = Promise.resolve();

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
    this.requestsMap[requestId] = {
      accountId: account.amoId,
      total: normalizedLeadIds.length,
      completed: 0,
      failed: 0,
      results: [],
      createdAt: Date.now(),
    };

    normalizedLeadIds.forEach((leadId) => {
      this.enqueueExecution(async () => {
        const state = this.requestsMap[requestId];
        if (!state) return;

        try {
          const result = await this.copy({
            data: { account, requestId, leadId, payload: normalizedPayload },
          } as CopyJob);
          state.completed += 1;
          state.results.push(result);
        } catch (e) {
          state.failed += 1;
          state.results.push({
            sourceLeadId: leadId,
            skipped: false,
            error: (e as Error)?.message || 'Ошибка копирования',
          });
          this.logger.error(
            `Ошибка копирования сделки ${leadId} (requestId=${requestId}): ${
              (e as Error)?.message || e
            }`,
          );
        }

        const done = state.completed + state.failed;
        if (done >= state.total && !state.finishedAt) {
          state.finishedAt = Date.now();
          setTimeout(() => {
            delete this.requestsMap[requestId];
            delete this.requestOwnerMap[requestId];
          }, 5 * 60 * 1000);
        }

        // Global throttle to avoid aggressive API bursts.
        await this.sleep(350);
      });
    });

    return requestId;
  }

  async check(requestId: string, accountId?: number) {
    const state = this.requestsMap[requestId];
    if (!state) {
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

    const total = state.total;
    const completed = state.completed;
    const failed = state.failed;
    const done = completed + failed;

    return {
      total,
      completed,
      failed,
      progress: total ? (done / total) * 100 : 100,
      results: state.results,
    };
  }

  private enqueueExecution(task: () => Promise<void>) {
    const run = this.executionChain.then(task, task);
    this.executionChain = run.then(
      () => undefined,
      () => undefined,
    );
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
      responsible_user_id: Number.isFinite(payload.responsibleId) && payload.responsibleId > 0
        ? payload.responsibleId
        : lead.responsible_user_id,
      pipeline_id: pipelineId,
      status_id: statusId,
      price: payload.budget ? Number(lead.price || 0) : 0,
      custom_fields_values: (lead.custom_fields_values || [])
        .filter(
          (cf) =>
            Number.isFinite(Number(cf.field_id)) &&
            Number(cf.field_id) > 0 &&
            payload.customFields.includes(Number(cf.field_id)),
        )
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
        const noteBodies = (
          await this.getLeadAndContactNotes(api, leadId, contactIds.filter((id) => Number.isFinite(id)))
        )
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

      try {
        await this.copyConversationEventsAsNotes(
          api,
          leadId,
          contactIds.filter((id) => Number.isFinite(id)),
          Number(newLeadId),
        );
      } catch (e) {
        this.logger.warn(
          `Не удалось подтянуть беседы для сделки ${leadId} -> ${newLeadId}: ${
            (e as Error).message
          }`,
        );
      }
    }

    if (newLeadId) {
      await this.createCrossLinkNotes(api, account.url, leadId, Number(newLeadId));
    }

    return {
      sourceLeadId: leadId,
      newLeadId,
      skipped: false,
    };
  }

  private normalizePayload(payload: CopyPayload): CopyPayload {
    const parsedResponsibleId = Number(payload?.responsibleId);
    const parsedCustomFields = Array.isArray(payload?.customFields)
      ? payload.customFields
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id))
      : [];

    return {
      statusId: payload?.statusId || '',
      responsibleId: Number.isFinite(parsedResponsibleId) ? parsedResponsibleId : -1,
      customFields: parsedCustomFields,
      budget: Boolean(payload?.budget) || parsedCustomFields.includes(BUDGET_FIELD_TOKEN),
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

  private async getLeadAndContactNotes(
    api: AxiosInstance,
    leadId: number,
    contactIds: number[],
  ) {
    const fromLead = await this.getAllEntityNotes(api, 'leads', leadId);
    const fromContacts = await Promise.all(
      contactIds
        .filter((id) => Number.isFinite(id) && id > 0)
        .map(async (contactId) => {
          try {
            const notes = await this.getAllEntityNotes(api, 'contacts', contactId);
            return notes.map((note) => ({
              ...note,
              __source_entity: `contact:${contactId}`,
            }));
          } catch (e) {
            this.logger.warn(
              `Не удалось получить примечания контакта ${contactId} для копии сделки ${leadId}: ${
                (e as Error).message
              }`,
            );
            return [];
          }
        }),
    ).then((chunks) => chunks.flat());

    const all = [
      ...fromLead.map((note) => ({ ...note, __source_entity: `lead:${leadId}` })),
      ...fromContacts,
    ];

    const deduped = new Map<string, any>();
    for (const note of all) {
      const key = `${note.__source_entity || ''}:${String(note.id || '')}:${String(
        note.created_at || '',
      )}`;
      if (!deduped.has(key)) deduped.set(key, note);
    }

    return Array.from(deduped.values()).sort(
      (a, b) => Number(a?.created_at || 0) - Number(b?.created_at || 0),
    );
  }

  private async getAllEntityNotes(
    api: AxiosInstance,
    entityType: 'leads' | 'contacts',
    entityId: number,
  ) {
    const notes: any[] = [];
    const limit = 250;
    let page = 1;

    while (true) {
      const data = await this.requestWithRetry(() =>
        api.get(`/api/v4/${entityType}/${entityId}/notes`, {
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

  private async copyConversationEventsAsNotes(
    api: AxiosInstance,
    sourceLeadId: number,
    contactIds: number[],
    targetLeadId: number,
  ) {
    const events = await this.getChatEvents(api, sourceLeadId, contactIds);
    if (!events.length) return;

    const noteBodies = events
      .map((event) => this.mapChatEventToServiceNote(event))
      .filter(Boolean) as Array<{
      note_type: 'service_message';
      params: { service: string; text: string };
      responsible_user_id?: number;
    }>;

    if (!noteBodies.length) return;

    for (const chunk of this.chunk(noteBodies, 100)) {
      if (!chunk.length) continue;
      await this.requestWithRetry(() =>
        api.post(`/api/v4/leads/${targetLeadId}/notes`, chunk),
      );
    }
  }

  private async getChatEvents(
    api: AxiosInstance,
    sourceLeadId: number,
    contactIds: number[],
  ) {
    const fromLead = await this.getEntityChatEvents(api, 'lead', [sourceLeadId]);
    const fromContacts = contactIds.length
      ? await this.getEntityChatEvents(api, 'contact', contactIds)
      : [];

    const deduped = new Map<string, any>();
    [...fromLead, ...fromContacts].forEach((event) => {
      const id = String(event?.id || '');
      const type = String(event?.type || '');
      const messageId = String(event?.value_after?.[0]?.message?.id || '');
      const key = `${id}:${type}:${messageId}`;
      if (!deduped.has(key)) deduped.set(key, event);
    });

    return Array.from(deduped.values())
      .filter((event) =>
        CHAT_EVENT_TYPES.includes(String(event?.type || '') as any),
      )
      .sort((a, b) => Number(a?.created_at || 0) - Number(b?.created_at || 0))
      .slice(-200);
  }

  private async getEntityChatEvents(
    api: AxiosInstance,
    entity: 'lead' | 'contact',
    entityIds: number[],
  ) {
    const normalizedEntityIds = Array.from(
      new Set(
        (entityIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );
    if (!normalizedEntityIds.length) return [];

    const events: any[] = [];
    let page = 1;
    const limit = 100;
    const maxPages = 5;

    while (page <= maxPages) {
      const data = await this.requestWithRetry(() =>
        api.get('/api/v4/events', {
          params: {
            page,
            limit,
            'order[created_at]': 'asc',
            'filter[entity][]': [entity],
            'filter[type][]': [...CHAT_EVENT_TYPES],
            'filter[entity_id][]': normalizedEntityIds,
          },
        }),
      ).then(({ data }) => data);

      const current = data?._embedded?.events || [];
      events.push(...current);

      const hasNext = Boolean(data?._links?.next?.href);
      if (!hasNext || current.length < limit) break;
      page += 1;
    }

    return events;
  }

  private mapChatEventToServiceNote(event: any) {
    const messageId = String(event?.value_after?.[0]?.message?.id || '').trim();
    if (!messageId) return null;

    const type = String(event?.type || '');
    const prefix =
      type === 'incoming_chat_message'
        ? 'Беседа: входящее сообщение'
        : type === 'outgoing_chat_message'
          ? 'Беседа: исходящее сообщение'
          : 'Беседа: внутреннее сообщение';

    return {
      note_type: 'service_message' as const,
      params: {
        service: 'Копирование сделок',
        text: `${prefix} (message_id: ${messageId})`,
      },
      responsible_user_id: Number.isFinite(Number(event?.created_by))
        ? Number(event.created_by)
        : undefined,
    };
  }

  private async createCrossLinkNotes(
    api: AxiosInstance,
    accountUrl: string,
    sourceLeadId: number,
    newLeadId: number,
  ) {
    const sourceLeadUrl = this.getLeadUrl(accountUrl, sourceLeadId);
    const newLeadUrl = this.getLeadUrl(accountUrl, newLeadId);

    await this.safeCreateSystemNote(
      api,
      sourceLeadId,
      `Создана копия сделки: ${newLeadUrl}`,
    );
    await this.safeCreateSystemNote(
      api,
      newLeadId,
      `Сделка скопирована из: ${sourceLeadUrl}`,
    );
  }

  private getLeadUrl(accountUrl: string, leadId: number) {
    const base = String(accountUrl || '').replace(/\/$/, '');
    return `${base}/leads/detail/${leadId}`;
  }

  private async safeCreateSystemNote(
    api: AxiosInstance,
    leadId: number,
    text: string,
  ) {
    try {
      await this.requestWithRetry(() =>
        api.post(`/api/v4/leads/${leadId}/notes`, [
          {
            note_type: 'service_message',
            params: {
              service: 'Копирование сделок',
              text,
            },
          },
        ]),
      );
    } catch (e) {
      this.logger.warn(
        `Не удалось создать служебное примечание для сделки ${leadId}: ${
          (e as Error).message
        }`,
      );
    }
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
        const code = (axiosError as any)?.code;
        const shouldRetry =
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          code === 'ECONNABORTED' ||
          code === 'ETIMEDOUT' ||
          code === 'ECONNRESET' ||
          code === 'EAI_AGAIN';

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
