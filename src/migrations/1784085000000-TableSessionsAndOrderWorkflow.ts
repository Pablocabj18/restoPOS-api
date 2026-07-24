import { MigrationInterface, QueryRunner } from 'typeorm'

export class TableSessionsAndOrderWorkflow1784085000000 implements MigrationInterface {
  name = 'TableSessionsAndOrderWorkflow1784085000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `user` MODIFY `companyId` int NULL')
    await queryRunner.query(
      "ALTER TABLE `order` MODIFY `status` enum ('open','confirmed','preparing','ready','delivered','paid','closed','cancelled') NOT NULL DEFAULT 'open'"
    )
    await queryRunner.query(`
      CREATE TABLE \`table_session\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`tableId\` int NOT NULL,
        \`openTableId\` int NULL,
        \`status\` enum ('open','closed') NOT NULL DEFAULT 'open',
        \`openedByUserId\` int NULL,
        \`closedByUserId\` int NULL,
        \`openedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`closedAt\` datetime NULL,
        UNIQUE INDEX \`IDX_table_session_open_table\` (\`openTableId\`),
        PRIMARY KEY (\`id\`),
        CONSTRAINT \`FK_table_session_table\` FOREIGN KEY (\`tableId\`) REFERENCES \`table\`(\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `)
    await queryRunner.query('ALTER TABLE `order` ADD `tableSessionId` int NULL')
    await queryRunner.query(
      'ALTER TABLE `order` ADD CONSTRAINT `FK_order_table_session` FOREIGN KEY (`tableSessionId`) REFERENCES `table_session`(`id`) ON DELETE NO ACTION'
    )

    // Preserve current restaurant activity: one session per table with an active order.
    await queryRunner.query(`
      INSERT INTO \`table_session\` (\`tableId\`, \`openTableId\`, \`status\`, \`openedAt\`)
      SELECT DISTINCT o.\`tableId\`, o.\`tableId\`, 'open', MIN(o.\`createdAt\`)
      FROM \`order\` o
      WHERE o.\`tableId\` IS NOT NULL AND o.\`status\` NOT IN ('closed', 'cancelled')
      GROUP BY o.\`tableId\`
    `)
    await queryRunner.query(`
      UPDATE \`order\` o
      INNER JOIN \`table_session\` ts ON ts.\`tableId\` = o.\`tableId\` AND ts.\`status\` = 'open'
      SET o.\`tableSessionId\` = ts.\`id\`
      WHERE o.\`status\` NOT IN ('closed', 'cancelled')
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `order` DROP FOREIGN KEY `FK_order_table_session`')
    await queryRunner.query('ALTER TABLE `order` DROP COLUMN `tableSessionId`')
    await queryRunner.query('DROP TABLE `table_session`')
    await queryRunner.query("ALTER TABLE `order` MODIFY `status` enum ('open','closed','cancelled') NOT NULL DEFAULT 'open'")
    await queryRunner.query('ALTER TABLE `user` MODIFY `companyId` int NOT NULL')
  }
}
