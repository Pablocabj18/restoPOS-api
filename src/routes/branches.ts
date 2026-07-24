import { Router, Response } from 'express'
import { AppDataSource } from '../data-source'
import { Branch } from '../entities/Branch'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { UserRole } from '../entities/User'

const router = Router()

router.use(authenticate)

// GET /branches
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(Branch)
    const branches = await repo.find({
      where: { companyId: req.user!.companyId, active: true }
    })
    res.json(branches)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener sucursales' })
  }
})

// POST /branches
router.post('/', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const { name, address, phone, email } = req.body
    if (!name) return res.status(400).json({ error: 'El nombre es requerido' })

    const repo = AppDataSource.getRepository(Branch)
    const branch = await repo.save({
      companyId: req.user!.companyId,
      name, address, phone, email
    })
    res.json(branch)
  } catch (error) {
    res.status(500).json({ error: 'Error al crear sucursal' })
  }
})

// PUT /branches/:id
router.put('/:id', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const { name, address, phone, email } = req.body
    const repo = AppDataSource.getRepository(Branch)

    const branch = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada' })

    await repo.update(id, { name, address, phone, email })
    res.json(await repo.findOne({ where: { id } }))
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar sucursal' })
  }
})

// DELETE /branches/:id
router.delete('/:id', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const repo = AppDataSource.getRepository(Branch)
    const branch = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada' })

    await repo.update(id, { active: false })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar sucursal' })
  }
})

export default router
