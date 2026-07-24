import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm"

export enum CashSessionStatus {
  OPEN = 'open',
  CLOSED = 'closed'
}

@Entity()
export class CashSession {
  @PrimaryGeneratedColumn()
  id?: number

  @Column()
  companyId?: number

  @Column()
  branchId?: number

  @Column()
  userId?: number

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  openAmount?: number

  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  closeAmount?: number

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  totalSales?: number

  @Column({ default: 0 })
  totalOrders?: number

  @Column({
    type: 'enum',
    enum: CashSessionStatus,
    default: CashSessionStatus.OPEN
  })
  status?: CashSessionStatus

  @Column({ type: 'text', nullable: true })
  notes?: string

  @CreateDateColumn()
  openedAt?: Date

  @Column({ nullable: true, type: 'datetime' })
  closedAt?: Date
}
