import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class BillingInvoice {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_billing_invoice_number_unique', { unique: true })
  @Column()
  invoiceNumber: string;

  @Index('IDX_billing_invoice_amoId')
  @Column()
  amoId: number;

  @Column({ nullable: true })
  accountId?: number | null;

  @Column({ nullable: true })
  widgetCode?: string | null;

  @Column()
  inn: string;

  @Column()
  legalName: string;

  @Column({ nullable: true })
  ogrn?: string | null;

  @Column({ nullable: true })
  phone?: string | null;

  @Column({ nullable: true })
  email?: string | null;

  @Column({ type: 'int', default: 1000000 })
  amountKopecks: number;

  @Column({ type: 'int', default: 5 })
  vatRate: number;

  @Column({ type: 'int', default: 47619 })
  vatKopecks: number;

  @Column({ nullable: true })
  source?: string | null;

  @Column({ nullable: true })
  dadataStatus?: string | null;

  @Column({ default: 'issued' })
  status: string;

  @Column({ type: 'datetime', nullable: true })
  paidAt?: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
