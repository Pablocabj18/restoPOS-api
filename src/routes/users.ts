import { Router, Response } from 'express'
import * as bcrypt from 'bcryptjs'
import { AppDataSource } from '../data-source'
import { User, UserRole } from '../entities/User'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'

const router = Router()
router.use(authenticate)

// GET /users
router.get('/', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(User)
    const users = await repo.find({
      where: { companyId: req.user!.companyId },
      select: ['id', 'name', 'lastName', 'email', 'role', 'branchId', 'active']
    })
    res.json(users)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuarios' })
  }
})

// POST /users
router.post('/', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const { name, lastName, email, password, role, branchId } = req.body
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Nombre, email, contraseña y rol son requeridos' })
    }

    if (!Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' })
    }

    const repo = AppDataSource.getRepository(User)
    const existing = await repo.findOne({ where: { email } })
    if (existing) return res.status(400).json({ error: 'El email ya está en uso' })

    const hashed = await bcrypt.hash(password, 10)
    const user = await repo.save({
      companyId: req.user!.companyId,
      branchId: branchId || req.user!.branchId,
      name, lastName, email,
      password: hashed,
      role
    })

    const { password: _, ...safeUser } = user as any
    res.json(safeUser)
  } catch (error) {
    res.status(500).json({ error: 'Error al crear usuario' })
  }
})

// PUT /users/:id
router.put('/:id', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const { name, lastName, role, branchId, active, password } = req.body

    const repo = AppDataSource.getRepository(User)
    const user = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })

    const updateData: Partial<User> = { name, lastName, role, branchId, active }
    if (password) {
      updateData.password = await bcrypt.hash(password, 10)
    }

    await repo.update(id, updateData)
    const updated = await repo.findOne({ where: { id }, select: ['id', 'name', 'lastName', 'email', 'role', 'branchId', 'active'] })
    res.json(updated)
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar usuario' })
  }
})

// DELETE /users/:id
router.delete('/:id', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    if (id === req.user!.userId) {
      return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' })
    }
    const repo = AppDataSource.getRepository(User)
    const user = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })

    await repo.update(id, { active: false })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar usuario' })
  }
})

export default router
