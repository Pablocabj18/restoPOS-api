import { Router, Response } from 'express'
import { AppDataSource } from '../data-source'
import { Product } from '../entities/Product'
import { Category } from '../entities/Category'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { UserRole } from '../entities/User'

const router = Router()

// GET /products
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const prodRepo = AppDataSource.getRepository(Product)
    const catRepo = AppDataSource.getRepository(Category)

    const products = await prodRepo.find({
      where: { companyId: req.user!.companyId, available: true },
      order: { categoryId: 'ASC', sortOrder: 'ASC', id: 'ASC' }
    })

    // Attach category info
    const categories = await catRepo.find({ where: { companyId: req.user!.companyId } })
    const catMap = new Map(categories.map(c => [c.id, c]))

    const result = products.map(p => ({
      ...p,
      category: catMap.get(p.categoryId) || null
    }))

    res.json(result)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos' })
  }
})

// GET /products/all — All including unavailable (admin)
router.get('/all', authenticate, requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const prodRepo = AppDataSource.getRepository(Product)
    const catRepo = AppDataSource.getRepository(Category)

    const products = await prodRepo.find({
      where: { companyId: req.user!.companyId },
      order: { categoryId: 'ASC', sortOrder: 'ASC', id: 'ASC' }
    })

    const categories = await catRepo.find({ where: { companyId: req.user!.companyId } })
    const catMap = new Map(categories.map(c => [c.id, c]))

    const result = products.map(p => ({
      ...p,
      category: catMap.get(p.categoryId) || null
    }))

    res.json(result)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos' })
  }
})

// POST /products
router.post('/', authenticate, requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, price, categoryId, image, sortOrder } = req.body
    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Nombre y precio son requeridos' })
    }

    const repo = AppDataSource.getRepository(Product)
    const product = await repo.save({
      companyId: req.user!.companyId,
      name, description, price, categoryId, image,
      sortOrder: sortOrder ?? 0
    })
    res.json(product)
  } catch (error) {
    res.status(500).json({ error: 'Error al crear producto' })
  }
})

// PUT /products/:id
router.put('/:id', authenticate, requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const { name, description, price, categoryId, image, available, sortOrder } = req.body

    const repo = AppDataSource.getRepository(Product)
    const product = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    await repo.update(id, { name, description, price, categoryId, image, available, sortOrder })
    res.json(await repo.findOne({ where: { id } }))
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar producto' })
  }
})

// DELETE /products/:id (soft delete)
router.delete('/:id', authenticate, requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const repo = AppDataSource.getRepository(Product)
    const product = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    await repo.update(id, { available: false })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar producto' })
  }
})

export default router
