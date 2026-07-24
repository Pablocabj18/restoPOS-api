import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm"

@Entity()
export class Company {
  @PrimaryGeneratedColumn()
  id?: number

  @Column({ unique: true })
  name?: string

  @Column({ unique: true })
  slug?: string

  @Column({ default: 'free' })
  plan?: string // free | pro | enterprise

  @Column({ nullable: true })
  logo?: string

  @Column({ nullable: true })
  phone?: string

  @Column({ nullable: true })
  address?: string

  @Column({ default: true })
  active?: boolean

  @CreateDateColumn()
  createdAt?: Date
}
