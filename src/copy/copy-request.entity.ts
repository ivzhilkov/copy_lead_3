import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'copy_request' })
@Index(['accountId'])
export class CopyRequest {
  @PrimaryColumn({ length: 64 })
  id: string;

  @Column({ type: 'int' })
  accountId: number;

  @Column({ type: 'int' })
  total: number;

  @Column({ type: 'int', default: 0 })
  completed: number;

  @Column({ type: 'int', default: 0 })
  failed: number;

  @Column({ type: 'json', nullable: true })
  results: any[] | null;

  @Column({ length: 32, default: 'queued' })
  status: string;

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date;

  @Column({ type: 'datetime', nullable: true })
  finishedAt?: Date | null;
}
