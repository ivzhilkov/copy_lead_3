import { MigrationInterface, QueryRunner } from 'typeorm';

export class MultiWidgetAccounts1715200000000 implements MigrationInterface {
  name = 'MultiWidgetAccounts1715200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS crm_client (
        id int NOT NULL AUTO_INCREMENT,
        amoId int NOT NULL,
        domain varchar(255) NOT NULL,
        adminName varchar(255) NULL,
        adminEmail varchar(255) NULL,
        adminPhone varchar(255) NULL,
        adminUserId int NULL,
        usersCount int NOT NULL DEFAULT 0,
        createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS widget_integration (
        id int NOT NULL AUTO_INCREMENT,
        widgetCode varchar(255) NOT NULL,
        amoClientId varchar(255) NOT NULL,
        amoClientSecret LONGTEXT NOT NULL,
        widgetSlug varchar(255) NOT NULL DEFAULT 'copy_leads',
        widgetName varchar(255) NOT NULL DEFAULT 'Копирование сделок',
        redirectUri varchar(255) NULL,
        isDefault tinyint NOT NULL DEFAULT 0,
        createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);

    await this.ensureIndex(
      queryRunner,
      'crm_client',
      'IDX_crm_client_amoId_unique',
      'CREATE UNIQUE INDEX IDX_crm_client_amoId_unique ON crm_client (amoId)',
    );
    await this.ensureIndex(
      queryRunner,
      'widget_integration',
      'IDX_widget_integration_widgetCode_unique',
      'CREATE UNIQUE INDEX IDX_widget_integration_widgetCode_unique ON widget_integration (widgetCode)',
    );
    await this.ensureIndex(
      queryRunner,
      'widget_integration',
      'IDX_widget_integration_clientId_unique',
      'CREATE UNIQUE INDEX IDX_widget_integration_clientId_unique ON widget_integration (amoClientId)',
    );

    await this.ensureColumn(queryRunner, 'account', 'clientAccountId', 'int NULL');
    await this.ensureColumn(queryRunner, 'account', 'integrationId', 'int NULL');
    await this.ensureColumn(
      queryRunner,
      'account',
      'widgetSlug',
      "varchar(255) NOT NULL DEFAULT 'copy_leads'",
    );
    await this.ensureColumn(
      queryRunner,
      'account',
      'widgetName',
      "varchar(255) NOT NULL DEFAULT 'Копирование сделок'",
    );
    await this.ensureColumn(queryRunner, 'account', 'widgetCode', 'varchar(255) NULL');
    await this.ensureColumn(queryRunner, 'account', 'amoClientId', 'varchar(255) NULL');

    if (await this.hasIndex(queryRunner, 'account', 'IDX_account_amoId_unique')) {
      await queryRunner.query(`DROP INDEX IDX_account_amoId_unique ON account`);
    }
    await this.ensureIndex(
      queryRunner,
      'account',
      'IDX_account_amoId',
      'CREATE INDEX IDX_account_amoId ON account (amoId)',
    );
    await this.ensureIndex(
      queryRunner,
      'account',
      'IDX_account_widgetCode',
      'CREATE INDEX IDX_account_widgetCode ON account (widgetCode)',
    );

    await queryRunner.query(`
      INSERT INTO crm_client (amoId, domain, adminName, adminEmail, adminPhone, adminUserId, usersCount, createdAt, updatedAt)
      SELECT a.amoId, MAX(a.domain), MAX(a.adminName), MAX(a.adminEmail), MAX(a.adminPhone), MAX(a.adminUserId), MAX(a.usersCount), NOW(6), NOW(6)
      FROM account a
      LEFT JOIN crm_client c ON c.amoId = a.amoId
      WHERE c.id IS NULL
      GROUP BY a.amoId
    `);

    const widgetCode = String(process.env.WIDGET_CODE || '').trim();
    const clientId = String(process.env.CLIENT_ID || '').trim();
    const clientSecret = String(process.env.CLIENT_SECRET || '').trim();
    const redirectUri = String(process.env.REDIRECT_URI || '').trim();

    if (widgetCode && clientId && clientSecret) {
      await queryRunner.query(
        `
          INSERT INTO widget_integration
            (widgetCode, amoClientId, amoClientSecret, widgetSlug, widgetName, redirectUri, isDefault, createdAt, updatedAt)
          SELECT ?, ?, ?, 'copy_leads', 'Копирование сделок', ?, 1, NOW(6), NOW(6)
          WHERE NOT EXISTS (
            SELECT 1 FROM widget_integration WHERE widgetCode = ? OR amoClientId = ?
          )
        `,
        [widgetCode, clientId, clientSecret, redirectUri || null, widgetCode, clientId],
      );

      await queryRunner.query(
        `
          UPDATE account a
          JOIN crm_client c ON c.amoId = a.amoId
          JOIN widget_integration wi ON wi.widgetCode = ?
          SET
            a.clientAccountId = COALESCE(a.clientAccountId, c.id),
            a.integrationId = COALESCE(a.integrationId, wi.id),
            a.widgetCode = COALESCE(a.widgetCode, wi.widgetCode),
            a.amoClientId = COALESCE(a.amoClientId, wi.amoClientId),
            a.widgetSlug = COALESCE(NULLIF(a.widgetSlug, ''), wi.widgetSlug),
            a.widgetName = COALESCE(NULLIF(a.widgetName, ''), wi.widgetName)
        `,
        [widgetCode],
      );
    } else {
      await queryRunner.query(`
        UPDATE account a
        JOIN crm_client c ON c.amoId = a.amoId
        SET a.clientAccountId = COALESCE(a.clientAccountId, c.id)
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasIndex(queryRunner, 'account', 'IDX_account_widgetCode')) {
      await queryRunner.query(`DROP INDEX IDX_account_widgetCode ON account`);
    }
    if (await this.hasIndex(queryRunner, 'account', 'IDX_account_amoId')) {
      await queryRunner.query(`DROP INDEX IDX_account_amoId ON account`);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS widget_integration`);
    await queryRunner.query(`DROP TABLE IF EXISTS crm_client`);
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

  private async ensureIndex(
    queryRunner: QueryRunner,
    table: string,
    index: string,
    createSql: string,
  ) {
    if (!(await this.hasIndex(queryRunner, table, index))) {
      await queryRunner.query(createSql);
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
