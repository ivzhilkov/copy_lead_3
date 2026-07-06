import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import axios, { AxiosError, AxiosInstance } from "axios";
import { Account } from "src/accounts/account.entity";
import { AccountsService } from "src/accounts/accounts.service";
import { Repository } from "typeorm";
import { MergeHistory } from "./merge-history.entity";

const EDITABLE_NOTE_TYPES = new Set(["common", "attachment"]);

const CHAT_EVENT_TYPES = [
  "incoming_chat_message",
  "outgoing_chat_message",
  "entity_direct_message",
] as const;

type MergePermission = "all" | "leads" | "contacts" | "none";
type MergeEntityType = "leads" | "contacts" | "companies";
type StandaloneEntityType = MergeEntityType;

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

type ContactMergeResult = {
  contactIds: number[];
  survivorContactId: number | null;
  deletedContactIds: number[];
  pendingContactDeleteIds: number[];
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

type EntityFieldValueView = {
  entityId: number;
  hasValue: boolean;
  display: string;
  items?: EntityFieldValueItem[];
};

type EntityFieldValueItem = {
  key: string;
  entityId: number;
  display: string;
};

type EntityFieldRow = {
  key: string;
  label: string;
  type: "base" | "custom";
  mode?: "single" | "multiple";
  customFieldId?: number;
  defaultEntityId: number | null;
  values: EntityFieldValueView[];
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
    const selectedMultiValueKeys = this.normalizeStringList(
      body?.selected_multi_value_keys
    );
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
    const contactFieldSources = this.normalizeFieldSources(
      body?.contact_field_sources
    );
    const selectedContactTagKeys = Array.isArray(
      body?.selected_contact_tag_keys
    )
      ? body.selected_contact_tag_keys
          .map((value) => String(value || ""))
          .filter(Boolean)
      : [];
    const selectedContactMultiValueKeys = this.normalizeStringList(
      body?.selected_contact_multi_value_keys
    );
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

    let contactMergeResult: ContactMergeResult = {
      contactIds: [],
      survivorContactId: null,
      deletedContactIds: [],
      pendingContactDeleteIds: [],
    };
    if (mergeContacts && selectedContactIds.length) {
      contactMergeResult = await this.mergeContacts(
        api,
        pair.resultLeadId,
        selectedContactIds,
        contactFieldSources,
        selectedContactTagKeys,
        selectedContactMultiValueKeys,
        reason,
        profile,
        warnings
      );
    }

    const pendingLeadDeleteIds: number[] = [];
    if (canMergeLeads) {
      const leadDeleted = await this.deleteEntityOrWarn(
        api,
        "leads",
        pair.deletedLeadId,
        warnings
      );
      if (!leadDeleted) pendingLeadDeleteIds.push(pair.deletedLeadId);
    }

    await this.createMergeSystemNote(
      api,
      account,
      pair,
      reason,
      profile,
      contactMergeResult.contactIds,
      canMergeLeads
    );

    await this.historyRepo.save({
      accountId: account.amoId,
      widgetCode: account.widgetCode,
      primaryLeadId: sourceLeadId,
      secondaryLeadId: targetLeadId,
      resultLeadId: pair.resultLeadId,
      deletedLeadId: canMergeLeads ? pair.deletedLeadId : null,
      contactIds: contactMergeResult.contactIds,
      userName: profile.userName,
      userId: profile.userId,
      reason,
      permission,
      details: {
        fieldSources,
        selectedTagKeys,
        mergeContacts,
        deletedContactIds: contactMergeResult.deletedContactIds,
        pendingLeadDeleteIds,
        pendingContactDeleteIds: contactMergeResult.pendingContactDeleteIds,
        warnings,
      },
    });

    return {
      ok: true,
      resultLeadId: pair.resultLeadId,
      deletedLeadId: canMergeLeads ? pair.deletedLeadId : null,
      contactIds: contactMergeResult.contactIds,
      deletedContactIds: contactMergeResult.deletedContactIds,
      pendingLeadDeleteIds,
      pendingContactDeleteIds: contactMergeResult.pendingContactDeleteIds,
      warnings,
      message: "Объединение выполнено.",
    };
  }

  async searchEntities(
    account: Account,
    entityTypeRaw: unknown,
    excludeIdsRaw: unknown,
    query: string
  ) {
    const entityType = this.normalizeStandaloneEntityType(entityTypeRaw);
    const excludeIds = new Set(
      this.normalizeOptionalIds(excludeIdsRaw).filter((id) =>
        Number.isFinite(id)
      )
    );
    const normalizedQuery = String(query || "").trim();
    if (normalizedQuery.length < 2) return { items: [] };

    const api = this.createApi(account);
    const results = new Map<number, any>();
    const idFromQuery = this.extractEntityId(entityType, normalizedQuery);

    if (idFromQuery && !excludeIds.has(idFromQuery)) {
      try {
        const entity = await this.getMergeEntity(api, entityType, idFromQuery);
        if (entity?.id) {
          results.set(
            Number(entity.id),
            this.toEntitySearchItem(entityType, entity)
          );
        }
      } catch (e) {
        const status = (e as AxiosError)?.response?.status;
        if (status !== 404 && status !== 204) throw e;
      }
    }

    if (!/^\d+$/.test(normalizedQuery) || normalizedQuery.length >= 3) {
      const data = await this.requestWithRetry(() =>
        api.get(`/api/v4/${entityType}`, {
          params: {
            query: normalizedQuery,
            limit: 10,
            with: "leads,customers,catalog_elements",
          },
        })
      ).then(({ data }) => data);

      const entities = data?._embedded?.[entityType] || [];
      entities.forEach((entity) => {
        const id = Number(entity?.id);
        if (Number.isFinite(id) && !excludeIds.has(id)) {
          results.set(id, this.toEntitySearchItem(entityType, entity));
        }
      });
    }

    return { items: Array.from(results.values()).slice(0, 10) };
  }

  async buildEntityPreview(
    account: Account,
    entityTypeRaw: unknown,
    entityIdsRaw: unknown
  ) {
    const entityType = this.normalizeStandaloneEntityType(entityTypeRaw);
    const entityIds = this.normalizeEntityIds(
      entityIdsRaw,
      "Выберите от 2 до 5 сущностей для объединения",
      2,
      5
    );

    const api = this.createApi(account);
    const [entities, customFields, users, statuses] = await Promise.all([
      Promise.all(
        entityIds.map((id) => this.getMergeEntity(api, entityType, id))
      ),
      this.getCustomFieldsForEntity(api, entityType),
      this.getUsersMap(api),
      entityType === "leads"
        ? this.getStatusesMap(api)
        : Promise.resolve(new Map<string, string>()),
    ]);

    const safeEntities = entities.filter((entity) =>
      Number.isFinite(Number(entity?.id))
    );
    if (safeEntities.length < 2) {
      throw new BadRequestException("Не удалось загрузить выбранные карточки");
    }

    const resultEntityId = this.getOldestEntityId(safeEntities);
    const deletedEntityIds = safeEntities
      .map((entity) => Number(entity.id))
      .filter((id) => id !== resultEntityId);
    const fields = this.buildEntityFieldRows(
      entityType,
      safeEntities,
      customFields,
      users,
      statuses
    );
    const tags = this.buildGenericTagsPreview(safeEntities);
    const linkedLeads =
      entityType === "leads"
        ? []
        : await this.buildLinkedLeadsPreview(api, entityType, safeEntities);

    return {
      entityType,
      entityLabel: this.getEntityTypePluralName(entityType),
      entities: safeEntities.map((entity) =>
        this.toPreviewEntity(entityType, entity, users)
      ),
      olderEntityId: resultEntityId,
      resultEntityId,
      deletedEntityIds,
      fields,
      tags,
      linkedLeads,
    };
  }

  async executeEntityMerge(account: Account, body: any) {
    const entityType = this.normalizeStandaloneEntityType(body?.entity_type);
    const entityIds = this.normalizeEntityIds(
      body?.entity_ids,
      "Выберите от 2 до 5 сущностей для объединения",
      2,
      5
    );
    const reason = String(body?.reason || "").trim();
    if (reason.length < 4) {
      throw new BadRequestException(
        "Укажите причину объединения, минимум 4 символа"
      );
    }

    const permission = this.normalizePermission(body?.permission);
    const canMergeEntity =
      entityType === "leads"
        ? permission === "all" || permission === "leads"
        : permission === "all" || permission === "contacts";
    if (!canMergeEntity) {
      throw new BadRequestException(
        "У пользователя нет прав на это объединение"
      );
    }

    const fieldSources = this.normalizeFieldSources(body?.field_sources);
    const selectedMultiValueKeys = this.normalizeStringList(
      body?.selected_multi_value_keys
    );
    const selectedTagKeys = Array.isArray(body?.selected_tag_keys)
      ? body.selected_tag_keys
          .map((value) => String(value || ""))
          .filter(Boolean)
      : [];
    const selectedLinkedLeadIds = this.normalizeOptionalIds(
      body?.selected_linked_lead_ids
    );
    const profile = this.normalizeProfile(body?.profile);
    const api = this.createApi(account);

    const [entities, customFields, users] = await Promise.all([
      Promise.all(
        entityIds.map((id) => this.getMergeEntity(api, entityType, id))
      ),
      this.getCustomFieldsForEntity(api, entityType),
      this.getUsersMap(api),
    ]);
    const safeEntities = entities.filter((entity) =>
      Number.isFinite(Number(entity?.id))
    );
    if (safeEntities.length < 2) {
      throw new BadRequestException("Не удалось загрузить выбранные карточки");
    }

    const resultEntityId = this.getOldestEntityId(safeEntities);
    const deletedEntityIds: number[] = [];
    const pendingEntityDeleteIds: number[] = [];
    const warnings: string[] = [];
    const patch = this.buildEntityMergePatch(
      entityType,
      safeEntities,
      customFields,
      fieldSources,
      selectedTagKeys,
      selectedMultiValueKeys
    );

    if (Object.keys(patch).length) {
      await this.requestWithRetry(() =>
        api.patch(`/api/v4/${entityType}/${resultEntityId}`, patch)
      );
    }

    if (entityType !== "leads") {
      await this.syncEntityLeadLinks(
        api,
        entityType,
        resultEntityId,
        selectedLinkedLeadIds,
        warnings
      );
    }

    for (const duplicate of safeEntities) {
      const duplicateId = Number(duplicate.id);
      if (duplicateId === resultEntityId) continue;
      if (entityType === "leads") {
        await this.linkEntitiesFromLeadId(
          api,
          duplicateId,
          resultEntityId,
          warnings
        );
        await this.copyLeadNotes(api, duplicateId, resultEntityId, warnings);
        await this.copyLeadTasks(api, duplicateId, resultEntityId, warnings);
      } else if (entityType === "contacts") {
        await this.moveContactChats(api, duplicateId, resultEntityId, warnings);
        await this.copyEntityNotes(
          api,
          entityType,
          duplicateId,
          resultEntityId,
          warnings
        );
      } else {
        await this.copyEntityNotes(
          api,
          entityType,
          duplicateId,
          resultEntityId,
          warnings
        );
      }
      const deleted = await this.deleteEntityOrWarn(
        api,
        entityType,
        duplicateId,
        warnings
      );
      if (deleted) deletedEntityIds.push(duplicateId);
      else pendingEntityDeleteIds.push(duplicateId);
    }

    await this.createEntityMergeSystemNote(
      api,
      account,
      entityType,
      safeEntities.map((entity) => Number(entity.id)),
      resultEntityId,
      selectedLinkedLeadIds,
      reason,
      profile
    );

    await this.historyRepo.save({
      accountId: account.amoId,
      widgetCode: account.widgetCode,
      primaryLeadId: entityIds[0],
      secondaryLeadId: entityIds[1],
      resultLeadId: resultEntityId,
      deletedLeadId: deletedEntityIds[0] || null,
      contactIds:
        entityType === "contacts"
          ? safeEntities.map((entity) => Number(entity.id))
          : [],
      userName: profile.userName,
      userId: profile.userId,
      reason,
      permission,
      details: {
        entityType,
        entityIds,
        fieldSources,
        selectedMultiValueKeys,
        selectedTagKeys,
        selectedLinkedLeadIds,
        deletedEntityIds,
        pendingEntityDeleteIds,
        warnings,
      },
    });

    return {
      ok: true,
      entityType,
      resultEntityId,
      deletedEntityIds,
      pendingEntityDeleteIds,
      pendingLeadDeleteIds:
        entityType === "leads" ? pendingEntityDeleteIds : [],
      pendingContactDeleteIds:
        entityType === "contacts" ? pendingEntityDeleteIds : [],
      pendingCompanyDeleteIds:
        entityType === "companies" ? pendingEntityDeleteIds : [],
      warnings,
      message: "Объединение выполнено.",
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
    fieldSources: Record<string, number>,
    selectedTagKeys: string[],
    selectedMultiValueKeys: string[],
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
    if (!safeContacts.length) {
      return {
        contactIds: [],
        survivorContactId: null,
        deletedContactIds: [],
        pendingContactDeleteIds: [],
      };
    }

    const survivor = [...safeContacts].sort(
      (a, b) => Number(a?.created_at || 0) - Number(b?.created_at || 0)
    )[0];
    const survivorId = Number(survivor.id);
    const duplicateContacts = safeContacts.filter(
      (contact) => Number(contact.id) !== survivorId
    );

    const customFields = await this.getCustomFieldsForEntity(api, "contacts");
    const patch =
      Object.keys(fieldSources || {}).length || selectedTagKeys.length
        ? this.buildEntityMergePatch(
            "contacts",
            safeContacts,
            customFields,
            fieldSources,
            selectedTagKeys,
            selectedMultiValueKeys
          )
        : this.buildContactPatch(survivor, duplicateContacts);
    if (Object.keys(patch).length) {
      await this.requestWithRetry(() =>
        api.patch(`/api/v4/contacts/${survivorId}`, patch)
      );
    }

    await this.safeLinkLeadContact(api, resultLeadId, survivorId, warnings);

    const deletedContactIds: number[] = [];
    const pendingContactDeleteIds: number[] = [];
    for (const duplicate of duplicateContacts) {
      const duplicateId = Number(duplicate.id);
      await this.moveContactChats(api, duplicateId, survivorId, warnings);
      await this.copyContactNotes(api, duplicateId, survivorId, warnings);
      const contactDeleted = await this.deleteEntityOrWarn(
        api,
        "contacts",
        duplicateId,
        warnings
      );
      if (contactDeleted) deletedContactIds.push(duplicateId);
      else pendingContactDeleteIds.push(duplicateId);
    }

    return {
      contactIds: safeContacts.map((contact) => Number(contact.id)),
      survivorContactId: survivorId,
      deletedContactIds,
      pendingContactDeleteIds,
    };
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

  private buildEntityMergePatch(
    entityType: MergeEntityType,
    entities: any[],
    customFields: Map<number, any>,
    fieldSources: Record<string, number>,
    selectedTagKeys: string[],
    selectedMultiValueKeys: string[] = []
  ) {
    const byId = new Map<number, any>(
      entities.map((entity) => [Number(entity.id), entity])
    );
    const patch: any = {};
    const customFieldsPatch: any[] = [];
    const selectedMultiValues = this.buildSelectedMultiCustomFields(
      entities,
      selectedMultiValueKeys
    );
    const handledMultiFieldIds = new Set<number>(
      selectedMultiValues.map((field) => Number(field.field_id))
    );
    customFieldsPatch.push(...selectedMultiValues);

    Object.entries(fieldSources || {}).forEach(([key, sourceEntityId]) => {
      const source = byId.get(Number(sourceEntityId));
      if (!source) return;

      if (key === "name" && this.hasValue(source.name)) {
        patch.name = source.name;
        return;
      }
      if (
        entityType === "contacts" &&
        key === "first_name" &&
        this.hasValue(source.first_name)
      ) {
        patch.first_name = source.first_name;
        return;
      }
      if (
        entityType === "contacts" &&
        key === "last_name" &&
        this.hasValue(source.last_name)
      ) {
        patch.last_name = source.last_name;
        return;
      }
      if (
        key === "responsible_user_id" &&
        Number.isFinite(Number(source.responsible_user_id))
      ) {
        patch.responsible_user_id = Number(source.responsible_user_id);
        return;
      }
      if (
        entityType === "leads" &&
        key === "created_at" &&
        Number.isFinite(Number(source.created_at))
      ) {
        patch.created_at = Number(source.created_at);
        return;
      }
      if (
        entityType === "leads" &&
        key === "price" &&
        Number.isFinite(Number(source.price))
      ) {
        patch.price = Number(source.price);
        return;
      }
      if (entityType === "leads" && key === "status") {
        if (Number.isFinite(Number(source.pipeline_id))) {
          patch.pipeline_id = Number(source.pipeline_id);
        }
        if (Number.isFinite(Number(source.status_id))) {
          patch.status_id = Number(source.status_id);
        }
        return;
      }
      if (
        entityType === "leads" &&
        key === "source_id" &&
        Number.isFinite(Number(source.source_id))
      ) {
        patch.source_id = Number(source.source_id);
        return;
      }
      if (key.startsWith("cf_")) {
        const fieldId = Number(key.replace(/^cf_/, ""));
        if (handledMultiFieldIds.has(fieldId)) return;
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

    const selectedTags = this.buildGenericTagsPreview(entities).filter((tag) =>
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

  private async syncEntityLeadLinks(
    api: AxiosInstance,
    entityType: StandaloneEntityType,
    resultEntityId: number,
    selectedLeadIds: number[],
    warnings: string[]
  ) {
    const selected = new Set(
      (selectedLeadIds || []).filter((id) => Number.isFinite(id) && id > 0)
    );
    const links = await this.getEntityLinks(api, entityType, resultEntityId);
    const currentLeadIds = new Set(
      links
        .filter((link) => link?.to_entity_type === "leads")
        .map((link) => Number(link?.to_entity_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    );

    const toAttach = Array.from(selected)
      .filter((leadId) => !currentLeadIds.has(leadId))
      .map((leadId) => ({
        to_entity_id: leadId,
        to_entity_type: "leads",
      }));
    for (const chunk of this.chunk(toAttach, 50)) {
      if (!chunk.length) continue;
      try {
        await this.requestWithRetry(() =>
          api.post(`/api/v4/${entityType}/${resultEntityId}/link`, chunk)
        );
      } catch (e) {
        warnings.push(
          `не удалось привязать часть сделок к ${this.getEntitySingularName(
            entityType
          )} #${resultEntityId}: ${this.formatAmoError(e)}`
        );
      }
    }

    const toDetach = Array.from(currentLeadIds)
      .filter((leadId) => !selected.has(leadId))
      .map((leadId) => ({
        to_entity_id: leadId,
        to_entity_type: "leads",
      }));
    for (const chunk of this.chunk(toDetach, 50)) {
      if (!chunk.length) continue;
      try {
        await this.requestWithRetry(() =>
          api.post(`/api/v4/${entityType}/${resultEntityId}/unlink`, chunk)
        );
      } catch (e) {
        warnings.push(
          `не удалось отвязать часть сделок от ${this.getEntitySingularName(
            entityType
          )} #${resultEntityId}: ${this.formatAmoError(e)}`
        );
      }
    }
  }

  private async copyEntityNotes(
    api: AxiosInstance,
    entityType: StandaloneEntityType,
    sourceEntityId: number,
    targetEntityId: number,
    warnings: string[]
  ) {
    try {
      const notes = await this.getAllEntityNotes(
        api,
        entityType,
        sourceEntityId
      );
      const serviceName =
        entityType === "contacts"
          ? "Объединение контактов"
          : "Объединение компаний";
      const bodies = notes
        .filter((note) => EDITABLE_NOTE_TYPES.has(note.note_type))
        .map((note) => this.buildCopiedNoteBody(note, serviceName));
      await this.postCopiedNotes(api, entityType, targetEntityId, bodies);
    } catch (e) {
      warnings.push(
        `не удалось перенести примечания ${this.getEntityGenitiveName(
          entityType
        )} #${sourceEntityId}: ${this.formatAmoError(e)}`
      );
    }
  }

  private async createEntityMergeSystemNote(
    api: AxiosInstance,
    account: Account,
    entityType: StandaloneEntityType,
    entityIds: number[],
    resultEntityId: number,
    selectedLeadIds: number[],
    reason: string,
    profile: PublicProfilePayload
  ) {
    const user = this.formatProfileName(profile);
    const dateText = this.formatTimestamp(Math.floor(Date.now() / 1000));
    const resultUrl = this.getEntityUrl(
      account.url,
      entityType,
      resultEntityId
    );
    const linkedText =
      entityType === "leads"
        ? null
        : selectedLeadIds.length
        ? `Оставлены сделки: ${selectedLeadIds
            .map((id) => `#${id}`)
            .join(", ")}.`
        : "Связанные сделки не оставлены.";
    const text = [
      `Объединил: ${user}.`,
      `Когда: ${dateText}.`,
      `${this.getEntityTypePluralName(entityType)} ${entityIds
        .map((id) => `#${id}`)
        .join(", ")} объединены в #${resultEntityId}.`,
      `Итоговая карточка: ${resultUrl}.`,
      linkedText,
      `Причина: ${reason}`,
    ]
      .filter(Boolean)
      .join("\n");

    await this.safeCreateEntitySystemNote(
      api,
      entityType,
      resultEntityId,
      text
    );
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
    await this.linkEntitiesFromLeadId(
      api,
      pair.deletedLeadId,
      pair.resultLeadId,
      warnings
    );
  }

  private async linkEntitiesFromLeadId(
    api: AxiosInstance,
    sourceLeadId: number,
    targetLeadId: number,
    warnings: string[]
  ) {
    const links = await this.getEntityLinks(api, "leads", sourceLeadId);
    const payload = links
      .filter((link) => Number(link?.to_entity_id) > 0 && link?.to_entity_type)
      .map((link) => {
        const item: any = {
          to_entity_id: Number(link.to_entity_id),
          to_entity_type: link.to_entity_type,
        };
        const metadata = this.normalizeLinkMetadataForAttach(link);
        if (metadata) item.metadata = metadata;
        return item;
      });

    for (const chunk of this.chunk(payload, 50)) {
      if (!chunk.length) continue;
      try {
        await this.requestWithRetry(() =>
          api.post(`/api/v4/leads/${targetLeadId}/link`, chunk)
        );
      } catch (e) {
        warnings.push(
          `не удалось перенести часть связей сделки #${sourceLeadId}: ${this.formatAmoError(
            e
          )}`
        );
      }
    }
  }

  private normalizeLinkMetadataForAttach(link: any) {
    const metadata = link?.metadata || {};
    const entityType = String(link?.to_entity_type || "");
    const normalized: any = {};

    if (entityType === "contacts") {
      if (typeof metadata.is_main === "boolean") {
        normalized.is_main = metadata.is_main;
      } else if (typeof metadata.main_contact === "boolean") {
        normalized.is_main = metadata.main_contact;
      }
    }

    if (entityType === "catalog_elements") {
      if (Number.isFinite(Number(metadata.catalog_id))) {
        normalized.catalog_id = Number(metadata.catalog_id);
      }
      if (Number.isFinite(Number(metadata.quantity))) {
        normalized.quantity = Number(metadata.quantity);
      }
      if (
        metadata.price_id === null ||
        Number.isFinite(Number(metadata.price_id))
      ) {
        normalized.price_id =
          metadata.price_id === null ? null : Number(metadata.price_id);
      }
    }

    if (Number.isFinite(Number(metadata.updated_by))) {
      normalized.updated_by = Number(metadata.updated_by);
    }

    return Object.keys(normalized).length ? normalized : null;
  }

  private async createMergeSystemNote(
    api: AxiosInstance,
    account: Account,
    pair: LeadPair,
    reason: string,
    profile: PublicProfilePayload,
    contactIds: number[],
    leadWasDeleted: boolean
  ) {
    const user = this.formatProfileName(profile);
    const resultUrl = this.getLeadUrl(account.url, pair.resultLeadId);
    const dateText = this.formatTimestamp(Math.floor(Date.now() / 1000));
    const actionText = leadWasDeleted
      ? `Сделки #${pair.left.id} и #${pair.right.id} объединены в #${pair.resultLeadId}.`
      : `Контакты объединены в сделке #${pair.resultLeadId}.`;
    const contactsText = contactIds.length
      ? `Контакты: ${contactIds.map((id) => `#${id}`).join(", ")}.`
      : "Контакты не объединялись.";
    const text = [
      `Объединил: ${user}.`,
      `Когда: ${dateText}.`,
      actionText,
      `Итоговая сделка: ${resultUrl}.`,
      contactsText,
      `Причина: ${reason}`,
    ].join("\n");

    await this.safeCreateLeadSystemNote(api, pair.resultLeadId, text);
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

  private async deleteEntityOrWarn(
    api: AxiosInstance,
    entityType: MergeEntityType,
    entityId: number,
    warnings: string[]
  ) {
    try {
      const deleted = await this.deleteEntity(api, entityType, entityId);
      if (!deleted) {
        warnings.push(
          `${this.getEntitySingularName(
            entityType
          )} #${entityId} не удалён: amoCRM оставила карточку активной`
        );
      }
      return deleted;
    } catch (e) {
      warnings.push(
        `не удалось удалить ${this.getEntityAccusativeName(
          entityType
        )} #${entityId}: ${this.formatAmoError(e)}`
      );
      return false;
    }
  }

  private async deleteEntity(
    api: AxiosInstance,
    entityType: MergeEntityType,
    entityId: number
  ) {
    const attempts: Array<() => Promise<void>> = [
      () =>
        this.requestWithRetry(() =>
          api.delete(`/api/v4/${entityType}/${entityId}`)
        ).then(() => undefined),
      () =>
        this.requestWithRetry(() =>
          api.delete(`/api/v2/${entityType}/${entityId}`)
        ).then(() => undefined),
      () =>
        this.requestWithRetry(() =>
          api.patch(`/api/v4/${entityType}`, [
            {
              id: entityId,
              is_deleted: true,
            },
          ])
        ).then(() => undefined),
      () =>
        this.requestWithRetry(() =>
          api.patch(`/api/v4/${entityType}/${entityId}`, {
            is_deleted: true,
          })
        ).then(() => undefined),
      () => this.deleteEntityViaAjax(api, entityType, entityId),
    ];

    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        await attempt();
        await this.sleep(500);
        if (await this.isEntityDeleted(api, entityType, entityId)) return true;
      } catch (e) {
        lastError = e;
        const status = (e as AxiosError)?.response?.status;
        if (![400, 401, 403, 404, 405, 415, 422].includes(Number(status))) {
          throw e;
        }
      }
    }

    if (lastError) {
      this.logger.warn(
        `Could not delete ${entityType} #${entityId}: ${this.formatAmoError(
          lastError
        )}`
      );
    }
    return this.isEntityDeleted(api, entityType, entityId);
  }

  private async deleteEntityViaAjax(
    api: AxiosInstance,
    entityType: MergeEntityType,
    entityId: number
  ) {
    const body = new URLSearchParams();
    body.append("ACTION", "DELETE");
    body.append("ID[]", String(entityId));

    await this.requestWithRetry(() =>
      api.post(`/ajax/${entityType}/multiple/delete/`, body.toString(), {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
      })
    );
  }

  private async isEntityDeleted(
    api: AxiosInstance,
    entityType: MergeEntityType,
    entityId: number
  ) {
    try {
      const { data } = await this.requestWithRetry(() =>
        api.get(`/api/v4/${entityType}/${entityId}`)
      );
      if (data?.is_deleted === true) return true;
      if (Number(data?.id) === Number(entityId)) return false;
    } catch (e) {
      const status = (e as AxiosError)?.response?.status;
      if ([204, 404].includes(Number(status))) return true;
      throw e;
    }

    try {
      const { data } = await this.requestWithRetry(() =>
        api.get(`/api/v4/${entityType}/${entityId}`, {
          params: { with: "only_deleted" },
        })
      );
      return data?.is_deleted === true;
    } catch (e) {
      const status = (e as AxiosError)?.response?.status;
      if ([204, 404].includes(Number(status))) return true;
      throw e;
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

  private async safeCreateEntitySystemNote(
    api: AxiosInstance,
    entityType: MergeEntityType,
    entityId: number,
    text: string
  ) {
    try {
      const service =
        entityType === "leads"
          ? "Объединение сделок"
          : entityType === "contacts"
          ? "Объединение контактов"
          : "Объединение компаний";
      await this.requestWithRetry(() =>
        api.post(`/api/v4/${entityType}/${entityId}/notes`, [
          {
            note_type: "service_message",
            params: {
              service,
              text,
            },
          },
        ])
      );
    } catch (e) {
      this.logger.warn(
        `Не удалось создать системное примечание для ${entityType} ${entityId}: ${this.formatAmoError(
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
              this.formatCustomField(
                this.findCustomField(lead, fieldId),
                schema
              ),
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

  private buildEntityFieldRows(
    entityType: StandaloneEntityType,
    entities: any[],
    customFields: Map<number, any>,
    users: Map<number, string>,
    statuses: Map<string, string> = new Map()
  ): EntityFieldRow[] {
    const baseRows: Array<{
      key: string;
      label: string;
      getDisplay: (entity: any) => string;
      hasValue?: (entity: any) => boolean;
    }> = [
      {
        key: "name",
        label: "Имя",
        getDisplay: (entity) => String(entity?.name || ""),
      },
      ...(entityType === "contacts"
        ? [
            {
              key: "first_name",
              label: "Имя контакта",
              getDisplay: (entity: any) => String(entity?.first_name || ""),
            },
            {
              key: "last_name",
              label: "Фамилия контакта",
              getDisplay: (entity: any) => String(entity?.last_name || ""),
            },
          ]
        : []),
      {
        key: "responsible_user_id",
        label: "Отв-ный",
        getDisplay: (entity) =>
          users.get(Number(entity?.responsible_user_id)) ||
          (entity?.responsible_user_id
            ? `ID ${entity.responsible_user_id}`
            : ""),
      },
      ...(entityType === "leads"
        ? [
            {
              key: "created_at",
              label: "Дата создания",
              getDisplay: (entity: any) =>
                this.formatTimestamp(entity?.created_at),
            },
            {
              key: "price",
              label: "Бюджет",
              getDisplay: (entity: any) => this.formatMoney(entity?.price),
              hasValue: (entity: any) => Number.isFinite(Number(entity?.price)),
            },
            {
              key: "status",
              label: "Статус",
              getDisplay: (entity: any) =>
                statuses.get(`${entity?.pipeline_id}_${entity?.status_id}`) ||
                [entity?.pipeline_id, entity?.status_id]
                  .filter(Boolean)
                  .join(" / "),
            },
            {
              key: "source_id",
              label: "Источник",
              getDisplay: (entity: any) =>
                entity?.source_id ? `ID ${entity.source_id}` : "",
            },
          ]
        : []),
    ];

    const rows = baseRows.map((row) =>
      this.toEntityFieldRow(
        entities,
        row.key,
        row.label,
        "base",
        row.getDisplay,
        row.hasValue
      )
    );

    const customFieldIds = new Set<number>();
    entities.forEach((entity) => {
      (entity?.custom_fields_values || []).forEach((field) => {
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
        if (
          entityType === "contacts" &&
          this.isContactMultiValueField(entities, fieldId, schema)
        ) {
          rows.push(
            this.toEntityMultiValueFieldRow(
              entities,
              `cf_${fieldId}`,
              schema?.name || `Поле #${fieldId}`,
              fieldId
            )
          );
          return;
        }
        rows.push(
          this.toEntityFieldRow(
            entities,
            `cf_${fieldId}`,
            schema?.name || `Поле #${fieldId}`,
            "custom",
            (entity) =>
              this.formatCustomField(
                this.findCustomField(entity, fieldId),
                schema
              ),
            (entity) => Boolean(this.findCustomField(entity, fieldId)),
            fieldId
          )
        );
      });

    return rows.filter((row) => row.values.some((value) => value.hasValue));
  }

  private toEntityMultiValueFieldRow(
    entities: any[],
    key: string,
    label: string,
    customFieldId: number
  ): EntityFieldRow {
    const values = entities.map((entity) => {
      const sourceField = this.findCustomField(entity, customFieldId);
      const items = this.buildSelectableCustomValueItems(entity, sourceField);
      return {
        entityId: Number(entity.id),
        hasValue: items.length > 0,
        display: items.map((item) => item.display).join(", "),
        items,
      };
    });

    return {
      key,
      label,
      type: "custom",
      mode: "multiple",
      customFieldId,
      defaultEntityId: null,
      values,
    };
  }

  private toEntityFieldRow(
    entities: any[],
    key: string,
    label: string,
    type: "base" | "custom",
    getDisplay: (entity: any) => string,
    hasValueFn?: (entity: any) => boolean,
    customFieldId?: number
  ): EntityFieldRow {
    const values = entities.map((entity) => {
      const display = getDisplay(entity);
      return {
        entityId: Number(entity.id),
        hasValue: hasValueFn ? hasValueFn(entity) : this.hasValue(display),
        display,
      };
    });
    const olderEntityId = this.getOldestEntityId(entities);
    const olderValue = values.find((value) => value.entityId === olderEntityId);
    const fallbackValue = values.find((value) => value.hasValue);

    return {
      key,
      label,
      type,
      customFieldId,
      defaultEntityId: olderValue?.hasValue
        ? olderValue.entityId
        : fallbackValue?.entityId || null,
      values,
    };
  }

  private buildGenericTagsPreview(entities: any[]) {
    const tags = new Map<string, any>();
    entities.forEach((entity) => {
      const entityId = Number(entity?.id);
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
            key,
            id: Number.isFinite(Number(tag?.id)) ? Number(tag.id) : null,
            name: String(tag?.name || `Тег #${tag?.id}`).trim(),
            entityIds: [],
          });
        }
        const saved = tags.get(key);
        if (!saved.entityIds.includes(entityId)) saved.entityIds.push(entityId);
      });
    });
    return Array.from(tags.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "ru")
    );
  }

  private async buildLinkedLeadsPreview(
    api: AxiosInstance,
    entityType: StandaloneEntityType,
    entities: any[]
  ) {
    const leadIds = Array.from(
      new Set(
        entities.flatMap((entity) =>
          (entity?._embedded?.leads || [])
            .map((lead) => Number(lead?.id))
            .filter((id) => Number.isFinite(id) && id > 0)
        )
      )
    );

    const leads = await Promise.all(
      leadIds.map(async (leadId) => {
        try {
          return await this.getLead(api, leadId);
        } catch (e) {
          return { id: leadId, name: `Сделка #${leadId}` };
        }
      })
    );

    return leads
      .sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0))
      .map((lead) => ({
        id: Number(lead.id),
        name: lead.name || `Сделка #${lead.id}`,
        createdAt: lead.created_at || null,
        createdAtText: this.formatTimestamp(lead.created_at),
        price: Number(lead.price || 0),
        defaultSelected: true,
        entityType,
      }));
  }

  private getOldestEntityId(entities: any[]) {
    const sorted = [...entities].sort((left, right) => {
      const leftCreatedAt = Number(left?.created_at || 0);
      const rightCreatedAt = Number(right?.created_at || 0);
      if (leftCreatedAt && rightCreatedAt && leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
      }
      return Number(left?.id || 0) - Number(right?.id || 0);
    });
    return Number(sorted[0]?.id);
  }

  private toPreviewEntity(
    entityType: StandaloneEntityType,
    entity: any,
    users: Map<number, string>
  ) {
    return {
      id: Number(entity.id),
      entityType,
      name:
        entity.name ||
        [entity.first_name, entity.last_name].filter(Boolean).join(" ") ||
        `${this.getEntitySingularName(entityType)} #${entity.id}`,
      createdAt: entity.created_at || null,
      createdAtText: this.formatTimestamp(entity.created_at),
      responsibleUserId: entity.responsible_user_id,
      responsibleName:
        users.get(Number(entity.responsible_user_id)) ||
        (entity.responsible_user_id ? `ID ${entity.responsible_user_id}` : ""),
      summary:
        entityType === "contacts"
          ? this.contactSummary(entity)
          : this.companySummary(entity),
    };
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

  private companySummary(company: any) {
    const values = (company?.custom_fields_values || [])
      .flatMap((field) =>
        (field?.values || []).map((value) => String(value?.value || "").trim())
      )
      .filter(Boolean);
    return values.slice(0, 3).join(", ") || "нет заполненных полей";
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

  private async getCompany(api: AxiosInstance, companyId: number) {
    return this.requestWithRetry(() =>
      api.get(`/api/v4/companies/${companyId}`, {
        params: { with: "leads,customers,catalog_elements" },
      })
    ).then(({ data }) => data);
  }

  private async getMergeEntity(
    api: AxiosInstance,
    entityType: MergeEntityType,
    entityId: number
  ) {
    if (entityType === "leads") return this.getLead(api, entityId);
    if (entityType === "contacts") return this.getContact(api, entityId);
    return this.getCompany(api, entityId);
  }

  private async getCustomFields(api: AxiosInstance) {
    return this.getCustomFieldsForEntity(api, "leads");
  }

  private async getCustomFieldsForEntity(
    api: AxiosInstance,
    entityType: MergeEntityType
  ) {
    const data = await this.requestWithRetry(() =>
      api.get(`/api/v4/${entityType}/custom_fields`, { params: { limit: 250 } })
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
    entityType: MergeEntityType,
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
    entityType: MergeEntityType,
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
    entityType: MergeEntityType,
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

    const limit = 100;
    const maxPages = 5;
    const eventsById = new Map<string, any>();

    for (const eventType of CHAT_EVENT_TYPES) {
      let page = 1;
      while (page <= maxPages) {
        const data = await this.requestWithRetry(() =>
          api.get("/api/v4/events", {
            params: {
              page,
              limit,
              "order[created_at]": "asc",
              "filter[entity]": entity,
              "filter[type]": eventType,
              "filter[entity_id][]": normalizedEntityIds,
            },
          })
        ).then(({ data }) => data);
        const current = data?._embedded?.events || [];
        current.forEach((event) => {
          const key = String(
            event?.id || `${event?.type}:${event?.created_at}`
          );
          if (key) eventsById.set(key, event);
        });
        if (!data?._links?.next?.href || current.length < limit) break;
        page += 1;
      }
    }

    return Array.from(eventsById.values()).sort(
      (left, right) =>
        Number(left?.created_at || 0) - Number(right?.created_at || 0)
    );
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
    api.interceptors.response.use(
      (response) => response,
      (error) => {
        const config = (error as AxiosError)?.config || {};
        this.logger.warn(
          `amoCRM merge request failed account=${account.amoId} method=${String(
            config.method || ""
          ).toUpperCase()} url=${config.url || "-"}: ${this.formatAmoError(
            error
          )}`
        );
        return Promise.reject(error);
      }
    );
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

  private extractEntityId(entityType: MergeEntityType, value: string) {
    const path =
      entityType === "leads"
        ? "leads"
        : entityType === "contacts"
        ? "contacts"
        : "companies";
    const fromUrl = String(value || "").match(
      new RegExp(`/${path}/detail/(\\d+)`)
    )?.[1];
    const fromDigits = String(value || "").match(/^\s*(\d+)\s*$/)?.[1];
    const parsed = Number(fromUrl || fromDigits || 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private normalizeStandaloneEntityType(value: unknown): StandaloneEntityType {
    const normalized = String(value || "").toLowerCase();
    if (normalized === "leads" || normalized === "lead") return "leads";
    if (normalized === "contacts" || normalized === "contact")
      return "contacts";
    if (normalized === "companies" || normalized === "company")
      return "companies";
    throw new BadRequestException("Некорректный тип сущности");
  }

  private normalizeOptionalIds(value: unknown) {
    const values = Array.isArray(value)
      ? value
      : typeof value === "string" && value.includes(",")
      ? value.split(",")
      : value === null || value === undefined || value === ""
      ? []
      : [value];
    return Array.from(
      new Set(
        values
          .map((item) => Number(item))
          .filter((id) => Number.isFinite(id) && id > 0)
          .map((id) => Math.floor(id))
      )
    );
  }

  private normalizeStringList(value: unknown) {
    const values = Array.isArray(value)
      ? value
      : typeof value === "string" && value.includes(",")
      ? value.split(",")
      : value === null || value === undefined || value === ""
      ? []
      : [value];
    return Array.from(
      new Set(
        values
          .map((item) => String(item || "").trim())
          .filter((item) => item.length > 0)
      )
    );
  }

  private normalizeEntityIds(
    value: unknown,
    message: string,
    minCount: number,
    maxCount: number
  ) {
    const ids = this.normalizeOptionalIds(value);
    if (ids.length < minCount || ids.length > maxCount) {
      throw new BadRequestException(message);
    }
    return ids;
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

  private formatProfileName(profile: PublicProfilePayload) {
    return (
      String(profile?.userName || "")
        .trim()
        .replace(/\s+/g, " ") || "Пользователь amoCRM"
    );
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

  private toEntitySearchItem(entityType: StandaloneEntityType, entity: any) {
    return {
      id: Number(entity.id),
      entityType,
      name:
        entity.name ||
        [entity.first_name, entity.last_name].filter(Boolean).join(" ") ||
        `${this.getEntitySingularName(entityType)} #${entity.id}`,
      createdAt: entity.created_at || null,
      createdAtText: this.formatTimestamp(entity.created_at),
      responsibleUserId: entity.responsible_user_id || null,
      summary:
        entityType === "contacts"
          ? this.contactSummary(entity)
          : this.companySummary(entity),
    };
  }

  private findCustomField(lead: any, fieldId: number) {
    return (lead?.custom_fields_values || []).find(
      (field) => Number(field?.field_id) === Number(fieldId)
    );
  }

  private isContactMultiValueField(
    entities: any[],
    fieldId: number,
    schema?: any
  ) {
    const schemaCode = String(
      schema?.code || schema?.field_code || schema?.type || ""
    ).toUpperCase();
    if (schemaCode === "PHONE" || schemaCode === "EMAIL") return true;

    return entities.some((entity) => {
      const field = this.findCustomField(entity, fieldId);
      const code = String(field?.field_code || field?.code || "").toUpperCase();
      return code === "PHONE" || code === "EMAIL";
    });
  }

  private buildSelectableCustomValueItems(entity: any, field: any) {
    const entityId = Number(entity?.id);
    const fieldId = Number(field?.field_id);
    const values = Array.isArray(field?.values) ? field.values : [];
    if (!Number.isFinite(entityId) || !Number.isFinite(fieldId)) return [];

    return values
      .map((value, index) => {
        const mapped = this.mapCustomFieldValues([value])[0];
        if (!mapped) return null;
        const display = this.formatCustomValueDisplay(value);
        if (!display) return null;
        return {
          key: this.buildCustomValueKey(entityId, fieldId, index, mapped),
          entityId,
          display,
        };
      })
      .filter(Boolean);
  }

  private buildSelectedMultiCustomFields(
    entities: any[],
    selectedKeys: string[]
  ) {
    const selected = new Set(selectedKeys || []);
    if (!selected.size) return [];

    const byField = new Map<number, any>();
    const seenByField = new Map<number, Set<string>>();
    entities.forEach((entity) => {
      const entityId = Number(entity?.id);
      (entity?.custom_fields_values || []).forEach((field) => {
        const fieldId = Number(field?.field_id);
        if (!Number.isFinite(entityId) || !Number.isFinite(fieldId)) return;
        const values = Array.isArray(field?.values) ? field.values : [];
        values.forEach((value, index) => {
          const mapped = this.mapCustomFieldValues([value])[0];
          if (!mapped) return;
          const key = this.buildCustomValueKey(
            entityId,
            fieldId,
            index,
            mapped
          );
          if (!selected.has(key)) return;

          if (!byField.has(fieldId)) {
            byField.set(fieldId, {
              field_id: fieldId,
              field_code: field.field_code,
              values: [],
            });
            seenByField.set(fieldId, new Set());
          }
          const stableValueKey = JSON.stringify(mapped);
          const seen = seenByField.get(fieldId)!;
          if (seen.has(stableValueKey)) return;
          seen.add(stableValueKey);
          byField.get(fieldId).values.push(mapped);
        });
      });
    });

    return Array.from(byField.values()).filter((field) => field.values.length);
  }

  private buildCustomValueKey(
    entityId: number,
    fieldId: number,
    index: number,
    value: any
  ) {
    const raw = Buffer.from(JSON.stringify(value)).toString("base64");
    return `${entityId}:${fieldId}:${index}:${raw}`;
  }

  private formatCustomValueDisplay(value: any) {
    const raw = value?.value;
    if (raw === null || raw === undefined || raw === "") return "";
    const text = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    const enumText = this.translateCustomValueEnum(value);
    return enumText ? `${text} · ${enumText}` : text;
  }

  private translateCustomValueEnum(value: any) {
    const raw = String(value?.enum || value?.enum_code || "").trim();
    if (!raw) return "";

    const labels: Record<string, string> = {
      WORK: "Рабочий",
      WORKDD: "Рабочий прямой",
      MOB: "Мобильный",
      MOBILE: "Мобильный",
      HOME: "Домашний",
      FAX: "Факс",
      OTHER: "Другой",
      PRIV: "Личный",
      PRIVATE: "Личный",
    };

    return labels[raw.toUpperCase()] || raw;
  }

  private formatCustomField(field: any, schema?: any) {
    if (!field) return "";
    const fieldType = String(
      field?.field_type ||
        field?.type ||
        schema?.type ||
        schema?.field_type ||
        ""
    ).toLowerCase();
    const values = Array.isArray(field?.values) ? field.values : [];
    return values
      .map((item) => {
        const value = item?.value;
        if (value === null || value === undefined || value === "") {
          if (item?.catalog_element_id)
            return `Элемент #${item.catalog_element_id}`;
          return "";
        }
        if (this.isDateFieldType(fieldType)) {
          return this.formatCustomFieldDateValue(value, fieldType);
        }
        if (typeof value === "object") return JSON.stringify(value);
        return String(value);
      })
      .filter(Boolean)
      .join(", ");
  }

  private isDateFieldType(fieldType: string) {
    return ["date", "datetime", "date_time", "birthday"].includes(fieldType);
  }

  private formatCustomFieldDateValue(value: any, fieldType: string) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return this.formatDate(
        value,
        fieldType !== "date" && fieldType !== "birthday"
      );
    }

    const raw = String(value || "").trim();
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      return this.formatDate(
        new Date(millis),
        fieldType !== "date" && fieldType !== "birthday"
      );
    }

    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) {
      return this.formatDate(
        parsed,
        fieldType !== "date" && fieldType !== "birthday"
      );
    }

    return raw;
  }

  private mapCustomFieldValues(values: any[]) {
    return values
      .map((value) => {
        const mapped: any = {};
        [
          "value",
          "enum_id",
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
    return this.formatDate(new Date(timestamp * 1000), true);
  }

  private formatDate(date: Date, withTime: boolean) {
    if (!Number.isFinite(date.getTime())) return "";
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      ...(withTime
        ? {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }
        : {}),
    }).format(date);
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

  private getEntityUrl(
    accountUrl: string,
    entityType: MergeEntityType,
    entityId: number
  ) {
    const base = String(accountUrl || "").replace(/\/$/, "");
    return `${base}/${entityType}/detail/${entityId}`;
  }

  private getEntitySingularName(entityType: MergeEntityType) {
    if (entityType === "leads") return "сделка";
    if (entityType === "contacts") return "контакт";
    return "компания";
  }

  private getEntityAccusativeName(entityType: MergeEntityType) {
    if (entityType === "leads") return "сделку";
    if (entityType === "contacts") return "контакт";
    return "компанию";
  }

  private getEntityGenitiveName(entityType: MergeEntityType) {
    if (entityType === "leads") return "сделки";
    if (entityType === "contacts") return "контакта";
    return "компании";
  }

  private getEntityTypePluralName(entityType: MergeEntityType) {
    if (entityType === "leads") return "Сделки";
    if (entityType === "contacts") return "Контакты";
    return "Компании";
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
