import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index, CreateDateColumn, UpdateDateColumn } from "typeorm"
import { Restaurant } from "./Restaurant"

export enum UserRole {
  ADMIN = 'admin',
  WAITER = 'waiter',
  CASHIER = 'cashier',
  KITCHEN = 'kitchen'
}

export enum UserStatus {
  PENDING_ACTIVATION = 'pending_activation',
  ACTIVE = 'active',
  DISABLED = 'disabled',
  PASSWORD_RESET_REQUIRED = 'password_reset_required'
}

@Entity()
@Index('IDX_user_restaurant_username', ['restaurantId', 'username'], { unique: true })
@Index('IDX_user_restaurant_email', ['restaurantId', 'email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn()
  id?: number

  @Column({ nullable: true })
  companyId?: number

  @Column({ nullable: true })
  branchId?: number

  @ManyToOne(() => Restaurant, restaurant => restaurant.users)
  @JoinColumn({ name: 'restaurantId' })
  restaurant?: Restaurant

  @Column({ nullable: true, type: 'int' })
  restaurantId?: number | null

  @Column({ nullable: true, type: 'varchar' })
  email?: string | null

  @Column({ nullable: true, select: false, name: 'password', type: 'varchar' })
  passwordHash?: string | null

  @Column({ nullable: true, length: 80, type: 'varchar' })
  username?: string | null

  @Column()
  name?: string

  @Column({ nullable: true, type: 'varchar' })
  lastName?: string | null

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.WAITER
  })
  role?: UserRole

  @Column({ default: true })
  active?: boolean

  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.ACTIVE
  })
  status?: UserStatus

  @Column({ default: false })
  mustSetPassword?: boolean

  @Column({ nullable: true, type: 'int' })
  createdByUserId?: number | null

  @Column({ default: 0 })
  tokenVersion?: number

  @CreateDateColumn()
  createdAt?: Date

  @UpdateDateColumn()
  updatedAt?: Date
}
