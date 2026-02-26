import mongoose, { Document, Schema } from 'mongoose'

export interface IWorkspace extends Document {
  name: string
  ownerId: mongoose.Types.ObjectId
  plan: 'free' | 'pro' | 'enterprise'
  createdAt: Date
  updatedAt: Date
}

const workspaceSchema = new Schema<IWorkspace>(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    plan: {
      type: String,
      enum: ['free', 'pro', 'enterprise'],
      default: 'free'
    }
  },
  { timestamps: true }
)

export default mongoose.model<IWorkspace>('Workspace', workspaceSchema)