import { Router, Response } from 'express'
import { AppDataSource } from '../data-source'
import { Table } from '../entities/Table'
import { Order, OrderStatus } from '../entities/Order'
import { OrderItem } from '../entities/OrderItem'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { UserRole } from '../entities/User'
import crypto from 'crypto'

const router = Router()
router.use(authenticate)

// GET /tables
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tableRepo = AppDataSource.getRepository(Table)
    const orderRepo = AppDataSource.getRepository(Order)
    const itemRepo = AppDataSource.getRepository(OrderItem)

    const branchId = req.query.branchId
      ? parseInt(req.query.branchId as string)
      : req.user!.branchId

    const whereClause: any = { companyId: req.user!.companyId }
    if (branchId) whereClause.branchId = branchId

    const tables = await tableRepo.find({
      where: whereClause,
      order: { number: 'ASC' }
    })

    const tablesWithOrders = await Promise.all(tables.map(async (table) => {
      const activeOrder = await orderRepo.findOne({
        where: { tableId: table.id, status: OrderStatus.OPEN, companyId: req.user!.companyId }
      })

      let total = 0
      let itemCount = 0
      if (activeOrder) {
        const items = await itemRepo.find({ where: { orderId: activeOrder.id } })
        total = items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0)
        itemCount = items.reduce((sum, item) => sum + (item.quantity || 0), 0)
      }

      return {
        ...table,
        status: activeOrder ? 'occupied' : 'free',
        total,
        itemCount,
        orderId: activeOrder?.id || null
      }
    }))

    res.json(tablesWithOrders)
  } catch (error) {
    console.error('Tables error:', error)
    res.status(500).json({ error: 'Error al obtener mesas' })
  }
})

// POST /tables
router.post('/', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const { number, capacity, branchId } = req.body
    if (!number || !branchId) {
      return res.status(400).json({ error: 'Número y sucursal son requeridos' })
    }

    const repo = AppDataSource.getRepository(Table)
    const existing = await repo.findOne({
      where: { companyId: req.user!.companyId, branchId, number }
    })
    if (existing) return res.status(400).json({ error: 'Ya existe una mesa con ese número en la sucursal' })

    const qrToken = crypto.randomUUID()
    const table = await repo.save({
      companyId: req.user!.companyId,
      branchId,
      number,
      capacity: capacity || 4,
      qrToken
    })
    res.json(table)
  } catch (error) {
    res.status(500).json({ error: 'Error al crear mesa' })
  }
})

// PUT /tables/:id
router.put('/:id', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const { number, capacity } = req.body

    const repo = AppDataSource.getRepository(Table)
    const table = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!table) return res.status(404).json({ error: 'Mesa no encontrada' })

    await repo.update(id, { number, capacity })
    res.json(await repo.findOne({ where: { id } }))
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar mesa' })
  }
})

// DELETE /tables/:id
router.delete('/:id', requireRole(UserRole.ADMIN), async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id)
    const repo = AppDataSource.getRepository(Table)
    const table = await repo.findOne({ where: { id, companyId: req.user!.companyId } })
    if (!table) return res.status(404).json({ error: 'Mesa no encontrada' })

    await repo.delete(id)
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar mesa' })
  }
})

export default router
