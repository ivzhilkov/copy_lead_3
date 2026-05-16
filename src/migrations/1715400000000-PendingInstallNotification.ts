import { MigrationInterface, QueryRunner } from 'typeorm';

export class PendingInstallNotification1715400000000 implements MigrationInterface {
  name = 'PendingInstallNotification1715400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.ensureColumn(
      queryRunner,
      'crm_client',
      'pendingInstallNotifiedAt',
      'datetime NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.dropColumnIfExists(queryRunner, 'crm_client', 'pendingInstallNotifiedAt');
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
