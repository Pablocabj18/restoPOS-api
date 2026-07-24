import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from "typeorm"
import { Order } from "./Order"
import { Product } from "./Product"

@Entity()
@Index('IDX_order_item_order_id', ['orderId'])
export class OrderItem {
  @PrimaryGeneratedColumn()
  id?: number

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order?: Order

  @Column({ type: 'int' })
  orderId?: number

  @ManyToOne(() => Product)
  @JoinColumn({ name: 'productId' })
  product?: Product

  @Column({ type: 'int' })
  productId?: number

  @Column({ default: 1 })
  quantity?: number

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  unitPrice?: number

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  subtotal?: number

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes?: string | null
}
