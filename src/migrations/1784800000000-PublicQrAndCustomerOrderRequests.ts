import { MigrationInterface, QueryRunner } from 'typeorm'

export class PublicQrAndCustomerOrderRequests1784800000000 implements MigrationInterface {
  name = 'PublicQrAndCustomerOrderRequests1784800000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE `table` ADD `publicToken` varchar(64) NULL")
    await queryRunner.query("UPDATE `table` SET `publicToken` = LOWER(SHA2(CONCAT(UUID(), '-', `id`, '-', UUID()), 256)) WHERE `publicToken` IS NULL")
    await queryRunner.query("CREATE UNIQUE INDEX `IDX_table_public_token` ON `table` (`publicToken`)")
    await queryRunner.query("CREATE TABLE `customer_order_request` (`id` int NOT NULL AUTO_INCREMENT, `tableId` int NOT NULL, `tableSessionId` int NOT NULL, `orderId` int NULL, `customerName` varchar(100) NULL, `status` enum ('pending','accepted','rejected') NOT NULL DEFAULT 'pending', `rejectionReason` varchar(300) NULL, `resolvedByUserId` int NULL, `resolvedAt` datetime NULL, `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updatedAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX `IDX_customer_request_status_created` (`status`, `createdAt`), CONSTRAINT `FK_customer_request_table` FOREIGN KEY (`tableId`) REFERENCES `table`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT `FK_customer_request_session` FOREIGN KEY (`tableSessionId`) REFERENCES `table_session`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT `FK_customer_request_order` FOREIGN KEY (`orderId`) REFERENCES `order`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION, PRIMARY KEY (`id`)) ENGINE=InnoDB")
    await queryRunner.query("CREATE TABLE `customer_order_request_item` (`id` int NOT NULL AUTO_INCREMENT, `requestId` int NOT NULL, `productId` int NOT NULL, `productName` varchar(255) NOT NULL, `quantity` int NOT NULL, `unitPrice` decimal(12,2) NOT NULL, `subtotal` decimal(12,2) NOT NULL, `notes` varchar(500) NULL, CONSTRAINT `FK_customer_request_item_request` FOREIGN KEY (`requestId`) REFERENCES `customer_order_request`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION, PRIMARY KEY (`id`)) ENGINE=InnoDB")
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE `customer_order_request_item`")
    await queryRunner.query("DROP TABLE `customer_order_request`")
    await queryRunner.query("DROP INDEX `IDX_table_public_token` ON `table`")
    await queryRunner.query("ALTER TABLE `table` DROP COLUMN `publicToken`")
  }
}
