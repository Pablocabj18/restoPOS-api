import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm'

export class OfficialAuthentication1784340000000 implements MigrationInterface {
  name = 'OfficialAuthentication1784340000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    let userTable = await queryRunner.getTable('user')
    if (!userTable) return

    const add = async (column: TableColumn) => {
      if (!userTable!.findColumnByName(column.name)) {
        await queryRunner.addColumn('user', column)
        userTable = await queryRunner.getTable('user')
      }
    }

    await add(new TableColumn({ name: 'username', type: 'varchar', length: '80', isNullable: true }))
    await add(new TableColumn({ name: 'status', type: 'enum', enum: ['pending_activation', 'active', 'disabled', 'password_reset_required'], default: "'active'" }))
    await add(new TableColumn({ name: 'mustSetPassword', type: 'boolean', default: false }))
    await add(new TableColumn({ name: 'createdByUserId', type: 'int', isNullable: true }))
    await add(new TableColumn({ name: 'tokenVersion', type: 'int', default: 0 }))
    await add(new TableColumn({ name: 'createdAt', type: 'datetime', precision: 6, default: 'CURRENT_TIMESTAMP(6)' }))
    await add(new TableColumn({ name: 'updatedAt', type: 'datetime', precision: 6, default: 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' }))

    const emailColumn = userTable.findColumnByName('email')!
    if (!emailColumn.isNullable) await queryRunner.changeColumn('user', emailColumn, new TableColumn({
      name: 'email', type: emailColumn.type, length: emailColumn.length || undefined, isNullable: true
    }))
    const passwordColumn = userTable.findColumnByName('password')!
    if (!passwordColumn.isNullable) await queryRunner.changeColumn('user', passwordColumn, new TableColumn({
      name: 'password', type: passwordColumn.type, length: passwordColumn.length || undefined, isNullable: true
    }))

    await queryRunner.query(`
      UPDATE \`user\`
      SET \`username\` = CONCAT(
        CASE
          WHEN LENGTH(REGEXP_REPLACE(LOWER(SUBSTRING_INDEX(COALESCE(\`email\`, CONCAT('user', \`id\`)), '@', 1)), '[^a-z0-9._-]', '')) >= 3
          THEN REGEXP_REPLACE(LOWER(SUBSTRING_INDEX(COALESCE(\`email\`, CONCAT('user', \`id\`)), '@', 1)), '[^a-z0-9._-]', '')
          ELSE CONCAT('user', \`id\`)
        END,
        '-', \`id\`
      )
      WHERE \`username\` IS NULL OR \`username\` = ''
    `)
    await queryRunner.query("UPDATE `user` SET `status` = CASE WHEN `active` = 0 THEN 'disabled' ELSE 'active' END")
    await queryRunner.query(`
      UPDATE \`user\`
      SET \`restaurantId\` = (SELECT MIN(r.\`id\`) FROM \`restaurant\` r)
      WHERE \`restaurantId\` IS NULL AND (SELECT COUNT(*) FROM \`restaurant\`) = 1
    `)
    await queryRunner.query('UPDATE `user` SET `companyId` = NULL WHERE `companyId` = 0')
    const [{ total, admins }] = await queryRunner.query("SELECT COUNT(*) total, SUM(role = 'admin') admins FROM `user`")
    if (Number(total) === 1 && Number(admins) === 0) {
      await queryRunner.query("UPDATE `user` SET `role` = 'admin' LIMIT 1")
    }

    userTable = (await queryRunner.getTable('user'))!
    for (const index of userTable.indices.filter(index => index.isUnique && index.columnNames.length === 1 && index.columnNames[0] === 'email')) {
      await queryRunner.dropIndex('user', index)
    }
    if (!userTable.indices.some(index => index.name === 'IDX_user_restaurant_username')) {
      await queryRunner.createIndex('user', new TableIndex({ name: 'IDX_user_restaurant_username', columnNames: ['restaurantId', 'username'], isUnique: true }))
    }
    if (!userTable.indices.some(index => index.name === 'IDX_user_restaurant_email')) {
      await queryRunner.createIndex('user', new TableIndex({ name: 'IDX_user_restaurant_email', columnNames: ['restaurantId', 'email'], isUnique: true }))
    }

    if (!(await queryRunner.hasTable('auth_challenge'))) {
      await queryRunner.createTable(new Table({
        name: 'auth_challenge',
        columns: [
          { name: 'id', type: 'int', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'tokenHash', type: 'varchar', length: '64' },
          { name: 'userId', type: 'int' },
          { name: 'purpose', type: 'enum', enum: ['login', 'password_setup'] },
          { name: 'expiresAt', type: 'datetime' },
          { name: 'usedAt', type: 'datetime', isNullable: true },
          { name: 'attempts', type: 'int', default: 0 },
          { name: 'createdAt', type: 'datetime', precision: 6, default: 'CURRENT_TIMESTAMP(6)' }
        ],
        indices: [{ name: 'IDX_auth_challenge_token_hash', columnNames: ['tokenHash'], isUnique: true }]
      }))
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('auth_challenge')) await queryRunner.dropTable('auth_challenge')
    for (const name of ['tokenVersion', 'createdByUserId', 'mustSetPassword', 'status', 'username']) {
      const table = await queryRunner.getTable('user')
      if (table?.findColumnByName(name)) await queryRunner.dropColumn('user', name)
    }
  }
}
