import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from "typeorm"
import { Category } from "./Category"

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id?: number

  @Column()
  name?: string

  @Column({ nullable: true })
  description?: string

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  price?: number

  @Column({ nullable: true })
  image?: string

  @Column({ default: true })
  available?: boolean

  @Column({ default: 0 })
  sortOrder?: number

  @ManyToOne(() => Category, (category) => category.products)
  category?: Category

  @Column({ nullable: true, type: 'int' })
  categoryId?: number
}
