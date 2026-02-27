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

    if (session.status === 'completed' || session.status === 'cancelled') {
      res.status(400).json({ message: 'This session is no longer available' })
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

// POST /api/sessions/finalize (public — called by employee after explicit end)
export const finalizeSessionByInvite = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { inviteToken, action } = req.body as {
      inviteToken?: string
      action?: 'generate_partial' | 'discard'
    }

    if (!inviteToken || (action !== 'generate_partial' && action !== 'discard')) {
      res.status(400).json({ message: 'inviteToken and valid action are required' })
      return
    }

    const session = await Session.findOne({ inviteToken })
    if (!session) {
      res.status(404).json({ message: 'Session not found' })
      return
    }

    if (action === 'discard') {
      await Session.updateOne(
        { inviteToken },
        { $set: { status: 'cancelled', endedAt: session.endedAt || new Date(), resumptionHandle: null } }
      )
      res.status(200).json({ success: true, status: 'cancelled' })
      return
    }

    // action === 'generate_partial'
    await Session.updateOne(
      { inviteToken },
      { $set: { status: 'processing', endedAt: session.endedAt || new Date(), resumptionHandle: null } }
    )
    generateDocumentById(session._id.toString(), session.inviteToken)
    res.status(202).json({ success: true, status: 'processing' })
  } catch (err) {
    console.error('finalizeSessionByInvite error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to finalize session' })
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

// PATCH /api/sessions/:id/document — save edited document HTML
export const saveDocumentHtml = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { html } = req.body
    if (typeof html !== 'string') {
      res.status(400).json({ message: 'html field is required' })
      return
    }

    const session = await Session.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.user?.workspaceId },
      { $set: { documentHtml: html } },
      { new: true }
    )

    if (!session) {
      res.status(404).json({ message: 'Session not found' })
      return
    }

    res.status(200).json({ success: true })
  } catch (err) {
    console.error('saveDocumentHtml error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to save document' })
  }
}

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