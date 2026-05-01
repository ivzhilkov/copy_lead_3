import { OAuthField } from 'src/interfaces/oauth-field.interface';
import { normalizeAmoDomain } from 'src/helpers/amo-domain';
import { encryptedJsonTransformer } from 'src/security/encrypted-json.transformer';
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity()
export class Account {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_account_amoId_unique', { unique: true })
  @Column()
  amoId: number;

  @Column()
  domain: string;

  get url(): string {
    return `https://${normalizeAmoDomain(this.domain)}`;
  }

  @Column({ type: 'longtext', transformer: encryptedJsonTransformer })
  oauth: OAuthField;

  @Column({ type: 'datetime', nullable: true })
  installedAt?: Date | null;

  @Column({ type: 'datetime', nullable: true })
  installNotifiedAt?: Date | null;

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
