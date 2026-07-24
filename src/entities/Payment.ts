import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

export enum PaymentMethod {
  CASH = 'cash',
  CARD = 'card',
  TRANSFER = 'transfer',
  MIXED = 'mixed'
}

@Entity()
@Index('UQ_payment_order', ['orderId'], { unique: true })
@Index('UQ_payment_idempotency', ['idempotencyKey'], { unique: true })
export class Payment {
  @PrimaryGeneratedColumn()
  id?: number

  @Column({ type: 'int' })
  orderId?: number

  @Column({ type: 'int', nullable: true })
  restaurantId?: number | null

  @Column({ type: 'int', nullable: true })
  companyId?: number | null

  @Column({ type: 'int', nullable: true })
  branchId?: number | null

  @Column({ type: 'enum', enum: PaymentMethod })
  method?: PaymentMethod

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount?: number

  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  receivedAmount?: number | null

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  changeAmount?: number

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  tipAmount?: number

  @Column({ type: 'json', nullable: true })
  breakdown?: Array<{ method: 'cash' | 'card' | 'transfer'; amount: number }> | null

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes?: string | null

  @Column({ type: 'int' })
  paidByUserId?: number

  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey?: string | null

  @CreateDateColumn()
  createdAt?: Date

  @UpdateDateColumn()
  updatedAt?: Date
}
