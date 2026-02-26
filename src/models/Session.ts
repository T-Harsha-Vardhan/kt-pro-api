import mongoose, { Document, Schema } from "mongoose";

export type InterviewType =
  | "strategic"
  | "operational"
  | "flow"
  | "procedure"
  | "tool"
  | "troubleshooting";

export type SessionStatus =
  | "pending"
  | "active"
  | "processing"
  | "completed"
  | "failed";

export interface ITranscriptChunk {
  speaker: "employee" | "ai";
  text: string;
  timestamp: number;
}

export interface IFrame {
  url: string;
  timestamp: number;
}

export interface IDocument {
  title: string;
  sections: {
    heading: string;
    content: string;
    gaps: string;
  }[];
  criticalKnowledge: string[];
  gaps: string[];
  followUpQuestions: string[];
}

export interface ISession extends Document {
  inviteToken: string;
  workspaceId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  employeeName: string;
  employeeEmail: string;
  role: string;
  interviewGoal: string;
  interviewType: InterviewType;
  topics: string[];
  duration: number;
  status: SessionStatus;
  transcript: ITranscriptChunk[];
  frames: IFrame[];
  audioUrl: string | null;
  document: IDocument | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const transcriptChunkSchema = new Schema<ITranscriptChunk>(
  {
    speaker: { type: String, enum: ["employee", "ai"], required: true },
    text: { type: String, required: true },
    timestamp: { type: Number, required: true },
  },
  { _id: false },
);

const frameSchema = new Schema<IFrame>(
  {
    url: { type: String, required: true },
    timestamp: { type: Number, required: true },
  },
  { _id: false },
);

const documentSchema = new Schema<IDocument>(
  {
    title: { type: String },
    sections: [
      {
        heading: String,
        content: String,
        gaps: String,
      },
    ],
    criticalKnowledge: [String],
    gaps: [String],
    followUpQuestions: [String],
  },
  { _id: false },
);

const sessionSchema = new Schema<ISession>(
  {
    inviteToken: {
      type: String,
      required: true,
      unique: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    employeeName: {
      type: String,
      required: true,
      trim: true,
    },
    employeeEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      required: true,
      trim: true,
    },
    interviewGoal: {
      type: String,
      default: "",
    },
    interviewType: {
      type: String,
      enum: [
        "strategic",
        "operational",
        "flow",
        "procedure",
        "tool",
        "troubleshooting",
      ],
      required: true,
    },
    topics: {
      type: [String],
      default: [],
    },
    duration: {
      type: Number,
      default: 30,
    },
    status: {
      type: String,
      enum: ["pending", "active", "processing", "completed", "failed"],
      default: "pending",
    },
    transcript: {
      type: [transcriptChunkSchema],
      default: [],
    },
    frames: {
      type: [frameSchema],
      default: [],
    },
    document: {
      type: documentSchema,
      default: null,
    },
    audioUrl: {
      type: String,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Index for fast lookups
sessionSchema.index({ workspaceId: 1, createdAt: -1 });

export default mongoose.model<ISession>("Session", sessionSchema);
