import { Request, Response, NextFunction } from 'express'
import * as jwt from 'jsonwebtoken'
import { UserRole } from '../entities/User'

const JWT_SECRET = process.env.JWT_SECRET || 'resto-pos-secret-key-2024'

export interface AuthRequest extends Request {
  user?: {
    userId: number
    companyId: number
    branchId?: number
    role: UserRole
    email: string
  }
}

// Verifies JWT and injects user + companyId into request
export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' })
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any
    req.user = decoded
    next()
  } catch (err) {
    return res.status(403).json({ error: 'Token inválido o expirado' })
  }
}

// Checks that the user has one of the required roles
export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' })
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acceso denegado: rol insuficiente' })
    }
    next()
  }
}

export const signToken = (payload: {
  userId: number
  companyId: number
  branchId?: number
  role: UserRole
  email: string
}) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}
