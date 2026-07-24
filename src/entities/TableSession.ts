import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm'
import { Table } from './Table'
import { Order } from './Order'

export enum TableSessionStatus {
  OPEN = 'open',
  CLOSED = 'closed'
}

@Entity()
export class TableSession {
  @PrimaryGeneratedColumn()
  id?: number

  @Column({ type: 'int' })
  tableId?: number

  @ManyToOne(() => Table, table => table.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tableId' })
  table?: Table

  @Index({ unique: true })
  @Column({ type: 'int', nullable: true })
  openTableId?: number | null

  @Column({ type: 'enum', enum: TableSessionStatus, default: TableSessionStatus.OPEN })
  status?: TableSessionStatus

  @Column({ type: 'int', nullable: true })
  openedByUserId?: number | null

  @Column({ type: 'int', nullable: true })
  closedByUserId?: number | null

  @CreateDateColumn()
  openedAt?: Date

  @Column({ type: 'datetime', nullable: true })
  closedAt?: Date | null

  @OneToMany(() => Order, order => order.tableSession)
  orders?: Order[]
}
