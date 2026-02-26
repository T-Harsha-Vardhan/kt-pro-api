import { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import User from '../models/User'
import Workspace from '../models/Workspace'
import OTP from '../models/OTP'
import generateOTP from '../utils/generateOTP'
import transporter from '../config/email'
import { AuthRequest } from '../middleware/auth.middleware'

export const sendOTP = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body

    if (!email) {
      res.status(400).json({ message: 'Email is required' })
      return
    }

    await OTP.deleteMany({ email })

    const otp = generateOTP()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

    await OTP.create({ email, otp, expiresAt })

    await transporter.sendMail({
      from: `"KT Pro" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'Your KT Pro login code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 400px; margin: 0 auto;">
          <h2>Your login code</h2>
          <p>Enter this code to sign in to KT Pro:</p>
          <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px;
                      padding: 20px; background: #f5f5f5; text-align: center;
                      border-radius: 8px; margin: 20px 0;">
            ${otp}
          </div>
          <p style="color: #666;">This code expires in 10 minutes.</p>
          <p style="color: #666;">If you didn't request this, ignore this email.</p>
        </div>
      `
    })

    res.status(200).json({ message: 'OTP sent successfully' })

  } catch (err) {
    console.error('sendOTP error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to send OTP' })
  }
}

export const verifyOTP = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body

    if (!email || !otp) {
      res.status(400).json({ message: 'Email and OTP are required' })
      return
    }

    const otpRecord = await OTP.findOne({ email })

    if (!otpRecord) {
      res.status(400).json({ message: 'OTP not found. Request a new one.' })
      return
    }

    if (new Date() > otpRecord.expiresAt) {
      await OTP.deleteMany({ email })
      res.status(400).json({ message: 'OTP expired. Request a new one.' })
      return
    }

    if (otpRecord.otp !== otp) {
      res.status(400).json({ message: 'Invalid OTP' })
      return
    }

    await OTP.deleteMany({ email })

    let user = await User.findOne({ email })

    if (!user) {
      user = await User.create({ email })

      const workspace = await Workspace.create({
        name: `${email.split('@')[0]}'s Workspace`,
        ownerId: user._id
      })

      user.workspaceId = workspace._id as mongoose.Types.ObjectId
      await user.save()
    }

    const token = jwt.sign(
      {
        userId: user._id,
        email: user.email,
        role: user.role,
        workspaceId: user.workspaceId
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '7d' }
    )

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })

    res.status(200).json({
      message: 'Login successful',
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        workspaceId: user.workspaceId
      }
    })

  } catch (err) {
    console.error('verifyOTP error:', (err as Error).message)
    res.status(500).json({ message: 'Verification failed' })
  }
}

export const logout = (req: Request, res: Response): void => {
  res.clearCookie('token')
  res.status(200).json({ message: 'Logged out successfully' })
}

export const getMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user?.userId).select('-__v')
    if (!user) {
      res.status(404).json({ message: 'User not found' })
      return
    }
    res.status(200).json({ user })
  } catch (err) {
    console.error('getMe error:', (err as Error).message)
    res.status(500).json({ message: 'Failed to get user' })
  }
}