import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import connectDB from './src/config/db'
import authRoutes from './src/routes/auth.routes'

const app = express()

connectDB()

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}))
app.use(express.json())
app.use(cookieParser())
app.use(morgan('dev'))

app.use('/api/auth', authRoutes)

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

const PORT = process.env.PORT || 5000
app.listen(PORT, () => {
  console.log(`KT Pro API running on port ${PORT}`)
})