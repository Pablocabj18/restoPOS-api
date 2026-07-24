import { Router, Response } from 'express'
import { AppDataSource } from '../data-source'
import { CashSession, CashSessionStatus } from '../entities/CashSession'
import { Order, OrderStatus } from '../entities/Order'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { UserRole } from '../entities/User'

const router = Router()
router.use(authenticate)

// GET /cash/current — Get current open cash session
router.get('/current', async (req: AuthRequest, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(CashSession)
    const session = await repo.findOne({
      where: {
        companyId: req.user!.companyId,
        branchId: req.user!.branchId,
        status: CashSessionStatus.OPEN
      }
    })
    res.json(session || null)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener caja' })
  }
})

// POST /cash/open — Open cash session
router.post('/open', requireRole(UserRole.ADMIN, UserRole.CASHIER), async (req: AuthRequest, res: Response) => {
  try {
    const { openAmount = 0, notes } = req.body

    const repo = AppDataSource.getRepository(CashSession)
    const existing = await repo.findOne({
      where: {
        companyId: req.user!.companyId,
        branchId: req.user!.branchId,
        status: CashSessionStatus.OPEN
      }
    })
    if (existing) return res.status(400).json({ error: 'Ya hay una caja abierta' })

    const session = await repo.save({
      companyId: req.user!.companyId,
      branchId: req.user!.branchId!,
      userId: req.user!.userId,
      openAmount,
      notes,
      status: CashSessionStatus.OPEN
    })
    res.json(session)
  } catch (error) {
    res.status(500).json({ error: 'Error al abrir caja' })
  }
})

// POST /cash/close — Close cash session
router.post('/close', requireRole(UserRole.ADMIN, UserRole.CASHIER), async (req: AuthRequest, res: Response) => {
  try {
    const { closeAmount, notes } = req.body

    const repo = AppDataSource.getRepository(CashSession)
    const session = await repo.findOne({
      where: {
        companyId: req.user!.companyId,
        branchId: req.user!.branchId,
        status: CashSessionStatus.OPEN
      }
    })
    if (!session) return res.status(404).json({ error: 'No hay caja abierta' })

    // Calculate total sales during session
    const orderRepo = AppDataSource.getRepository(Order)
    const closedOrders = await orderRepo
      .createQueryBuilder('order')
      .where('order.companyId = :companyId', { companyId: req.user!.companyId })
      .andWhere('order.branchId = :branchId', { branchId: req.user!.branchId })
      .andWhere('order.status = :status', { status: OrderStatus.CLOSED })
      .andWhere('order.closedAt >= :openedAt', { openedAt: session.openedAt })
      .getMany()

    const totalSales = closedOrders.reduce((sum, o) => sum + Number(o.total || 0), 0)

    await repo.update(session.id!, {
      closeAmount,
      totalSales,
      totalOrders: closedOrders.length,
      notes: notes || session.notes,
      status: CashSessionStatus.CLOSED,
      closedAt: new Date()
    })

    res.json(await repo.findOne({ where: { id: session.id } }))
  } catch (error) {
    res.status(500).json({ error: 'Error al cerrar caja' })
  }
})

// GET /cash/history — Get past sessions
router.get('/history', requireRole(UserRole.ADMIN, UserRole.CASHIER), async (req: AuthRequest, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(CashSession)
    const sessions = await repo.find({
      where: { companyId: req.user!.companyId },
      order: { openedAt: 'DESC' },
      take: 30
    })
    res.json(sessions)
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener historial de caja' })
  }
})

export default router
