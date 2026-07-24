import { Router, Response } from 'express'
import { AppDataSource } from '../data-source'
import { Order, OrderStatus } from '../entities/Order'
import { Table } from '../entities/Table'
import { Product } from '../entities/Product'
import { OrderItem } from '../entities/OrderItem'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()
router.use(authenticate)

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const companyId = req.user!.companyId
    const branchId = req.user!.branchId

    const orderRepo = AppDataSource.getRepository(Order)
    const tableRepo = AppDataSource.getRepository(Table)
    const itemRepo = AppDataSource.getRepository(OrderItem)
    const prodRepo = AppDataSource.getRepository(Product)

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayEnd = new Date()
    todayEnd.setHours(23, 59, 59, 999)

    const where: any = { companyId, status: OrderStatus.CLOSED }
    if (branchId) where.branchId = branchId

    // Today's closed orders
    const todayOrders = await orderRepo
      .createQueryBuilder('order')
      .where('order.companyId = :companyId', { companyId })
      .andWhere('order.status = :status', { status: OrderStatus.CLOSED })
      .andWhere('order.closedAt BETWEEN :start AND :end', { start: today, end: todayEnd })
      .getMany()

    const todaySales = todayOrders.reduce((sum, o) => sum + Number(o.total || 0), 0)
    const averageTicket = todayOrders.length > 0 ? todaySales / todayOrders.length : 0

    // Tables status
    const tableWhere: any = { companyId }
    if (branchId) tableWhere.branchId = branchId
    const allTables = await tableRepo.find({ where: tableWhere })
    const occupiedTables = allTables.filter(t => t.currentOrderId !== null && t.currentOrderId !== undefined).length

    // Top 5 products today
    const todayOrderIds = todayOrders.map(o => o.id)
    let topProducts: any[] = []

    if (todayOrderIds.length > 0) {
      const todayItems = await itemRepo
        .createQueryBuilder('item')
        .where('item.orderId IN (:...ids)', { ids: todayOrderIds })
        .getMany()

      const productSales = new Map<number, { qty: number, revenue: number }>()
      todayItems.forEach(item => {
        const pid = item.productId!
        const existing = productSales.get(pid) || { qty: 0, revenue: 0 }
        productSales.set(pid, {
          qty: existing.qty + (item.quantity || 0),
          revenue: existing.revenue + Number(item.subtotal || 0)
        })
      })

      const sortedProducts = Array.from(productSales.entries())
        .sort((a, b) => b[1].qty - a[1].qty)
        .slice(0, 5)

      topProducts = await Promise.all(sortedProducts.map(async ([productId, stats]) => {
        const product = await prodRepo.findOne({ where: { id: productId } })
        return { product, qty: stats.qty, revenue: stats.revenue }
      }))
    }

    // Open orders count
    const openOrders = await orderRepo.count({
      where: { companyId, status: OrderStatus.OPEN }
    })

    res.json({
      todaySales,
      todayOrders: todayOrders.length,
      averageTicket,
      totalTables: allTables.length,
      occupiedTables,
      openOrders,
      topProducts
    })
  } catch (error) {
    console.error('Stats error:', error)
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
})

export default router
