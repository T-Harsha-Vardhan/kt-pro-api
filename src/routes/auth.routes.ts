import { Router } from 'express'
import { sendOTP, verifyOTP, logout, getMe } from '../controllers/auth.controller'
import authMiddleware from '../middleware/auth.middleware'

const router = Router()

router.post('/send-otp', sendOTP)
router.post('/verify-otp', verifyOTP)
router.post('/logout', logout)
router.get('/me', authMiddleware, getMe)

export default router