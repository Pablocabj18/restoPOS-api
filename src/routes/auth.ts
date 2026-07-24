import { Router, Request, Response } from 'express'
import * as bcrypt from 'bcryptjs'
import { AppDataSource, seedCompanyData } from '../data-source'
import { Company } from '../entities/Company'
import { Branch } from '../entities/Branch'
import { User, UserRole } from '../entities/User'
import { authenticate, AuthRequest, signToken } from '../middleware/auth'

const router = Router()

// Helper to generate URL-safe slug from name
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

// POST /auth/register — Register a new company + admin user
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { companyName, email, password, name, lastName } = req.body

    if (!companyName || !email || !password || !name) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' })
    }

    const companyRepo = AppDataSource.getRepository(Company)
    const userRepo = AppDataSource.getRepository(User)
    const branchRepo = AppDataSource.getRepository(Branch)

    // Check if email already exists
    const existingUser = await userRepo.findOne({ where: { email } })
    if (existingUser) {
      return res.status(400).json({ error: 'El email ya está en uso' })
    }

    // Generate unique slug
    let slug = generateSlug(companyName)
    const existingSlug = await companyRepo.findOne({ where: { slug } })
    if (existingSlug) {
      slug = `${slug}-${Date.now()}`
    }

    // Create company
    const company = await companyRepo.save({ name: companyName, slug })

    // Create default branch
    const branch = await branchRepo.save({
      companyId: company.id,
      name: 'Sucursal Principal'
    })

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10)

    // Create admin user
    const user = await userRepo.save({
      companyId: company.id,
      branchId: branch.id,
      email,
      password: hashedPassword,
      name,
      lastName,
      role: UserRole.ADMIN
    })

    // Seed initial categories, products and tables for this company
    await seedCompanyData(company.id!, branch.id!)

    const token = signToken({
      userId: user.id!,
      companyId: company.id!,
      branchId: branch.id!,
      role: UserRole.ADMIN,
      email: user.email!
    })

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      company: { id: company.id, name: company.name, slug: company.slug },
      branch: { id: branch.id, name: branch.name }
    })
  } catch (error) {
    console.error('Register error:', error)
    res.status(500).json({ error: 'Error al registrar empresa' })
  }
})

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body

    const userRepo = AppDataSource.getRepository(User)
    const user = await userRepo.findOne({ where: { email, active: true } })

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' })
    }

    const validPassword = await bcrypt.compare(password, user.password!)
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciales inválidas' })
    }

    const companyRepo = AppDataSource.getRepository(Company)
    const branchRepo = AppDataSource.getRepository(Branch)

    const company = await companyRepo.findOne({ where: { id: user.companyId, active: true } })
    if (!company) {
      return res.status(403).json({ error: 'Empresa inactiva o no encontrada' })
    }

    const branch = user.branchId
      ? await branchRepo.findOne({ where: { id: user.branchId } })
      : await branchRepo.findOne({ where: { companyId: user.companyId } })

    const token = signToken({
      userId: user.id!,
      companyId: user.companyId!,
      branchId: branch?.id,
      role: user.role!,
      email: user.email!
    })

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, lastName: user.lastName, role: user.role },
      company: { id: company.id, name: company.name, slug: company.slug, logo: company.logo },
      branch: branch ? { id: branch.id, name: branch.name } : null
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ error: 'Error al iniciar sesión' })
  }
})

// GET /auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userRepo = AppDataSource.getRepository(User)
    const companyRepo = AppDataSource.getRepository(Company)
    const branchRepo = AppDataSource.getRepository(Branch)

    const user = await userRepo.findOne({ where: { id: req.user!.userId } })
    const company = await companyRepo.findOne({ where: { id: req.user!.companyId } })
    const branch = req.user!.branchId
      ? await branchRepo.findOne({ where: { id: req.user!.branchId } })
      : null

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })

    res.json({
      user: { id: user.id, email: user.email, name: user.name, lastName: user.lastName, role: user.role },
      company: company ? { id: company.id, name: company.name, slug: company.slug, logo: company.logo } : null,
      branch: branch ? { id: branch.id, name: branch.name } : null
    })
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuario' })
  }
})

export default router
