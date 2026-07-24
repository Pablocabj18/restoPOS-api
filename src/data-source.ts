import "reflect-metadata"
import { DataSource } from "typeorm"
import { User } from "./entities/User"
import { Restaurant } from "./entities/Restaurant"
import { Category } from "./entities/Category"
import { Product } from "./entities/Product"
import { Table } from "./entities/Table"
import { Order, OrderStatus } from "./entities/Order"
import { OrderItem } from "./entities/OrderItem"
import { TableSession } from "./entities/TableSession"
import { TableSessionsAndOrderWorkflow1784085000000 } from "./migrations/1784085000000-TableSessionsAndOrderWorkflow"
import { RepairOrderItemForeignKeyIndex1784086000000 } from "./migrations/1784086000000-RepairOrderItemForeignKeyIndex"
import { OrderItemNotes1784087000000 } from "./migrations/1784087000000-OrderItemNotes"
import { AuthChallenge } from "./entities/AuthChallenge"
import { OfficialAuthentication1784340000000 } from "./migrations/1784340000000-OfficialAuthentication"
import { Reservation } from "./entities/Reservation"
import { MenuAndReservations1784600000000 } from "./migrations/1784600000000-MenuAndReservations"
import { Payment } from "./entities/Payment"
import { PaymentsAndTableAdministration1784700000000 } from "./migrations/1784700000000-PaymentsAndTableAdministration"
import { CustomerOrderRequest, CustomerOrderRequestItem } from "./entities/CustomerOrderRequest"
import { PublicQrAndCustomerOrderRequests1784800000000 } from "./migrations/1784800000000-PublicQrAndCustomerOrderRequests"
import 'dotenv/config'

export const AppDataSource = new DataSource({
  type: "mysql",
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306"),
  username: process.env.DB_USERNAME || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_DATABASE || "resto_db",
  synchronize: process.env.NODE_ENV === 'production' ? false : process.env.DB_SYNCHRONIZE !== 'false',
  logging: false,
  entities: [User, Restaurant, AuthChallenge, Reservation, Payment, CustomerOrderRequest, CustomerOrderRequestItem, Category, Product, Table, TableSession, Order, OrderItem],
  migrations: [
    TableSessionsAndOrderWorkflow1784085000000,
    RepairOrderItemForeignKeyIndex1784086000000,
    OrderItemNotes1784087000000,
    OfficialAuthentication1784340000000,
    MenuAndReservations1784600000000,
    PaymentsAndTableAdministration1784700000000,
    PublicQrAndCustomerOrderRequests1784800000000
  ],
  // extra: {
  //   allowPublicKeyRetrieval: true,
  // },
})

// Seed data function
export async function seedData() {
  const categoryRepo = AppDataSource.getRepository(Category)
  const productRepo = AppDataSource.getRepository(Product)
  const tableRepo = AppDataSource.getRepository(Table)

  // Check if already seeded
  const existingCategories = await categoryRepo.count()
  if (existingCategories > 0) {
    console.log("Data already seeded")
    return
  }

  console.log("Seeding initial data...")

  // Create categories
  const categories = await categoryRepo.save([
    { name: "Entradas", icon: "utensils", description: "Para abrir el apetito" },
    { name: "Carnes", icon: "beef", description: "Las mejores carnes" },
    { name: "Pastas", icon: "wheat", description: "Caseras y frescas" },
    { name: "Pizzas", icon: "circle-dot", description: "Horneadas en horno de leña" },
    { name: "Bebidas", icon: "glass-water", description: "Refrescantes opciones" },
    { name: "Bebidas Alcoholicas", icon: "wine", description: "Vinos, cocktails y mas" },
    { name: "Postres", icon: "cake", description: "Dulces tentaciones" },
    { name: "Cafes", icon: "coffee", description: "El mejor cafe" },
  ])

  // Create products
  await productRepo.save([
    // Entradas
    { name: "Bruschetas Mixtas", price: 4500, category: categories[0], description: "Tomate, albahaca y ajo sobre pan tostado" },
    { name: "Carpaccio de Res", price: 6800, category: categories[0], description: "Finas laminas con rucula y parmesano" },
    { name: "Provoleta", price: 5200, category: categories[0], description: "Queso fundido con chimichurri" },
    { name: "Empanadas (6u)", price: 4800, category: categories[0], description: "Carne, pollo o jamon y queso" },

    // Carnes
    { name: "Bife de Chorizo 400g", price: 12500, category: categories[1], description: "A la parilla con chimichurri" },
    { name: "Ojo de Bife 500g", price: 14500, category: categories[1], description: "El corte premium" },
    { name: "Entraña 350g", price: 13200, category: categories[1], description: "Suculenta y tierna" },
    { name: "Filet Mignon 380g", price: 15800, category: categories[1], description: "La pieza mas tierna" },
    { name: "Costillas de Cerdo", price: 9800, category: categories[1], description: "BBQ casero" },
    { name: "Pollo a la Parrilla", price: 8500, category: categories[1], description: "Suprema con hierbas" },

    // Pastas
    { name: "Spaghetti a la Boloñesa", price: 7200, category: categories[2], description: "Salsa de carne casera" },
    { name: "Fetuccini Alfredo", price: 7800, category: categories[2], description: "Crema de queso y disco de mantequilla" },
    { name: "Ravioles de Ricota", price: 8200, category: categories[2], description: "Rellenos a mano" },
    { name: "Lasagna Clasica", price: 8500, category: categories[2], description: "Capas de carne, salsa y queso" },
    { name: "Gnocchi a la Romana", price: 6800, category: categories[2], description: "Con salsa rosa" },

    // Pizzas
    { name: "Margherita", price: 6200, category: categories[3], description: "Tomate, mozzarella y albahaca" },
    { name: "Quattro Formaggi", price: 7500, category: categories[3], description: "4 quesos Italiano" },
    { name: "Napolitana", price: 6800, category: categories[3], description: "Con anchoas y aceitunas" },
    { name: "Calzone", price: 7200, category: categories[3], description: "Rellena de jamon y queso" },
    { name: "Diavola", price: 7000, category: categories[3], description: "Picante con salamín" },

    // Bebidas
    { name: "Gaseosa 500ml", price: 1800, category: categories[4], description: "Coca, Sprite o Fanta" },
    { name: "Jugo Natural 300ml", price: 2200, category: categories[4], description: "Naranja, limon o pomelo" },
    { name: "Agua Mineral 500ml", price: 1500, category: categories[4], description: "Con o sin gas" },
    { name: "Limonada Casera", price: 2800, category: categories[4], description: "Recién hecha" },
    { name: "Batido de Frutilla", price: 3200, category: categories[4], description: "Con leche y hielo" },

    // Bebidas Alcoholicas
    { name: "Cerveza Artesanal 500ml", price: 4500, category: categories[5], description: "Rubia, roja o negra" },
    { name: "Copa de Vino Tinto", price: 3800, category: categories[5], description: "Malbec mendocino" },
    { name: "Copa de Vino Blanco", price: 3800, category: categories[5], description: "Chardonnay chilled" },
    { name: "Fernet con Coca", price: 4200, category: categories[5], description: "El trago Argentino" },
    { name: "Gin Tonic", price: 5500, category: categories[5], description: "Con limón y Hierbabuena" },
    { name: "Whisky on the Rocks", price: 6500, category: categories[5], description: "Johnnie Walker" },
    { name: "Aperol Spritz", price: 4800, category: categories[5], description: "Refrescante y Italiano" },

    // Postres
    { name: "Flan Casero", price: 2800, category: categories[6], description: "Con dulce de leche" },
    { name: "Helado Artesanal", price: 3500, category: categories[6], description: "2 bolas a elección" },
    { name: "Tiramisú", price: 4200, category: categories[6], description: "Receta Italiana autentica" },
    { name: "Brownie con Helado", price: 4800, category: categories[6], description: "Tibia con bola de vainilla" },
    { name: "Queso y Dulce", price: 3200, category: categories[6], description: "Reggianito con dulce de leche" },

    // Cafes
    { name: "Café Expresso", price: 1800, category: categories[7], description: "Simple y fuerte" },
    { name: "Cappuccino", price: 2500, category: categories[7], description: "Con espuma de leche" },
    { name: "Latte", price: 2700, category: categories[7], description: "Café con leche" },
    { name: "Café Irlandés", price: 4200, category: categories[7], description: "Con whisky y crema" },
    { name: "Chocolate Caliente", price: 2800, category: categories[7], description: "Espeso y amargo" },
  ])

  // Create tables (10 by default)
  const tables = []
  for (let i = 1; i <= 10; i++) {
    tables.push({
      number: i,
      capacity: i <= 4 ? 4 : i <= 7 ? 6 : 8,
      status: 'free'
    })
  }
  await tableRepo.save(tables as any)

  console.log("Seed completed! 🎉")
}
