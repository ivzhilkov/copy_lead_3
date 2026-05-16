import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminCredential1715500000000 implements MigrationInterface {
  name = 'AdminCredential1715500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin_credential (
        id int NOT NULL AUTO_INCREMENT,
        login varchar(255) NOT NULL DEFAULT 'admin',
        passwordHash varchar(255) NOT NULL,
        salt varchar(255) NOT NULL,
        createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS admin_credential`);
  }
}
