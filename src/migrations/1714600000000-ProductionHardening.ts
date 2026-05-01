import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductionHardening1714600000000 implements MigrationInterface {
  name = 'ProductionHardening1714600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS account (
        id int NOT NULL AUTO_INCREMENT,
        amoId int NOT NULL,
        domain varchar(255) NOT NULL,
        oauth LONGTEXT NOT NULL,
        installedAt datetime NULL,
        installNotifiedAt datetime NULL,
        adminName varchar(255) NULL,
        adminEmail varchar(255) NULL,
        adminPhone varchar(255) NULL,
        adminUserId int NULL,
        usersCount int NOT NULL DEFAULT 0,
        trialActivatedAt datetime NULL,
        trialEndsAt datetime NULL,
        trialRequestedEmail varchar(255) NULL,
        trialRequestedPhone varchar(255) NULL,
        paidUntil datetime NULL,
        graceExtendedUntil datetime NULL,
        graceExtensionUsed tinyint NOT NULL DEFAULT 0,
        paymentRequestedAt datetime NULL,
        paymentRequestedBy varchar(255) NULL,
        paymentRequestContext varchar(255) NULL,
        lastSeenAt datetime NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS copy_request (
        id varchar(64) NOT NULL,
        accountId int NOT NULL,
        total int NOT NULL,
        completed int NOT NULL DEFAULT 0,
        failed int NOT NULL DEFAULT 0,
        results json NULL,
        status varchar(32) NOT NULL DEFAULT 'queued',
        createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        finishedAt datetime NULL,
        INDEX IDX_copy_request_accountId (accountId),
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);

    await this.ensureColumn(
      queryRunner,
      'account',
      'installedAt',
      'datetime NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'installNotifiedAt',
      'datetime NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'adminName',
      'varchar(255) NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'adminEmail',
      'varchar(255) NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'adminPhone',
      'varchar(255) NULL',
    );
    await this.ensureColumn(queryRunner, 'account', 'adminUserId', 'int NULL');
    await this.ensureColumn(
      queryRunner,
      'account',
      'usersCount',
      'int NOT NULL DEFAULT 0',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'trialActivatedAt',
      'datetime NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'trialEndsAt',
      'datetime NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'trialRequestedEmail',
      'varchar(255) NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'trialRequestedPhone',
      'varchar(255) NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'paidUntil',
      'datetime NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'graceExtendedUntil',
      'datetime NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'graceExtensionUsed',
      'tinyint NOT NULL DEFAULT 0',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'paymentRequestedAt',
      'datetime NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'paymentRequestedBy',
      'varchar(255) NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'paymentRequestContext',
      'varchar(255) NULL',
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'lastSeenAt',
      'datetime NULL',
    );

    await queryRunner.query(
      `ALTER TABLE account MODIFY COLUMN oauth LONGTEXT NOT NULL`,
    );
    await queryRunner.query(
      `DELETE a FROM account a INNER JOIN account b WHERE a.amoId = b.amoId AND a.id < b.id`,
    );

    if (
      !(await this.hasIndex(queryRunner, 'account', 'IDX_account_amoId_unique'))
    ) {
      await queryRunner.query(
        `CREATE UNIQUE INDEX IDX_account_amoId_unique ON account (amoId)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (
      await this.hasIndex(queryRunner, 'account', 'IDX_account_amoId_unique')
    ) {
      await queryRunner.query(`DROP INDEX IDX_account_amoId_unique ON account`);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS copy_request`);
  }

  private async ensureColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    definition: string,
  ) {
    const rows = await queryRunner.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [
      column,
    ]);
    if (!rows?.length) {
      await queryRunner.query(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
      );
    }
  }

  private async hasIndex(
    queryRunner: QueryRunner,
    table: string,
    index: string,
  ) {
    const rows = await queryRunner.query(
      `SHOW INDEX FROM ${table} WHERE Key_name = ?`,
      [index],
    );
    return Boolean(rows?.length);
  }
}
