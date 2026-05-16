import { MigrationInterface, QueryRunner } from 'typeorm';

export class PendingClientLegacy1715500000000 implements MigrationInterface {
  name = 'PendingClientLegacy1715500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.ensureColumn(
      queryRunner,
      'crm_client',
      'isLegacy',
      'tinyint NOT NULL DEFAULT 0',
    );
    await this.ensureColumn(
      queryRunner,
      'crm_client',
      'firstSeenSource',
      'varchar(255) NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.dropColumnIfExists(queryRunner, 'crm_client', 'firstSeenSource');
    await this.dropColumnIfExists(queryRunner, 'crm_client', 'isLegacy');
  }

  private async ensureColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    definition: string,
  ) {
    const rows = await queryRunner.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
    if (!rows?.length) {
      await queryRunner.query(`ALTER TABLE ${table} ADD ${column} ${definition}`);
    }
  }

  private async dropColumnIfExists(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ) {
    const rows = await queryRunner.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
    if (rows?.length) {
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
}
