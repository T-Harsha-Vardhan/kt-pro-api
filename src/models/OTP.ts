import mongoose, { Document, Schema } from 'mongoose'

export interface IOTP extends Document {
  email: string
  otp: string
  expiresAt: Date
  createdAt: Date
}

const otpSchema = new Schema<IOTP>(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    otp: {
      type: String,
      required: true
    },
    expiresAt: {
      type: Date,
      required: true
    }
  },
  { timestamps: true }
)

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model<IOTP>('OTP', otpSchema)