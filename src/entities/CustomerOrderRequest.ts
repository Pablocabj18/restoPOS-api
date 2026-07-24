import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { Table } from './Table'
import { TableSession } from './TableSession'
import { Order } from './Order'

export enum CustomerOrderRequestStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected'
}

@Entity()
export class CustomerOrderRequest {
  @PrimaryGeneratedColumn()
  id?: number

  @Column({ type: 'int' })
  tableId?: number

  @ManyToOne(() => Table, { nullable: false })
  @JoinColumn({ name: 'tableId' })
  table?: Table

  @Column({ type: 'int' })
  tableSessionId?: number

  @ManyToOne(() => TableSession, { nullable: false })
  @JoinColumn({ name: 'tableSessionId' })
  tableSession?: TableSession

  @Column({ type: 'int', nullable: true })
  orderId?: number | null

  @ManyToOne(() => Order, { nullable: true })
  @JoinColumn({ name: 'orderId' })
  order?: Order | null

  @Column({ type: 'varchar', length: 100, nullable: true })
  customerName?: string | null

  @Column({ type: 'enum', enum: CustomerOrderRequestStatus, default: CustomerOrderRequestStatus.PENDING })
  status?: CustomerOrderRequestStatus

  @Column({ type: 'varchar', length: 300, nullable: true })
  rejectionReason?: string | null

  @Column({ type: 'int', nullable: true })
  resolvedByUserId?: number | null

  @Column({ type: 'datetime', nullable: true })
  resolvedAt?: Date | null

  @OneToMany(() => CustomerOrderRequestItem, item => item.request)
  items?: CustomerOrderRequestItem[]

  @CreateDateColumn()
  createdAt?: Date

  @UpdateDateColumn()
  updatedAt?: Date
}

@Entity()
export class CustomerOrderRequestItem {
  @PrimaryGeneratedColumn()
  id?: number

  @Column({ type: 'int' })
  requestId?: number

  @ManyToOne(() => CustomerOrderRequest, request => request.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requestId' })
  request?: CustomerOrderRequest

  @Column({ type: 'int' })
  productId?: number

  @Column({ type: 'varchar', length: 255 })
  productName?: string

  @Column({ type: 'int' })
  quantity?: number

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  unitPrice?: number

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  subtotal?: number

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes?: string | null
}
