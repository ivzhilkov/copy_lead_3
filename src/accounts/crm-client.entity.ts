import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Account } from './account.entity';

@Entity()
export class CrmClient {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_crm_client_amoId_unique', { unique: true })
  @Column()
  amoId: number;

  @Column()
  domain: string;

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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Account, (account) => account.client)
  widgets: Account[];
}
