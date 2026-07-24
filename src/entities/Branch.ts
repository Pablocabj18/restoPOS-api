import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm"

@Entity()
export class Branch {
  @PrimaryGeneratedColumn()
  id?: number

  @Column()
  companyId?: number

  @Column()
  name?: string

  @Column({ nullable: true })
  address?: string

  @Column({ nullable: true })
  phone?: string

  @Column({ nullable: true })
  email?: string

  @Column({ default: true })
  active?: boolean

  @CreateDateColumn()
  createdAt?: Date
}
