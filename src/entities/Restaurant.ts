import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm"
import { User } from "./User"

@Entity()
export class Restaurant {
  @PrimaryGeneratedColumn()
  id?: number

  @Column()
  name?: string

  @OneToMany(() => User, (user) => user.restaurant)
  users?: User[]
}