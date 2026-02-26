import WebSocket from 'ws'
import { GoogleAuth } from 'google-auth-library'
import { uploadFrame, uploadAudio } from './s3.service'

async function getAccessToken(): Promise<string> {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  const client = await auth.getClient()
  const token = await client.getAccessToken()
  if (!token.token) throw new Error('Failed to get access token')
  return token.token
}

function buildSystemPrompt(session: any): string {
  return `You are an expert knowledge transfer interviewer conducting a structured KT session.

EMPLOYEE: ${session.employeeName}
ROLE: ${session.role}
INTERVIEW TYPE: ${session.interviewType}
GOAL: ${session.interviewGoal}

TOPICS THAT MUST BE COVERED:
${session.topics.map((t: string, i: number) => `${i + 1}. ${t}`).join('\n')}

YOUR BEHAVIOUR:
- Start by greeting ${session.employeeName} and explaining the session purpose
- Do not wait for the employee to speak first — begin immediately
- Work through each topic systematically — do not skip any
- Ask follow-up questions when answers are vague
- Push for edge cases: "What breaks? What only you know?"
- When employee shares screen, ask about what you see specifically
- Prompt for screen share when discussing systems or codebases
- Track which topics are covered and which are remaining
- At the end, explicitly list any topics not fully covered

STRICT RULES:
- NEVER generate a document during the session
- NEVER summarise the session while it is still running
- Your ONLY job is to INTERVIEW and EXTRACT knowledge
- When employee says they are done, thank them and close naturally`
}

function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < Math.min(str.length, 100); i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash = hash & hash
  }
  return hash
}

export async function handleSessionWebSocket(
  browserWs: WebSocket,
  inviteToken: string,
  db: any
) {
  const session = await db.collection('sessions').findOne({ inviteToken })
  if (!session) {
    browserWs.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
    browserWs.close()
    return
  }

  await db.collection('sessions').updateOne(
    { inviteToken },
    { $set: { status: 'active', startedAt: new Date() } }
  )

  let geminiWs: WebSocket | null = null
  let resumptionToken: string | null = null
  let reconnectAttempts = 0
  let lastFrameHash: number | null = null
  const MAX_RECONNECTS = 5

  async function saveTranscriptChunk(chunk: any) {
    await db.collection('sessions').updateOne(
      { inviteToken },
      {
        $push: { transcript: chunk },
        $set: { lastActivity: new Date() },
      }
    )
  }

  // Upload to S3 and save URL in MongoDB
  async function saveFrameIfChanged(jpegBase64: string, timestamp: number) {
    const hash = simpleHash(jpegBase64)
    if (hash === lastFrameHash) return
    lastFrameHash = hash

    try {
      const s3Url = await uploadFrame(inviteToken, jpegBase64, timestamp)
      await db.collection('sessions').updateOne(
        { inviteToken },
        {
          $push: {
            frames: { url: s3Url, timestamp }  // URL not base64
          }
        }
      )
      console.log(`[${inviteToken.slice(0, 8)}] Frame saved: ${s3Url}`)
    } catch (err: any) {
      console.error(`[${inviteToken.slice(0, 8)}] Frame upload failed:`, err.message)
    }
  }

  async function connectToGemini(token: string | null = null) {
    const PROJECT_ID = process.env.GEMINI_PROJECT_ID
    const LOCATION = process.env.GEMINI_LOCATION
    const MODEL = process.env.GEMINI_MODEL
    const GEMINI_URL = `wss://${LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`

    const ACCESS_TOKEN = await getAccessToken()

    console.log(`[${inviteToken.slice(0, 8)}] Connecting to Gemini...`)

    geminiWs = new WebSocket(GEMINI_URL, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    })

    geminiWs.onopen = () => {
      console.log(`[${inviteToken.slice(0, 8)}] Gemini connected`)
      reconnectAttempts = 0

      const setupMessage: any = {
        setup: {
          model: `projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}`,
          generation_config: {
            response_modalities: ['AUDIO'],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: 'Aoede' },
              },
            },
          },
          system_instruction: {
            parts: [{ text: buildSystemPrompt(session) }],
          },
          input_audio_transcription: {},
          output_audio_transcription: {},
        },
      }

      if (token) {
        setupMessage.setup.session_resumption = { handle: token }
      }

      geminiWs!.send(JSON.stringify(setupMessage))
      browserWs.send(JSON.stringify({ type: 'session_ready' }))
    }

    geminiWs.onmessage = (event) => {
      const data = JSON.parse(event.data.toString())

      if (data.serverContent?.modelTurn?.parts) {
        data.serverContent.modelTurn.parts.forEach((part: any) => {
          if (part.inlineData?.mimeType === 'audio/pcm') {
            browserWs.send(JSON.stringify({ type: 'ai_audio', data: part.inlineData.data }))
          }
        })
        browserWs.send(JSON.stringify({ type: 'ai_speaking', value: true }))
      }

      if (data.serverContent?.turnComplete) {
        browserWs.send(JSON.stringify({ type: 'ai_speaking', value: false }))
      }

      if (data.serverContent?.inputTranscription?.text) {
        const text = data.serverContent.inputTranscription.text
        const chunk = { speaker: 'employee', text, timestamp: new Date() }
        saveTranscriptChunk(chunk)
        browserWs.send(JSON.stringify({ type: 'transcript', speaker: 'employee', text }))
      }

      if (data.serverContent?.outputTranscription?.text) {
        const text = data.serverContent.outputTranscription.text
        const chunk = { speaker: 'ai', text, timestamp: new Date() }
        saveTranscriptChunk(chunk)
        browserWs.send(JSON.stringify({ type: 'transcript', speaker: 'ai', text }))
      }

      if (data.sessionResumptionUpdate?.newHandle) {
        resumptionToken = data.sessionResumptionUpdate.newHandle
      }
    }

    geminiWs.onclose = (event) => {
      console.log(`[${inviteToken.slice(0, 8)}] Gemini closed: ${event.code} — reason: ${event.reason}`)
      if (reconnectAttempts < MAX_RECONNECTS) {
        reconnectAttempts++
        const delay = reconnectAttempts * 2000
        setTimeout(() => connectToGemini(resumptionToken), delay)
      } else {
        browserWs.send(JSON.stringify({ type: 'session_ended', reason: 'max_reconnects' }))
      }
    }

    geminiWs.onerror = (err) => {
      console.error(`[${inviteToken.slice(0, 8)}] Gemini error:`, err.message)
    }
  }

  browserWs.on('message', (message) => {
    const data = JSON.parse(message.toString())

    if (data.realtime_input?.media_chunks) {
      data.realtime_input.media_chunks.forEach((chunk: any) => {
        if (chunk.mime_type === 'image/jpeg') {
          saveFrameIfChanged(chunk.data, Date.now())
        }
      })
    }

    if (geminiWs?.readyState === WebSocket.OPEN) {
      geminiWs.send(JSON.stringify(data))
    }
  })

  browserWs.on('close', async () => {
    console.log(`[${inviteToken.slice(0, 8)}] Browser disconnected`)
    if (geminiWs) geminiWs.close()

    await db.collection('sessions').updateOne(
      { inviteToken },
      { $set: { status: 'processing', endedAt: new Date() } }
    )

    generateDocument(inviteToken, db)
  })

  browserWs.on('error', (err) => {
    console.error(`[${inviteToken.slice(0, 8)}] Browser WS error:`, err.message)
  })

  connectToGemini()
}

async function generateDocument(inviteToken: string, db: any) {
  const PROJECT_ID = process.env.GEMINI_PROJECT_ID
  const LOCATION = process.env.GEMINI_LOCATION

  console.log(`[${inviteToken.slice(0, 8)}] Generating document...`)
  try {
    const session = await db.collection('sessions').findOne({ inviteToken })
    if (!session || session.transcript.length === 0) {
      console.log('No transcript — skipping')
      return
    }

    const transcriptText = session.transcript
      .map((c: any) => `${c.speaker.toUpperCase()}: ${c.text}`)
      .join('\n')

    const prompt = `You are a technical documentation specialist.

Employee: ${session.employeeName}, Role: ${session.role}
Interview type: ${session.interviewType}
Goal: ${session.interviewGoal}
Topics: ${session.topics.join(', ')}

TRANSCRIPT:
${transcriptText}

Generate a comprehensive knowledge document. Output ONLY valid JSON:
{
  "title": "...",
  "sections": [{ "heading": "...", "content": "...", "gaps": "..." }],
  "criticalKnowledge": ["..."],
  "gaps": ["..."],
  "followUpQuestions": ["..."]
}`

    const ACCESS_TOKEN = await getAccessToken()
    const https = await import('https')
    const requestBody = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
    })

    const options = {
      hostname: `${LOCATION}-aiplatform.googleapis.com`,
      path: `/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/gemini-2.0-flash:generateContent`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    }

    const response = await new Promise<any>((resolve, reject) => {
      const req = https.default.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve(JSON.parse(data)))
      })
      req.on('error', reject)
      req.write(requestBody)
      req.end()
    })

    const generatedText = response.candidates?.[0]?.content?.parts?.[0]?.text
    if (!generatedText) throw new Error('No content in response')

    const document = JSON.parse(generatedText)
    await db.collection('sessions').updateOne(
      { inviteToken },
      { $set: { document, status: 'completed' } }
    )
    console.log(`[${inviteToken.slice(0, 8)}] Document generated`)
  } catch (err: any) {
    console.error(`[${inviteToken.slice(0, 8)}] Document generation failed:`, err.message)
    await db.collection('sessions').updateOne(
      { inviteToken },
      { $set: { status: 'failed' } }
    )
  }
}

export async function generateDocumentById(sessionId: string, inviteToken: string) {
  // Reuse existing generateDocument function
  const mongoose = await import('mongoose')
  const db = mongoose.default.connection.db
  await generateDocument(inviteToken, db)
}
