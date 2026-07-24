import { MigrationInterface, QueryRunner } from 'typeorm'

export class RepairOrderItemForeignKeyIndex1784086000000 implements MigrationInterface {
  name = 'RepairOrderItemForeignKeyIndex1784086000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('order_item')
    if (!table) return

    const supportIndex = table.indices.find(index => index.name === 'IDX_order_item_order_id')
    if (!supportIndex) {
      await queryRunner.query('CREATE INDEX `IDX_order_item_order_id` ON `order_item` (`orderId`)')
    }

    const obsoleteIndex = table.indices.find(index => index.name === 'IDX_7e383dc486afc7800bf87d1c11')
    if (obsoleteIndex) {
      await queryRunner.query('DROP INDEX `IDX_7e383dc486afc7800bf87d1c11` ON `order_item`')
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE UNIQUE INDEX `IDX_7e383dc486afc7800bf87d1c11` ON `order_item` (`orderId`, `productId`)')
    await queryRunner.query('DROP INDEX `IDX_order_item_order_id` ON `order_item`')
  }
}
