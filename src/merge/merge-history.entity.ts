import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity({ name: "merge_history" })
@Index(["accountId", "createdAt"])
export class MergeHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  accountId: number;

  @Column({ nullable: true })
  widgetCode?: string | null;

  @Column({ type: "int" })
  primaryLeadId: number;

  @Column({ type: "int" })
  secondaryLeadId: number;

  @Column({ type: "int", nullable: true })
  resultLeadId?: number | null;

  @Column({ type: "int", nullable: true })
  deletedLeadId?: number | null;

  @Column({ type: "json", nullable: true })
  contactIds?: number[] | null;

  @Column({ nullable: true })
  userName?: string | null;

  @Column({ type: "int", nullable: true })
  userId?: number | null;

  @Column({ type: "text" })
  reason: string;

  @Column({ length: 32, default: "all" })
  permission: string;

  @Column({ type: "json", nullable: true })
  details?: Record<string, any> | null;

  @CreateDateColumn({ type: "datetime" })
  createdAt: Date;
}
