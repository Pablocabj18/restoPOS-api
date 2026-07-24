import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm'

export class PaymentsAndTableAdministration1784700000000 implements MigrationInterface {
  name = 'PaymentsAndTableAdministration1784700000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('table')
    if (table && !table.findColumnByName('active')) {
      await queryRunner.addColumn('table', new TableColumn({ name: 'active', type: 'boolean', default: true }))
    }
    if (!(await queryRunner.hasTable('payment'))) {
      await queryRunner.createTable(new Table({
        name: 'payment',
        columns: [
          { name: 'id', type: 'int', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'orderId', type: 'int' },
          { name: 'restaurantId', type: 'int', isNullable: true },
          { name: 'companyId', type: 'int', isNullable: true },
          { name: 'branchId', type: 'int', isNullable: true },
          { name: 'method', type: 'enum', enum: ['cash', 'card', 'transfer', 'mixed'] },
          { name: 'amount', type: 'decimal', precision: 12, scale: 2 },
          { name: 'receivedAmount', type: 'decimal', precision: 12, scale: 2, isNullable: true },
          { name: 'changeAmount', type: 'decimal', precision: 12, scale: 2, default: 0 },
          { name: 'tipAmount', type: 'decimal', precision: 12, scale: 2, default: 0 },
          { name: 'breakdown', type: 'json', isNullable: true },
          { name: 'notes', type: 'varchar', length: '500', isNullable: true },
          { name: 'paidByUserId', type: 'int' },
          { name: 'idempotencyKey', type: 'varchar', length: '100', isNullable: true },
          { name: 'createdAt', type: 'datetime', precision: 6, default: 'CURRENT_TIMESTAMP(6)' },
          { name: 'updatedAt', type: 'datetime', precision: 6, default: 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' }
        ],
        indices: [
          { name: 'UQ_payment_order', columnNames: ['orderId'], isUnique: true },
          { name: 'UQ_payment_idempotency', columnNames: ['idempotencyKey'], isUnique: true }
        ],
        foreignKeys: [{ name: 'FK_payment_order', columnNames: ['orderId'], referencedTableName: 'order', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }]
      }))
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('payment')) await queryRunner.dropTable('payment')
    const table = await queryRunner.getTable('table')
    if (table?.findColumnByName('active')) await queryRunner.dropColumn('table', 'active')
  }
}
