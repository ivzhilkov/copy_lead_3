import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import axios, { AxiosError, AxiosInstance } from "axios";
import { Account } from "src/accounts/account.entity";
import { AccountsService } from "src/accounts/accounts.service";
import { Repository } from "typeorm";
import { MergeHistory } from "./merge-history.entity";

const EDITABLE_NOTE_TYPES = new Set([
  "common",
  "call_in",
  "call_out",
  "service_message",
  "message_cashier",
  "geolocation",
  "sms_in",
  "sms_out",
  "extended_service_message",
  "attachment",
]);

const CHAT_EVENT_TYPES = [
  "incoming_chat_message",
  "outgoing_chat_message",
  "entity_direct_message",
] as const;

type MergePermission = "all" | "leads" | "contacts" | "none";

type PublicProfilePayload = {
  userName?: string;
  userId?: number;
  email?: string;
  phone?: string;
  domain?: string;
};

type LeadPair = {
  left: any;
  right: any;
  olderLeadId: number;
  resultLeadId: number;
  deletedLeadId: number;
};

type FieldValueView = {
  leadId: number;
  hasValue: boolean;
  display: string;
};

type FieldRow = {
  key: string;
  label: string;
  type: "base" | "custom";
  customFieldId?: number;
  defaultLeadId: number | null;
  values: {
    left: FieldValueView;
    right: FieldValueView;
  };
};

@Injectable()
export class MergeService {
  private readonly logger = new Logger(MergeService.name);
  private globalNextRequestAt = 0;
  private readonly accountNextRequestAt = new Map<number, number>();

  constructor(
    private readonly accountsService: AccountsService,
    @InjectRepository(MergeHistory)
    private readonly historyRepo: Repository<MergeHistory>
  ) {}

  async searchLeads(account: Account, sourceLeadIdRaw: number, query: string) {
    const sourceLeadId = this.normalizeId(
      sourceLeadIdRaw,
      "Некорректный ID текущей сделки"
    );
    const normalizedQuery = String(query || "").trim();
    if (normalizedQuery.length < 2) return { items: [] };

    const api = this.createApi(account);
    const results = new Map<number, any>();
    const idFromQuery = this.extractLeadId(normalizedQuery);

    if (idFromQuery && idFromQuery !== sourceLeadId) {
      try {
        const lead = await this.getLead(api, idFromQuery);
        if (lead?.id) results.set(Number(lead.id), this.toSearchItem(lead));
      } catch (e) {
        const status = (e as AxiosError)?.response?.status;
        if (status !== 404 && status !== 204) throw e;
      }
    }

    if (!/^\d+$/.test(normalizedQuery) || normalizedQuery.length >= 3) {
      const data = await this.requestWithRetry(() =>
        api.get("/api/v4/leads", {
          params: {
            query: normalizedQuery,
            limit: 10,
            with: "contacts",
          },
        })
      ).then(({ data }) => data);

      const leads = data?._embedded?.leads || [];
      leads.forEach((lead) => {
        const id = Number(lead?.id);
        if (Number.isFinite(id) && id !== sourceLeadId) {
          results.set(id, this.toSearchItem(lead));
        }
      });
    }

    return { items: Array.from(results.values()).slice(0, 10) };
  }

  async buildPreview(
    account: Account,
    sourceLeadIdRaw: number,
    targetLeadIdRaw: number
  ) {
    const sourceLeadId = this.normalizeId(
      sourceLeadIdRaw,
      "Некорректный ID текущей сделки"
    );
    const targetLeadId = this.normalizeId(
      targetLeadIdRaw,
      "Некорректный ID второй сделки"
    );
    if (sourceLeadId === targetLeadId) {
      throw new BadRequestException("Нужно выбрать другую сделку");
    }

    const api = this.createApi(account);
    const [left, right, customFields, users, statuses] = await Promise.all([
      this.getLead(api, sourceLeadId),
      this.getLead(api, targetLeadId),
      this.getCustomFields(api),
      this.getUsersMap(api),
      this.getStatusesMap(api),
    ]);

    const pair = this.buildLeadPair(left, right);
    const fields = this.buildFieldRows(pair, customFields, users, statuses);
    const tags = this.buildTagsPreview(pair);
    const contacts = await this.buildContactsPreview(api, pair);

    return {
      leads: {
        left: this.toPreviewLead(pair.left, users, statuses),
        right: this.toPreviewLead(pair.right, users, statuses),
      },
      olderLeadId: pair.olderLeadId,
      resultLeadId: pair.resultLeadId,
      deletedLeadId: pair.deletedLeadId,
      fields,
      tags,
      contacts,
    };
  }

  async execute(account: Account, body: any) {
    const sourceLeadId = this.normalizeId(
      body?.source_lead_id,
      "Некорректный ID текущей сделки"
    );
    const targetLeadId = this.normalizeId(
      body?.target_lead_id,
      "Некорректный ID второй сделки"
    );
    if (sourceLeadId === targetLeadId) {
      throw new BadRequestException("Нужно выбрать другую сделку");
    }

    const reason = String(body?.reason || "").trim();
    if (reason.length < 4) {
      throw new BadRequestException(
        "Укажите причину объединения, минимум 4 символа"
      );
    }

    const permission = this.normalizePermission(body?.permission);
    if (permission === "none") {
      throw new BadRequestException("У пользователя нет прав на объединение");
    }

    const canMergeLeads = permission === "all" || permission === "leads";
    const canMergeContacts = permission === "all" || permission === "contacts";
    const mergeContacts = Boolean(body?.merge_contacts) && canMergeContacts;
    const fieldSources = this.normalizeFieldSources(body?.field_sources);
    const selectedTagKeys = Array.isArray(body?.selected_tag_keys)
      ? body.selected_tag_keys
          .map((value) => String(value || ""))
          .filter(Boolean)
      : [];
    const selectedContactIds = Array.isArray(body?.contact_ids)
      ? body.contact_ids
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const profile = this.normalizeProfile(body?.profile);
    const api = this.createApi(account);

    const [left, right, customFields, users, statuses] = await Promise.all([
      this.getLead(api, sourceLeadId),
      this.getLead(api, targetLeadId),
      this.getCustomFields(api),
      this.getUsersMap(api),
      this.getStatusesMap(api),
    ]);
    const pair = this.buildLeadPair(left, right);
    const warnings: string[] = [];

    if (canMergeLeads) {
      await this.applyLeadMerge(
        api,
        account,
        pair,
        customFields,
        users,
        statuses,
        fieldSources,
        selectedTagKeys,
        reason,
        profile,
        warnings
      );
    }

    let mergedContactIds: number[] = [];
    if (mergeContacts && selectedContactIds.length) {
      mergedContactIds = await this.mergeContacts(
        api,
        pair.resultLeadId,
        selectedContactIds,
        reason,
        profile,
        warnings
      );
    }

    await this.createMergeSystemNotes(
      api,
      account,
      pair,
      reason,
      profile,
      mergedContactIds,
      canMergeLeads
    );

    if (canMergeLeads) {
      try {
        await this.requestWithRetry(() =>
          api.patch(`/api/v4/leads/${pair.deletedLeadId}`, { is_deleted: true })
        );
      } catch (e) {
        warnings.push(
          `не удалось удалить исходную сделку #${
            pair.deletedLeadId
          }: ${this.formatAmoError(e)}`
        );
      }
    }

    await this.historyRepo.save({
      accountId: account.amoId,
      widgetCode: account.widgetCode,
      primaryLeadId: sourceLeadId,
      secondaryLeadId: targetLeadId,
      resultLeadId: pair.resultLeadId,
      deletedLeadId: canMergeLeads ? pair.deletedLeadId : null,
      contactIds: mergedContactIds,
      userName: profile.userName,
      userId: profile.userId,
      reason,
      permission,
      details: {
        fieldSources,
        selectedTagKeys,
        mergeContacts,
        warnings,
      },
    });

    return {
      ok: true,
      resultLeadId: pair.resultLeadId,
      deletedLeadId: canMergeLeads ? pair.deletedLeadId : null,
      contactIds: mergedContactIds,
      warnings,
      message: warnings.length
        ? `Объединение выполнено, есть предупреждения: ${warnings.join("; ")}`
        : "Объединение выполнено. Системные примечания и история записаны.",
    };
  }

  async getHistory(account: Account, limitRaw = 50) {
    const limit = Math.max(1, Math.min(100, Number(limitRaw) || 50));
    const items = await this.historyRepo.find({
      where: {
        accountId: account.amoId,
        widgetCode: account.widgetCode,
      } as any,
      order: { createdAt: "DESC" },
      take: limit,
    });

    return {
      items: items.map((item) => ({
        id: item.id,
        accountId: item.accountId,
        widgetCode: item.widgetCode,
        primaryLeadId: item.primaryLeadId,
        secondaryLeadId: item.secondaryLeadId,
        resultLeadId: item.resultLeadId,
        deletedLeadId: item.deletedLeadId,
        contactIds: item.contactIds || [],
        userName: item.userName,
        userId: item.userId,
        reason: item.reason,
        permission: item.permission,
        details: item.details || {},
        createdAt: item.createdAt,
      })),
    };
  }

  private async applyLeadMerge(
    api: AxiosInstance,
    account: Account,
    pair: LeadPair,
    customFields: Map<number, any>,
    users: Map<number, string>,
    statuses: Map<string, string>,
    fieldSources: Record<string, number>,
    selectedTagKeys: string[],
    reason: string,
    profile: PublicProfilePayload,
    warnings: string[]
  ) {
    const patch = this.buildLeadPatch(
      pair,
      customFields,
      fieldSources,
      selectedTagKeys
    );

    if (Object.keys(patch).length) {
      await this.requestWithRetry(() =>
        api.patch(`/api/v4/leads/${pair.resultLeadId}`, patch)
      );
    }

    await this.linkEntitiesFromDeletedLead(api, pair, warnings);
    await this.copyLeadNotes(
      api,
      pair.deletedLeadId,
      pair.resultLeadId,
      warnings
    );
    await this.copyLeadTasks(
      api,
      pair.deletedLeadId,
      pair.resultLeadId,
      warnings
    );
    await this.copyConversationEventsAsNotes(
      api,
      pair.deletedLeadId,
      pair.resultLeadId,
      warnings
    );

    this.logger.log(
      `Merged leads ${pair.left.id}/${pair.right.id} -> ${
        pair.resultLeadId
      }. User=${profile.userName || profile.userId || "-"}`
    );
  }

  private buildLeadPatch(
    pair: LeadPair,
    customFields: Map<number, any>,
    fieldSources: Record<string, number>,
    selectedTagKeys: string[]
  ) {
    const byId = new Map<number, any>([
      [Number(pair.left.id), pair.left],
      [Number(pair.right.id), pair.right],
    ]);
    const patch: any = {};
    const customFieldsPatch: any[] = [];

    Object.entries(fieldSources || {}).forEach(([key, sourceLeadId]) => {
      const source = byId.get(Number(sourceLeadId));
      if (!source) return;

      if (key === "name" && this.hasValue(source.name)) {
        patch.name = source.name;
        return;
      }
      if (
        key === "responsible_user_id" &&
        Number.isFinite(Number(source.responsible_user_id))
      ) {
        patch.responsible_user_id = Number(source.responsible_user_id);
        return;
      }
      if (key === "created_at" && Number.isFinite(Number(source.created_at))) {
        patch.created_at = Number(source.created_at);
        return;
      }
      if (key === "price" && Number.isFinite(Number(source.price))) {
        patch.price = Number(source.price);
        return;
      }
      if (key === "status") {
        if (Number.isFinite(Number(source.pipeline_id)))
          patch.pipeline_id = Number(source.pipeline_id);
        if (Number.isFinite(Number(source.status_id)))
          patch.status_id = Number(source.status_id);
        return;
      }
      if (key === "source_id" && Number.isFinite(Number(source.source_id))) {
        patch.source_id = Number(source.source_id);
        return;
      }
      if (key.startsWith("cf_")) {
        const fieldId = Number(key.replace(/^cf_/, ""));
        const sourceField = this.findCustomField(source, fieldId);
        if (!sourceField) return;
        customFieldsPatch.push({
          field_id: fieldId,
          values: this.mapCustomFieldValues(sourceField.values || []),
        });
      }
    });

    if (customFieldsPatch.length) {
      patch.custom_fields_values = customFieldsPatch.filter((field) => {
        const schema = customFields.get(Number(field.field_id));
        return schema || Number.isFinite(Number(field.field_id));
      });
    }

    const selectedTags = this.buildTagsPreview(pair).filter((tag) =>
      selectedTagKeys.includes(tag.key)
    );
    if (selectedTags.length) {
      patch.tags_to_add = selectedTags.map((tag) =>
        Number.isFinite(Number(tag.id)) && Number(tag.id) > 0
          ? { id: Number(tag.id) }
          : { name: tag.name }
      );
    }

    return patch;
  }

  private async mergeContacts(
    api: AxiosInstance,
    resultLeadId: number,
    selectedContactIds: number[],
    reason: string,
    profile: PublicProfilePayload,
    warnings: string[]
  ) {
    const contacts = await Promise.all(
      Array.from(new Set(selectedContactIds)).map((contactId) =>
        this.getContact(api, contactId)
      )
    );
    const safeContacts = contacts.filter((contact) =>
      Number.isFinite(Number(contact?.id))
    );
    if (!safeContacts.length) return [];

    const survivor = [...safeContacts].sort(
      (a, b) => Number(a?.created_at || 0) - Number(b?.created_at || 0)
    )[0];
    const survivorId = Number(survivor.id);
    const duplicateContacts = safeContacts.filter(
      (contact) => Number(contact.id) !== survivorId
    );

    const patch = this.buildContactPatch(survivor, duplicateContacts);
    if (Object.keys(patch).length) {
      await this.requestWithRetry(() =>
        api.patch(`/api/v4/contacts/${survivorId}`, patch)
      );
    }

    await this.safeLinkLeadContact(api, resultLeadId, survivorId, warnings);

    for (const duplicate of duplicateContacts) {
      const duplicateId = Number(duplicate.id);
      await this.moveContactChats(api, duplicateId, survivorId, warnings);
      await this.copyContactNotes(api, duplicateId, survivorId, warnings);
      await this.safeCreateContactSystemNote(
        api,
        survivorId,
        this.buildContactMergeNoteText(duplicateId, reason, profile)
      );
      try {
        await this.requestWithRetry(() =>
          api.patch(`/api/v4/contacts/${duplicateId}`, { is_deleted: true })
        );
      } catch (e) {
        warnings.push(
          `не удалось удалить контакт #${duplicateId}: ${this.formatAmoError(
            e
          )}`
        );
      }
    }

    return safeContacts.map((contact) => Number(contact.id));
  }

  private buildContactPatch(survivor: any, duplicates: any[]) {
    const patch: any = {};
    ["name", "first_name", "last_name"].forEach((key) => {
      if (this.hasValue(survivor?.[key])) return;
      const donor = duplicates.find((contact) => this.hasValue(contact?.[key]));
      if (donor) patch[key] = donor[key];
    });

    const mergedCustomFields = this.mergeCustomFieldsForPatch([
      survivor,
      ...duplicates,
    ]);
    if (mergedCustomFields.length) {
      patch.custom_fields_values = mergedCustomFields;
    }

    const tagsToAdd = this.collectTags(duplicates)
      .filter((tag) => tag.name || Number.isFinite(Number(tag.id)))
      .map((tag) =>
        Number.isFinite(Number(tag.id)) && Number(tag.id) > 0
          ? { id: Number(tag.id) }
          : { name: tag.name }
      );
    if (tagsToAdd.length) patch.tags_to_add = tagsToAdd;

    return patch;
  }

  private mergeCustomFieldsForPatch(entities: any[]) {
    const byField = new Map<number, any>();
    entities.forEach((entity, entityIndex) => {
      (entity?.custom_fields_values || []).forEach((field) => {
        const fieldId = Number(field?.field_id);
        if (!Number.isFinite(fieldId)) return;

        const existing = byField.get(fieldId);
        const values = this.mapCustomFieldValues(field.values || []);
        if (!values.length) return;

        if (!existing) {
          byField.set(fieldId, {
            field_id: fieldId,
            field_code: field.field_code,
            field_type: field.field_type,
            values: [...values],
            fromSurvivor: entityIndex === 0,
          });
          return;
        }

        const isMulti =
          /multi/i.test(
            String(existing.field_type || field.field_type || "")
          ) ||
          ["PHONE", "EMAIL", "IM"].includes(
            String(existing.field_code || field.field_code || "")
          );

        if (!isMulti && existing.values.length) return;

        const seen = new Set(
          existing.values.map((value) => JSON.stringify(value))
        );
        values.forEach((value) => {
          const key = JSON.stringify(value);
          if (seen.has(key)) return;
          seen.add(key);
          existing.values.push(value);
        });
      });
    });

    return Array.from(byField.values()).map(
      ({ field_id, field_code, values }) => ({
        field_id,
        field_code,
        values,
      })
    );
  }

  private async linkEntitiesFromDeletedLead(
    api: AxiosInstance,
    pair: LeadPair,
    warnings: string[]
  ) {
    const links = await this.getEntityLinks(api, "leads", pair.deletedLeadId);
    const payload = links
      .filter((link) => Number(link?.to_entity_id) > 0 && link?.to_entity_type)
      .map((link) => ({
        to_entity_id: Number(link.to_entity_id),
        to_entity_type: link.to_entity_type,
        metadata: link.metadata || undefined,
      }));

    for (const chunk of this.chunk(payload, 50)) {
      if (!chunk.length) continue;
      try {
        await this.requestWithRetry(() =>
          api.post(`/api/v4/leads/${pair.resultLeadId}/link`, chunk)
        );
      } catch (e) {
        warnings.push(
          `не удалось перенести часть связей сделки #${
            pair.deletedLeadId
          }: ${this.formatAmoError(e)}`
        );
      }
    }
  }

  private async createMergeSystemNotes(
    api: AxiosInstance,
    account: Account,
    pair: LeadPair,
    reason: string,
    profile: PublicProfilePayload,
    contactIds: number[],
    leadWasDeleted: boolean
  ) {
    const user = this.formatProfile(profile);
    const resultUrl = this.getLeadUrl(account.url, pair.resultLeadId);
    const deletedText = leadWasDeleted
      ? `Исходная сделка #${pair.deletedLeadId} объединена и удалена.`
      : `Сделки не удалялись: по роли пользователя выполнялось только объединение контактов.`;
    const contactsText = contactIds.length
      ? `Контакты: ${contactIds.map((id) => `#${id}`).join(", ")}.`
      : "Контакты не объединялись.";
    const text = [
      `Объединение выполнено пользователем: ${user}.`,
      `Сделки: #${pair.left.id} и #${pair.right.id}.`,
      `Итоговая сделка: #${pair.resultLeadId} (${resultUrl}).`,
      deletedText,
      contactsText,
      `Причина: ${reason}`,
    ].join("\n");

    await this.safeCreateLeadSystemNote(api, pair.resultLeadId, text);
    if (leadWasDeleted) {
      await this.safeCreateLeadSystemNote(api, pair.deletedLeadId, text);
    }
  }

  private async copyLeadNotes(
    api: AxiosInstance,
    sourceLeadId: number,
    targetLeadId: number,
    warnings: string[]
  ) {
    try {
      const notes = await this.getAllEntityNotes(api, "leads", sourceLeadId);
      const bodies = notes
        .filter((note) => EDITABLE_NOTE_TYPES.has(note.note_type))
        .map((note) => this.buildCopiedNoteBody(note, "Объединение сделок"));
      await this.postCopiedNotes(api, "leads", targetLeadId, bodies);
    } catch (e) {
      warnings.push(
        `не удалось перенести примечания сделки #${sourceLeadId}: ${this.formatAmoError(
          e
        )}`
      );
    }
  }

  private async copyContactNotes(
    api: AxiosInstance,
    sourceContactId: number,
    targetContactId: number,
    warnings: string[]
  ) {
    try {
      const notes = await this.getAllEntityNotes(
        api,
        "contacts",
        sourceContactId
      );
      const bodies = notes
        .filter((note) => EDITABLE_NOTE_TYPES.has(note.note_type))
        .map((note) => this.buildCopiedNoteBody(note, "Объединение контактов"));
      await this.postCopiedNotes(api, "contacts", targetContactId, bodies);
    } catch (e) {
      warnings.push(
        `не удалось перенести примечания контакта #${sourceContactId}: ${this.formatAmoError(
          e
        )}`
      );
    }
  }

  private async copyLeadTasks(
    api: AxiosInstance,
    sourceLeadId: number,
    targetLeadId: number,
    warnings: string[]
  ) {
    try {
      const tasks = await this.getLeadTasks(api, sourceLeadId);
      const mapped = tasks
        .filter((task) => task?.is_completed !== true)
        .map((task) => ({
          text:
            String(task?.text || "").trim() || "Задача из объединённой сделки",
          complete_till: Number.isFinite(Number(task?.complete_till))
            ? Number(task.complete_till)
            : undefined,
          entity_id: targetLeadId,
          entity_type: "leads",
          task_type_id: Number.isFinite(Number(task?.task_type_id))
            ? Number(task.task_type_id)
            : undefined,
          responsible_user_id: Number.isFinite(
            Number(task?.responsible_user_id)
          )
            ? Number(task.responsible_user_id)
            : undefined,
        }))
        .filter((task) => task.text);

      for (const chunk of this.chunk(mapped, 50)) {
        if (!chunk.length) continue;
        await this.requestWithRetry(() => api.post("/api/v4/tasks", chunk));
      }
    } catch (e) {
      warnings.push(
        `не удалось перенести задачи сделки #${sourceLeadId}: ${this.formatAmoError(
          e
        )}`
      );
    }
  }

  private async copyConversationEventsAsNotes(
    api: AxiosInstance,
    sourceLeadId: number,
    targetLeadId: number,
    warnings: string[]
  ) {
    try {
      const events = await this.getEntityChatEvents(api, "lead", [
        sourceLeadId,
      ]);
      const bodies = events
        .filter((event) =>
          CHAT_EVENT_TYPES.includes(String(event?.type || "") as any)
        )
        .map((event) => this.mapChatEventToServiceNote(event))
        .filter(Boolean);
      await this.postCopiedNotes(api, "leads", targetLeadId, bodies);
    } catch (e) {
      warnings.push(
        `не удалось перенести историю бесед сделки #${sourceLeadId}: ${this.formatAmoError(
          e
        )}`
      );
    }
  }

  private mapChatEventToServiceNote(event: any) {
    const messageId = String(event?.value_after?.[0]?.message?.id || "").trim();
    if (!messageId) return null;

    const type = String(event?.type || "");
    const prefix =
      type === "incoming_chat_message"
        ? "Беседа: входящее сообщение"
        : type === "outgoing_chat_message"
        ? "Беседа: исходящее сообщение"
        : "Беседа: внутреннее сообщение";

    return {
      note_type: "service_message",
      params: {
        service: "Объединение сделок",
        text: `${prefix} из объединённой сделки (message_id: ${messageId})`,
      },
    };
  }

  private async moveContactChats(
    api: AxiosInstance,
    sourceContactId: number,
    targetContactId: number,
    warnings: string[]
  ) {
    try {
      const data = await this.requestWithRetry(() =>
        api.get("/api/v4/contacts/chats", {
          params: { "contact_id[]": sourceContactId },
        })
      ).then(({ data }) => data);
      const chats = data?._embedded?.chats || [];
      const payload = chats
        .map((chat) => String(chat?.chat_id || "").trim())
        .filter(Boolean)
        .map((chatId) => ({
          contact_id: targetContactId,
          chat_id: chatId,
        }));
      for (const chunk of this.chunk(payload, 50)) {
        if (!chunk.length) continue;
        await this.requestWithRetry(() =>
          api.post("/api/v4/contacts/chats", chunk)
        );
      }
    } catch (e) {
      warnings.push(
        `не удалось перенести чаты контакта #${sourceContactId}: ${this.formatAmoError(
          e
        )}`
      );
    }
  }

  private async safeLinkLeadContact(
    api: AxiosInstance,
    leadId: number,
    contactId: number,
    warnings: string[]
  ) {
    try {
      await this.requestWithRetry(() =>
        api.post(`/api/v4/leads/${leadId}/link`, [
          {
            to_entity_id: contactId,
            to_entity_type: "contacts",
            metadata: { is_main: true },
          },
        ])
      );
    } catch (e) {
      warnings.push(
        `не удалось привязать итоговый контакт #${contactId} к сделке #${leadId}: ${this.formatAmoError(
          e
        )}`
      );
    }
  }

  private async safeCreateLeadSystemNote(
    api: AxiosInstance,
    leadId: number,
    text: string
  ) {
    try {
      await this.requestWithRetry(() =>
        api.post(`/api/v4/leads/${leadId}/notes`, [
          {
            note_type: "service_message",
            params: {
              service: "Объединение сделок",
              text,
            },
          },
        ])
      );
    } catch (e) {
      this.logger.warn(
        `Не удалось создать системное примечание для сделки ${leadId}: ${this.formatAmoError(
          e
        )}`
      );
    }
  }

  private async safeCreateContactSystemNote(
    api: AxiosInstance,
    contactId: number,
    text: string
  ) {
    try {
      await this.requestWithRetry(() =>
        api.post(`/api/v4/contacts/${contactId}/notes`, [
          {
            note_type: "service_message",
            params: {
              service: "Объединение контактов",
              text,
            },
          },
        ])
      );
    } catch (e) {
      this.logger.warn(
        `Не удалось создать системное примечание для контакта ${contactId}: ${this.formatAmoError(
          e
        )}`
      );
    }
  }

  private buildFieldRows(
    pair: LeadPair,
    customFields: Map<number, any>,
    users: Map<number, string>,
    statuses: Map<string, string>
  ): FieldRow[] {
    const baseRows: Array<{
      key: string;
      label: string;
      getDisplay: (lead: any) => string;
      hasValue?: (lead: any) => boolean;
    }> = [
      {
        key: "name",
        label: "Имя",
        getDisplay: (lead) => String(lead?.name || ""),
      },
      {
        key: "responsible_user_id",
        label: "Отв-ный",
        getDisplay: (lead) =>
          users.get(Number(lead?.responsible_user_id)) ||
          (lead?.responsible_user_id ? `ID ${lead.responsible_user_id}` : ""),
      },
      {
        key: "created_at",
        label: "Дата создания",
        getDisplay: (lead) => this.formatTimestamp(lead?.created_at),
      },
      {
        key: "price",
        label: "Бюджет",
        getDisplay: (lead) => this.formatMoney(lead?.price),
        hasValue: (lead) => Number.isFinite(Number(lead?.price)),
      },
      {
        key: "status",
        label: "Статус",
        getDisplay: (lead) =>
          statuses.get(`${lead?.pipeline_id}_${lead?.status_id}`) ||
          [lead?.pipeline_id, lead?.status_id].filter(Boolean).join(" / "),
      },
      {
        key: "source_id",
        label: "Источник",
        getDisplay: (lead) => (lead?.source_id ? `ID ${lead.source_id}` : ""),
      },
    ];

    const rows = baseRows.map((row) =>
      this.toFieldRow(
        pair,
        row.key,
        row.label,
        "base",
        row.getDisplay,
        row.hasValue
      )
    );

    const customFieldIds = new Set<number>();
    [pair.left, pair.right].forEach((lead) => {
      (lead?.custom_fields_values || []).forEach((field) => {
        const id = Number(field?.field_id);
        if (Number.isFinite(id)) customFieldIds.add(id);
      });
    });

    Array.from(customFieldIds)
      .sort((a, b) => {
        const leftName = String(customFields.get(a)?.name || a);
        const rightName = String(customFields.get(b)?.name || b);
        return leftName.localeCompare(rightName, "ru");
      })
      .forEach((fieldId) => {
        const schema = customFields.get(fieldId);
        rows.push(
          this.toFieldRow(
            pair,
            `cf_${fieldId}`,
            schema?.name || `Поле #${fieldId}`,
            "custom",
            (lead) =>
              this.formatCustomField(this.findCustomField(lead, fieldId)),
            (lead) => Boolean(this.findCustomField(lead, fieldId)),
            fieldId
          )
        );
      });

    return rows.filter(
      (row) => row.values.left.hasValue || row.values.right.hasValue
    );
  }

  private toFieldRow(
    pair: LeadPair,
    key: string,
    label: string,
    type: "base" | "custom",
    getDisplay: (lead: any) => string,
    hasValueFn?: (lead: any) => boolean,
    customFieldId?: number
  ): FieldRow {
    const leftDisplay = getDisplay(pair.left);
    const rightDisplay = getDisplay(pair.right);
    const leftHasValue = hasValueFn
      ? hasValueFn(pair.left)
      : this.hasValue(leftDisplay);
    const rightHasValue = hasValueFn
      ? hasValueFn(pair.right)
      : this.hasValue(rightDisplay);
    const olderLead =
      pair.olderLeadId === Number(pair.left.id) ? pair.left : pair.right;
    const olderHasValue =
      pair.olderLeadId === Number(pair.left.id) ? leftHasValue : rightHasValue;
    const fallbackLeadId = leftHasValue
      ? Number(pair.left.id)
      : rightHasValue
      ? Number(pair.right.id)
      : null;

    return {
      key,
      label,
      type,
      customFieldId,
      defaultLeadId: olderHasValue ? Number(olderLead.id) : fallbackLeadId,
      values: {
        left: {
          leadId: Number(pair.left.id),
          hasValue: leftHasValue,
          display: leftDisplay,
        },
        right: {
          leadId: Number(pair.right.id),
          hasValue: rightHasValue,
          display: rightDisplay,
        },
      },
    };
  }

  private buildLeadPair(left: any, right: any): LeadPair {
    const leftCreatedAt = Number(left?.created_at || 0);
    const rightCreatedAt = Number(right?.created_at || 0);
    const olderLeadId =
      leftCreatedAt && rightCreatedAt
        ? leftCreatedAt <= rightCreatedAt
          ? Number(left.id)
          : Number(right.id)
        : Number(left.id) <= Number(right.id)
        ? Number(left.id)
        : Number(right.id);
    const resultLeadId = olderLeadId;
    const deletedLeadId =
      resultLeadId === Number(left.id) ? Number(right.id) : Number(left.id);

    return {
      left,
      right,
      olderLeadId,
      resultLeadId,
      deletedLeadId,
    };
  }

  private toPreviewLead(
    lead: any,
    users: Map<number, string>,
    statuses: Map<string, string>
  ) {
    return {
      id: Number(lead.id),
      name: lead.name || `Сделка #${lead.id}`,
      createdAt: lead.created_at,
      createdAtText: this.formatTimestamp(lead.created_at),
      responsibleUserId: lead.responsible_user_id,
      responsibleName:
        users.get(Number(lead.responsible_user_id)) ||
        (lead.responsible_user_id ? `ID ${lead.responsible_user_id}` : ""),
      statusText:
        statuses.get(`${lead.pipeline_id}_${lead.status_id}`) ||
        [lead.pipeline_id, lead.status_id].filter(Boolean).join(" / "),
    };
  }

  private buildTagsPreview(pair: LeadPair) {
    const tags = new Map<string, any>();
    [
      { lead: pair.left, leadId: Number(pair.left.id) },
      { lead: pair.right, leadId: Number(pair.right.id) },
    ].forEach(({ lead, leadId }) => {
      (lead?._embedded?.tags || []).forEach((tag) => {
        const key =
          Number.isFinite(Number(tag?.id)) && Number(tag.id) > 0
            ? `id:${tag.id}`
            : `name:${String(tag?.name || "")
                .trim()
                .toLowerCase()}`;
        if (!key || key === "name:") return;
        if (!tags.has(key)) {
          tags.set(key, {
            key,
            id: Number.isFinite(Number(tag?.id)) ? Number(tag.id) : null,
            name: String(tag?.name || `Тег #${tag?.id}`).trim(),
            leadIds: [],
          });
        }
        const saved = tags.get(key);
        if (!saved.leadIds.includes(leadId)) saved.leadIds.push(leadId);
      });
    });
    return Array.from(tags.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "ru")
    );
  }

  private async buildContactsPreview(api: AxiosInstance, pair: LeadPair) {
    const contactIds = Array.from(
      new Set(
        [pair.left, pair.right].flatMap((lead) =>
          (lead?._embedded?.contacts || [])
            .map((contact) => Number(contact?.id))
            .filter((id) => Number.isFinite(id) && id > 0)
        )
      )
    );

    const contacts = await Promise.all(
      contactIds.map(async (contactId) => {
        try {
          return await this.getContact(api, contactId);
        } catch (e) {
          return { id: contactId, name: `Контакт #${contactId}` };
        }
      })
    );

    return contacts
      .sort((a, b) => Number(a?.created_at || 0) - Number(b?.created_at || 0))
      .map((contact) => ({
        id: Number(contact.id),
        name:
          contact.name ||
          [contact.first_name, contact.last_name].filter(Boolean).join(" "),
        createdAt: contact.created_at || null,
        summary: this.contactSummary(contact),
        defaultSelected: true,
      }));
  }

  private contactSummary(contact: any) {
    const values = (contact?.custom_fields_values || [])
      .flatMap((field) =>
        (field?.values || []).map((value) => String(value?.value || "").trim())
      )
      .filter(Boolean);
    return (
      values.slice(0, 3).join(", ") ||
      "нет телефонов или email в доступных полях"
    );
  }

  private async getLead(api: AxiosInstance, leadId: number) {
    return this.requestWithRetry(() =>
      api.get(`/api/v4/leads/${leadId}`, {
        params: { with: "contacts,companies,tags,catalog_elements" },
      })
    ).then(({ data }) => data);
  }

  private async getContact(api: AxiosInstance, contactId: number) {
    return this.requestWithRetry(() =>
      api.get(`/api/v4/contacts/${contactId}`, {
        params: { with: "leads,customers,catalog_elements" },
      })
    ).then(({ data }) => data);
  }

  private async getCustomFields(api: AxiosInstance) {
    const data = await this.requestWithRetry(() =>
      api.get("/api/v4/leads/custom_fields", { params: { limit: 250 } })
    ).then(({ data }) => data);
    const map = new Map<number, any>();
    (data?._embedded?.custom_fields || []).forEach((field) => {
      const id = Number(field?.id);
      if (Number.isFinite(id)) map.set(id, field);
    });
    return map;
  }

  private async getUsersMap(api: AxiosInstance) {
    const map = new Map<number, string>();
    try {
      let page = 1;
      const limit = 250;
      while (true) {
        const data = await this.requestWithRetry(() =>
          api.get("/api/v4/users", { params: { page, limit } })
        ).then(({ data }) => data);
        const users = data?._embedded?.users || [];
        users.forEach((user) => {
          const id = Number(user?.id);
          if (Number.isFinite(id)) map.set(id, user?.name || `ID ${id}`);
        });
        if (!data?._links?.next?.href || users.length < limit) break;
        page += 1;
      }
    } catch (e) {
      this.logger.warn(
        `Не удалось загрузить пользователей amoCRM: ${this.formatAmoError(e)}`
      );
    }
    return map;
  }

  private async getStatusesMap(api: AxiosInstance) {
    const map = new Map<string, string>();
    try {
      const data = await this.requestWithRetry(() =>
        api.get("/api/v4/leads/pipelines", {
          params: { with: "statuses", limit: 250 },
        })
      ).then(({ data }) => data);
      const pipelines = data?._embedded?.pipelines || [];
      pipelines.forEach((pipeline) => {
        (pipeline?._embedded?.statuses || []).forEach((status) => {
          map.set(
            `${pipeline.id}_${status.id}`,
            `${pipeline.name} / ${status.name}`
          );
        });
      });
    } catch (e) {
      this.logger.warn(
        `Не удалось загрузить статусы amoCRM: ${this.formatAmoError(e)}`
      );
    }
    return map;
  }

  private async getEntityLinks(
    api: AxiosInstance,
    entityType: "leads" | "contacts",
    entityId: number
  ) {
    const links: any[] = [];
    let page = 1;
    const limit = 250;
    while (true) {
      const data = await this.requestWithRetry(() =>
        api.get(`/api/v4/${entityType}/${entityId}/links`, {
          params: { page, limit },
        })
      ).then(({ data }) => data);
      const current = data?._embedded?.links || [];
      links.push(...current);
      if (!data?._links?.next?.href || current.length < limit) break;
      page += 1;
    }
    return links;
  }

  private async getLeadTasks(api: AxiosInstance, leadId: number) {
    const tasks: any[] = [];
    const limit = 250;
    let page = 1;
    while (true) {
      const data = await this.requestWithRetry(() =>
        api.get("/api/v4/tasks", {
          params: {
            page,
            limit,
            "filter[entity_type]": "leads",
            "filter[entity_id]": leadId,
            "order[id]": "asc",
          },
        })
      ).then(({ data }) => data);
      const current = data?._embedded?.tasks || [];
      tasks.push(...current);
      if (!data?._links?.next?.href || current.length < limit) break;
      page += 1;
    }
    return tasks;
  }

  private async getAllEntityNotes(
    api: AxiosInstance,
    entityType: "leads" | "contacts",
    entityId: number
  ) {
    const notes: any[] = [];
    const limit = 250;
    let page = 1;
    while (true) {
      const data = await this.requestWithRetry(() =>
        api.get(`/api/v4/${entityType}/${entityId}/notes`, {
          params: { page, limit, with: "is_pinned" },
        })
      ).then(({ data }) => data);
      const current = data?._embedded?.notes || [];
      notes.push(...current);
      if (!data?._links?.next?.href || current.length < limit) break;
      page += 1;
    }
    return notes;
  }

  private buildCopiedNoteBody(note: any, serviceName: string) {
    return {
      note_type: note.note_type,
      params: {
        ...(note?.params || {}),
        service:
          note.note_type === "service_message"
            ? serviceName
            : note?.params?.service,
      },
      responsible_user_id: Number.isFinite(Number(note?.responsible_user_id))
        ? Number(note.responsible_user_id)
        : undefined,
    };
  }

  private async postCopiedNotes(
    api: AxiosInstance,
    entityType: "leads" | "contacts",
    entityId: number,
    noteBodies: any[]
  ) {
    for (const chunk of this.chunk(noteBodies, 100)) {
      if (!chunk.length) continue;
      await this.requestWithRetry(() =>
        api.post(`/api/v4/${entityType}/${entityId}/notes`, chunk)
      );
    }
  }

  private async getEntityChatEvents(
    api: AxiosInstance,
    entity: "lead" | "contact",
    entityIds: number[]
  ) {
    const normalizedEntityIds = Array.from(
      new Set(
        (entityIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
      )
    );
    if (!normalizedEntityIds.length) return [];

    const events: any[] = [];
    let page = 1;
    const limit = 100;
    const maxPages = 5;
    while (page <= maxPages) {
      const data = await this.requestWithRetry(() =>
        api.get("/api/v4/events", {
          params: {
            page,
            limit,
            "order[created_at]": "asc",
            "filter[entity][]": [entity],
            "filter[type][]": [...CHAT_EVENT_TYPES],
            "filter[entity_id][]": normalizedEntityIds,
          },
        })
      ).then(({ data }) => data);
      const current = data?._embedded?.events || [];
      events.push(...current);
      if (!data?._links?.next?.href || current.length < limit) break;
      page += 1;
    }
    return events;
  }

  private createApi(account: Account) {
    const api = this.accountsService.createConnector(
      account.amoId,
      account.widgetCode
    );
    api.interceptors.request.use(async (config) => {
      await this.waitForAmoSlot(account.amoId);
      return config;
    });
    return api;
  }

  private normalizeId(value: unknown, message: string) {
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0) {
      throw new BadRequestException(message);
    }
    return Math.floor(id);
  }

  private extractLeadId(value: string) {
    const fromUrl = String(value || "").match(/\/leads\/detail\/(\d+)/)?.[1];
    const fromDigits = String(value || "").match(/^\s*(\d+)\s*$/)?.[1];
    const parsed = Number(fromUrl || fromDigits || 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private normalizePermission(value: unknown): MergePermission {
    if (value === "leads") return "leads";
    if (value === "contacts") return "contacts";
    if (value === "none") return "none";
    return "all";
  }

  private normalizeFieldSources(value: unknown) {
    const result: Record<string, number> = {};
    if (!value || typeof value !== "object") return result;
    Object.entries(value as Record<string, unknown>).forEach(
      ([key, leadId]) => {
        const id = Number(leadId);
        if (!key || !Number.isFinite(id) || id <= 0) return;
        result[key] = Math.floor(id);
      }
    );
    return result;
  }

  private normalizeProfile(value: any): PublicProfilePayload {
    return {
      userName: String(value?.userName || value?.name || "").trim() || null,
      userId: Number.isFinite(Number(value?.userId))
        ? Number(value.userId)
        : null,
      email: String(value?.email || "").trim() || null,
      phone: String(value?.phone || "").trim() || null,
      domain: String(value?.domain || "").trim() || null,
    };
  }

  private formatProfile(profile: PublicProfilePayload) {
    const name = String(profile?.userName || "").trim();
    const id = Number(profile?.userId);
    const email = String(profile?.email || "").trim();
    return [
      name || (Number.isFinite(id) ? `ID ${id}` : "Пользователь amoCRM"),
      email ? `<${email}>` : "",
      Number.isFinite(id) ? `(ID ${id})` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private toSearchItem(lead: any) {
    return {
      id: Number(lead.id),
      name: lead.name || `Сделка #${lead.id}`,
      price: Number(lead.price || 0),
      createdAt: lead.created_at || null,
      responsibleUserId: lead.responsible_user_id || null,
    };
  }

  private findCustomField(lead: any, fieldId: number) {
    return (lead?.custom_fields_values || []).find(
      (field) => Number(field?.field_id) === Number(fieldId)
    );
  }

  private formatCustomField(field: any) {
    if (!field) return "";
    const values = Array.isArray(field?.values) ? field.values : [];
    return values
      .map((item) => {
        const value = item?.value;
        if (value === null || value === undefined || value === "") {
          if (item?.catalog_element_id)
            return `Элемент #${item.catalog_element_id}`;
          return "";
        }
        if (typeof value === "object") return JSON.stringify(value);
        return String(value);
      })
      .filter(Boolean)
      .join(", ");
  }

  private mapCustomFieldValues(values: any[]) {
    return values
      .map((value) => {
        const mapped: any = {};
        [
          "value",
          "enum_id",
          "enum_code",
          "currency",
          "catalog_id",
          "catalog_element_id",
        ].forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            mapped[key] = value[key];
          }
        });
        return mapped;
      })
      .filter((value) => Object.keys(value).length > 0);
  }

  private collectTags(entities: any[]) {
    const tags = new Map<string, any>();
    entities.forEach((entity) => {
      (entity?._embedded?.tags || []).forEach((tag) => {
        const key =
          Number.isFinite(Number(tag?.id)) && Number(tag.id) > 0
            ? `id:${tag.id}`
            : `name:${String(tag?.name || "")
                .trim()
                .toLowerCase()}`;
        if (!key || key === "name:") return;
        if (!tags.has(key)) {
          tags.set(key, {
            id: Number.isFinite(Number(tag?.id)) ? Number(tag.id) : null,
            name: String(tag?.name || "").trim(),
          });
        }
      });
    });
    return Array.from(tags.values());
  }

  private buildContactMergeNoteText(
    duplicateContactId: number,
    reason: string,
    profile: PublicProfilePayload
  ) {
    return [
      `Контакт #${duplicateContactId} объединён с этим контактом.`,
      `Пользователь: ${this.formatProfile(profile)}.`,
      `Причина: ${reason}`,
    ].join("\n");
  }

  private hasValue(value: any): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return false;
  }

  private formatTimestamp(value: any) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(timestamp * 1000));
  }

  private formatMoney(value: any) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "";
    return `${amount.toLocaleString("ru-RU")} ₽`;
  }

  private getLeadUrl(accountUrl: string, leadId: number) {
    const base = String(accountUrl || "").replace(/\/$/, "");
    return `${base}/leads/detail/${leadId}`;
  }

  private formatAmoError(error: unknown) {
    const axiosError = error as AxiosError;
    const status = axiosError?.response?.status;
    const data = axiosError?.response?.data;
    const message = (error as Error)?.message || "unknown error";
    if (!status && !data) return message;
    return `${message}; status=${status || "-"}; response=${JSON.stringify(
      data || {}
    ).slice(0, 500)}`;
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
    maxAttempts = 7
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
          code === "ECONNABORTED" ||
          code === "ETIMEDOUT" ||
          code === "ECONNRESET" ||
          code === "EAI_AGAIN";

        if (!shouldRetry || attempt === maxAttempts) throw error;

        const retryAfterHeader =
          axiosError?.response?.headers?.["retry-after"] ||
          axiosError?.response?.headers?.["Retry-After"];
        const retryAfterSeconds = Number(retryAfterHeader);
        const delayMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 15000);
        await this.sleep(delayMs);
      }
    }
    throw lastError;
  }

  private async waitForAmoSlot(accountId: number) {
    const now = Date.now();
    const globalIntervalMs = 180;
    const accountIntervalMs = 240;
    const globalWait = Math.max(0, this.globalNextRequestAt - now);
    const accountWait = Math.max(
      0,
      (this.accountNextRequestAt.get(accountId) || 0) - now
    );
    const wait = Math.max(globalWait, accountWait);
    if (wait > 0) await this.sleep(wait);

    const base = Date.now();
    this.globalNextRequestAt = base + globalIntervalMs;
    this.accountNextRequestAt.set(accountId, base + accountIntervalMs);
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
