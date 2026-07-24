import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm"
import { Product } from "./Product"

@Entity()
export class Category {
  @PrimaryGeneratedColumn()
  id?: number

  @Column()
  name?: string

  @Column({ nullable: true })
  description?: string

  @Column({ nullable: true })
  icon?: string

  @Column({ default: true })
  active?: boolean

  @Column({ default: 0 })
  sortOrder?: number

  @OneToMany(() => Product, (product) => product.category)
  products?: Product[]
}
