require('dotenv').config()

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const mysql = require('mysql2/promise')
const jwt = require('jsonwebtoken')
const { io: createSocket } = require('socket.io-client')

const port = 3187
const database = `resto_order_flow_test_${Date.now()}`
const baseUrl = `http://127.0.0.1:${port}`

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD || ''
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options.headers
    }
  })
  const body = await response.json()
  assert.ok(response.ok, `${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function expectStatus(path, expectedStatus, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers }
  })
  const body = await response.json()
  assert.equal(response.status, expectedStatus, JSON.stringify(body))
  return body
}

function waitForEvent(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`Timed out waiting for ${event}`))
    }, 4000)
    const handler = payload => {
      if (!predicate(payload)) return
      clearTimeout(timeout)
      socket.off(event, handler)
      resolve(payload)
    }
    socket.on(event, handler)
  })
}

function connectSocket(token, auth = {}) {
  return new Promise((resolve, reject) => {
    const socket = createSocket(baseUrl, {
      transports: ['websocket'],
      auth: { token, ...auth },
      forceNew: true
    })
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

async function waitForDatabase() {
  let lastError
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/products`)
      if (response.ok) {
        const products = await response.json()
        if (products.length > 0) return
      }
      lastError = new Error(`GET /products is not seeded yet (${response.status})`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw lastError
}

async function main() {
  const admin = await mysql.createConnection(dbConfig)
  let testDb
  let server
  const sockets = []

  try {
    await admin.query(`CREATE DATABASE \`${database}\``)

    server = spawn(
      process.execPath,
      [require.resolve('ts-node/dist/bin.js'), 'src/index.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, DB_DATABASE: database, PORT: String(port) },
        stdio: ['ignore', 'inherit', 'inherit']
      }
    )
    await waitForDatabase()
    testDb = await mysql.createConnection({ ...dbConfig, database })

    await testDb.query(`
      INSERT INTO \`order\` (\`tableId\`, \`tableSessionId\`, \`userId\`, \`status\`, \`total\`, \`createdAt\`, \`updatedAt\`)
      VALUES (2, NULL, NULL, 'open', 0, NOW(), NOW())
    `)
    await testDb.query("UPDATE `table` SET `status` = 'occupied', `currentOrderId` = LAST_INSERT_ID() WHERE `id` = 2")

    const bootstrapState = await request('/auth/bootstrap/status')
    assert.equal(bootstrapState.bootstrapAllowed, true)
    const bootstrap = await request('/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        restaurantName: 'Restaurante Test',
        username: 'owner',
        email: `owner-${Date.now()}@test.local`,
        password: 'OwnerPass123',
        name: 'Owner'
      })
    })
    assert.equal(bootstrap.user.role, 'admin')
    await expectStatus('/auth/bootstrap', 409, {
      method: 'POST',
      body: JSON.stringify({ restaurantName: 'Otro', username: 'other', password: 'OtherPass123', name: 'Other' })
    })
    await expectStatus('/auth/register', 403, { method: 'POST', body: JSON.stringify({}) })

    const adminHeaders = { authorization: `Bearer ${bootstrap.token}` }
    const employee = await request('/users', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ username: 'waiter.one', name: 'Waiter', lastName: 'One', role: 'waiter' })
    })
    assert.equal(employee.status, 'pending_activation')
    assert.equal(employee.mustSetPassword, true)
    assert.equal(Object.hasOwn(employee, 'passwordHash'), false)

    let identification = await request('/auth/identify', {
      method: 'POST', body: JSON.stringify({ identifier: 'waiter.one' })
    })
    assert.equal(identification.requiresPasswordSetup, true)
    const initialSession = await request('/auth/set-initial-password', {
      method: 'POST',
      body: JSON.stringify({ challenge: identification.challenge, password: 'WaiterPass123', confirmPassword: 'WaiterPass123' })
    })
    assert.equal(initialSession.user.status, 'active')
    await expectStatus('/auth/set-initial-password', 400, {
      method: 'POST',
      body: JSON.stringify({ challenge: identification.challenge, password: 'WaiterPass123', confirmPassword: 'WaiterPass123' })
    })

    identification = await request('/auth/identify', {
      method: 'POST', body: JSON.stringify({ identifier: 'waiter.one' })
    })
    assert.equal(identification.requiresPasswordSetup, false)
    let login = await request('/auth/login', {
      method: 'POST', body: JSON.stringify({ challenge: identification.challenge, password: 'WaiterPass123' })
    })
    assert.equal(login.user.role, 'waiter')

    await request(`/users/${employee.id}`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ status: 'disabled' })
    })
    await expectStatus('/auth/identify', 401, {
      method: 'POST', body: JSON.stringify({ identifier: 'waiter.one' })
    })
    await request(`/users/${employee.id}`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ status: 'active' })
    })
    await request(`/users/${employee.id}/password-reset`, { method: 'POST', headers: adminHeaders })
    await expectStatus('/auth/me', 403, { headers: { authorization: `Bearer ${login.token}` } })

    identification = await request('/auth/identify', {
      method: 'POST', body: JSON.stringify({ identifier: 'waiter.one' })
    })
    assert.equal(identification.requiresPasswordSetup, true)
    const resetSession = await request('/auth/set-initial-password', {
      method: 'POST',
      body: JSON.stringify({ challenge: identification.challenge, password: 'NewWaiter123', confirmPassword: 'NewWaiter123' })
    })
    login = resetSession
    const headers = { authorization: `Bearer ${login.token}` }
    const me = await request('/auth/me', { headers })
    assert.equal(me.role, 'waiter')
    const restaurantId = bootstrap.restaurant.id

    const roleHeaders = role => ({
      authorization: `Bearer ${jwt.sign(
        { userId: bootstrap.user.id, username: 'owner', role, restaurantId, tokenVersion: 0 },
        process.env.JWT_SECRET || 'resto-pos-secret-key-2024'
      )}`
    })

    const waiterSocket = await connectSocket(login.token)
    const kitchenToken = roleHeaders('kitchen').authorization.replace('Bearer ', '')
    const kitchenSocket = await connectSocket(kitchenToken)
    sockets.push(waiterSocket, kitchenSocket)

    const products = await request('/products')
    assert.ok(products.length > 0, 'The seed must provide at least one product')
    const product = products[0]

    const adminCategories = await request('/categories/all', { headers: adminHeaders })
    assert.ok(adminCategories.length > 0)
    const testCategory = await request('/categories', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'Categoría MVP Test', description: 'Test', sortOrder: 99 })
    })
    await expectStatus('/categories', 409, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'categoría mvp test' })
    })
    await expectStatus('/products', 400, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'Producto inválido', price: 0, categoryId: testCategory.id })
    })
    const testProduct = await request('/products', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({
        name: 'Producto MVP Test', description: 'Producto prueba', price: 1234,
        categoryId: testCategory.id, image: null, available: true, sortOrder: 20
      })
    })
    assert.equal(Number(testProduct.price), 1234)
    await request(`/products/${testProduct.id}`, { method: 'DELETE', headers: adminHeaders })
    const publicProductsAfterDelete = await request('/products')
    assert.equal(publicProductsAfterDelete.some(candidate => candidate.id === testProduct.id), false)
    const allProductsAfterDelete = await request('/products/all', { headers: adminHeaders })
    assert.equal(allProductsAfterDelete.find(candidate => candidate.id === testProduct.id).available, false)

    const tablesWithLegacyOrder = await request('/tables')
    assert.equal(tablesWithLegacyOrder.find(candidate => candidate.id === 2).status, 'free')
    const statsWithLegacyOrder = await request('/stats', { headers })
    assert.equal(statsWithLegacyOrder.occupiedTables, 0)

    const table = await request('/tables', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ number: 9999, capacity: 4 })
    })
    const draftTable = await request('/tables', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ number: 9998, capacity: 2 })
    })
    const draftOrder = await request('/orders', {
      method: 'POST', headers, body: JSON.stringify({ tableId: draftTable.id })
    })
    assert.equal(draftOrder.tableSessionId, null)
    const sameDraftOrder = await request('/orders', {
      method: 'POST', headers, body: JSON.stringify({ tableId: draftTable.id })
    })
    assert.equal(sameDraftOrder.id, draftOrder.id)
    const tablesAfterDraftVisit = await request('/tables')
    assert.equal(tablesAfterDraftVisit.find(candidate => candidate.id === draftTable.id).status, 'free')
    await request(`/orders/${draftOrder.id}/close`, { method: 'POST', headers })

    const reservationEventPromise = waitForEvent(waiterSocket, 'reservation:created')
    const reservation = await request('/reservations', {
      method: 'POST', headers,
      body: JSON.stringify({
        customerName: 'Cliente Reserva', phone: '+5491112345678',
        startsAt: '2030-01-15T20:00:00.000Z', durationMinutes: 120,
        partySize: 4, tableId: table.id, notes: '  cerca de ventana  ',
        source: 'manual', whatsappOptIn: true
      })
    })
    assert.equal(reservation.notes, 'cerca de ventana')
    assert.equal((await reservationEventPromise).reservationId, reservation.id)
    await expectStatus('/reservations', 409, {
      method: 'POST', headers,
      body: JSON.stringify({
        customerName: 'Reserva Superpuesta', phone: '123',
        startsAt: '2030-01-15T21:00:00.000Z', durationMinutes: 120,
        partySize: 2, tableId: table.id
      })
    })
    const filteredReservations = await request('/reservations?date=2030-01-15&status=pending', { headers })
    assert.equal(filteredReservations.some(candidate => candidate.id === reservation.id), true)
    const eligibleTables = await request(`/reservations/${reservation.id}/eligible-tables`, { headers })
    assert.equal(eligibleTables.some(candidate => candidate.id === table.id), true)
    const confirmedReservation = await request(`/reservations/${reservation.id}/status`, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'confirmed' })
    })
    assert.equal(confirmedReservation.status, 'confirmed')
    const seatedReservation = await request(`/reservations/${reservation.id}/status`, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'seated' })
    })
    assert.equal(seatedReservation.status, 'seated')
    assert.ok(seatedReservation.tableSessionId)
    await expectStatus(`/tables/${table.id}`, 409, { method: 'DELETE', headers: adminHeaders })

    const [openedSession, concurrentSession] = await Promise.all([
      request(`/tables/${table.id}/sessions/open`, { method: 'POST', headers }),
      request(`/tables/${table.id}/sessions/open`, { method: 'POST', headers })
    ])
    assert.equal(openedSession.id, concurrentSession.id)
    assert.equal(openedSession.id, seatedReservation.tableSessionId)
    assert.equal(openedSession.status, 'open')

    const order = await request('/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId: table.id })
    })
    assert.equal(order.tableSession.id, openedSession.id)
    assert.equal(order.status, 'open')

    const firstAdd = await request(`/orders/${order.id}/items`, {
      method: 'POST', headers,
      body: JSON.stringify({ productId: product.id, quantity: 2 })
    })
    assert.ok(firstAdd.item.id, 'POST must return the persisted item ID')
    assert.equal(firstAdd.item.quantity, 2)

    const secondAdd = await request(`/orders/${order.id}/items`, {
      method: 'POST', headers,
      body: JSON.stringify({ productId: product.id, quantity: 3 })
    })
    assert.equal(secondAdd.item.id, firstAdd.item.id)
    assert.equal(secondAdd.item.quantity, 5)

    let detail = await request(`/orders/${order.id}`)
    assert.equal(detail.items.length, 1)
    assert.equal(detail.items[0].id, firstAdd.item.id)
    assert.equal(detail.items[0].productId, product.id)

    const publicLink = await request(`/tables/${table.id}/public-link`, { headers: adminHeaders })
    assert.equal(publicLink.tableId, table.id)
    assert.equal(publicLink.token.length, 64)
    const publicTable = await request(`/public/tables/${publicLink.token}`)
    assert.equal(publicTable.occupied, true)
    assert.equal(publicTable.canRequest, true)
    assert.equal(publicTable.orderId, order.id)
    const publicCatalog = await request(`/public/tables/${publicLink.token}/catalog`)
    assert.equal(publicCatalog.categories.some(category =>
      (category.products || []).some(candidate => candidate.id === product.id)), true)

    const beforeCustomerRequest = Number(detail.total)
    const customerCreatedEvent = waitForEvent(waiterSocket, 'customer-order-request:created')
    const customerRequest = await request(`/public/tables/${publicLink.token}/customer-order-requests`, {
      method: 'POST', body: JSON.stringify({
        customerName: 'Cliente QR',
        items: [{ productId: product.id, quantity: 2, notes: '  desde QR  ' }]
      })
    })
    assert.equal(customerRequest.status, 'pending')
    assert.equal(customerRequest.items[0].notes, 'desde QR')
    assert.equal((await customerCreatedEvent).requestId, customerRequest.id)
    detail = await request(`/orders/${order.id}`)
    assert.equal(Number(detail.total), beforeCustomerRequest, 'pending request must not modify the POS order')
    const pendingCustomerRequests = await request('/customer-order-requests?status=pending', { headers })
    assert.equal(pendingCustomerRequests.some(candidate => candidate.id === customerRequest.id), true)

    const customerUpdatedEvent = waitForEvent(waiterSocket, 'customer-order-request:updated', payload => payload.requestId === customerRequest.id)
    const acceptedRequest = await request(`/customer-order-requests/${customerRequest.id}/accept`, { method: 'POST', headers })
    assert.equal(acceptedRequest.request.status, 'accepted')
    assert.equal(acceptedRequest.order.status, 'open')
    assert.equal((await customerUpdatedEvent).status, 'accepted')
    assert.equal(acceptedRequest.order.items.some(item => item.notes === 'desde QR' && item.quantity === 2), true)
    await expectStatus(`/customer-order-requests/${customerRequest.id}/accept`, 409, { method: 'POST', headers })

    const rejectedRequest = await request(`/public/tables/${publicLink.token}/customer-order-requests`, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] })
    })
    const rejected = await request(`/customer-order-requests/${rejectedRequest.id}/reject`, {
      method: 'POST', headers, body: JSON.stringify({ reason: 'Producto demorado' })
    })
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.rejectionReason, 'Producto demorado')

    const regeneratedLink = await request(`/tables/${table.id}/public-link/regenerate`, { method: 'POST', headers: adminHeaders })
    assert.notEqual(regeneratedLink.token, publicLink.token)
    await expectStatus(`/public/tables/${publicLink.token}`, 404)
    const acceptedQrItem = acceptedRequest.order.items.find(item => item.notes === 'desde QR')
    await request(`/orders/${order.id}/items/${acceptedQrItem.id}`, { method: 'DELETE', headers })
    detail = await request(`/orders/${order.id}`)
    assert.equal(detail.items[0].product.name, product.name)
    assert.equal(detail.items[0].quantity, 5)
    assert.equal(Number(detail.items[0].unitPrice), Number(product.price))
    assert.equal(Number(detail.items[0].subtotal), Number(product.price) * 5)
    assert.equal(Number(detail.total), Number(product.price) * 5)

    await request(`/orders/${order.id}/items/${firstAdd.item.id}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ quantity: 4 })
    })
    detail = await request(`/orders/${order.id}`)
    assert.equal(detail.items[0].quantity, 4)
    assert.equal(Number(detail.total), Number(product.price) * 4)

    const tables = await request('/tables')
    const occupiedTable = tables.find(candidate => candidate.id === table.id)
    assert.equal(occupiedTable.orderId, order.id)
    assert.equal(Number(occupiedTable.total), Number(product.price) * 4)

    await request(`/orders/${order.id}/items/${firstAdd.item.id}`, {
      method: 'DELETE', headers
    })
    detail = await request(`/orders/${order.id}`)
    assert.deepEqual(detail.items, [])
    assert.equal(Number(detail.total), 0)

    const itemEventPromise = waitForEvent(waiterSocket, 'order:item-added', payload => payload.orderId === order.id)
    const notedItem = await request(`/orders/${order.id}/items`, {
      method: 'POST', headers,
      body: JSON.stringify({ productId: product.id, quantity: 1, notes: '  sin cebolla  ' })
    })
    const itemEvent = await itemEventPromise
    assert.equal(itemEvent.item.notes, 'sin cebolla')

    const sameNotes = await request(`/orders/${order.id}/items`, {
      method: 'POST', headers,
      body: JSON.stringify({ productId: product.id, quantity: 2, notes: 'sin cebolla' })
    })
    assert.equal(sameNotes.item.id, notedItem.item.id)
    assert.equal(sameNotes.item.quantity, 3)

    const differentNotes = await request(`/orders/${order.id}/items`, {
      method: 'POST', headers,
      body: JSON.stringify({ productId: product.id, quantity: 1, notes: 'extra salsa' })
    })
    assert.notEqual(differentNotes.item.id, notedItem.item.id)
    detail = await request(`/orders/${order.id}`)
    assert.equal(detail.items.length, 2)
    const expectedRevenue = Number(detail.total)

    const assertOccupied = async expectedStatus => {
      const currentTables = await request('/tables')
      const currentTable = currentTables.find(candidate => candidate.id === table.id)
      assert.equal(currentTable.status, 'occupied')
      assert.equal(currentTable.orderId, order.id)
      assert.equal(currentTable.orderStatus, expectedStatus)
      assert.equal(currentTable.tableSession.id, openedSession.id)
      const stats = await request('/stats', { headers })
      assert.equal(stats.occupiedTables, 1)
      assert.equal(stats.freeTables, stats.totalTables - 1)
    }

    const confirmedEventPromise = waitForEvent(kitchenSocket, 'order:status-changed', payload =>
      payload.orderId === order.id && payload.status === 'confirmed'
    )
    let transitioned = await request(`/orders/${order.id}/status`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ status: 'CONFIRMED' })
    })
    assert.equal(transitioned.status, 'confirmed')
    const confirmedEvent = await confirmedEventPromise
    assert.equal(confirmedEvent.tableSessionId, openedSession.id)
    await assertOccupied('confirmed')

    await expectStatus(`/orders/${order.id}/status`, 403, {
      method: 'PATCH', headers,
      body: JSON.stringify({ status: 'preparing' })
    })

    transitioned = await request(`/orders/${order.id}/status`, {
      method: 'PATCH', headers: roleHeaders('kitchen'),
      body: JSON.stringify({ status: 'preparing' })
    })
    assert.equal(transitioned.status, 'preparing')
    await assertOccupied('preparing')

    const readyEventPromise = waitForEvent(waiterSocket, 'order:status-changed', payload =>
      payload.orderId === order.id && payload.status === 'ready'
    )
    transitioned = await request(`/orders/${order.id}/status`, {
      method: 'PATCH', headers: roleHeaders('kitchen'),
      body: JSON.stringify({ status: 'ready' })
    })
    assert.equal(transitioned.status, 'ready')
    await readyEventPromise
    await assertOccupied('ready')
    transitioned = await request(`/orders/${order.id}/status`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ status: 'delivered' })
    })
    assert.equal(transitioned.status, 'delivered')
    const cashPayment = await request(`/orders/${order.id}/payments`, {
      method: 'POST',
      headers: { ...roleHeaders('cashier'), 'Idempotency-Key': 'cash-main-order' },
      body: JSON.stringify({
        method: 'cash', amount: expectedRevenue, tipAmount: 100,
        receivedAmount: expectedRevenue + 500, notes: 'Pago de prueba'
      })
    })
    assert.equal(cashPayment.order.status, 'paid')
    assert.equal(cashPayment.changeAmount, 400)
    assert.equal(cashPayment.totalDue, expectedRevenue + 100)
    const idempotentPayment = await request(`/orders/${order.id}/payments`, {
      method: 'POST',
      headers: { ...roleHeaders('cashier'), 'Idempotency-Key': 'cash-main-order' },
      body: JSON.stringify({ method: 'cash', receivedAmount: expectedRevenue + 500, tipAmount: 100 })
    })
    assert.equal(idempotentPayment.id, cashPayment.id)
    await expectStatus(`/orders/${order.id}/payments`, 409, {
      method: 'POST', headers: roleHeaders('cashier'),
      body: JSON.stringify({ method: 'cash', receivedAmount: expectedRevenue + 100, tipAmount: 100 })
    })
    const receipt = await request(`/payments/${cashPayment.id}/receipt`, { headers })
    assert.equal(receipt.orderId, order.id)

    const closedSession = await request(`/table-sessions/${openedSession.id}/close`, {
      method: 'POST', headers: roleHeaders('cashier')
    })
    assert.equal(closedSession.status, 'closed')
    assert.equal(closedSession.orders[0].status, 'closed')

    const createDeliveredOrder = async tableNumber => {
      const paymentTable = await request('/tables', {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ number: tableNumber, capacity: 2 })
      })
      const paymentOrder = await request('/orders', {
        method: 'POST', headers, body: JSON.stringify({ tableId: paymentTable.id })
      })
      await request(`/orders/${paymentOrder.id}/items`, {
        method: 'POST', headers, body: JSON.stringify({ productId: product.id, quantity: 1 })
      })
      await request(`/orders/${paymentOrder.id}/status`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'confirmed' }) })
      await request(`/orders/${paymentOrder.id}/status`, { method: 'PATCH', headers: roleHeaders('kitchen'), body: JSON.stringify({ status: 'preparing' }) })
      await request(`/orders/${paymentOrder.id}/status`, { method: 'PATCH', headers: roleHeaders('kitchen'), body: JSON.stringify({ status: 'ready' }) })
      return request(`/orders/${paymentOrder.id}/status`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'delivered' }) })
    }

    const cardOrder = await createDeliveredOrder(9901)
    const cardPayment = await request(`/orders/${cardOrder.id}/payments`, {
      method: 'POST', headers: roleHeaders('cashier'),
      body: JSON.stringify({ method: 'card', amount: Number(cardOrder.total) })
    })
    assert.equal(cardPayment.method, 'card')
    await request(`/orders/${cardOrder.id}/close`, { method: 'POST', headers: roleHeaders('cashier') })

    const mixedOrder = await createDeliveredOrder(9902)
    const mixedDue = Number(mixedOrder.total) + 50
    const mixedPayment = await request(`/orders/${mixedOrder.id}/payments`, {
      method: 'POST', headers: roleHeaders('cashier'),
      body: JSON.stringify({
        method: 'mixed', amount: Number(mixedOrder.total), tipAmount: 50,
        breakdown: [
          { method: 'cash', amount: 1000 },
          { method: 'card', amount: mixedDue - 1000 }
        ]
      })
    })
    assert.equal(mixedPayment.method, 'mixed')
    assert.equal(mixedPayment.breakdown.length, 2)
    await request(`/orders/${mixedOrder.id}/close`, { method: 'POST', headers: roleHeaders('cashier') })

    const tablesAfterClose = await request('/tables')
    const freeTable = tablesAfterClose.find(candidate => candidate.id === table.id)
    assert.equal(freeTable.status, 'free')
    assert.equal(freeTable.tableSession, null)
    const statsAfterClose = await request('/stats', { headers })
    assert.equal(statsAfterClose.occupiedTables, 0)
    assert.equal(statsAfterClose.freeTables, statsAfterClose.totalTables)
    assert.equal(Number(statsAfterClose.todaySales), expectedRevenue + Number(cardOrder.total) + Number(mixedOrder.total))
    assert.equal(statsAfterClose.paymentsByMethod.cash.count, 1)
    assert.equal(statsAfterClose.paymentsByMethod.card.count, 1)
    assert.equal(statsAfterClose.paymentsByMethod.mixed.count, 1)
    assert.equal(statsAfterClose.paymentsByMethod.cash.tips, 100)

    await request(`/tables/${draftTable.id}`, { method: 'DELETE', headers: adminHeaders })
    const allTablesAdmin = await request('/tables/all', { headers: adminHeaders })
    assert.equal(allTablesAdmin.find(candidate => candidate.id === draftTable.id).active, false)

    console.log('Order flow integration test passed')
  } finally {
    sockets.forEach(socket => socket.disconnect())
    if (server) server.kill()
    if (testDb) await testDb.end()
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await admin.end()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
