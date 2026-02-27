import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

// Create client lazily — reads env vars at call time, not module load time
function getS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  })
}

export async function uploadFrame(
  inviteToken: string,
  jpegBase64: string,
  timestamp: number
): Promise<string> {
  const bucket = process.env.AWS_S3_BUCKET!
  const region = process.env.AWS_REGION!
  const key = `sessions/${inviteToken}/frames/${timestamp}.jpg`
  const buffer = Buffer.from(jpegBase64, 'base64')

  await getS3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg',
    ACL: 'public-read',
  }))

  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`
}

export async function uploadAudio(
  inviteToken: string,
  audioBuffer: Buffer,
  mimeType: string
): Promise<string> {
  const bucket = process.env.AWS_S3_BUCKET!
  const region = process.env.AWS_REGION!
  const ext = mimeType.includes('webm') ? 'webm' : 'mp4'
  const key = `sessions/${inviteToken}/audio.${ext}`

  await getS3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: audioBuffer,
    ContentType: mimeType,
  }))

  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`
}