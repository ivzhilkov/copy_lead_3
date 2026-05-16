import { MigrationInterface, QueryRunner } from 'typeorm';

export class IntegrationAmoDomain1715400000000 implements MigrationInterface {
  name = 'IntegrationAmoDomain1715400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = await queryRunner.query(
      `SHOW COLUMNS FROM widget_integration LIKE 'amoDomain'`,
    );
    if (!rows?.length) {
      await queryRunner.query(
        `ALTER TABLE widget_integration ADD amoDomain varchar(255) NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = await queryRunner.query(
      `SHOW COLUMNS FROM widget_integration LIKE 'amoDomain'`,
    );
    if (rows?.length) {
      await queryRunner.query(
        `ALTER TABLE widget_integration DROP COLUMN amoDomain`,
      );
    }
  }
}
