import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { Table } from './Table'
import { TableSession } from './TableSession'

export enum ReservationStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  SEATED = 'seated',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show'
}

@Entity()
@Index('IDX_reservation_restaurant_starts_at', ['restaurantId', 'startsAt'])
@Index('IDX_reservation_company_starts_at', ['companyId', 'startsAt'])
export class Reservation {
  @PrimaryGeneratedColumn()
  id?: number

  @Column({ type: 'int', nullable: true })
  restaurantId?: number | null

  @Column({ type: 'int', nullable: true })
  companyId?: number | null

  @Column({ type: 'int', nullable: true })
  branchId?: number | null

  @Column({ length: 140 })
  customerName?: string

  @Column({ length: 40 })
  phone?: string

  @Column({ type: 'datetime' })
  startsAt?: Date

  @Column({ type: 'int', default: 120 })
  durationMinutes?: number

  @Column({ type: 'int' })
  partySize?: number

  @Column({ type: 'int', nullable: true })
  tableId?: number | null

  @ManyToOne(() => Table, { nullable: true })
  @JoinColumn({ name: 'tableId' })
  table?: Table | null

  @Column({ type: 'int', nullable: true })
  tableSessionId?: number | null

  @ManyToOne(() => TableSession, { nullable: true })
  @JoinColumn({ name: 'tableSessionId' })
  tableSession?: TableSession | null

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes?: string | null

  @Column({ type: 'enum', enum: ReservationStatus, default: ReservationStatus.PENDING })
  status?: ReservationStatus

  @Column({ type: 'int', nullable: true })
  createdByUserId?: number | null

  @Column({ length: 30, default: 'manual' })
  source?: string

  @Column({ type: 'varchar', length: 120, nullable: true })
  externalReference?: string | null

  @Column({ default: false })
  whatsappOptIn?: boolean

  @CreateDateColumn()
  createdAt?: Date

  @UpdateDateColumn()
  updatedAt?: Date
}
