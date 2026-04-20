import { OAuthField } from 'src/interfaces/oauth-field.interface';
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Account {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  amoId: number;

  @Column()
  domain: string;

  get url(): string {
    return `https://${this.domain}`;
  }

  @Column({ type: 'json' })
  oauth: OAuthField;
}
