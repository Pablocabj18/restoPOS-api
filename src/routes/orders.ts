import { Router, Response, Request } from 'express'
import { Server as SocketServer } from 'socket.io'
import { AppDataSource } from '../data-source'
import { Order, OrderStatus, OrderType } from '../entities/Order'
import { OrderItem, ItemStatus } from '../entities/OrderItem'
import { Product } from '../entities/Product'
import { Table } from '../entities/Table'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { UserRole } from '../entities/User'

export function createOrdersRouter(io: SocketServer) {
  const router = Router()

  const buildFullOrder = async (orderId: number) => {
    const orderRepo = AppDataSource.getRepository(Order)
    const itemRepo = AppDataSource.getRepository(OrderItem)
    const prodRepo = AppDataSource.getRepository(Product)
    const tableRepo = AppDataSource.getRepository(Table)

    const order = await orderRepo.findOne({ where: { id: orderId } })
    if (!order) return null

    const items = await itemRepo.find({ where: { orderId } })
    const itemsWithProducts = await Promise.all(items.map(async (item) => {
      const product = await prodRepo.findOne({ where: { id: item.productId } })
      return { ...item, product }
    }))

    const table = order.tableId ? await tableRepo.findOne({ where: { id: order.tableId } }) : null

    return { ...order, items: itemsWithProducts, table }
  }

  // GET /orders
  router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const orderRepo = AppDataSource.getRepository(Order)
      const itemRepo = AppDataSource.getRepository(OrderItem)

      const where: any = { companyId: req.user!.companyId }
      if (req.query.status) where.status = req.query.status
      if (req.query.branchId) where.branchId = parseInt(req.query.branchId as string)

      const orders = await orderRepo.find({
        where,
        order: { createdAt: 'DESC' }
      })

      const result = await Promise.all(orders.map(async (order) => {
        const items = await itemRepo.find({ where: { orderId: order.id } })
        return { ...order, itemCount: items.length }
      }))

      res.json(result)
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener órdenes' })
    }
  })

  // GET /orders/kitchen — Open orders for kitchen display
  router.get('/kitchen', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const orderRepo = AppDataSource.getRepository(Order)
      const itemRepo = AppDataSource.getRepository(OrderItem)
      const prodRepo = AppDataSource.getRepository(Product)
      const tableRepo = AppDataSource.getRepository(Table)

      const orders = await orderRepo.find({
        where: {
          companyId: req.user!.companyId,
          status: OrderStatus.KITCHEN
        },
        order: { createdAt: 'ASC' }
      })

      const result = await Promise.all(orders.map(async (order) => {
        const items = await itemRepo.find({ where: { orderId: order.id } })
        const itemsWithProducts = await Promise.all(items.map(async (item) => {
          const product = await prodRepo.findOne({ where: { id: item.productId } })
          return { ...item, product }
        }))
        const table = order.tableId ? await tableRepo.findOne({ where: { id: order.tableId } }) : null
        return { ...order, items: itemsWithProducts, table }
      }))

      res.json(result)
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener órdenes de cocina' })
    }
  })

  // GET /orders/:id
  router.get('/:id', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id)
      const order = await buildFullOrder(id)
      if (!order) return res.status(404).json({ error: 'Orden no encontrada' })
      res.json(order)
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener orden' })
    }
  })

  // POST /orders — Create new order
  router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { tableId, type = OrderType.DINE_IN, customerName, notes } = req.body
      const orderRepo = AppDataSource.getRepository(Order)
      const tableRepo = AppDataSource.getRepository(Table)

      // If dine-in, check if table already has open order
      if (tableId) {
        const existingOrder = await orderRepo.findOne({
          where: { tableId, status: OrderStatus.OPEN, companyId: req.user!.companyId }
        })
        if (existingOrder) {
          return res.json(await buildFullOrder(existingOrder.id!))
        }
      }

      const branchId = req.user!.branchId || (tableId ? (await tableRepo.findOne({ where: { id: tableId } }))?.branchId : undefined)

      const order = await orderRepo.save({
        companyId: req.user!.companyId,
        branchId,
        tableId: tableId || null,
        userId: req.user!.userId,
        status: OrderStatus.OPEN,
        type,
        total: 0,
        customerName,
        notes
      })

      const fullOrder = await buildFullOrder(order.id!)
      io.to(`company_${req.user!.companyId}`).emit('order:new', fullOrder)

      res.json(fullOrder)
    } catch (error) {
      console.error('Create order error:', error)
      res.status(500).json({ error: 'Error al crear orden' })
    }
  })

  // POST /orders/:id/items — Add item
  router.post('/:id/items', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const orderId = parseInt(req.params.id)
      const { productId, quantity = 1, notes } = req.body

      const orderRepo = AppDataSource.getRepository(Order)
      const prodRepo = AppDataSource.getRepository(Product)
      const itemRepo = AppDataSource.getRepository(OrderItem)

      const order = await orderRepo.findOne({ where: { id: orderId, companyId: req.user!.companyId } })
      if (!order) return res.status(404).json({ error: 'Orden no encontrada' })

      const product = await prodRepo.findOne({ where: { id: productId, companyId: req.user!.companyId } })
      if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

      // Check if item already in order, update quantity
      let item = await itemRepo.findOne({ where: { orderId, productId } })
      if (item) {
        item.quantity = (item.quantity || 0) + quantity
        item.subtotal = item.quantity * Number(item.unitPrice)
        if (notes) item.notes = notes
        await itemRepo.save(item)
      } else {
        item = await itemRepo.save({
          orderId,
          productId,
          quantity,
          unitPrice: product.price,
          subtotal: quantity * Number(product.price),
          notes,
          status: ItemStatus.PENDING
        })
      }

      // Update order total
      const allItems = await itemRepo.find({ where: { orderId } })
      const newTotal = allItems.reduce((sum, i) => sum + Number(i.subtotal || 0), 0)
      await orderRepo.update(orderId, { total: newTotal })

      const fullOrder = await buildFullOrder(orderId)
      io.to(`company_${req.user!.companyId}`).emit('order:updated', fullOrder)

      res.json({ item: { ...item, product }, orderTotal: newTotal })
    } catch (error) {
      console.error('Add item error:', error)
      res.status(500).json({ error: 'Error al agregar producto' })
    }
  })

  // PUT /orders/:orderId/items/:itemId — Update quantity
  router.put('/:orderId/items/:itemId', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const orderId = parseInt(req.params.orderId)
      const itemId = parseInt(req.params.itemId)
      const { quantity } = req.body

      const orderRepo = AppDataSource.getRepository(Order)
      const itemRepo = AppDataSource.getRepository(OrderItem)

      if (quantity <= 0) {
        await itemRepo.delete(itemId)
      } else {
        const item = await itemRepo.findOne({ where: { id: itemId } })
        if (item) {
          item.quantity = quantity
          item.subtotal = quantity * Number(item.unitPrice)
          await itemRepo.save(item)
        }
      }

      const allItems = await itemRepo.find({ where: { orderId } })
      const newTotal = allItems.reduce((sum, i) => sum + Number(i.subtotal || 0), 0)
      await orderRepo.update(orderId, { total: newTotal })

      const fullOrder = await buildFullOrder(orderId)
      io.to(`company_${req.user!.companyId}`).emit('order:updated', fullOrder)

      res.json({ orderTotal: newTotal })
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar item' })
    }
  })

  // DELETE /orders/:orderId/items/:itemId
  router.delete('/:orderId/items/:itemId', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const orderId = parseInt(req.params.orderId)
      const itemId = parseInt(req.params.itemId)

      const orderRepo = AppDataSource.getRepository(Order)
      const itemRepo = AppDataSource.getRepository(OrderItem)

      await itemRepo.delete(itemId)

      const allItems = await itemRepo.find({ where: { orderId } })
      const newTotal = allItems.reduce((sum, i) => sum + Number(i.subtotal || 0), 0)
      await orderRepo.update(orderId, { total: newTotal })

      const fullOrder = await buildFullOrder(orderId)
      io.to(`company_${req.user!.companyId}`).emit('order:updated', fullOrder)

      res.json({ orderTotal: newTotal })
    } catch (error) {
      res.status(500).json({ error: 'Error al eliminar item' })
    }
  })

  // POST /orders/:id/send-to-kitchen — Send order to kitchen
  router.post('/:id/send-to-kitchen', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id)
      const orderRepo = AppDataSource.getRepository(Order)

      const order = await orderRepo.findOne({ where: { id, companyId: req.user!.companyId } })
      if (!order) return res.status(404).json({ error: 'Orden no encontrada' })

      await orderRepo.update(id, { status: OrderStatus.KITCHEN })

      const fullOrder = await buildFullOrder(id)
      io.to(`company_${req.user!.companyId}`).emit('order:kitchen', fullOrder)

      res.json({ success: true, order: fullOrder })
    } catch (error) {
      res.status(500).json({ error: 'Error al enviar a cocina' })
    }
  })

  // PUT /orders/:orderId/items/:itemId/status — Kitchen updates item status
  router.put('/:orderId/items/:itemId/status', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const orderId = parseInt(req.params.orderId)
      const itemId = parseInt(req.params.itemId)
      const { status } = req.body

      const itemRepo = AppDataSource.getRepository(OrderItem)
      const orderRepo = AppDataSource.getRepository(Order)

      await itemRepo.update(itemId, { status })

      // If all items are ready, update order status
      const allItems = await itemRepo.find({ where: { orderId } })
      const allReady = allItems.every(i => i.status === ItemStatus.READY || i.status === ItemStatus.DELIVERED)
      if (allReady && allItems.length > 0) {
        await orderRepo.update(orderId, { status: OrderStatus.READY })
      }

      const fullOrder = await buildFullOrder(orderId)
      io.to(`company_${req.user!.companyId}`).emit('order:updated', fullOrder)

      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar estado del item' })
    }
  })

  // POST /orders/:id/close
  router.post('/:id/close', authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id)
      const orderRepo = AppDataSource.getRepository(Order)
      const tableRepo = AppDataSource.getRepository(Table)

      const order = await orderRepo.findOne({ where: { id, companyId: req.user!.companyId } })
      if (!order) return res.status(404).json({ error: 'Orden no encontrada' })

      await orderRepo.update(id, { status: OrderStatus.CLOSED, closedAt: new Date() })

      if (order.tableId) {
        await tableRepo.update(order.tableId, { status: 'free' as any, currentOrderId: null })
      }

      io.to(`company_${req.user!.companyId}`).emit('order:closed', { orderId: id, tableId: order.tableId, total: order.total })

      res.json({ success: true, total: order.total })
    } catch (error) {
      console.error('Close order error:', error)
      res.status(500).json({ error: 'Error al cerrar orden' })
    }
  })

  return router
}
