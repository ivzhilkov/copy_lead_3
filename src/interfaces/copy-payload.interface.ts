export interface CopyPayload {
  statusId: string;
  responsibleId: number;
  customFields: number[];
  budget: boolean;
  linkedEntities: boolean;
  tags: boolean;
  notes: boolean;
  tasks: boolean;
  createIfContactHasDeal: boolean;
}
