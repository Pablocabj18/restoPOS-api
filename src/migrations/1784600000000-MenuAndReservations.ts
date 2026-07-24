import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm'

export class MenuAndReservations1784600000000 implements MigrationInterface {
  name = 'MenuAndReservations1784600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    const category = await queryRunner.getTable('category')
    if (category && !category.findColumnByName('sortOrder')) {
      await queryRunner.addColumn('category', new TableColumn({ name: 'sortOrder', type: 'int', default: 0 }))
    }
    const product = await queryRunner.getTable('product')
    if (product && !product.findColumnByName('sortOrder')) {
      await queryRunner.addColumn('product', new TableColumn({ name: 'sortOrder', type: 'int', default: 0 }))
    }
    if (!(await queryRunner.hasTable('reservation'))) {
      await queryRunner.createTable(new Table({
        name: 'reservation',
        columns: [
          { name: 'id', type: 'int', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'restaurantId', type: 'int', isNullable: true },
          { name: 'companyId', type: 'int', isNullable: true },
          { name: 'branchId', type: 'int', isNullable: true },
          { name: 'customerName', type: 'varchar', length: '140' },
          { name: 'phone', type: 'varchar', length: '40' },
          { name: 'startsAt', type: 'datetime' },
          { name: 'durationMinutes', type: 'int', default: 120 },
          { name: 'partySize', type: 'int' },
          { name: 'tableId', type: 'int', isNullable: true },
          { name: 'tableSessionId', type: 'int', isNullable: true },
          { name: 'notes', type: 'varchar', length: '1000', isNullable: true },
          { name: 'status', type: 'enum', enum: ['pending', 'confirmed', 'seated', 'cancelled', 'no_show'], default: "'pending'" },
          { name: 'createdByUserId', type: 'int', isNullable: true },
          { name: 'source', type: 'varchar', length: '30', default: "'manual'" },
          { name: 'externalReference', type: 'varchar', length: '120', isNullable: true },
          { name: 'whatsappOptIn', type: 'boolean', default: false },
          { name: 'createdAt', type: 'datetime', precision: 6, default: 'CURRENT_TIMESTAMP(6)' },
          { name: 'updatedAt', type: 'datetime', precision: 6, default: 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' }
        ],
        indices: [
          { name: 'IDX_reservation_restaurant_starts_at', columnNames: ['restaurantId', 'startsAt'] },
          { name: 'IDX_reservation_company_starts_at', columnNames: ['companyId', 'startsAt'] }
        ],
        foreignKeys: [
          { name: 'FK_reservation_table', columnNames: ['tableId'], referencedTableName: 'table', referencedColumnNames: ['id'], onDelete: 'SET NULL' },
          { name: 'FK_reservation_table_session', columnNames: ['tableSessionId'], referencedTableName: 'table_session', referencedColumnNames: ['id'], onDelete: 'SET NULL' }
        ]
      }))
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('reservation')) await queryRunner.dropTable('reservation')
    for (const [tableName, columnName] of [['product', 'sortOrder'], ['category', 'sortOrder']]) {
      const table = await queryRunner.getTable(tableName)
      if (table?.findColumnByName(columnName)) await queryRunner.dropColumn(tableName, columnName)
    }
  }
}
