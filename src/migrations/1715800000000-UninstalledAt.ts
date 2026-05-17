import { MigrationInterface, QueryRunner } from 'typeorm';

export class UninstalledAt1715800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('account');
    const exists = table?.findColumnByName('uninstalledAt');
    if (!exists) {
      await queryRunner.query(
        'ALTER TABLE account ADD COLUMN uninstalledAt datetime NULL',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE account DROP COLUMN uninstalledAt');
  }
}
