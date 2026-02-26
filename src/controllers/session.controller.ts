import { Response } from 'express'
import crypto from 'crypto'
import multer from 'multer'
import Session from '../models/Session'
import { AuthRequest } from '../middleware/auth.middleware'
import { uploadAudio } from '../services/s3.service'
import { generateDocumentById } from '../services/gemini.service'


// GET /api/sessions
export const getSessions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sessions = await Session.find({ workspaceId: req.user?.workspaceId })
      .select('-transcript -frames -document')
      .sort({ createdAt: -1 })

    res.status(200).json({ sessions })
  } catch (err) {
    console.error('getSessions error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to fetch sessions' })
  }
}

// GET /api/sessions/:id
export const getSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const session = await Session.findOne({
      _id: req.params.id,
      workspaceId: req.user?.workspaceId
    })

    if (!session) {
      res.status(404).json({ message: 'Session not found' })
      return
    }

    res.status(200).json({ session })
  } catch (err) {
    console.error('getSession error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to fetch session' })
  }
}

// POST /api/sessions
export const createSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      employeeName,
      employeeEmail,
      role,
      interviewGoal,
      interviewType,
      topics,
      duration
    } = req.body

    if (!employeeName || !employeeEmail || !role || !interviewType) {
      res.status(400).json({ message: 'Missing required fields' })
      return
    }

    // Generate unique invite token
    const inviteToken = crypto.randomBytes(32).toString('hex')

    const session = await Session.create({
      inviteToken,
      workspaceId: req.user?.workspaceId,
      createdBy: req.user?.userId,
      employeeName,
      employeeEmail,
      role,
      interviewGoal: interviewGoal || '',
      interviewType,
      topics: topics || [],
      duration: duration || 30,
      status: 'pending'
    })

    res.status(201).json({ session })
  } catch (err) {
    console.error('createSession error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to create session' })
  }
}

// DELETE /api/sessions/:id
export const deleteSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const session = await Session.findOneAndDelete({
      _id: req.params.id,
      workspaceId: req.user?.workspaceId
    })

    if (!session) {
      res.status(404).json({ message: 'Session not found' })
      return
    }

    res.status(200).json({ message: 'Session deleted' })
  } catch (err) {
    console.error('deleteSession error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to delete session' })
  }
}

// GET /api/sessions/invite/:token (public — no auth, for employee)
export const getSessionByToken = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const session = await Session.findOne({
      inviteToken: req.params.token
    }).select('-transcript -frames -document -interviewGoal')

    if (!session) {
      res.status(404).json({ message: 'Invalid or expired invite link' })
      return
    }

    if (session.status === 'completed') {
      res.status(400).json({ message: 'This session has already been completed' })
      return
    }

    res.status(200).json({ session })
  } catch (err) {
    console.error('getSessionByToken error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to fetch session' })
  }
}

// POST /api/sessions/upload-audio (public — called by employee browser after session)
export const uploadSessionAudio = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { inviteToken } = req.body
    const file = req.file

    if (!inviteToken || !file) {
      res.status(400).json({ message: 'Missing inviteToken or audio file' })
      return
    }

    const session = await Session.findOne({ inviteToken })
    if (!session) {
      res.status(404).json({ message: 'Session not found' })
      return
    }

    const audioUrl = await uploadAudio(inviteToken, file.buffer, file.mimetype)

    await Session.updateOne(
      { inviteToken },
      { $set: { audioUrl } }
    )

    res.status(200).json({ success: true, audioUrl })
  } catch (err) {
    console.error('uploadSessionAudio error:', (err as Error).message)
    res.status(500).json({ message: 'Audio upload failed' })
  }
}

// Multer config — memory storage, 100MB limit
export const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true)
    } else {
      cb(new Error('Only audio files allowed'))
    }
  }
})

// POST /api/sessions/:id/generate
export const generateSessionDocument = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const session = await Session.findOne({
      _id: req.params.id,
      workspaceId: req.user?.workspaceId
    })

    if (!session) {
      res.status(404).json({ message: 'Session not found' })
      return
    }

    if (!session.transcript || session.transcript.length === 0) {
      res.status(400).json({ message: 'No transcript available to generate document from' })
      return
    }

    // Mark as processing so UI can show spinner
    await Session.updateOne({ _id: req.params.id }, { $set: { status: 'processing' } })

    // Fire and forget — client polls for completion
    generateDocumentById(session._id.toString(), session.inviteToken)

    res.status(202).json({ message: 'Document generation started' })
  } catch (err) {
    console.error('generateSessionDocument error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to start generation' })
  }
}