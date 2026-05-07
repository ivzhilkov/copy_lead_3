import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { encryptedJsonTransformer } from 'src/security/encrypted-json.transformer';
import { Account } from './account.entity';

@Entity()
export class WidgetIntegration {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_widget_integration_widgetCode_unique', { unique: true })
  @Column()
  widgetCode: string;

  @Index('IDX_widget_integration_clientId_unique', { unique: true })
  @Column()
  amoClientId: string;

  @Column({ type: 'longtext', transformer: encryptedJsonTransformer })
  amoClientSecret: string;

  @Column({ default: 'copy_leads' })
  widgetSlug: string;

  @Column({ default: 'Копирование сделок' })
  widgetName: string;

  @Column({ nullable: true })
  redirectUri?: string | null;

  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Account, (account) => account.integration)
  accounts: Account[];
}
