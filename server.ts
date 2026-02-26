import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import mongoose from 'mongoose'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import authRoutes from './src/routes/auth.routes'
import sessionRoutes from './src/routes/session.routes'
import { handleSessionWebSocket } from './src/services/gemini.service'

dotenv.config()

const app = express()
const httpServer = createServer(app)

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }))
app.use(express.json())
app.use(cookieParser())
app.use(morgan('dev'))

// REST routes
app.use('/api/auth', authRoutes)
app.use('/api/sessions', sessionRoutes)

// WebSocket server — no path filter, handle routing manually
const wss = new WebSocketServer({ server: httpServer })

wss.on('connection', async (ws, request) => {
  const url = request.url || ''

  // Only handle /ws/session/{token} — reject everything else
  if (!url.startsWith('/ws/session/')) {
    ws.close()
    return
  }

  const inviteToken = url.replace('/ws/session/', '')
  if (!inviteToken) {
    ws.close()
    return
  }

  console.log(`WS connection — token: ${inviteToken.slice(0, 8)}...`)

  const db = mongoose.connection.db
  await handleSessionWebSocket(ws, inviteToken, db)
})

// MongoDB + start
const PORT = process.env.PORT || 5000
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ktpro'

mongoose.connect(MONGO_URI).then(() => {
  console.log('MongoDB connected')
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
    console.log(`REST API: http://localhost:${PORT}/api`)
    console.log(`WebSocket: ws://localhost:${PORT}/ws/session/{token}`)
  })
}).catch((err) => {
  console.error('MongoDB connection failed:', err)
  process.exit(1)
})