import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

export interface AuthRequest extends Request {
  user?: {
    userId: string
    email: string
    role: string
    workspaceId: string
  }
}

const authMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  try {
    const token = req.cookies?.token

    if (!token) {
      res.status(401).json({ message: 'Not authenticated' })
      return
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as AuthRequest['user']
    req.user = decoded
    next()
  } catch (err) {
    res.status(401).json({ message: 'Invalid or expired token' })
  }
}

export default authMiddleware