import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class AdminCredential {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: 'admin' })
  login: string;

  @Column()
  passwordHash: string;

  @Column()
  salt: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
