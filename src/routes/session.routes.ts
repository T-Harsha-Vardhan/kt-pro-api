import { Router } from 'express'
import {
  getSessions,
  getSession,
  createSession,
  deleteSession,
  getSessionByToken,
  uploadSessionAudio,
  audioUpload,
    generateSessionDocument,

} from '../controllers/session.controller'
import authMiddleware from '../middleware/auth.middleware'

const router = Router()

// Public — employee invite link
router.get('/invite/:token', getSessionByToken)
router.post('/upload-audio', audioUpload.single('audio'), uploadSessionAudio)


// Protected — manager only
router.get('/', authMiddleware, getSessions)
router.get('/:id', authMiddleware, getSession)
router.post('/', authMiddleware, createSession)
router.delete('/:id', authMiddleware, deleteSession)
router.post('/:id/generate', generateSessionDocument)

export default router