import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

export enum AuthChallengePurpose {
  LOGIN = 'login',
  PASSWORD_SETUP = 'password_setup'
}

@Entity()
export class AuthChallenge {
  @PrimaryGeneratedColumn()
  id?: number

  @Index({ unique: true })
  @Column({ length: 64 })
  tokenHash?: string

  @Column({ type: 'int' })
  userId?: number

  @Column({ type: 'enum', enum: AuthChallengePurpose })
  purpose?: AuthChallengePurpose

  @Column({ type: 'datetime' })
  expiresAt?: Date

  @Column({ type: 'datetime', nullable: true })
  usedAt?: Date | null

  @Column({ default: 0 })
  attempts?: number

  @CreateDateColumn()
  createdAt?: Date
}
