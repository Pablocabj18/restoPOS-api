import { Router, Response } from 'express'
import { AppDataSource } from '../data-source'
import { Category } from '../entities/Category'
import { Product } from '../entities/Product'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { UserRole } from '../entities/User'

const router = Router()

// GET /categories — Public within tenant context (via token)
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const catRepo = AppDataSource.getRepository(Category)
    const prodRepo = AppDataSource.getRepository(Product)

    const categories = await catRepo.find({
      where: { companyId: req.user!.companyId, active: true },
      order: { sortOrder: 'ASC', id: 'ASC' }
    })

    // Attach products to each category
    const result = await Promise.all(categories.map(async (cat) => {
      const products = await prodRepo.find({
        where: { companyId: req.user!.companyId, categoryId: cat.id, available: true },
        order: { sortOrder: 'ASC', id: 'ASC' }
      })
      return { ...cat, products }
    }))

    res.json(result)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener categorías' })
  }
})

// POST /categories
router.post('/', authenticate, requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, icon, sortOrder } = req.body
    if (!name) return res.status(400).json({ error: 'El nombre es requerido' })

    const repo = AppDataSource.getRepository(Category)
    const category = await repo.save({
      companyId: req.user!.companyId,
      name, description, icon, sortOrder: sortOrder ?? 0
    })
    res.json(category)
  } catch (error) {
    res.status(500).json({ error: 'Error al crear categoría' })
  }
})

// PUT /categories/:id
router.put('/:id', authenticate, requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const { name, description, icon, sortOrder, active } = req.body

    const repo = AppDataSource.getRepository(Category)
    const cat = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!cat) return res.status(404).json({ error: 'Categoría no encontrada' })

    await repo.update(id, { name, description, icon, sortOrder, active })
    res.json(await repo.findOne({ where: { id } }))
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar categoría' })
  }
})

// DELETE /categories/:id
router.delete('/:id', authenticate, requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const repo = AppDataSource.getRepository(Category)
    const cat = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!cat) return res.status(404).json({ error: 'Categoría no encontrada' })

    await repo.update(id, { active: false })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar categoría' })
  }
})

export default router
