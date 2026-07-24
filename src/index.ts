import { AppDataSource, seedData } from './data-source'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { User, UserRole, UserStatus } from './entities/User'
import { Restaurant } from './entities/Restaurant'
import { Category } from './entities/Category'
import { Product } from './entities/Product'
import { Table } from './entities/Table'
import { Order, OrderStatus } from './entities/Order'
import { OrderItem } from './entities/OrderItem'
import { TableSession, TableSessionStatus } from './entities/TableSession'
import * as jwt from 'jsonwebtoken'
import * as bcrypt from 'bcryptjs'
import { Between, In, IsNull, Not } from 'typeorm'
import { createServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import crypto from 'crypto'
import { AuthChallenge, AuthChallengePurpose } from './entities/AuthChallenge'
import { Reservation, ReservationStatus } from './entities/Reservation'
import { Payment, PaymentMethod } from './entities/Payment'
import { CustomerOrderRequest, CustomerOrderRequestItem, CustomerOrderRequestStatus } from './entities/CustomerOrderRequest'

const app = express()
const httpServer = createServer(app)
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
const corsOrigin = allowedOrigins.length > 0 ? allowedOrigins : '*'
const io = new SocketServer(httpServer, { cors: { origin: corsOrigin } })
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET es obligatorio en producción')
}
const JWT_SECRET = process.env.JWT_SECRET || 'resto-pos-secret-key-2024'

app.use(cors({ origin: corsOrigin }))
app.use(express.json())

const authRate = new Map<string, { count: number; resetAt: number }>()
const publicOrderRate = new Map<string, { count: number; resetAt: number }>()
app.use('/auth', (req: Request, res: Response, next: NextFunction) => {
  const key = req.ip || 'unknown'
  const now = Date.now()
  const current = authRate.get(key)
  const entry = current && current.resetAt > now ? current : { count: 0, resetAt: now + 5 * 60_000 }
  entry.count += 1
  authRate.set(key, entry)
  if (entry.count > 100) return res.status(429).json({ error: 'Demasiadas solicitudes de autenticación' })
  next()
})

type SocketIdentity = {
  userId: number
  role: UserRole
  companyId?: number
  branchId?: number
  restaurantId?: number
}

const tenantPrefix = (identity: Partial<SocketIdentity>) => {
  if (identity.companyId) return `company:${identity.companyId}`
  if (identity.restaurantId) return `restaurant:${identity.restaurantId}`
  return null
}

const scopedRoom = (identity: Partial<SocketIdentity>, room: string) => {
  const prefix = tenantPrefix(identity)
  return prefix ? `${prefix}:${room}` : room
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token
    if (!token || typeof token !== 'string') return next(new Error('Token requerido'))
    const decoded = jwt.verify(token, JWT_SECRET) as any
    const role = decoded.role || UserRole.WAITER
    if (!Object.values(UserRole).includes(role)) return next(new Error('Rol inválido'))
    const user = await AppDataSource.getRepository(User).findOne({ where: { id: decoded.userId } })
    if (!user || user.status !== UserStatus.ACTIVE || user.active === false) {
      return next(new Error('Sesión inválida'))
    }
    if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      return next(new Error('Sesión invalidada'))
    }
    socket.data.user = { ...decoded, role } as SocketIdentity
    next()
  } catch (error) {
    next(new Error('Token inválido o expirado'))
  }
})

io.on('connection', socket => {
  const identity = socket.data.user as SocketIdentity
  socket.join(`role:${identity.role}`)
  socket.join(scopedRoom(identity, `role:${identity.role}`))

  const tableId = Number(socket.handshake.auth?.tableId)
  const tableSessionId = Number(socket.handshake.auth?.tableSessionId)
  if (Number.isInteger(tableId) && tableId > 0) {
    socket.join(`table:${tableId}`)
    socket.join(scopedRoom(identity, `table:${tableId}`))
  }
  if (Number.isInteger(tableSessionId) && tableSessionId > 0) {
    socket.join(`table-session:${tableSessionId}`)
    socket.join(scopedRoom(identity, `table-session:${tableSessionId}`))
  }
})

// ============ MIDDLEWARE ============
const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' })
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any
    const user = await AppDataSource.getRepository(User).findOne({ where: { id: decoded.userId } })
    if (!user || user.status !== UserStatus.ACTIVE || user.active === false) {
      return res.status(403).json({ error: 'Sesión inválida' })
    }
    if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(403).json({ error: 'Sesión invalidada' })
    }
    ; (req as any).user = { ...decoded, role: decoded.role || UserRole.WAITER }
    next()
  } catch (err) {
    return res.status(403).json({ error: 'Token inválido' })
  }
}

const requireRole = (...roles: UserRole[]) => (req: Request, res: Response, next: NextFunction) => {
  const role = (req as any).user?.role || UserRole.WAITER
  if (!roles.includes(role)) {
    return res.status(403).json({ error: 'Acceso denegado: rol insuficiente' })
  }
  next()
}

const emitRealtime = (
  req: Request,
  event: string,
  payload: { tableId?: number | null; tableSessionId?: number | null; [key: string]: any },
  roles: UserRole[]
) => {
  const identity = ((req as any).user || {}) as SocketIdentity
  const rooms = roles.map(role => scopedRoom(identity, `role:${role}`))
  if (payload.tableId) rooms.push(scopedRoom(identity, `table:${payload.tableId}`))
  if (payload.tableSessionId) rooms.push(scopedRoom(identity, `table-session:${payload.tableSessionId}`))
  io.to([...new Set(rooms)]).emit(event, payload)
}

const orderEventPayload = (order: Order, extra: Record<string, any> = {}) => ({
  orderId: order.id,
  tableId: order.tableId || null,
  tableSessionId: order.tableSessionId || null,
  status: order.status,
  order,
  ...extra
})

const normalizeItemNotes = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('INVALID_NOTES')
  const notes = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
  if (notes.length > 500) throw new Error('INVALID_NOTES')
  return notes || null
}

const loadEnrichedOrder = (id: number) => AppDataSource.getRepository(Order).findOne({
  where: { id },
  relations: ['table', 'tableSession', 'items', 'items.product']
})

const customerRequestRelations = ['table', 'tableSession', 'order', 'items']
const loadCustomerRequest = (id: number) => AppDataSource.getRepository(CustomerOrderRequest).findOne({
  where: { id }, relations: customerRequestRelations
})

const customerRequestPayload = (request: CustomerOrderRequest) => ({
  requestId: request.id,
  tableId: request.tableId,
  tableSessionId: request.tableSessionId,
  orderId: request.orderId || null,
  status: request.status,
  request
})

const releaseEmptyOrderSession = async (orderId: number, userId?: number) => {
  const orderRepo = AppDataSource.getRepository(Order)
  const order = await orderRepo.findOne({ where: { id: orderId } })
  if (!order?.tableSessionId || !order.tableId) return
  const seatedReservation = await AppDataSource.getRepository(Reservation).count({
    where: { tableSessionId: order.tableSessionId, status: ReservationStatus.SEATED }
  })
  if (seatedReservation > 0) return

  await AppDataSource.getRepository(TableSession).update(order.tableSessionId, {
    status: TableSessionStatus.CLOSED,
    openTableId: null,
    closedByUserId: userId || null,
    closedAt: new Date()
  })
  await orderRepo.update(orderId, { tableSessionId: null })
  await AppDataSource.getRepository(Table).update(order.tableId, { status: 'free', currentOrderId: null })
}

// ============ AUTH ============
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const identifyAttempts = new Map<string, { count: number; resetAt: number }>()

const normalizeUsername = (value: unknown) => {
  if (typeof value !== 'string') return null
  const username = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{2,79}$/.test(username) ? username : null
}

const normalizeEmail = (value: unknown) => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

const validatePassword = (password: unknown): string | null => {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    return 'La contraseña debe tener entre 10 y 128 caracteres'
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'La contraseña debe incluir mayúscula, minúscula y número'
  }
  return null
}

const safeUser = (user: User) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  name: user.name,
  lastName: user.lastName,
  role: user.role,
  status: user.status,
  mustSetPassword: user.mustSetPassword,
  restaurantId: user.restaurantId,
  companyId: user.companyId,
  branchId: user.branchId,
  createdByUserId: user.createdByUserId,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt
})

const signSessionToken = (user: User) => jwt.sign({
  userId: user.id,
  username: user.username,
  email: user.email,
  role: user.role || UserRole.WAITER,
  companyId: user.companyId,
  branchId: user.branchId,
  restaurantId: user.restaurantId,
  tokenVersion: user.tokenVersion || 0
}, JWT_SECRET, { expiresIn: '7d' })

const loadUserWithPassword = (id: number) => AppDataSource.getRepository(User)
  .createQueryBuilder('user')
  .addSelect('user.passwordHash')
  .leftJoinAndSelect('user.restaurant', 'restaurant')
  .where('user.id = :id', { id })
  .getOne()

const issueChallenge = async (user: User, purpose: AuthChallengePurpose) => {
  const repo = AppDataSource.getRepository(AuthChallenge)
  await repo.update({ userId: user.id!, usedAt: IsNull() }, { usedAt: new Date() })
  const challenge = crypto.randomBytes(32).toString('base64url')
  await repo.save({
    tokenHash: crypto.createHash('sha256').update(challenge).digest('hex'),
    userId: user.id,
    purpose,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    usedAt: null,
    attempts: 0
  })
  return challenge
}

const resolveChallenge = async (raw: unknown, purpose: AuthChallengePurpose) => {
  if (typeof raw !== 'string' || raw.length < 20) return null
  const repo = AppDataSource.getRepository(AuthChallenge)
  const challenge = await repo.findOne({
    where: {
      tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
      purpose,
      usedAt: IsNull()
    }
  })
  if (!challenge || challenge.expiresAt!.getTime() <= Date.now() || (challenge.attempts || 0) >= 5) return null
  return challenge
}

const bootstrapStatus = async () => {
  const [restaurants, users] = await Promise.all([
    AppDataSource.getRepository(Restaurant).count(),
    AppDataSource.getRepository(User).count()
  ])
  return { configured: restaurants > 0 || users > 0, bootstrapAllowed: restaurants === 0 && users === 0 }
}

app.get('/auth/bootstrap/status', async (_req: Request, res: Response) => {
  res.json(await bootstrapStatus())
})

const bootstrapHandler = async (req: Request, res: Response) => {
  const restaurantName = typeof req.body.restaurantName === 'string' ? req.body.restaurantName.trim() : ''
  const username = normalizeUsername(req.body.username)
  const email = normalizeEmail(req.body.email)
  const { password, name, lastName } = req.body
  const passwordError = validatePassword(password)
  if (!restaurantName || !username || !name || passwordError || (req.body.email && !email)) {
    return res.status(400).json({ error: passwordError || 'Datos de bootstrap inválidos' })
  }

  const runner = AppDataSource.createQueryRunner()
  await runner.connect()
  await runner.startTransaction('SERIALIZABLE')
  try {
    const restaurantRepo = runner.manager.getRepository(Restaurant)
    const userRepo = runner.manager.getRepository(User)
    if (await restaurantRepo.count() > 0 || await userRepo.count() > 0) {
      await runner.rollbackTransaction()
      return res.status(409).json({ error: 'El sistema ya está configurado' })
    }

    const restaurant = await restaurantRepo.save({ name: restaurantName })
    const user = await userRepo.save({
      restaurantId: restaurant.id,
      restaurant,
      username,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      name: String(name).trim(),
      lastName: typeof lastName === 'string' ? lastName.trim() : null,
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      active: true,
      mustSetPassword: false,
      tokenVersion: 0
    })
    await runner.commitTransaction()
    res.status(201).json({
      token: signSessionToken(user),
      user: safeUser(user),
      restaurant: { id: restaurant.id, name: restaurant.name }
    })
  } catch (error) {
    await runner.rollbackTransaction()
    console.error('Bootstrap error:', error)
    res.status(500).json({ error: 'No se pudo configurar el sistema' })
  } finally {
    await runner.release()
  }
}

app.post('/auth/bootstrap', bootstrapHandler)
app.post('/auth/register', async (req: Request, res: Response) => {
  if (!(await bootstrapStatus()).bootstrapAllowed) {
    return res.status(403).json({ error: 'El registro público está deshabilitado' })
  }
  return bootstrapHandler(req, res)
})

app.post('/auth/identify', async (req: Request, res: Response) => {
  try {
    const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : ''
    const rateKey = `${req.ip}:${identifier}`
    const now = Date.now()
    const rate = identifyAttempts.get(rateKey)
    if (rate && rate.resetAt > now && rate.count >= 10) {
      return res.status(429).json({ error: 'No se pudo iniciar autenticación' })
    }
    identifyAttempts.set(rateKey, rate && rate.resetAt > now
      ? { ...rate, count: rate.count + 1 }
      : { count: 1, resetAt: now + 60_000 })

    if (!identifier) return res.status(401).json({ error: 'No se pudo iniciar autenticación' })
    const user = await AppDataSource.getRepository(User)
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.restaurant', 'restaurant')
      .where('LOWER(user.username) = :identifier OR LOWER(user.email) = :identifier', { identifier })
      .orderBy('user.id', 'ASC')
      .getOne()

    if (!user || user.status === UserStatus.DISABLED || user.active === false) {
      return res.status(401).json({ error: 'No se pudo iniciar autenticación' })
    }

    const requiresPasswordSetup = user.mustSetPassword === true ||
      user.status === UserStatus.PENDING_ACTIVATION ||
      user.status === UserStatus.PASSWORD_RESET_REQUIRED
    const challenge = await issueChallenge(
      user,
      requiresPasswordSetup ? AuthChallengePurpose.PASSWORD_SETUP : AuthChallengePurpose.LOGIN
    )
    res.json({
      challenge,
      expiresInSeconds: CHALLENGE_TTL_MS / 1000,
      displayName: [user.name, user.lastName].filter(Boolean).join(' '),
      restaurantName: user.restaurant?.name || null,
      requiresPasswordSetup
    })
  } catch (error) {
    res.status(500).json({ error: 'No se pudo iniciar autenticación' })
  }
})

app.post('/auth/set-initial-password', async (req: Request, res: Response) => {
  try {
    const challenge = await resolveChallenge(req.body.challenge, AuthChallengePurpose.PASSWORD_SETUP)
    const passwordError = validatePassword(req.body.password)
    if (!challenge || passwordError || req.body.password !== req.body.confirmPassword) {
      return res.status(400).json({ error: passwordError || 'Challenge o confirmación inválidos' })
    }
    const user = await loadUserWithPassword(challenge.userId!)
    if (!user || user.status === UserStatus.DISABLED || user.active === false) {
      return res.status(400).json({ error: 'Challenge inválido' })
    }

    user.passwordHash = await bcrypt.hash(req.body.password, 12)
    user.status = UserStatus.ACTIVE
    user.active = true
    user.mustSetPassword = false
    user.tokenVersion = (user.tokenVersion || 0) + 1
    await AppDataSource.getRepository(User).save(user)
    await AppDataSource.getRepository(AuthChallenge).update(challenge.id!, { usedAt: new Date() })
    res.json({ token: signSessionToken(user), user: safeUser(user) })
  } catch (error) {
    res.status(500).json({ error: 'No se pudo establecer la contraseña' })
  }
})

app.post('/auth/login', async (req: Request, res: Response) => {
  try {
    let user: User | null = null
    let challenge: AuthChallenge | null = null

    if (req.body.challenge) {
      challenge = await resolveChallenge(req.body.challenge, AuthChallengePurpose.LOGIN)
      if (challenge) user = await loadUserWithPassword(challenge.userId!)
    } else if (req.body.email && req.body.password) {
      // Temporary compatibility for the current frontend.
      user = await AppDataSource.getRepository(User)
        .createQueryBuilder('user')
        .addSelect('user.passwordHash')
        .leftJoinAndSelect('user.restaurant', 'restaurant')
        .where('LOWER(user.email) = :email', { email: String(req.body.email).trim().toLowerCase() })
        .getOne()
    }

    if (!user || user.status !== UserStatus.ACTIVE || user.active === false || user.mustSetPassword) {
      return res.status(401).json({ error: 'Credenciales inválidas' })
    }
    const stored = user.passwordHash || ''
    const matches = stored.startsWith('$2')
      ? await bcrypt.compare(req.body.password || '', stored)
      : stored === req.body.password
    if (!matches) {
      if (challenge) {
        challenge.attempts = (challenge.attempts || 0) + 1
        if (challenge.attempts >= 5) challenge.usedAt = new Date()
        await AppDataSource.getRepository(AuthChallenge).save(challenge)
      }
      return res.status(401).json({ error: 'Credenciales inválidas' })
    }

    if (!stored.startsWith('$2')) {
      user.passwordHash = await bcrypt.hash(req.body.password, 12)
      await AppDataSource.getRepository(User).save(user)
    }
    if (challenge) await AppDataSource.getRepository(AuthChallenge).update(challenge.id!, { usedAt: new Date() })
    res.json({
      token: signSessionToken(user),
      user: { ...safeUser(user), restaurant: user.restaurant || null }
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ error: 'Error al iniciar sesión' })
  }
})

app.get('/auth/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userRepo = AppDataSource.getRepository(User)
    const user = await userRepo.findOne({
      where: { id: (req as any).user.userId },
      relations: ['restaurant']
    })

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' })
    }

    res.json({ ...safeUser(user), restaurant: (user as any).restaurant })
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuario' })
  }
})

// ============ USERS / EMPLOYEES ============
const applyUserScope = (query: any, identity: any) => {
  if (identity.companyId) return query.andWhere('user.companyId = :scopeId', { scopeId: identity.companyId })
  return query.andWhere('user.restaurantId = :scopeId', { scopeId: identity.restaurantId })
}

const findScopedUser = async (id: number, identity: any) => {
  let query = AppDataSource.getRepository(User).createQueryBuilder('user').where('user.id = :id', { id })
  query = applyUserScope(query, identity)
  return query.getOne()
}

const invalidateUserAuth = async (user: User) => {
  user.tokenVersion = (user.tokenVersion || 0) + 1
  await AppDataSource.getRepository(User).save(user)
  await AppDataSource.getRepository(AuthChallenge).update({ userId: user.id!, usedAt: IsNull() }, { usedAt: new Date() })
}

app.get('/users', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    let query = AppDataSource.getRepository(User).createQueryBuilder('user').orderBy('user.createdAt', 'ASC')
    query = applyUserScope(query, (req as any).user)
    res.json((await query.getMany()).map(safeUser))
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuarios' })
  }
})

app.post('/users', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const identity = (req as any).user
    const username = normalizeUsername(req.body.username)
    const email = normalizeEmail(req.body.email)
    const role = String(req.body.role || '').toLowerCase() as UserRole
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
    if (!username || !name || !Object.values(UserRole).includes(role) || (req.body.email && !email)) {
      return res.status(400).json({ error: 'Datos de usuario inválidos' })
    }

    let duplicateQuery = AppDataSource.getRepository(User).createQueryBuilder('user')
      .where('(LOWER(user.username) = :username OR (:email IS NOT NULL AND LOWER(user.email) = :email))', { username, email })
    duplicateQuery = applyUserScope(duplicateQuery, identity)
    if (await duplicateQuery.getOne()) return res.status(409).json({ error: 'Username o email ya utilizado' })

    const user = await AppDataSource.getRepository(User).save({
      restaurantId: identity.restaurantId || null,
      companyId: identity.companyId || null,
      branchId: req.body.branchId || identity.branchId || null,
      username,
      email,
      name,
      lastName: typeof req.body.lastName === 'string' ? req.body.lastName.trim() : null,
      role,
      passwordHash: null,
      status: UserStatus.PENDING_ACTIVATION,
      active: true,
      mustSetPassword: true,
      createdByUserId: identity.userId,
      tokenVersion: 0
    })
    res.status(201).json(safeUser(user))
  } catch (error: any) {
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username o email ya utilizado' })
    res.status(500).json({ error: 'Error al crear usuario' })
  }
})

app.put('/users/:id', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const identity = (req as any).user
    const user = await findScopedUser(Number(req.params.id), identity)
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })

    if (req.body.username !== undefined) {
      const username = normalizeUsername(req.body.username)
      if (!username) return res.status(400).json({ error: 'Username inválido' })
      user.username = username
    }
    if (req.body.email !== undefined) {
      const email = normalizeEmail(req.body.email)
      if (req.body.email && !email) return res.status(400).json({ error: 'Email inválido' })
      user.email = email
    }
    if (req.body.name !== undefined) user.name = String(req.body.name).trim()
    if (req.body.lastName !== undefined) user.lastName = req.body.lastName ? String(req.body.lastName).trim() : null
    if (req.body.role !== undefined) {
      const role = String(req.body.role).toLowerCase() as UserRole
      if (!Object.values(UserRole).includes(role)) return res.status(400).json({ error: 'Rol inválido' })
      user.role = role
    }
    if (req.body.status !== undefined) {
      const status = String(req.body.status).toLowerCase() as UserStatus
      if (!Object.values(UserStatus).includes(status)) return res.status(400).json({ error: 'Estado inválido' })
      if (user.id === identity.userId && status === UserStatus.DISABLED) {
        return res.status(400).json({ error: 'No puedes deshabilitar tu propio usuario' })
      }
      user.status = status
      user.active = status !== UserStatus.DISABLED
      if (status === UserStatus.PASSWORD_RESET_REQUIRED) user.mustSetPassword = true
      if (status === UserStatus.DISABLED || status === UserStatus.PASSWORD_RESET_REQUIRED) {
        await invalidateUserAuth(user)
        return res.json(safeUser(user))
      }
    }

    await AppDataSource.getRepository(User).save(user)
    res.json(safeUser(user))
  } catch (error: any) {
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username o email ya utilizado' })
    res.status(500).json({ error: 'Error al actualizar usuario' })
  }
})

app.delete('/users/:id', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const identity = (req as any).user
    const user = await findScopedUser(Number(req.params.id), identity)
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })
    if (user.id === identity.userId) return res.status(400).json({ error: 'No puedes deshabilitar tu propio usuario' })
    user.status = UserStatus.DISABLED
    user.active = false
    await invalidateUserAuth(user)
    res.json(safeUser(user))
  } catch (error) {
    res.status(500).json({ error: 'Error al deshabilitar usuario' })
  }
})

app.post('/users/:id/password-reset', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const user = await findScopedUser(Number(req.params.id), (req as any).user)
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })
    if (user.status === UserStatus.DISABLED) return res.status(409).json({ error: 'El usuario está deshabilitado' })
    user.status = UserStatus.PASSWORD_RESET_REQUIRED
    user.mustSetPassword = true
    user.active = true
    await invalidateUserAuth(user)
    res.json(safeUser(user))
  } catch (error) {
    res.status(500).json({ error: 'Error al solicitar cambio de contraseña' })
  }
})

// ============ RESERVATIONS ============
const reservationRelations = ['table', 'tableSession']
const reservationScope = (identity: any) => identity.companyId
  ? { companyId: identity.companyId }
  : { restaurantId: identity.restaurantId }

const normalizeReservationNotes = (value: unknown) => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new Error('INVALID_NOTES')
  const notes = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
  if (notes.length > 1000) throw new Error('INVALID_NOTES')
  return notes || null
}

const findScopedReservation = (id: number, identity: any) => AppDataSource.getRepository(Reservation).findOne({
  where: { id, ...reservationScope(identity) },
  relations: reservationRelations
})

const hasReservationConflict = async (
  identity: any,
  tableId: number | null,
  startsAt: Date,
  durationMinutes: number,
  excludeId?: number
) => {
  if (!tableId) return false
  const scope = reservationScope(identity)
  const query = AppDataSource.getRepository(Reservation).createQueryBuilder('reservation')
    .where('reservation.tableId = :tableId', { tableId })
    .andWhere('reservation.status IN (:...statuses)', {
      statuses: [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.SEATED]
    })
    .andWhere('reservation.startsAt < DATE_ADD(:startsAt, INTERVAL :duration MINUTE)', { startsAt, duration: durationMinutes })
    .andWhere('DATE_ADD(reservation.startsAt, INTERVAL reservation.durationMinutes MINUTE) > :startsAt', { startsAt })
  if (scope.companyId) query.andWhere('reservation.companyId = :companyId', scope)
  else query.andWhere('reservation.restaurantId = :restaurantId', scope)
  if (excludeId) query.andWhere('reservation.id != :excludeId', { excludeId })
  return (await query.getCount()) > 0
}

const reservationPayload = (reservation: Reservation) => ({
  reservationId: reservation.id,
  tableId: reservation.tableId || null,
  tableSessionId: reservation.tableSessionId || null,
  status: reservation.status,
  reservation
})

app.get('/reservations', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), async (req: Request, res: Response) => {
  try {
    const identity = (req as any).user
    const query = AppDataSource.getRepository(Reservation).createQueryBuilder('reservation')
      .leftJoinAndSelect('reservation.table', 'table')
      .leftJoinAndSelect('reservation.tableSession', 'tableSession')
      .orderBy('reservation.startsAt', 'ASC')
    const scope = reservationScope(identity)
    if (scope.companyId) query.where('reservation.companyId = :companyId', scope)
    else query.where('reservation.restaurantId = :restaurantId', scope)

    if (req.query.status) {
      const status = String(req.query.status).toLowerCase()
      if (!Object.values(ReservationStatus).includes(status as ReservationStatus)) {
        return res.status(400).json({ error: 'Estado inválido' })
      }
      query.andWhere('reservation.status = :status', { status })
    }
    if (req.query.date) {
      const date = String(req.query.date)
      const from = new Date(`${date}T00:00:00.000Z`)
      const to = new Date(`${date}T23:59:59.999Z`)
      if (Number.isNaN(from.getTime())) return res.status(400).json({ error: 'Fecha inválida' })
      query.andWhere('reservation.startsAt BETWEEN :from AND :to', { from, to })
    } else {
      if (req.query.from) query.andWhere('reservation.startsAt >= :from', { from: new Date(String(req.query.from)) })
      if (req.query.to) query.andWhere('reservation.startsAt <= :to', { to: new Date(String(req.query.to)) })
    }
    res.json(await query.getMany())
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener reservas' })
  }
})

app.get('/reservations/:id/eligible-tables', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), async (req: Request, res: Response) => {
  try {
    const identity = (req as any).user
    const reservation = await findScopedReservation(Number(req.params.id), identity)
    if (!reservation) return res.status(404).json({ error: 'Reserva no encontrada' })
    if (reservation.status === ReservationStatus.SEATED) return res.status(409).json({ error: 'La reserva ya está sentada' })
    const tables = await AppDataSource.getRepository(Table).find({
      where: { active: true },
      order: { number: 'ASC' }
    })
    const eligible = []
    for (const table of tables) {
      if ((table.capacity || 0) < (reservation.partySize || 0)) continue
      if (!await hasReservationConflict(identity, table.id!, reservation.startsAt!, reservation.durationMinutes!, reservation.id)) {
        eligible.push(table)
      }
    }
    res.json(eligible)
  } catch {
    res.status(500).json({ error: 'Error al obtener mesas elegibles' })
  }
})

app.post('/reservations', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), async (req: Request, res: Response) => {
  try {
    const identity = (req as any).user
    const customerName = typeof req.body.customerName === 'string' ? req.body.customerName.trim() : ''
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : ''
    const startsAt = new Date(req.body.startsAt)
    const durationMinutes = Number(req.body.durationMinutes ?? 120)
    const partySize = Number(req.body.partySize)
    const tableId = req.body.tableId === undefined || req.body.tableId === null ? null : Number(req.body.tableId)
    let notes: string | null
    try { notes = normalizeReservationNotes(req.body.notes) } catch { return res.status(400).json({ error: 'Notas inválidas' }) }

    if (!customerName || !phone || Number.isNaN(startsAt.getTime()) || !Number.isInteger(partySize) || partySize <= 0 ||
      !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 1440 ||
      (tableId !== null && (!Number.isInteger(tableId) || tableId <= 0))) {
      return res.status(400).json({ error: 'Datos de reserva inválidos' })
    }
    if (tableId && !await AppDataSource.getRepository(Table).findOne({ where: { id: tableId } })) {
      return res.status(404).json({ error: 'Mesa no encontrada' })
    }
    if (await hasReservationConflict(identity, tableId, startsAt, durationMinutes)) {
      return res.status(409).json({ error: 'La mesa ya está reservada en ese horario' })
    }

    const status = req.body.status === ReservationStatus.CONFIRMED ? ReservationStatus.CONFIRMED : ReservationStatus.PENDING
    const saved = await AppDataSource.getRepository(Reservation).save({
      ...reservationScope(identity),
      branchId: identity.branchId || null,
      customerName,
      phone,
      startsAt,
      durationMinutes,
      partySize,
      tableId,
      notes,
      status,
      createdByUserId: identity.userId,
      source: typeof req.body.source === 'string' ? req.body.source.trim().slice(0, 30) || 'manual' : 'manual',
      externalReference: typeof req.body.externalReference === 'string' ? req.body.externalReference.trim().slice(0, 120) || null : null,
      whatsappOptIn: req.body.whatsappOptIn === true
    })
    const reservation = (await findScopedReservation(saved.id!, identity))!
    emitRealtime(req, 'reservation:created', reservationPayload(reservation), [UserRole.ADMIN, UserRole.WAITER])
    res.status(201).json(reservation)
  } catch (error) {
    res.status(500).json({ error: 'Error al crear reserva' })
  }
})

const updateReservation = async (req: Request, res: Response) => {
  try {
    const identity = (req as any).user
    const reservation = await findScopedReservation(Number(req.params.id), identity)
    if (!reservation) return res.status(404).json({ error: 'Reserva no encontrada' })

    const startsAt = req.body.startsAt === undefined ? reservation.startsAt! : new Date(req.body.startsAt)
    const durationMinutes = req.body.durationMinutes === undefined ? reservation.durationMinutes! : Number(req.body.durationMinutes)
    const tableId = req.body.tableId === undefined ? reservation.tableId || null : (req.body.tableId === null ? null : Number(req.body.tableId))
    const partySize = req.body.partySize === undefined ? reservation.partySize! : Number(req.body.partySize)
    if (Number.isNaN(startsAt.getTime()) || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 1440 ||
      !Number.isInteger(partySize) || partySize <= 0 || (tableId !== null && !Number.isInteger(tableId))) {
      return res.status(400).json({ error: 'Datos de reserva inválidos' })
    }
    if (await hasReservationConflict(identity, tableId, startsAt, durationMinutes, reservation.id)) {
      return res.status(409).json({ error: 'La mesa ya está reservada en ese horario' })
    }

    if (req.body.customerName !== undefined) reservation.customerName = String(req.body.customerName).trim()
    if (req.body.phone !== undefined) reservation.phone = String(req.body.phone).trim()
    reservation.startsAt = startsAt
    reservation.durationMinutes = durationMinutes
    reservation.tableId = tableId
    reservation.partySize = partySize
    if (req.body.notes !== undefined) {
      try { reservation.notes = normalizeReservationNotes(req.body.notes) } catch { return res.status(400).json({ error: 'Notas inválidas' }) }
    }
    if (req.body.source !== undefined) reservation.source = String(req.body.source).trim().slice(0, 30) || 'manual'
    if (req.body.externalReference !== undefined) reservation.externalReference = req.body.externalReference ? String(req.body.externalReference).trim().slice(0, 120) : null
    if (req.body.whatsappOptIn !== undefined) reservation.whatsappOptIn = req.body.whatsappOptIn === true
    await AppDataSource.getRepository(Reservation).save(reservation)
    const updated = (await findScopedReservation(reservation.id!, identity))!
    emitRealtime(req, 'reservation:updated', reservationPayload(updated), [UserRole.ADMIN, UserRole.WAITER])
    res.json(updated)
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar reserva' })
  }
}

app.put('/reservations/:id', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), updateReservation)
app.patch('/reservations/:id', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), updateReservation)

const reservationTransitions: Record<ReservationStatus, ReservationStatus[]> = {
  [ReservationStatus.PENDING]: [ReservationStatus.CONFIRMED, ReservationStatus.CANCELLED, ReservationStatus.NO_SHOW],
  [ReservationStatus.CONFIRMED]: [ReservationStatus.SEATED, ReservationStatus.CANCELLED, ReservationStatus.NO_SHOW],
  [ReservationStatus.SEATED]: [],
  [ReservationStatus.CANCELLED]: [],
  [ReservationStatus.NO_SHOW]: []
}

app.patch('/reservations/:id/status', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), async (req: Request, res: Response) => {
  try {
    const identity = (req as any).user
    const reservation = await findScopedReservation(Number(req.params.id), identity)
    if (!reservation) return res.status(404).json({ error: 'Reserva no encontrada' })
    const status = String(req.body.status || '').toLowerCase() as ReservationStatus
    if (!Object.values(ReservationStatus).includes(status)) return res.status(400).json({ error: 'Estado inválido' })
    if (!reservationTransitions[reservation.status!].includes(status)) {
      return res.status(409).json({ error: 'Transición inválida', allowedStatuses: reservationTransitions[reservation.status!] })
    }
    if (status === ReservationStatus.SEATED) {
      if (!reservation.tableId) return res.status(409).json({ error: 'La reserva necesita una mesa para sentarse' })
      const session = await openTableSession(reservation.tableId, identity.userId)
      reservation.tableSessionId = session.id
      await AppDataSource.getRepository(Table).update(reservation.tableId, { status: 'occupied' })
    }
    reservation.status = status
    await AppDataSource.getRepository(Reservation).save(reservation)
    const updated = (await findScopedReservation(reservation.id!, identity))!
    emitRealtime(req, 'reservation:updated', reservationPayload(updated), [UserRole.ADMIN, UserRole.WAITER])
    if (status === ReservationStatus.SEATED) {
      emitRealtime(req, 'table:updated', reservationPayload(updated), [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])
    }
    res.json(updated)
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar estado de reserva' })
  }
})

// ============ CATEGORIES ============
app.get('/categories', async (req: Request, res: Response) => {
  try {
    const categoryRepo = AppDataSource.getRepository(Category)
    const categories = await categoryRepo.find({
      where: { active: true },
      relations: ['products'],
      order: { sortOrder: 'ASC', name: 'ASC' }
    })
    res.json(categories.map(category => ({
      ...category,
      products: (category.products || [])
        .filter(product => product.available)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.name).localeCompare(String(b.name)))
    })))
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener categorías' })
  }
})

const listAllCategories = async (_req: Request, res: Response) => {
  try {
    res.json(await AppDataSource.getRepository(Category).find({
      relations: ['products'],
      order: { sortOrder: 'ASC', name: 'ASC' }
    }))
  } catch {
    res.status(500).json({ error: 'Error al obtener categorías' })
  }
}

app.get('/categories/all', authenticateToken, requireRole(UserRole.ADMIN), listAllCategories)
app.get('/admin/categories', authenticateToken, requireRole(UserRole.ADMIN), listAllCategories)

app.post('/categories', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
    const { description, icon } = req.body
    const sortOrder = Number(req.body.sortOrder ?? 0)
    if (!name || !Number.isInteger(sortOrder)) return res.status(400).json({ error: 'Nombre o orden inválido' })
    const categoryRepo = AppDataSource.getRepository(Category)
    const duplicate = await categoryRepo.createQueryBuilder('category')
      .where('LOWER(category.name) = LOWER(:name)', { name })
      .getOne()
    if (duplicate) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' })
    const category = await categoryRepo.save({ name, description, icon, sortOrder, active: req.body.active !== false })
    res.json(category)
  } catch (error) {
    res.status(500).json({ error: 'Error al crear categoría' })
  }
})

app.put('/categories/:id', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const name = req.body.name === undefined ? undefined : String(req.body.name).trim()
    const { description, icon, active } = req.body
    const sortOrder = req.body.sortOrder === undefined ? undefined : Number(req.body.sortOrder)
    if (name === '' || (sortOrder !== undefined && !Number.isInteger(sortOrder))) return res.status(400).json({ error: 'Datos inválidos' })
    const categoryRepo = AppDataSource.getRepository(Category)
    if (!await categoryRepo.findOne({ where: { id } })) return res.status(404).json({ error: 'Categoría no encontrada' })
    if (name) {
      const duplicate = await categoryRepo.createQueryBuilder('category')
        .where('LOWER(category.name) = LOWER(:name) AND category.id != :id', { name, id }).getOne()
      if (duplicate) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' })
    }
    await categoryRepo.update(id, { name, description, icon, active })
    if (sortOrder !== undefined) await categoryRepo.update(id, { sortOrder })
    const category = await categoryRepo.findOne({ where: { id } })
    res.json(category)
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar categoría' })
  }
})

app.delete('/categories/:id', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string
    const categoryRepo = AppDataSource.getRepository(Category)
    await categoryRepo.update(id, { active: false })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar categoría' })
  }
})

// ============ PRODUCTS ============
app.get('/products', async (req: Request, res: Response) => {
  try {
    const productRepo = AppDataSource.getRepository(Product)
    const products = await productRepo.find({
      where: { available: true },
      relations: ['category'],
      order: { sortOrder: 'ASC', name: 'ASC' }
    })
    res.json(products)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos' })
  }
})

const listAllProducts = async (_req: Request, res: Response) => {
  try {
    res.json(await AppDataSource.getRepository(Product).find({
      relations: ['category'],
      order: { sortOrder: 'ASC', name: 'ASC' }
    }))
  } catch {
    res.status(500).json({ error: 'Error al obtener productos' })
  }
}

app.get('/products/all', authenticateToken, requireRole(UserRole.ADMIN), listAllProducts)
app.get('/admin/products', authenticateToken, requireRole(UserRole.ADMIN), listAllProducts)

app.post('/products', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
    const price = Number(req.body.price)
    const categoryId = Number(req.body.categoryId)
    const sortOrder = Number(req.body.sortOrder ?? 0)
    const { description, image } = req.body
    if (!name || !Number.isFinite(price) || price <= 0 || !Number.isInteger(categoryId) || !Number.isInteger(sortOrder)) {
      return res.status(400).json({ error: 'Nombre, precio y categoría válidos son requeridos' })
    }
    const productRepo = AppDataSource.getRepository(Product)
    if (!await AppDataSource.getRepository(Category).findOne({ where: { id: categoryId } })) {
      return res.status(404).json({ error: 'Categoría no encontrada' })
    }
    const duplicate = await productRepo.createQueryBuilder('product')
      .where('LOWER(product.name) = LOWER(:name) AND product.categoryId = :categoryId', { name, categoryId }).getOne()
    if (duplicate) return res.status(409).json({ error: 'Ya existe ese producto en la categoría' })
    const product = await productRepo.save({
      name,
      price,
      description,
      image,
      categoryId,
      available: req.body.available !== false,
      sortOrder,
      category: { id: categoryId }
    })
    res.json(product)
  } catch (error) {
    res.status(500).json({ error: 'Error al crear producto' })
  }
})

app.put('/products/:id', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const name = req.body.name === undefined ? undefined : String(req.body.name).trim()
    const price = req.body.price === undefined ? undefined : Number(req.body.price)
    const categoryId = req.body.categoryId === undefined ? undefined : Number(req.body.categoryId)
    const sortOrder = req.body.sortOrder === undefined ? undefined : Number(req.body.sortOrder)
    const { description, image, available } = req.body
    if (name === '' || (price !== undefined && (!Number.isFinite(price) || price <= 0)) ||
      (categoryId !== undefined && !Number.isInteger(categoryId)) || (sortOrder !== undefined && !Number.isInteger(sortOrder))) {
      return res.status(400).json({ error: 'Datos de producto inválidos' })
    }
    const productRepo = AppDataSource.getRepository(Product)
    const current = await productRepo.findOne({ where: { id } })
    if (!current) return res.status(404).json({ error: 'Producto no encontrado' })
    const finalName = name ?? current.name!
    const finalCategoryId = categoryId ?? current.categoryId!
    const duplicate = await productRepo.createQueryBuilder('product')
      .where('LOWER(product.name) = LOWER(:name) AND product.categoryId = :categoryId AND product.id != :id',
        { name: finalName, categoryId: finalCategoryId, id }).getOne()
    if (duplicate) return res.status(409).json({ error: 'Ya existe ese producto en la categoría' })
    await productRepo.update(id, {
      name,
      price,
      description,
      image,
      available,
      sortOrder,
      categoryId,
      category: { id: categoryId }
    })
    const product = await productRepo.findOne({
      where: { id },
      relations: ['category']
    })
    res.json(product)
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar producto' })
  }
})

app.delete('/products/:id', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string
    const productRepo = AppDataSource.getRepository(Product)
    await productRepo.update(id, { available: false })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar producto' })
  }
})

// ============ PUBLIC QR MENU / CUSTOMER ORDER REQUESTS ============
const publicTableByToken = async (token: string) => AppDataSource.getRepository(Table)
  .createQueryBuilder('table')
  .addSelect('table.publicToken')
  .where('table.publicToken = :token AND table.active = true', { token })
  .getOne()

const publicTableContext = async (token: string) => {
  const table = await publicTableByToken(token)
  if (!table) return null
  const session = await AppDataSource.getRepository(TableSession).findOne({
    where: { tableId: table.id, status: TableSessionStatus.OPEN }
  })
  const order = session ? await AppDataSource.getRepository(Order).findOne({
    where: { tableSessionId: session.id, status: OrderStatus.OPEN }
  }) : null
  return { table, session, order }
}

const ensureTablePublicToken = async (tableId: number, regenerate = false) => {
  const repo = AppDataSource.getRepository(Table)
  const table = await repo.createQueryBuilder('table').addSelect('table.publicToken')
    .where('table.id = :tableId', { tableId }).getOne()
  if (!table) return null
  if (!table.publicToken || regenerate) {
    table.publicToken = crypto.randomBytes(32).toString('hex')
    await repo.save(table)
  }
  return table
}

const publicTableResponse = (context: NonNullable<Awaited<ReturnType<typeof publicTableContext>>>) => ({
  id: context.table.id,
  number: context.table.number,
  capacity: context.table.capacity,
  occupied: Boolean(context.session),
  canRequest: Boolean(context.session && context.order),
  tableSessionId: context.session?.id || null,
  orderId: context.order?.id || null
})

app.get('/public/tables/:token', async (req: Request, res: Response) => {
  try {
    const context = await publicTableContext(String(req.params.token))
    if (!context) return res.status(404).json({ error: 'Mesa no encontrada' })
    res.json(publicTableResponse(context))
  } catch { res.status(500).json({ error: 'Error al obtener la mesa' }) }
})

app.get('/public/tables/:token/catalog', async (req: Request, res: Response) => {
  try {
    const context = await publicTableContext(String(req.params.token))
    if (!context) return res.status(404).json({ error: 'Mesa no encontrada' })
    const categories = await AppDataSource.getRepository(Category).createQueryBuilder('category')
      .leftJoinAndSelect('category.products', 'product', 'product.available = true')
      .where('category.active = true')
      .orderBy('category.sortOrder', 'ASC').addOrderBy('category.name', 'ASC')
      .addOrderBy('product.sortOrder', 'ASC').addOrderBy('product.name', 'ASC')
      .getMany()
    res.json({ table: publicTableResponse(context), categories })
  } catch { res.status(500).json({ error: 'Error al obtener la carta' }) }
})

app.post('/public/tables/:token/customer-order-requests', async (req: Request, res: Response) => {
  try {
    const key = req.ip || 'unknown'; const now = Date.now(); const current = publicOrderRate.get(key)
    const rate = current && current.resetAt > now ? current : { count: 0, resetAt: now + 60_000 }
    rate.count += 1; publicOrderRate.set(key, rate)
    if (rate.count > 10) return res.status(429).json({ error: 'Demasiadas solicitudes, intentá nuevamente en un minuto' })

    const context = await publicTableContext(String(req.params.token))
    if (!context) return res.status(404).json({ error: 'Mesa no encontrada' })
    if (!context.session || !context.order) {
      return res.status(409).json({ error: 'La mesa debe estar ocupada y tener una orden abierta para pedir' })
    }
    const rawItems = req.body.items
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 50) {
      return res.status(400).json({ error: 'La solicitud debe contener entre 1 y 50 ítems' })
    }
    const customerName = req.body.customerName === undefined || req.body.customerName === null
      ? null : String(req.body.customerName).replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
    if (customerName && customerName.length > 100) return res.status(400).json({ error: 'Nombre de cliente inválido' })

    const normalized = new Map<string, { productId: number; quantity: number; notes: string | null }>()
    for (const raw of rawItems) {
      const productId = Number(raw?.productId); const quantity = Number(raw?.quantity)
      let notes: string | null
      try { notes = normalizeItemNotes(raw?.notes) } catch { return res.status(400).json({ error: 'Notas inválidas' }) }
      if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantity) || quantity <= 0 || quantity > 99) {
        return res.status(400).json({ error: 'Producto o cantidad inválidos' })
      }
      const key = `${productId}:${notes || ''}`; const existing = normalized.get(key)
      normalized.set(key, { productId, notes, quantity: (existing?.quantity || 0) + quantity })
    }
    if ([...normalized.values()].some(item => item.quantity > 99)) return res.status(400).json({ error: 'Cantidad máxima por producto: 99' })
    const productIds = [...new Set([...normalized.values()].map(item => item.productId))]
    const products = await AppDataSource.getRepository(Product).find({ where: { id: In(productIds), available: true } })
    if (products.length !== productIds.length) return res.status(409).json({ error: 'Uno o más productos no están disponibles' })
    const byId = new Map(products.map(product => [product.id!, product]))

    const saved = await AppDataSource.transaction(async manager => {
      const request = await manager.getRepository(CustomerOrderRequest).save({
        tableId: context.table.id, tableSessionId: context.session!.id, orderId: context.order!.id,
        customerName: customerName || null, status: CustomerOrderRequestStatus.PENDING
      })
      await manager.getRepository(CustomerOrderRequestItem).save([...normalized.values()].map(item => {
        const product = byId.get(item.productId)!; const unitPrice = Number(product.price)
        return { requestId: request.id, productId: item.productId, productName: product.name,
          quantity: item.quantity, unitPrice, subtotal: unitPrice * item.quantity, notes: item.notes }
      }))
      return request
    })
    const request = (await loadCustomerRequest(saved.id!))!
    const payload = customerRequestPayload(request)
    const identity = {} as SocketIdentity
    const rooms = [UserRole.ADMIN, UserRole.WAITER].map(role => scopedRoom(identity, `role:${role}`))
    io.to(rooms).emit('customer-order-request:created', payload)
    res.status(201).json(request)
  } catch (error) {
    console.error('Public customer order request error:', error)
    res.status(500).json({ error: 'No se pudo crear la solicitud' })
  }
})

const publicLinkResponse = (table: Table) => {
  const path = `/menu/${table.publicToken}`
  const base = (process.env.PUBLIC_MENU_BASE_URL || allowedOrigins.find(origin => origin !== 'http://localhost:8080') || 'http://localhost:8080').replace(/\/$/, '')
  const url = `${base}${path}`
  return { tableId: table.id, tableNumber: table.number, token: table.publicToken, path, url, qrData: url }
}

app.get('/tables/:id/public-link', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  const table = await ensureTablePublicToken(Number(req.params.id))
  if (!table) return res.status(404).json({ error: 'Mesa no encontrada' })
  res.json(publicLinkResponse(table))
})

app.post('/tables/:id/public-link/regenerate', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  const table = await ensureTablePublicToken(Number(req.params.id), true)
  if (!table) return res.status(404).json({ error: 'Mesa no encontrada' })
  res.json(publicLinkResponse(table))
})

// ============ TABLES ============
app.get('/tables', async (req: Request, res: Response) => {
  try {
    const tableRepo = AppDataSource.getRepository(Table)
    const tables = await tableRepo.find({ where: { active: true }, order: { number: 'ASC' } })

    // Get active orders for each table
    const orderRepo = AppDataSource.getRepository(Order)
    const sessionRepo = AppDataSource.getRepository(TableSession)
    const tablesWithOrders = await Promise.all(
      tables.map(async (table) => {
        const tableSession = await sessionRepo.findOne({
          where: { tableId: table.id, status: TableSessionStatus.OPEN }
        })
        const activeOrder = tableSession
          ? await orderRepo.findOne({
            where: {
              tableSessionId: tableSession.id,
              status: Not(In([OrderStatus.CLOSED, OrderStatus.CANCELLED]))
            },
            relations: ['items', 'items.product']
          })
          : null

        let total = 0
        if (activeOrder && activeOrder.items) {
          total = activeOrder.items.reduce((sum: number, item: any) => {
            return sum + (Number(item.subtotal) || 0)
          }, 0)
        }

        return {
          ...table,
          status: tableSession ? 'occupied' : 'free',
          total: total,
          orderId: activeOrder?.id || null,
          orderStatus: activeOrder?.status || null,
          tableSessionId: tableSession?.id || null,
          tableSession: tableSession || null
        }
      })
    )

    res.json(tablesWithOrders)
  } catch (error) {
    console.error('Tables error:', error)
    res.status(500).json({ error: 'Error al obtener mesas' })
  }
})

const listAllTables = async (_req: Request, res: Response) => {
  try {
    res.json(await AppDataSource.getRepository(Table).find({ order: { number: 'ASC' } }))
  } catch {
    res.status(500).json({ error: 'Error al obtener mesas' })
  }
}

app.get('/tables/all', authenticateToken, requireRole(UserRole.ADMIN), listAllTables)
app.get('/admin/tables', authenticateToken, requireRole(UserRole.ADMIN), listAllTables)

app.post('/tables', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const number = Number(req.body.number)
    const capacity = Number(req.body.capacity ?? 4)
    if (!Number.isInteger(number) || number <= 0 || !Number.isInteger(capacity) || capacity <= 0 || capacity > 100) {
      return res.status(400).json({ error: 'Número o capacidad inválidos' })
    }
    const tableRepo = AppDataSource.getRepository(Table)

    const existing = await tableRepo.findOne({ where: { number } as any })
    if (existing) {
      return res.status(400).json({ error: 'Ya existe una mesa con ese número' })
    }

    const table = await tableRepo.save({ number, capacity, status: 'free', active: true } as any)
    res.json(table)
  } catch (error) {
    res.status(500).json({ error: 'Error al crear mesa' })
  }
})

const updateTable = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const number = req.body.number === undefined ? undefined : Number(req.body.number)
    const capacity = req.body.capacity === undefined ? undefined : Number(req.body.capacity)
    if ((number !== undefined && (!Number.isInteger(number) || number <= 0)) ||
      (capacity !== undefined && (!Number.isInteger(capacity) || capacity <= 0 || capacity > 100))) {
      return res.status(400).json({ error: 'Número o capacidad inválidos' })
    }
    const tableRepo = AppDataSource.getRepository(Table)
    const current = await tableRepo.findOne({ where: { id } })
    if (!current) return res.status(404).json({ error: 'Mesa no encontrada' })
    if (number !== undefined) {
      const duplicate = await tableRepo.findOne({ where: { number, active: true } })
      if (duplicate && duplicate.id !== id) return res.status(409).json({ error: 'Ya existe una mesa activa con ese número' })
    }
    await tableRepo.update(id, { number, capacity, active: req.body.active } as any)
    const table = await tableRepo.findOne({ where: { id } })
    res.json(table)
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar mesa' })
  }
}

app.put('/tables/:id', authenticateToken, requireRole(UserRole.ADMIN), updateTable)
app.patch('/tables/:id', authenticateToken, requireRole(UserRole.ADMIN), updateTable)

app.delete('/tables/:id', authenticateToken, requireRole(UserRole.ADMIN), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const tableRepo = AppDataSource.getRepository(Table)
    const table = await tableRepo.findOne({ where: { id } })
    if (!table) return res.status(404).json({ error: 'Mesa no encontrada' })
    const openSession = await AppDataSource.getRepository(TableSession).findOne({
      where: { tableId: id, status: TableSessionStatus.OPEN }
    })
    if (openSession) return res.status(409).json({ error: 'No se puede deshabilitar una mesa con sesión abierta' })
    await tableRepo.update(id, { active: false, status: 'free', currentOrderId: null })
    res.json({ success: true, table: await tableRepo.findOne({ where: { id } }) })
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar mesa' })
  }
})

// ============ TABLE SESSIONS ============
const tableSessionRelations = ['table', 'orders', 'orders.items', 'orders.items.product']

async function findOpenTableSession(tableId: number) {
  return AppDataSource.getRepository(TableSession).findOne({
    where: { tableId, status: TableSessionStatus.OPEN },
    relations: tableSessionRelations
  })
}

async function openTableSession(tableId: number, userId?: number) {
  const sessionRepo = AppDataSource.getRepository(TableSession)
  const existing = await findOpenTableSession(tableId)
  if (existing) return existing

  try {
    const saved = await sessionRepo.save({
      tableId,
      openTableId: tableId,
      openedByUserId: userId || null,
      status: TableSessionStatus.OPEN
    })
    return (await sessionRepo.findOne({
      where: { id: saved.id },
      relations: tableSessionRelations
    }))!
  } catch (error: any) {
    if (error?.code === 'ER_DUP_ENTRY') {
      const concurrent = await findOpenTableSession(tableId)
      if (concurrent) return concurrent
    }
    throw error
  }
}

app.get('/table-sessions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const tableId = req.query.tableId ? Number(req.query.tableId) : undefined
    const status = req.query.status as TableSessionStatus | undefined
    const where: any = {}
    if (tableId) where.tableId = tableId
    if (status) where.status = status

    const sessions = await AppDataSource.getRepository(TableSession).find({
      where,
      relations: tableSessionRelations,
      order: { openedAt: 'DESC' }
    })
    res.json(sessions)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener sesiones de mesa' })
  }
})

app.get('/tables/:tableId/session', authenticateToken, async (req: Request, res: Response) => {
  try {
    const tableId = Number(req.params.tableId)
    if (!Number.isInteger(tableId) || tableId <= 0) {
      return res.status(400).json({ error: 'Mesa inválida' })
    }
    res.json(await findOpenTableSession(tableId))
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener la sesión de mesa' })
  }
})

app.post(
  '/tables/:tableId/sessions/open',
  authenticateToken,
  requireRole(UserRole.ADMIN, UserRole.WAITER),
  async (req: Request, res: Response) => {
    try {
      const tableId = Number(req.params.tableId)
      const tableRepo = AppDataSource.getRepository(Table)
      const table = Number.isInteger(tableId)
        ? await tableRepo.findOne({ where: { id: tableId } })
        : null
      if (!table) return res.status(404).json({ error: 'Mesa no encontrada' })

      const session = await openTableSession(tableId, (req as any).user.userId)
      await tableRepo.update(tableId, { status: 'occupied' })
      emitRealtime(req, 'table:updated', {
        orderId: null,
        tableId,
        tableSessionId: session.id,
        status: session.status,
        tableSession: session
      }, [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])
      res.json(session)
    } catch (error) {
      res.status(500).json({ error: 'Error al abrir la sesión de mesa' })
    }
  }
)

app.post(
  '/table-sessions/:id/close',
  authenticateToken,
  requireRole(UserRole.ADMIN, UserRole.CASHIER),
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id)
      const sessionRepo = AppDataSource.getRepository(TableSession)
      const orderRepo = AppDataSource.getRepository(Order)
      const tableRepo = AppDataSource.getRepository(Table)
      const session = await sessionRepo.findOne({ where: { id }, relations: ['orders'] })
      if (!session) return res.status(404).json({ error: 'Sesión de mesa no encontrada' })
      if (session.status === TableSessionStatus.CLOSED) return res.json(session)

      const blocking = (session.orders || []).filter(order =>
        ![OrderStatus.PAID, OrderStatus.CLOSED, OrderStatus.CANCELLED].includes(order.status!)
      )
      if (blocking.length > 0) {
        return res.status(409).json({
          error: 'La sesión tiene órdenes pendientes',
          orderIds: blocking.map(order => order.id)
        })
      }

      const paidIds = (session.orders || [])
        .filter(order => order.status === OrderStatus.PAID)
        .map(order => order.id!)
      if (paidIds.length > 0) {
        await orderRepo.update({ id: In(paidIds) }, { status: OrderStatus.CLOSED, closedAt: new Date() })
      }

      await sessionRepo.update(id, {
        status: TableSessionStatus.CLOSED,
        openTableId: null,
        closedByUserId: (req as any).user.userId,
        closedAt: new Date()
      })
      await tableRepo.update(session.tableId!, { status: 'free', currentOrderId: null })

      const closedSession = await sessionRepo.findOne({ where: { id }, relations: tableSessionRelations })
      emitRealtime(req, 'table:updated', {
        orderId: null,
        tableId: session.tableId,
        tableSessionId: id,
        status: TableSessionStatus.CLOSED,
        tableSession: closedSession
      }, [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])
      res.json(closedSession)
    } catch (error) {
      res.status(500).json({ error: 'Error al cerrar la sesión de mesa' })
    }
  }
)

// ============ CUSTOMER ORDER REQUESTS (STAFF) ============
app.get('/customer-order-requests', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), async (req: Request, res: Response) => {
  try {
    const status = req.query.status ? String(req.query.status).toLowerCase() : CustomerOrderRequestStatus.PENDING
    if (!Object.values(CustomerOrderRequestStatus).includes(status as CustomerOrderRequestStatus)) {
      return res.status(400).json({ error: 'Estado inválido' })
    }
    const requests = await AppDataSource.getRepository(CustomerOrderRequest).find({
      where: { status: status as CustomerOrderRequestStatus }, relations: customerRequestRelations,
      order: { createdAt: 'ASC' }
    })
    res.json(requests)
  } catch { res.status(500).json({ error: 'Error al obtener solicitudes' }) }
})

app.get('/customer-order-requests/:id', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), async (req: Request, res: Response) => {
  const request = await loadCustomerRequest(Number(req.params.id))
  if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' })
  res.json(request)
})

app.post('/customer-order-requests/:id/accept', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), async (req: Request, res: Response) => {
  try {
    const requestId = Number(req.params.id); const userId = (req as any).user.userId
    const result: any = await AppDataSource.transaction(async manager => {
      const requestRepo = manager.getRepository(CustomerOrderRequest)
      const request = await requestRepo.findOne({
        where: { id: requestId }, relations: ['items'], lock: { mode: 'pessimistic_write' }
      })
      if (!request) return { error: 404, message: 'Solicitud no encontrada' }
      if (request.status !== CustomerOrderRequestStatus.PENDING) return { error: 409, message: 'La solicitud ya fue resuelta' }
      const session = await manager.getRepository(TableSession).findOne({
        where: { id: request.tableSessionId, status: TableSessionStatus.OPEN }
      })
      const order = session ? await manager.getRepository(Order).findOne({
        where: { id: request.orderId!, tableSessionId: session.id, status: OrderStatus.OPEN }, lock: { mode: 'pessimistic_write' }
      }) : null
      if (!session || !order) return { error: 409, message: 'La mesa o la orden ya no están abiertas' }
      const productIds = [...new Set((request.items || []).map(item => item.productId!))]
      const products = await manager.getRepository(Product).find({ where: { id: In(productIds), available: true } })
      const productMap = new Map(products.map(product => [product.id!, product]))
      if (products.length !== productIds.length || (request.items || []).some(item => Number(productMap.get(item.productId!)?.price) !== Number(item.unitPrice))) {
        return { error: 409, message: 'La disponibilidad o el precio de la carta cambió; rechazá y solicitá nuevamente' }
      }
      const itemRepo = manager.getRepository(OrderItem)
      for (const requested of request.items || []) {
        let item = await itemRepo.findOne({ where: {
          orderId: order.id, productId: requested.productId,
          notes: requested.notes === null ? IsNull() : requested.notes
        } })
        if (item) {
          item.quantity = Number(item.quantity) + Number(requested.quantity)
          item.subtotal = Number(item.unitPrice) * Number(item.quantity)
        } else {
          item = itemRepo.create({ orderId: order.id, productId: requested.productId,
            quantity: requested.quantity, unitPrice: requested.unitPrice, subtotal: requested.subtotal, notes: requested.notes })
        }
        await itemRepo.save(item)
      }
      const items = await itemRepo.find({ where: { orderId: order.id } })
      order.total = items.reduce((sum, item) => sum + Number(item.subtotal), 0)
      await manager.getRepository(Order).save(order)
      request.status = CustomerOrderRequestStatus.ACCEPTED; request.resolvedByUserId = userId
      request.resolvedAt = new Date(); await requestRepo.save(request)
      return { requestId: request.id!, orderId: order.id! }
    })
    if ('error' in result) return res.status(result.error).json({ error: result.message })
    const request = (await loadCustomerRequest(result.requestId!))!; const order = (await loadEnrichedOrder(result.orderId!))!
    const payload = customerRequestPayload(request)
    emitRealtime(req, 'customer-order-request:updated', payload, [UserRole.ADMIN, UserRole.WAITER])
    emitRealtime(req, 'order:item-added', orderEventPayload(order, { customerOrderRequestId: request.id }), [UserRole.ADMIN, UserRole.WAITER])
    emitRealtime(req, 'table:updated', orderEventPayload(order), [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])
    res.json({ request, order })
  } catch (error) {
    console.error('Accept customer request error:', error)
    res.status(500).json({ error: 'No se pudo aceptar la solicitud' })
  }
})

app.post('/customer-order-requests/:id/reject', authenticateToken, requireRole(UserRole.ADMIN, UserRole.WAITER), async (req: Request, res: Response) => {
  try {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.replace(/[\u0000-\u001F\u007F]/g, ' ').trim() : ''
    if (!reason || reason.length > 300) return res.status(400).json({ error: 'El motivo es obligatorio y admite hasta 300 caracteres' })
    const repo = AppDataSource.getRepository(CustomerOrderRequest)
    const request = await repo.findOne({ where: { id: Number(req.params.id) } })
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' })
    if (request.status !== CustomerOrderRequestStatus.PENDING) return res.status(409).json({ error: 'La solicitud ya fue resuelta' })
    request.status = CustomerOrderRequestStatus.REJECTED; request.rejectionReason = reason
    request.resolvedByUserId = (req as any).user.userId; request.resolvedAt = new Date()
    await repo.save(request)
    const enriched = (await loadCustomerRequest(request.id!))!
    emitRealtime(req, 'customer-order-request:updated', customerRequestPayload(enriched), [UserRole.ADMIN, UserRole.WAITER])
    res.json(enriched)
  } catch { res.status(500).json({ error: 'No se pudo rechazar la solicitud' }) }
})

// ============ ORDERS ============
app.get('/orders', authenticateToken, async (req: Request, res: Response) => {
  try {
    const orderRepo = AppDataSource.getRepository(Order)
    const orders = await orderRepo.find({
      relations: ['table', 'tableSession', 'items', 'items.product'],
      order: { createdAt: 'DESC' }
    })
    res.json(orders)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener órdenes' })
  }
})

app.post('/orders', authenticateToken, async (req: Request, res: Response) => {
  try {
    const tableId = Number(req.body.tableId)
    const userId = (req as any).user.userId

    const orderRepo = AppDataSource.getRepository(Order)
    const tableRepo = AppDataSource.getRepository(Table)

    if (!Number.isInteger(tableId) || tableId <= 0) {
      return res.status(400).json({ error: 'Mesa inválida' })
    }

    const table = await tableRepo.findOne({ where: { id: tableId } })
    if (!table) {
      return res.status(404).json({ error: 'Mesa no encontrada' })
    }

    const tableSession = await findOpenTableSession(tableId)
    // A visit to a free table creates/reuses a draft order but does not occupy
    // the table. The session starts when the first item is persisted.
    const existingOrder = tableSession
      ? await orderRepo.findOne({
        where: {
          tableSessionId: tableSession.id,
          status: Not(In([OrderStatus.CLOSED, OrderStatus.CANCELLED]))
        },
        relations: ['table', 'tableSession', 'items', 'items.product']
      })
      : await orderRepo.findOne({
        where: { tableId, tableSessionId: IsNull(), status: OrderStatus.OPEN },
        relations: ['table', 'tableSession', 'items', 'items.product']
      })

    if (existingOrder) {
      return res.json(existingOrder)
    }

    const order = await orderRepo.save({
      tableId,
      tableSessionId: tableSession?.id || null,
      userId,
      status: OrderStatus.OPEN,
      total: 0
    })

    if (tableSession) {
      await tableRepo.update(tableId, { currentOrderId: order.id, status: 'occupied' })
    }

    const enrichedOrder = (await loadEnrichedOrder(order.id!))!
    const payload = orderEventPayload(enrichedOrder)
    emitRealtime(req, 'order:created', payload, [UserRole.ADMIN, UserRole.WAITER])
    emitRealtime(req, 'table:updated', payload, [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])
    res.json(enrichedOrder)
  } catch (error) {
    console.error('Create order error:', error)
    res.status(500).json({ error: 'Error al crear orden' })
  }
})

app.get('/orders/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Orden inválida' })
    }
    const orderRepo = AppDataSource.getRepository(Order)
    const order = await orderRepo.findOne({
      where: { id },
      relations: ['table', 'tableSession', 'items', 'items.product']
    })

    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' })
    }

    res.json(order)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener orden' })
  }
})

app.post('/orders/:id/items', authenticateToken, async (req: Request, res: Response) => {
  try {
    const orderId = Number(req.params.id)
    const productId = Number(req.body.productId)
    const quantity = req.body.quantity === undefined ? 1 : Number(req.body.quantity)
    let notes: string | null
    try {
      notes = normalizeItemNotes(req.body.notes)
    } catch {
      return res.status(400).json({ error: 'Las notas deben ser texto de hasta 500 caracteres' })
    }

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'Orden inválida' })
    }
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ error: 'Producto inválido' })
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'La cantidad debe ser un entero mayor a cero' })
    }

    const orderRepo = AppDataSource.getRepository(Order)
    const productRepo = AppDataSource.getRepository(Product)
    const itemRepo = AppDataSource.getRepository(OrderItem)

    const order = await orderRepo.findOne({ where: { id: orderId, status: OrderStatus.OPEN } })
    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' })
    }

    if (!order.tableSessionId) {
      if (!order.tableId) return res.status(409).json({ error: 'La orden no tiene mesa asignada' })
      const session = await openTableSession(order.tableId, (req as any).user.userId)
      order.tableSessionId = session.id
      await orderRepo.update(orderId, { tableSessionId: session.id })
      await AppDataSource.getRepository(Table).update(order.tableId, {
        currentOrderId: orderId,
        status: 'occupied'
      })
    }

    const product = await productRepo.findOne({
      where: { id: productId },
      relations: ['category']
    })
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' })
    }

    // Check if item already exists in order
    let item = await itemRepo.findOne({
      where: { orderId, productId, notes: notes === null ? IsNull() : notes }
    })

    if (item) {
      const currentQty = item.quantity ?? 0
      const addQty = quantity ?? 1
      item.quantity = currentQty + addQty
      item.subtotal = (item.quantity ?? 0) * Number(item.unitPrice)
      await itemRepo.save(item)
    } else {
      item = await itemRepo.save({
        orderId,
        productId,
        quantity,
        notes,
        unitPrice: product.price,
        subtotal: quantity * Number(product.price)
      })
    }

    // Update order total
    const allItems = await itemRepo.find({ where: { orderId } })
    const newTotal = allItems.reduce((sum, i) => sum + Number(i.subtotal), 0)
    await orderRepo.update(orderId, { total: newTotal })

    // Return updated item with product
    const updatedItem = await itemRepo.findOne({
      where: { id: item.id },
      relations: ['product']
    })

    const enrichedOrder = (await loadEnrichedOrder(orderId))!
    emitRealtime(
      req,
      'order:item-added',
      orderEventPayload(enrichedOrder, { item: updatedItem }),
      [UserRole.ADMIN, UserRole.WAITER, UserRole.KITCHEN]
    )
    emitRealtime(
      req,
      'table:updated',
      orderEventPayload(enrichedOrder),
      [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER]
    )

    res.json({
      item: updatedItem,
      orderTotal: newTotal,
      order: enrichedOrder
    })
  } catch (error) {
    console.error('Add item error:', error)
    res.status(500).json({ error: 'Error al agregar producto' })
  }
})

app.put('/orders/:orderId/items/:itemId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const orderId = Number(req.params.orderId)
    const itemId = Number(req.params.itemId)
    const requestedQuantity = req.body.quantity === undefined ? undefined : Number(req.body.quantity)

    if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ error: 'Orden o ítem inválido' })
    }
    if (requestedQuantity !== undefined && !Number.isInteger(requestedQuantity)) {
      return res.status(400).json({ error: 'La cantidad debe ser un entero' })
    }

    const orderRepo = AppDataSource.getRepository(Order)
    const itemRepo = AppDataSource.getRepository(OrderItem)

    const order = await orderRepo.findOne({ where: { id: orderId, status: OrderStatus.OPEN } })
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' })

    const item = await itemRepo.findOne({ where: { id: itemId, orderId } })
    if (!item) return res.status(404).json({ error: 'Ítem no encontrado en la orden' })

    let notes = item.notes || null
    if (req.body.notes !== undefined) {
      try {
        notes = normalizeItemNotes(req.body.notes)
      } catch {
        return res.status(400).json({ error: 'Las notas deben ser texto de hasta 500 caracteres' })
      }
    }

    const quantity = requestedQuantity ?? item.quantity ?? 1
    let updatedItem: OrderItem | null = null

    if (quantity <= 0) {
      await itemRepo.delete({ id: itemId, orderId })
    } else {
      item.quantity = quantity
      item.notes = notes
      item.subtotal = quantity * Number(item.unitPrice)
      await itemRepo.save(item)
      updatedItem = await itemRepo.findOne({ where: { id: itemId }, relations: ['product'] })
    }

    // Update order total
    const allItems = await itemRepo.find({ where: { orderId } })
    const newTotal = allItems.reduce((sum, i) => sum + Number(i.subtotal), 0)
    await orderRepo.update(orderId, { total: newTotal })

    if (allItems.length === 0) {
      await releaseEmptyOrderSession(orderId, (req as any).user.userId)
    }

    const enrichedOrder = (await loadEnrichedOrder(orderId))!
    const event = quantity <= 0 ? 'order:item-removed' : 'order:item-updated'
    emitRealtime(
      req,
      event,
      orderEventPayload(enrichedOrder, { item: updatedItem || { id: itemId, orderId } }),
      [UserRole.ADMIN, UserRole.WAITER, UserRole.KITCHEN]
    )
    emitRealtime(req, 'table:updated', orderEventPayload(enrichedOrder), [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])

    res.json({ orderTotal: newTotal, item: updatedItem, order: enrichedOrder })
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar item' })
  }
})

app.delete('/orders/:orderId/items/:itemId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const orderId = Number(req.params.orderId)
    const itemId = Number(req.params.itemId)

    if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ error: 'Orden o ítem inválido' })
    }
    const orderRepo = AppDataSource.getRepository(Order)
    const itemRepo = AppDataSource.getRepository(OrderItem)

    const order = await orderRepo.findOne({ where: { id: orderId, status: OrderStatus.OPEN } })
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' })

    const item = await itemRepo.findOne({ where: { id: itemId, orderId } })
    if (!item) return res.status(404).json({ error: 'Ítem no encontrado en la orden' })

    await itemRepo.delete({ id: itemId, orderId })

    // Update order total
    const allItems = await itemRepo.find({ where: { orderId } })
    const newTotal = allItems.reduce((sum, i) => sum + Number(i.subtotal), 0)
    await orderRepo.update(orderId, { total: newTotal })

    if (allItems.length === 0) {
      await releaseEmptyOrderSession(orderId, (req as any).user.userId)
    }

    const enrichedOrder = (await loadEnrichedOrder(orderId))!
    emitRealtime(
      req,
      'order:item-removed',
      orderEventPayload(enrichedOrder, { item }),
      [UserRole.ADMIN, UserRole.WAITER, UserRole.KITCHEN]
    )
    emitRealtime(req, 'table:updated', orderEventPayload(enrichedOrder), [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])

    res.json({ orderTotal: newTotal, order: enrichedOrder })
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar item' })
  }
})

// ============ PAYMENTS ============
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
const paymentReceipt = (payment: Payment, order?: Order | null) => ({
  id: payment.id,
  orderId: payment.orderId,
  method: payment.method,
  amount: Number(payment.amount),
  tipAmount: Number(payment.tipAmount || 0),
  totalDue: money(Number(payment.amount) + Number(payment.tipAmount || 0)),
  receivedAmount: payment.receivedAmount === null || payment.receivedAmount === undefined ? null : Number(payment.receivedAmount),
  changeAmount: Number(payment.changeAmount || 0),
  breakdown: payment.breakdown || null,
  notes: payment.notes || null,
  paidByUserId: payment.paidByUserId,
  createdAt: payment.createdAt,
  updatedAt: payment.updatedAt,
  order: order || undefined
})

app.post('/orders/:id/payments', authenticateToken, requireRole(UserRole.ADMIN, UserRole.CASHIER), async (req: Request, res: Response) => {
  try {
    const orderId = Number(req.params.id)
    const paymentRepo = AppDataSource.getRepository(Payment)
    const orderRepo = AppDataSource.getRepository(Order)
    const idempotencyKeyRaw = req.headers['idempotency-key'] || req.body.idempotencyKey
    const idempotencyKey = typeof idempotencyKeyRaw === 'string' ? idempotencyKeyRaw.trim().slice(0, 100) || null : null

    if (idempotencyKey) {
      const previous = await paymentRepo.findOne({ where: { idempotencyKey } })
      if (previous) {
        if (previous.orderId !== orderId) return res.status(409).json({ error: 'La clave de idempotencia pertenece a otra orden' })
        return res.json(paymentReceipt(previous, await loadEnrichedOrder(orderId)))
      }
    }
    const existing = await paymentRepo.findOne({ where: { orderId } })
    if (existing) return res.status(409).json({ error: 'La orden ya fue cobrada', payment: paymentReceipt(existing) })

    const order = await orderRepo.findOne({ where: { id: orderId } })
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' })
    if (order.status !== OrderStatus.DELIVERED) {
      return res.status(409).json({ error: 'Sólo se puede cobrar una orden entregada', status: order.status })
    }

    const method = String(req.body.method || '').toLowerCase() as PaymentMethod
    if (!Object.values(PaymentMethod).includes(method)) return res.status(400).json({ error: 'Método de pago inválido' })
    const amount = money(Number(order.total || 0))
    const requestedAmount = req.body.amount === undefined ? amount : money(Number(req.body.amount))
    const tipAmount = req.body.tipAmount === undefined ? 0 : money(Number(req.body.tipAmount))
    if (!Number.isFinite(requestedAmount) || requestedAmount !== amount || !Number.isFinite(tipAmount) || tipAmount < 0) {
      return res.status(400).json({ error: 'El importe debe coincidir con el total de la orden y la propina no puede ser negativa' })
    }
    const totalDue = money(amount + tipAmount)
    let receivedAmount: number | null = null
    let changeAmount = 0
    let breakdown: Payment['breakdown'] = null

    if (method === PaymentMethod.CASH) {
      receivedAmount = req.body.receivedAmount === undefined ? totalDue : money(Number(req.body.receivedAmount))
      if (!Number.isFinite(receivedAmount) || receivedAmount < totalDue) {
        return res.status(400).json({ error: 'El efectivo recibido es insuficiente' })
      }
      changeAmount = money(receivedAmount - totalDue)
    } else if (method === PaymentMethod.MIXED) {
      if (!Array.isArray(req.body.breakdown) || req.body.breakdown.length < 2) {
        return res.status(400).json({ error: 'El pago mixed requiere al menos dos componentes' })
      }
      breakdown = req.body.breakdown.map((part: any) => ({
        method: String(part.method).toLowerCase(),
        amount: money(Number(part.amount))
      })) as Payment['breakdown']
      const allowed = [PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.TRANSFER]
      if (breakdown!.some(part => !allowed.includes(part.method as PaymentMethod) || !Number.isFinite(part.amount) || part.amount <= 0) ||
        money(breakdown!.reduce((sum, part) => sum + part.amount, 0)) !== totalDue) {
        return res.status(400).json({ error: 'El breakdown debe contener métodos válidos y sumar total+propina' })
      }
    }

    let notes: string | null = null
    if (req.body.notes !== undefined && req.body.notes !== null) {
      if (typeof req.body.notes !== 'string' || req.body.notes.trim().length > 500) return res.status(400).json({ error: 'Notas inválidas' })
      notes = req.body.notes.trim() || null
    }
    const identity = (req as any).user
    const payment = await paymentRepo.save({
      orderId,
      restaurantId: identity.restaurantId || null,
      companyId: identity.companyId || null,
      branchId: identity.branchId || null,
      method,
      amount,
      receivedAmount,
      changeAmount,
      tipAmount,
      breakdown,
      notes,
      paidByUserId: identity.userId,
      idempotencyKey
    })
    await orderRepo.update(orderId, { status: OrderStatus.PAID })
    const paidOrder = (await loadEnrichedOrder(orderId))!
    emitRealtime(req, 'order:status-changed', orderEventPayload(paidOrder, { previousStatus: OrderStatus.DELIVERED, payment: paymentReceipt(payment) }),
      [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])
    res.status(201).json(paymentReceipt(payment, paidOrder))
  } catch (error: any) {
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'La orden ya fue cobrada' })
    console.error('Payment error:', error)
    res.status(500).json({ error: 'Error al registrar pago' })
  }
})

app.get('/orders/:id/payment', authenticateToken, async (req: Request, res: Response) => {
  const payment = await AppDataSource.getRepository(Payment).findOne({ where: { orderId: Number(req.params.id) } })
  if (!payment) return res.status(404).json({ error: 'Pago no encontrado' })
  const identity = (req as any).user
  if ((identity.companyId && payment.companyId !== identity.companyId) ||
    (!identity.companyId && identity.restaurantId && payment.restaurantId !== identity.restaurantId)) {
    return res.status(404).json({ error: 'Pago no encontrado' })
  }
  res.json(paymentReceipt(payment, await loadEnrichedOrder(payment.orderId!)))
})

app.get('/payments/:id/receipt', authenticateToken, async (req: Request, res: Response) => {
  const payment = await AppDataSource.getRepository(Payment).findOne({ where: { id: Number(req.params.id) } })
  if (!payment) return res.status(404).json({ error: 'Pago no encontrado' })
  const identity = (req as any).user
  if ((identity.companyId && payment.companyId !== identity.companyId) ||
    (!identity.companyId && identity.restaurantId && payment.restaurantId !== identity.restaurantId)) {
    return res.status(404).json({ error: 'Pago no encontrado' })
  }
  res.json(paymentReceipt(payment, await loadEnrichedOrder(payment.orderId!)))
})

const allowedOrderTransitions: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.OPEN]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY],
  [OrderStatus.READY]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [OrderStatus.PAID],
  [OrderStatus.PAID]: [OrderStatus.CLOSED],
  [OrderStatus.CLOSED]: [],
  [OrderStatus.CANCELLED]: []
}

const statusRoles: Partial<Record<OrderStatus, UserRole[]>> = {
  [OrderStatus.CONFIRMED]: [UserRole.ADMIN, UserRole.WAITER],
  [OrderStatus.PREPARING]: [UserRole.ADMIN, UserRole.KITCHEN],
  [OrderStatus.READY]: [UserRole.ADMIN, UserRole.KITCHEN],
  [OrderStatus.DELIVERED]: [UserRole.ADMIN, UserRole.WAITER],
  [OrderStatus.PAID]: [UserRole.ADMIN, UserRole.CASHIER],
  [OrderStatus.CLOSED]: [UserRole.ADMIN, UserRole.CASHIER],
  [OrderStatus.CANCELLED]: [UserRole.ADMIN, UserRole.WAITER]
}

const transitionOrderStatus = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const requestedStatus = String(req.body.status || '').toLowerCase() as OrderStatus
    if (!Object.values(OrderStatus).includes(requestedStatus)) {
      return res.status(400).json({ error: 'Estado de orden inválido' })
    }

    const orderRepo = AppDataSource.getRepository(Order)
    const order = await orderRepo.findOne({ where: { id } })
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' })

    const allowed = allowedOrderTransitions[order.status!].includes(requestedStatus)
    if (!allowed) {
      return res.status(409).json({
        error: `Transición inválida de ${order.status} a ${requestedStatus}`,
        allowedStatuses: allowedOrderTransitions[order.status!]
      })
    }

    const role = (req as any).user.role as UserRole
    if (!(statusRoles[requestedStatus] || []).includes(role)) {
      return res.status(403).json({ error: 'El rol no puede realizar esta transición' })
    }

    await orderRepo.update(id, {
      status: requestedStatus,
      ...(requestedStatus === OrderStatus.CLOSED ? { closedAt: new Date() } : {})
    })

    const enrichedOrder = (await loadEnrichedOrder(id))!
    const payload = orderEventPayload(enrichedOrder, { previousStatus: order.status })
    emitRealtime(
      req,
      'order:status-changed',
      payload,
      [UserRole.ADMIN, UserRole.WAITER, UserRole.KITCHEN, UserRole.CASHIER]
    )
    emitRealtime(req, 'table:updated', payload, [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])
    res.json(enrichedOrder)
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar el estado de la orden' })
  }
}

app.patch('/orders/:id/status', authenticateToken, transitionOrderStatus)
app.put('/orders/:id/status', authenticateToken, transitionOrderStatus)

app.post('/orders/:id/close', authenticateToken, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string
    const orderRepo = AppDataSource.getRepository(Order)
    const tableRepo = AppDataSource.getRepository(Table)
    const sessionRepo = AppDataSource.getRepository(TableSession)
    const paymentRepo = AppDataSource.getRepository(Payment)

    const order = await orderRepo.findOne({ where: { id: parseInt(id) } })
    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' })
    }

    await orderRepo.update(id, {
      status: OrderStatus.CLOSED,
      closedAt: new Date()
    })

    await tableRepo.update(order.tableId!, {
      status: 'free',
      currentOrderId: null
    })

    if (order.tableSessionId) {
      await sessionRepo.update(order.tableSessionId, {
        status: TableSessionStatus.CLOSED,
        openTableId: null,
        closedByUserId: (req as any).user.userId,
        closedAt: new Date()
      })
    }

    const closedOrder = (await loadEnrichedOrder(parseInt(id)))!
    const payload = orderEventPayload(closedOrder, { previousStatus: order.status })
    emitRealtime(
      req,
      'order:status-changed',
      payload,
      [UserRole.ADMIN, UserRole.WAITER, UserRole.KITCHEN, UserRole.CASHIER]
    )
    emitRealtime(req, 'table:updated', payload, [UserRole.ADMIN, UserRole.WAITER, UserRole.CASHIER])

    res.json({ success: true, total: order.total, status: OrderStatus.CLOSED, tableSessionId: order.tableSessionId || null })
  } catch (error) {
    console.error('Close order error:', error)
    res.status(500).json({ error: 'Error al cerrar orden' })
  }
})

// ============ STATS ============
app.get('/stats', authenticateToken, async (req: Request, res: Response) => {
  try {
    const orderRepo = AppDataSource.getRepository(Order)
    const tableRepo = AppDataSource.getRepository(Table)
    const sessionRepo = AppDataSource.getRepository(TableSession)
    const paymentRepo = AppDataSource.getRepository(Payment)

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayEnd = new Date(today)
    todayEnd.setHours(23, 59, 59, 999)

    const identity = (req as any).user
    const paymentWhere: any = { createdAt: Between(today, todayEnd) }
    if (identity.companyId) paymentWhere.companyId = identity.companyId
    else if (identity.restaurantId) paymentWhere.restaurantId = identity.restaurantId
    const [todayOrders, allTables, todayPayments] = await Promise.all([
      orderRepo.find({
        where: {
          status: OrderStatus.CLOSED,
          closedAt: Between(today, todayEnd)
        }
      }),
      tableRepo.find({ where: { active: true } }),
      paymentRepo.find({ where: paymentWhere })
    ])

    const todaySales = todayOrders.reduce((sum, o) => sum + Number(o.total || 0), 0)
    const openSessions = await sessionRepo.find({ where: { status: TableSessionStatus.OPEN } })
    const occupiedTableIds = new Set(openSessions.map(session => session.tableId))
    const occupiedTables = allTables.filter(table => occupiedTableIds.has(table.id)).length
    const freeTables = allTables.length - occupiedTables
    const paymentsByMethod = Object.fromEntries(Object.values(PaymentMethod).map(method => [method, { count: 0, total: 0, tips: 0 }])) as Record<string, { count: number; total: number; tips: number }>
    for (const payment of todayPayments) {
      const summary = paymentsByMethod[payment.method!]
      summary.count += 1
      summary.total = money(summary.total + Number(payment.amount || 0) + Number(payment.tipAmount || 0))
      summary.tips = money(summary.tips + Number(payment.tipAmount || 0))
    }

    res.json({
      todaySales,
      todayOrders: todayOrders.length,
      totalTables: allTables.length,
      occupiedTables,
      freeTables,
      paymentsByMethod,
      averageTicket: todayOrders.length > 0 ? todaySales / todayOrders.length : 0
    })
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
})

// ============ HEALTH CHECK ============
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date() })
})

const PORT = process.env.PORT || 3000
const HOST = process.env.HOST || '0.0.0.0'

const startServer = async () => {
  try {
    await AppDataSource.initialize()
    console.log("DB conectada 🚀")
    await seedData()
    httpServer.listen(Number(PORT), HOST, () => {
      console.log(`Servidor corriendo en http://${HOST}:${PORT} 🎉`)
    })
  } catch (error) {
    console.error("No se pudo iniciar la API:", error)
    process.exit(1)
  }
}

void startServer()
