import mongoose, { Document, Schema } from 'mongoose'

export interface IUser extends Document {
  email: string
  name: string
  role: 'manager' | 'admin'
  workspaceId: mongoose.Types.ObjectId | null
  createdAt: Date
  updatedAt: Date
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    name: {
      type: String,
      default: ''
    },
    role: {
      type: String,
      enum: ['manager', 'admin'],
      default: 'manager'
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      default: null
    }
  },
  { timestamps: true }
)

export default mongoose.model<IUser>('User', userSchema)