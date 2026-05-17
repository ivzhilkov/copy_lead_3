import { MigrationInterface, QueryRunner } from 'typeorm';

export class BillingInvoice1715600000000 implements MigrationInterface {
  name = 'BillingInvoice1715600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing_invoice (
        id int NOT NULL AUTO_INCREMENT,
        invoiceNumber varchar(255) NOT NULL,
        amoId int NOT NULL,
        accountId int NULL,
        widgetCode varchar(255) NULL,
        inn varchar(255) NOT NULL,
        legalName varchar(255) NOT NULL,
        ogrn varchar(255) NULL,
        phone varchar(255) NULL,
        email varchar(255) NULL,
        amountKopecks int NOT NULL DEFAULT 1000000,
        vatRate int NOT NULL DEFAULT 5,
        vatKopecks int NOT NULL DEFAULT 47619,
        source varchar(255) NULL,
        dadataStatus varchar(255) NULL,
        createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        UNIQUE INDEX IDX_billing_invoice_number_unique (invoiceNumber),
        INDEX IDX_billing_invoice_amoId (amoId),
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS billing_invoice');
  }
}
