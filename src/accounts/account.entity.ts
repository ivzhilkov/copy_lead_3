import { OAuthField } from 'src/interfaces/oauth-field.interface';
import { normalizeAmoDomain } from 'src/helpers/amo-domain';
import { encryptedJsonTransformer } from 'src/security/encrypted-json.transformer';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { CrmClient } from './crm-client.entity';
import { WidgetIntegration } from './widget-integration.entity';

@Entity()
export class Account {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_account_amoId')
  @Column()
  amoId: number;

  @Column()
  domain: string;

  get url(): string {
    return `https://${normalizeAmoDomain(this.domain)}`;
  }

  @Column({ type: 'longtext', transformer: encryptedJsonTransformer })
  oauth: OAuthField;

  @Column({ nullable: true })
  clientAccountId?: number | null;

  @ManyToOne(() => CrmClient, (client) => client.widgets, { nullable: true })
  @JoinColumn({ name: 'clientAccountId' })
  client?: CrmClient | null;

  @Column({ nullable: true })
  integrationId?: number | null;

  @ManyToOne(() => WidgetIntegration, (integration) => integration.accounts, {
    nullable: true,
  })
  @JoinColumn({ name: 'integrationId' })
  integration?: WidgetIntegration | null;

  @Column({ default: 'copy_leads' })
  widgetSlug: string;

  @Column({ default: 'Копирование сделок' })
  widgetName: string;

  @Index('IDX_account_widgetCode')
  @Column({ nullable: true })
  widgetCode?: string | null;

  @Column({ nullable: true })
  amoClientId?: string | null;

  @Column({ type: 'datetime', nullable: true })
  installedAt?: Date | null;

  @Column({ type: 'datetime', nullable: true })
  installNotifiedAt?: Date | null;

  @Column({ type: 'boolean', default: false })
  isLegacy: boolean;

  @Column({ nullable: true })
  firstSeenSource?: string | null;

  @Column({ nullable: true })
  adminName?: string | null;

  @Column({ nullable: true })
  adminEmail?: string | null;

  @Column({ nullable: true })
  adminPhone?: string | null;

  @Column({ nullable: true })
  adminUserId?: number | null;

  @Column({ type: 'int', default: 0 })
  usersCount: number;

  @Column({ type: 'datetime', nullable: true })
  trialActivatedAt?: Date | null;

  @Column({ type: 'datetime', nullable: true })
  trialEndsAt?: Date | null;

  @Column({ nullable: true })
  trialRequestedEmail?: string | null;

  @Column({ nullable: true })
  trialRequestedPhone?: string | null;

  @Column({ type: 'datetime', nullable: true })
  paidUntil?: Date | null;

  @Column({ type: 'datetime', nullable: true })
  graceExtendedUntil?: Date | null;

  @Column({ type: 'boolean', default: false })
  graceExtensionUsed: boolean;

  @Column({ type: 'datetime', nullable: true })
  paymentRequestedAt?: Date | null;

  @Column({ nullable: true })
  paymentRequestedBy?: string | null;

  @Column({ nullable: true })
  paymentRequestContext?: string | null;

  @Column({ type: 'datetime', nullable: true })
  lastSeenAt?: Date | null;
}
