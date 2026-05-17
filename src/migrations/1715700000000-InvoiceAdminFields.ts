import { MigrationInterface, QueryRunner } from 'typeorm';

export class InvoiceAdminFields1715700000000 implements MigrationInterface {
  private async ensureColumn(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    definition: string,
  ) {
    const table = await queryRunner.getTable(tableName);
    const exists = table?.findColumnByName(columnName);
    if (!exists) {
      await queryRunner.query(
        `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
      );
    }
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.ensureColumn(queryRunner, 'billing_invoice', 'status', "varchar(255) NOT NULL DEFAULT 'issued'");
    await this.ensureColumn(queryRunner, 'billing_invoice', 'paidAt', 'datetime NULL');

    await this.ensureColumn(queryRunner, 'account', 'billingInn', 'varchar(255) NULL');
    await this.ensureColumn(queryRunner, 'account', 'billingLegalName', 'varchar(255) NULL');
    await this.ensureColumn(queryRunner, 'account', 'billingOgrn', 'varchar(255) NULL');
    await this.ensureColumn(queryRunner, 'account', 'latestInvoiceNumber', 'varchar(255) NULL');
    await this.ensureColumn(queryRunner, 'account', 'latestInvoiceStatus', 'varchar(255) NULL');
    await this.ensureColumn(queryRunner, 'account', 'latestInvoiceCreatedAt', 'datetime NULL');
    await this.ensureColumn(queryRunner, 'account', 'latestInvoicePaidAt', 'datetime NULL');

    await this.ensureColumn(queryRunner, 'crm_client', 'billingInn', 'varchar(255) NULL');
    await this.ensureColumn(queryRunner, 'crm_client', 'billingLegalName', 'varchar(255) NULL');
    await this.ensureColumn(queryRunner, 'crm_client', 'billingOgrn', 'varchar(255) NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE billing_invoice DROP COLUMN paidAt');
    await queryRunner.query('ALTER TABLE billing_invoice DROP COLUMN status');
    await queryRunner.query('ALTER TABLE account DROP COLUMN latestInvoicePaidAt');
    await queryRunner.query('ALTER TABLE account DROP COLUMN latestInvoiceCreatedAt');
    await queryRunner.query('ALTER TABLE account DROP COLUMN latestInvoiceStatus');
    await queryRunner.query('ALTER TABLE account DROP COLUMN latestInvoiceNumber');
    await queryRunner.query('ALTER TABLE account DROP COLUMN billingOgrn');
    await queryRunner.query('ALTER TABLE account DROP COLUMN billingLegalName');
    await queryRunner.query('ALTER TABLE account DROP COLUMN billingInn');
    await queryRunner.query('ALTER TABLE crm_client DROP COLUMN billingOgrn');
    await queryRunner.query('ALTER TABLE crm_client DROP COLUMN billingLegalName');
    await queryRunner.query('ALTER TABLE crm_client DROP COLUMN billingInn');
  }
}
