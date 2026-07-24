# RESTO POS API contract

All authenticated endpoints accept `Authorization: Bearer <jwt>`. Roles use the
lowercase wire values `admin`, `cashier`, `waiter`, and `kitchen`.

## Authentication

### Bootstrap

- `GET /auth/bootstrap/status` returns
  `{ "configured": boolean, "bootstrapAllowed": boolean }`.
- `POST /auth/bootstrap` is available only when both restaurant and user counts
  are zero. Request:
  `{ "restaurantName": string, "username": string, "email"?: string, "password": string, "name": string, "lastName"?: string }`.
  It atomically creates the restaurant and its first ACTIVE ADMIN, returning
  `{ token, user, restaurant }`. A second attempt returns `409`.
- `POST /auth/register` is a temporary bootstrap alias. After configuration it
  always returns `403`; it never registers employees publicly.

Usernames are lowercase and accept 3–80 characters: letters, numbers, `.`, `_`,
and `-`. Passwords must contain 10–128 characters, uppercase, lowercase, and a
number. Password hashes use bcrypt and are never returned.

### Two-step login

`POST /auth/identify` request: `{ "identifier": "username-or-email" }`.
Successful response:

```json
{
  "challenge": "single-use-opaque-token",
  "expiresInSeconds": 300,
  "displayName": "Ana Pérez",
  "restaurantName": "Mi Restaurante",
  "requiresPasswordSetup": false
}
```

Challenges are stored only as SHA-256 hashes, expire after five minutes, are
single-use, and allow at most five password attempts. Identify is limited to ten
requests per IP+identifier per minute. Missing and disabled users receive the
same generic `401` response.

`POST /auth/login` request:
`{ "challenge": string, "password": string }`. It accepts only ACTIVE users
without pending password setup and returns `{ token, user }`. Temporarily,
`{ "email": string, "password": string }` remains accepted for the existing
frontend; successful legacy plaintext credentials are immediately upgraded to bcrypt.

### Initial password and reset

`POST /auth/set-initial-password` request:
`{ "challenge": string, "password": string, "confirmPassword": string }`.
It accepts PASSWORD_SETUP challenges for `pending_activation` or
`password_reset_required`, activates the user, invalidates the challenge, and
returns `{ token, user }`.

`POST /users/:id/password-reset` requires ADMIN. It changes status to
`password_reset_required`, sets `mustSetPassword=true`, increments
`tokenVersion`, and invalidates all unused challenges. Existing HTTP and
Socket.IO JWTs stop working immediately.

### `GET /auth/me`

Returns the safe flat user and restaurant. Password fields are never selected:

```json
{ "id": 1, "username": "ana", "email": null, "name": "Ana", "role": "waiter", "status": "active", "mustSetPassword": false, "restaurant": {} }
```

### Employee administration

All `/users` endpoints require ADMIN and are scoped to the caller's
restaurant/company.

- `GET /users` lists safe user records.
- `POST /users` accepts `{ username, email?, name, lastName?, role, branchId? }`.
  It creates `pending_activation`, `mustSetPassword=true`, with no password.
- `PUT /users/:id` accepts username, email, name, lastName, role, or status.
- `DELETE /users/:id` performs a logical disable and invalidates auth; it does
  not remove restaurant activity.
- `POST /users/:id/password-reset` starts the reset flow described above.

Roles are `admin`, `waiter`, `kitchen`, and `cashier`. Statuses are
`pending_activation`, `active`, `disabled`, and `password_reset_required`.

## Menu administration

Public/POS-compatible reads remain unchanged:

- `GET /categories` returns active categories, ordered by `sortOrder`, then name.
- `GET /products` returns available products with category, ordered by
  `sortOrder`, then name.

ADMIN reads include active and inactive records:

- `GET /categories/all` and alias `GET /admin/categories`.
- `GET /products/all` and alias `GET /admin/products`.

ADMIN mutations:

- `POST /categories` — `{ name, description?, icon?, active?, sortOrder? }`.
- `PUT /categories/:id` — partial update of the same fields.
- `DELETE /categories/:id` — soft-delete (`active=false`).
- `POST /products` — `{ name, description?, price, image?, available?, sortOrder?, categoryId }`.
- `PUT /products/:id` — partial update of the same fields.
- `DELETE /products/:id` — soft-delete (`available=false`).

Prices must be finite and greater than zero. Category names are unique
case-insensitively; product names are unique inside their category. Mutations
from non-ADMIN roles return `403`.

## Reservations

All reservation endpoints require ADMIN or WAITER and are scoped by the JWT's
`companyId`, or otherwise `restaurantId`.

Reservation shape:

```json
{
  "id": 12,
  "customerName": "Ana Pérez",
  "phone": "+5491112345678",
  "startsAt": "2030-01-15T20:00:00.000Z",
  "durationMinutes": 120,
  "partySize": 4,
  "tableId": 3,
  "tableSessionId": null,
  "notes": "cerca de la ventana",
  "status": "confirmed",
  "createdByUserId": 1,
  "source": "manual",
  "externalReference": null,
  "whatsappOptIn": true,
  "createdAt": "...",
  "updatedAt": "...",
  "table": {},
  "tableSession": null
}
```

`startsAt` is an ISO-8601 instant stored as UTC. `durationMinutes` defaults to
120 and accepts 15–1440. Notes are trimmed and limited to 1000 characters.
`source`, `externalReference`, and `whatsappOptIn` are stable integration fields;
the backend does not send WhatsApp messages yet.

- `GET /reservations?date=YYYY-MM-DD&status=<status>` lists a UTC calendar day.
  `from=<ISO>&to=<ISO>` is also supported.
- `POST /reservations` creates PENDING by default; CONFIRMED may be requested.
- `PUT /reservations/:id` and `PATCH /reservations/:id` partially update details.
- `PATCH /reservations/:id/status` accepts `{ "status": string }`.
- `GET /reservations/:id/eligible-tables` returns active tables with enough
  capacity and no overlap. PUT/PATCH may assign or change `tableId` until SEATED.

Statuses and transitions:

| From | To |
|---|---|
| PENDING | CONFIRMED, CANCELLED, NO_SHOW |
| CONFIRMED | SEATED, CANCELLED, NO_SHOW |
| SEATED/CANCELLED/NO_SHOW | terminal |

Active reservations (`pending`, `confirmed`, `seated`) cannot overlap on the
same table. Transitioning to SEATED requires `tableId`, opens or reuses the
table's current `TableSession`, stores `tableSessionId`, and marks the table
occupied.

Realtime events are emitted after persistence to tenant-scoped ADMIN and WAITER
rooms:

- `reservation:created` — `{ reservationId, tableId, tableSessionId, status, reservation }`.
- `reservation:updated` — same payload for detail or status changes.

## Carta pública QR y solicitudes de clientes

Cada mesa activa tiene un token público aleatorio de 64 caracteres. El token es
estable hasta que un ADMIN lo regenera y nunca se incluye en `GET /tables`.

Administración del enlace (JWT ADMIN):

- `GET /tables/:id/public-link` crea el token si falta y devuelve
  `{ tableId, tableNumber, token, path, url, qrData }`.
- `POST /tables/:id/public-link/regenerate` invalida inmediatamente el enlace
  anterior y devuelve el mismo formato con un token nuevo.
- `PUBLIC_MENU_BASE_URL` define el origen usado para `url`; `qrData` contiene la
  URL que el frontend puede convertir en código QR.

Endpoints públicos, sin JWT:

- `GET /public/tables/:token` devuelve
  `{ id, number, capacity, occupied, canRequest, tableSessionId, orderId }`.
- `GET /public/tables/:token/catalog` devuelve
  `{ table, categories }`; sólo incluye categorías activas y productos disponibles,
  ordenados por `sortOrder` y nombre.
- `POST /public/tables/:token/customer-order-requests` acepta:

```json
{
  "customerName": "opcional",
  "items": [
    { "productId": 7, "quantity": 2, "notes": "sin hielo" }
  ]
}
```

La mesa debe tener una sesión OPEN y una orden OPEN. Se validan token, mesa,
disponibilidad, cantidades (1-99), notas (500 caracteres) y precios. Productos
repetidos con las mismas notas se consolidan. La respuesta `201` es una solicitud
`pending` con líneas que conservan nombre, precio unitario y subtotal. Esta acción
no modifica la orden POS ni envía nada a cocina. Hay un límite básico de diez
creaciones por IP por minuto.

Gestión de solicitudes (JWT ADMIN o WAITER):

- `GET /customer-order-requests?status=pending|accepted|rejected`; por defecto pending.
- `GET /customer-order-requests/:id`.
- `POST /customer-order-requests/:id/accept`: transaccional; revalida que la sesión,
  orden, productos y precios sigan vigentes, incorpora/acumula las líneas en la
  orden OPEN y recalcula el total. Devuelve `{ request, order }`. La orden permanece
  OPEN y el mozo debe ejecutar la transición normal a CONFIRMED para enviarla a cocina.
- `POST /customer-order-requests/:id/reject` con `{ "reason": "..." }` obligatorio
  de hasta 300 caracteres. Devuelve la solicitud rechazada.

Aceptar o rechazar una solicitud ya resuelta devuelve `409`. Eventos Socket.IO para
ADMIN/WAITER: `customer-order-request:created` y
`customer-order-request:updated`, con
`{ requestId, tableId, tableSessionId, orderId, status, request }`. Al aceptar
también se emiten `order:item-added` y `table:updated`; cocina no recibe una orden
CONFIRMED hasta la confirmación explícita del mozo.

## Table sessions

A table session covers occupancy from opening until final close. Only one open
session can exist per table; concurrent open requests return that same session.

Session shape:

```json
{
  "id": 10,
  "tableId": 3,
  "status": "open",
  "openedByUserId": 1,
  "closedByUserId": null,
  "openedAt": "2026-07-14T20:00:00.000Z",
  "closedAt": null,
  "table": {},
  "orders": []
}
```

- `GET /table-sessions?tableId=<id>&status=open|closed`: authenticated history/list.
- `GET /tables/:tableId/session`: current open session or JSON `null`.
- `POST /tables/:tableId/sessions/open`: ADMIN or WAITER; idempotently opens/returns the current session.
- `POST /table-sessions/:id/close`: ADMIN or CASHIER. Returns `409` with
  `orderIds` if an order is not PAID, CLOSED, or CANCELLED. PAID orders become
  CLOSED and the table becomes free.

`POST /orders` also opens the session implicitly, preserving the existing UI flow.

## Tables

`GET /tables` preserves all legacy fields and adds:

```json
{
  "id": 3,
  "number": 3,
  "status": "occupied",
  "total": 12500,
  "orderId": 20,
  "orderStatus": "preparing",
  "tableSessionId": 10,
  "tableSession": { "id": 10, "status": "open" }
}
```

For a free table, IDs/statuses and `tableSession` are `null`, and `total` is `0`.

ADMIN table management:

- `GET /tables/all` and `GET /admin/tables` include active/inactive tables.
- `POST /tables` accepts `{ number, capacity? }`.
- `PUT|PATCH /tables/:id` accepts `{ number?, capacity?, active? }`.
- `DELETE /tables/:id` performs soft-disable (`active=false`).

Number and capacity must be positive integers; capacity is capped at 100. Active
table numbers cannot duplicate. Disabling a table with an OPEN session returns
`409`. The POS `GET /tables` returns active tables only.

## Orders

### `POST /orders`

Request: `{ "tableId": number }`. It reuses an existing open session/order when
present; otherwise it creates or returns an OPEN draft order. For a free table,
this draft has `tableSessionId: null` and does not occupy the table;
the session starts when the first item is persisted. The response includes
`table`, `tableSession`, `status`, and `items`.

### `GET /orders/:id` and `GET /orders`

Each order includes:

```json
{
  "id": 20,
  "tableId": 3,
  "tableSessionId": 10,
  "status": "open",
  "total": "12500.00",
  "table": {},
  "tableSession": { "id": 10, "status": "open" },
  "items": [{
    "id": 45,
    "productId": 7,
    "product": { "id": 7, "name": "Producto" },
    "quantity": 1,
    "unitPrice": "12500.00",
    "subtotal": "12500.00",
    "notes": "sin cebolla"
  }]
}
```

MySQL decimal values can be serialized as strings. Clients should parse them as numbers.

### Items

- `POST /orders/:orderId/items` — `{ "productId": number, "quantity": positive integer, "notes"?: string|null }`.
  Notes are trimmed, control characters are replaced by spaces, empty text becomes
  `null`, and the maximum is 500 characters. Repeated products accumulate on the
  same persisted item ID only when their normalized notes also match.
- `PUT /orders/:orderId/items/:itemId` — `{ "quantity"?: integer, "notes"?: string|null }`;
  it supports notes-only edits, and a zero or negative quantity removes it.
- `DELETE /orders/:orderId/items/:itemId` — removes the persisted item.

All three recalculate `order.total`; PUT/DELETE verify that `itemId` belongs to
the order. Items can be changed only while the order is OPEN. Removing the last
item closes/releases the session and leaves the OPEN order as a reusable draft,
unless the session is held by a SEATED reservation.

### `PATCH /orders/:id/status`

`PUT` is accepted as an alias. Request: `{ "status": string }`; uppercase or
lowercase is accepted. The response is the enriched order.

Valid workflow and roles:

| From | To | Roles |
|---|---|---|
| OPEN | CONFIRMED | ADMIN, WAITER |
| OPEN | CANCELLED | ADMIN, WAITER |
| CONFIRMED | PREPARING | ADMIN, KITCHEN |
| CONFIRMED | CANCELLED | ADMIN, WAITER |
| PREPARING | READY | ADMIN, KITCHEN |
| READY | DELIVERED | ADMIN, WAITER |
| DELIVERED | PAID | ADMIN, CASHIER |
| PAID | CLOSED | ADMIN, CASHIER |

Invalid transitions return `409` with `allowedStatuses`; insufficient roles
return `403`.

### Legacy `POST /orders/:id/close`

Kept for the current frontend. It directly sets CLOSED, frees the table, and
closes the linked table session. Response:
`{ "success": true, "total": number|string, "status": "closed", "tableSessionId": number|null }`.

## Payments

`POST /orders/:id/payments` requires ADMIN or CASHIER and accepts only DELIVERED
orders. `amount`, when supplied, must equal `order.total`; `tipAmount` defaults
to zero and `totalDue = amount + tipAmount`.

```json
{
  "method": "cash",
  "amount": 12500,
  "receivedAmount": 15000,
  "tipAmount": 500,
  "notes": "opcional",
  "idempotencyKey": "optional-client-key"
}
```

`Idempotency-Key` is also accepted as a header. For cash, received defaults to
total due and change is calculated. Card/transfer require no received amount.
Mixed requires at least two positive cash/card/transfer components whose sum is
exactly `order.total + tipAmount`; mixed change is zero.

Only one payment can exist per order. Reusing the same idempotency key returns
the original receipt; another payment attempt returns `409`. Success moves the
order to PAID; subsequent close preserves payment history.

- `GET /orders/:id/payment`
- `GET /payments/:id/receipt`

Receipts include method, amount, tip, total due, received/change, breakdown,
notes, cashier, timestamps and enriched order. `/stats` adds
`paymentsByMethod.cash|card|transfer|mixed` with `count`, `total`, and `tips`.

## Schema rollout

Development defaults to TypeORM synchronization. For a controlled existing
database, set `DB_SYNCHRONIZE=false` and run migration
`TableSessionsAndOrderWorkflow1784085000000`. It makes `user.companyId`
nullable for legacy registrations, expands the order enum, creates
`table_session`, links active legacy orders to generated sessions, and adds the
database-level one-open-session-per-table constraint. `OrderItemNotes1784087000000`
adds the nullable `order_item.notes` column without rewriting existing items.
`OfficialAuthentication1784340000000` adds usernames, lifecycle status,
`mustSetPassword`, creator/token-version metadata and hashed, expiring auth
challenges. Existing usernames are deterministically derived from email plus ID;
a sole legacy user is linked to the sole restaurant and becomes ADMIN only when
the installation otherwise has no administrator.
`MenuAndReservations1784600000` adds `sortOrder` to menu tables and creates the
tenant-scoped reservation table, indexes, table/session links and future channel
metadata.
`PaymentsAndTableAdministration1784700000000` creates immutable payments,
order/idempotency uniqueness, receipt data and the table `active` flag.
`PublicQrAndCustomerOrderRequests1784800000000` adds secure table public tokens
and the pending/accepted/rejected customer request tables with immutable item
price snapshots.

Production deployment is documented in `docs/deploy.md`. Production requires
`JWT_SECRET`, forcibly disables schema synchronization, and uses the
comma-separated `CORS_ORIGINS` allowlist for HTTP and Socket.IO. Authentication
has general IP throttling plus stricter identify throttling. `/health` exposes
only status and timestamp.

## Realtime contract (Socket.IO)

Connect to the same origin and port as HTTP. The JWT must be sent in the
Socket.IO handshake; query-string tokens are not accepted:

```js
io(API_URL, {
  auth: {
    token: jwt,
    tableId: 3,
    tableSessionId: 10
  }
})
```

`tableId` and `tableSessionId` are optional subscriptions. Invalid or expired
tokens fail with `connect_error`. Each connection joins `role:admin`,
`role:waiter`, `role:kitchen`, or `role:cashier`. If the token contains
`companyId` or `restaurantId`, delivery uses tenant-scoped rooms to prevent
events from crossing restaurants.

Events are emitted only after persistence succeeds:

| Event | Trigger | Recipients |
|---|---|---|
| `order:created` | New order | ADMIN, WAITER |
| `order:item-added` | Item inserted or accumulated | ADMIN, WAITER, KITCHEN |
| `order:item-updated` | Quantity or notes changed | ADMIN, WAITER, KITCHEN |
| `order:item-removed` | DELETE or PUT quantity <= 0 | ADMIN, WAITER, KITCHEN |
| `order:status-changed` | Workflow transition or legacy close | All operational roles |
| `table:updated` | Table/session/order state changes | ADMIN, WAITER, CASHIER |

Order event payload:

```json
{
  "orderId": 20,
  "tableId": 3,
  "tableSessionId": 10,
  "status": "ready",
  "order": {},
  "item": {},
  "previousStatus": "preparing"
}
```

`item` appears on item events and `previousStatus` on status events. CONFIRMED
is delivered to KITCHEN; READY is delivered to WAITER and ADMIN.

## Occupancy and stats

A table remains occupied while its session is OPEN, including orders in OPEN,
CONFIRMED, PREPARING, READY, DELIVERED, or PAID. It becomes free when the
session closes. `GET /stats` includes `totalTables`, `occupiedTables`, and
`freeTables`. Occupancy is calculated exclusively from open sessions. Legacy
orders without `tableSessionId` remain historical data and do not occupy a table.
Daily sales use every CLOSED order whose `closedAt` falls anywhere inside the
server's local calendar day, rather than comparing against midnight exactly.
