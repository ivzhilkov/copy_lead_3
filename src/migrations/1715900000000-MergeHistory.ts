import { MigrationInterface, QueryRunner } from "typeorm";

export class MergeHistory1715900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("merge_history");
    if (table) return;

    await queryRunner.query(`
      CREATE TABLE merge_history (
        id int NOT NULL AUTO_INCREMENT,
        accountId int NOT NULL,
        widgetCode varchar(255) NULL,
        primaryLeadId int NOT NULL,
        secondaryLeadId int NOT NULL,
        resultLeadId int NULL,
        deletedLeadId int NULL,
        contactIds json NULL,
        userName varchar(255) NULL,
        userId int NULL,
        reason text NOT NULL,
        permission varchar(32) NOT NULL DEFAULT 'all',
        details json NULL,
        createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        INDEX IDX_merge_history_account_created (accountId, createdAt),
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE merge_history");
  }
}
