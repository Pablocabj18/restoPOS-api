import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm'

export class OrderItemNotes1784087000000 implements MigrationInterface {
  name = 'OrderItemNotes1784087000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('order_item')
    if (table && !table.findColumnByName('notes')) {
      await queryRunner.addColumn('order_item', new TableColumn({
        name: 'notes',
        type: 'varchar',
        length: '500',
        isNullable: true
      }))
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('order_item')
    if (table?.findColumnByName('notes')) await queryRunner.dropColumn('order_item', 'notes')
  }
}
