import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm"
import { Order } from "./Order"
import { TableSession } from "./TableSession"

@Entity()
export class Table {
  @PrimaryGeneratedColumn()
  id?: number

  @Column()
  number?: number

  @Column({ nullable: true })
  capacity?: number

  @Column({ default: 'free' })
  status?: string

  @Column({ default: true })
  active?: boolean

  @Column({ type: 'varchar', length: 64, nullable: true, unique: true, select: false })
  publicToken?: string | null

  @Column({ nullable: true, type: 'int' })
  currentOrderId?: number | null

  @OneToMany(() => Order, (order) => order.table)
  orders?: Order[]

  @OneToMany(() => TableSession, (session) => session.table)
  sessions?: TableSession[]
}
