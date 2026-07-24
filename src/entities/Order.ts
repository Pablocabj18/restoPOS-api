import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn, UpdateDateColumn, JoinColumn } from "typeorm"
import { OrderItem } from "./OrderItem"
import { Table } from "./Table"
import { TableSession } from "./TableSession"

export enum OrderStatus {
  OPEN = 'open',
  CONFIRMED = 'confirmed',
  PREPARING = 'preparing',
  READY = 'ready',
  DELIVERED = 'delivered',
  PAID = 'paid',
  CLOSED = 'closed',
  CANCELLED = 'cancelled'
}

@Entity()
export class Order {
  @PrimaryGeneratedColumn()
  id?: number

  @Column({ nullable: true, type: 'int' })
  tableId?: number | null

  @ManyToOne(() => Table, (table) => table.orders, { nullable: true })
  @JoinColumn({ name: 'tableId' })
  table?: Table | null

  @Column({ nullable: true, type: 'int' })
  tableSessionId?: number | null

  @ManyToOne(() => TableSession, (session) => session.orders, { nullable: true })
  @JoinColumn({ name: 'tableSessionId' })
  tableSession?: TableSession | null

  @Column({ nullable: true, type: 'int' })
  userId?: number | null

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.OPEN })
  status?: OrderStatus

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  total?: number

  @OneToMany(() => OrderItem, (item) => item.order)
  items?: OrderItem[]

  @CreateDateColumn()
  createdAt?: Date

  @UpdateDateColumn()
  updatedAt?: Date

  @Column({ nullable: true, type: 'datetime' })
  closedAt?: Date
}
