import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
})

const BUCKET = process.env.AWS_S3_BUCKET || 'ktpro-sessions'

export async function uploadFrame(
  inviteToken: string,
  jpegBase64: string,
  timestamp: number
): Promise<string> {
  const key = `sessions/${inviteToken}/frames/${timestamp}.jpg`
  const buffer = Buffer.from(jpegBase64, 'base64')

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg',
  }))

  return `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`
}

export async function uploadAudio(
  inviteToken: string,
  audioBuffer: Buffer,
  mimeType: string
): Promise<string> {
  const ext = mimeType.includes('webm') ? 'webm' : 'mp4'
  const key = `sessions/${inviteToken}/audio.${ext}`

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: audioBuffer,
    ContentType: mimeType,
  }))

  return `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`
}