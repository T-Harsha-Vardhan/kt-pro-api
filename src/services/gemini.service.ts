import WebSocket from 'ws'
import { GoogleAuth } from 'google-auth-library'
import { uploadFrame } from './s3.service'
import OpenAI from 'openai'

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
  const isContinuation = Array.isArray(session.transcript) && session.transcript.length > 0
  return `You are an expert knowledge transfer interviewer conducting a structured KT session.

EMPLOYEE: ${session.employeeName}
ROLE: ${session.role}
INTERVIEW TYPE: ${session.interviewType}
GOAL: ${session.interviewGoal}

TOPICS THAT MUST BE COVERED:
${session.topics.map((t: string, i: number) => `${i + 1}. ${t}`).join('\n')}

YOUR BEHAVIOUR:
- ${isContinuation
    ? `This is a continuation of an existing session. Do NOT greet again. Resume naturally from where the prior conversation stopped.`
    : `Start by greeting ${session.employeeName} and explaining the session purpose.`}
- ${isContinuation
    ? `Continue directly with follow-up questions based on the existing context and remaining topics.`
    : `Do not wait for the employee to speak first — begin immediately.`}
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
- When employee says they are done, thank them and close naturally
- RESPOND UNMISTAKABLY IN ENGLISH ONLY
- If the employee speaks another language, understand it and continue the interview in English
- Keep all AI responses and clarifying questions in English`
}

// ── Better hash: samples multiple positions across the full string ──────────
function simpleHash(str: string): number {
  const len = str.length
  const step = Math.max(1, Math.floor(len / 50)) // sample ~50 points spread across entire string
  let hash = len // include length so differently-sized images always differ
  for (let i = 0; i < len; i += step) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash = hash & hash
  }
  return hash
}

// ── Convert document JSON → clean HTML for the Notion-like editor ────────────
export function documentToHtml(doc: any): string {
  function esc(s: string): string {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }
  function paragraphs(text: string): string {
    return text
      .split(/\n+/)
      .filter(Boolean)
      .map((p) => `<p>${esc(p)}</p>`)
      .join('')
  }

  let html = `<h1>${esc(doc.title)}</h1>`

  if (doc.executiveSummary) {
    html += `<h2>Executive Summary</h2>${paragraphs(doc.executiveSummary)}`
  }

  if (Array.isArray(doc.sections)) {
    for (const section of doc.sections) {
      html += `<h2>${esc(section.heading)}</h2>`
      if (section.content) html += paragraphs(section.content)
      if (section.gaps) {
        html += `<blockquote><strong>Gaps: </strong>${esc(section.gaps)}</blockquote>`
      }
    }
  }

  if (Array.isArray(doc.criticalKnowledge) && doc.criticalKnowledge.length > 0) {
    html += `<h2>Critical Knowledge</h2><ul>`
    for (const item of doc.criticalKnowledge) html += `<li>${esc(item)}</li>`
    html += `</ul>`
  }

  if (Array.isArray(doc.handoverRisks) && doc.handoverRisks.length > 0) {
    html += `<h2>Handover Risks</h2><ul>`
    for (const risk of doc.handoverRisks) html += `<li>${esc(risk)}</li>`
    html += `</ul>`
  }

  if (Array.isArray(doc.gaps) && doc.gaps.length > 0) {
    html += `<h2>Knowledge Gaps</h2><ul>`
    for (const gap of doc.gaps) html += `<li>${esc(gap)}</li>`
    html += `</ul>`
  }

  if (Array.isArray(doc.recommendedActions) && doc.recommendedActions.length > 0) {
    html += `<h2>Recommended Next Steps</h2><ol>`
    for (const action of doc.recommendedActions) html += `<li>${esc(action)}</li>`
    html += `</ol>`
  }

  if (Array.isArray(doc.followUpQuestions) && doc.followUpQuestions.length > 0) {
    html += `<h2>Follow-up Questions</h2><ol>`
    for (const q of doc.followUpQuestions) html += `<li>${esc(q)}</li>`
    html += `</ol>`
  }

  return html
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
    { $set: { status: 'active', startedAt: session.startedAt || new Date(), endedAt: null } }
  )

  let geminiWs: WebSocket | null = null
  let resumptionToken: string | null = null
  let reconnectAttempts = 0
  let lastFrameHash: number | null = null
  let sessionTerminated = false // ← prevents Gemini from reconnecting after session ends
  let explicitSessionEndRequested = false
  const MAX_RECONNECTS = 5

  // ── Transcript buffering — merge until speaker changes ──────
  let transcriptBuffer: { speaker: string; text: string } | null = null

  function flushTranscriptBuffer() {
    if (!transcriptBuffer) return
    const chunk = {
      speaker: transcriptBuffer.speaker,
      text: transcriptBuffer.text.trim(),
      timestamp: new Date(),
    }
    if (!chunk.text) {
      transcriptBuffer = null
      return
    }
    db.collection('sessions').updateOne(
      { inviteToken },
      {
        $push: { transcript: chunk },
        $set: { lastActivity: new Date() },
      }
    )
    browserWs.send(JSON.stringify({
      type: 'transcript',
      speaker: chunk.speaker,
      text: chunk.text,
    }))
    transcriptBuffer = null
  }

  function bufferTranscript(speaker: string, text: string) {
    if (transcriptBuffer && transcriptBuffer.speaker === speaker) {
      transcriptBuffer.text += text
    } else {
      flushTranscriptBuffer()
      transcriptBuffer = { speaker, text }
    }
  }

  // ── Frame upload ─────────────────────────────────────────────
  async function saveFrameIfChanged(jpegBase64: string, timestamp: number) {
    const hash = simpleHash(jpegBase64)
    if (hash === lastFrameHash) {
      console.log(`[${inviteToken.slice(0, 8)}] Frame unchanged — skipping`)
      return
    }
    lastFrameHash = hash

    console.log(`[${inviteToken.slice(0, 8)}] Frame changed — uploading to S3...`)
    try {
      const s3Url = await uploadFrame(inviteToken, jpegBase64, timestamp)
      await db.collection('sessions').updateOne(
        { inviteToken },
        { $push: { frames: { url: s3Url, timestamp } } }
      )
      console.log(`[${inviteToken.slice(0, 8)}] Frame saved: ${s3Url}`)
    } catch (err: any) {
      console.error(`[${inviteToken.slice(0, 8)}] Frame upload failed:`, err.message)
    }
  }

  async function connectToGemini(token: string | null = null) {
    const PROJECT_ID = process.env.GEMINI_PROJECT_ID
    const LOCATION   = process.env.GEMINI_LOCATION
    const MODEL      = process.env.GEMINI_MODEL
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
              language_code: 'en-US',
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

      // AI audio
      if (data.serverContent?.modelTurn?.parts) {
        data.serverContent.modelTurn.parts.forEach((part: any) => {
          if (part.inlineData?.mimeType === 'audio/pcm') {
            browserWs.send(JSON.stringify({ type: 'ai_audio', data: part.inlineData.data }))
          }
        })
        browserWs.send(JSON.stringify({ type: 'ai_speaking', value: true }))
      }

      // AI turn complete — flush AI transcript buffer
      if (data.serverContent?.turnComplete) {
        flushTranscriptBuffer()
        browserWs.send(JSON.stringify({ type: 'ai_speaking', value: false }))
      }

      // Employee transcript
      if (data.serverContent?.inputTranscription?.text) {
        bufferTranscript('employee', data.serverContent.inputTranscription.text)
      }

      // AI transcript
      if (data.serverContent?.outputTranscription?.text) {
        bufferTranscript('ai', data.serverContent.outputTranscription.text)
      }

      // Resumption token
      if (data.sessionResumptionUpdate?.newHandle) {
        resumptionToken = data.sessionResumptionUpdate.newHandle
        db.collection('sessions').updateOne(
          { inviteToken },
          { $set: { resumptionHandle: resumptionToken } }
        ).catch(() => {})
      }
    }

    geminiWs.onclose = (event) => {
      console.log(`[${inviteToken.slice(0, 8)}] Gemini closed: ${event.code}`)
      // ← Do NOT reconnect if the session was intentionally ended by the employee
      if (sessionTerminated) {
        console.log(`[${inviteToken.slice(0, 8)}] Session terminated — skipping Gemini reconnect`)
        return
      }
      if (reconnectAttempts < MAX_RECONNECTS) {
        reconnectAttempts++
        setTimeout(() => connectToGemini(resumptionToken), reconnectAttempts * 2000)
      } else {
        browserWs.send(JSON.stringify({ type: 'session_ended', reason: 'max_reconnects' }))
      }
    }

    geminiWs.onerror = (err) => {
      console.error(`[${inviteToken.slice(0, 8)}] Gemini error:`, err.message)
    }
  }

  // ── Browser → Gemini ────────────────────────────────────────
  browserWs.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString())

      if (data.type === 'end_session') {
        console.log(`[${inviteToken.slice(0, 8)}] Explicit end_session received`)
        explicitSessionEndRequested = true
        sessionTerminated = true
        flushTranscriptBuffer()

        if (geminiWs?.readyState === WebSocket.OPEN) {
          geminiWs.close()
        }

        await db.collection('sessions').updateOne(
          { inviteToken },
          { $set: { status: 'ended', endedAt: new Date() } }
        )

        browserWs.send(JSON.stringify({ type: 'session_ended', reason: 'user_ended' }))
        return
      }

      // Handle frames
      if (data.realtime_input?.media_chunks) {
        for (const chunk of data.realtime_input.media_chunks) {
          if (chunk.mime_type === 'image/jpeg') {
            console.log(`[${inviteToken.slice(0, 8)}] Image chunk received, size: ${chunk.data?.length ?? 0}`)
            await saveFrameIfChanged(chunk.data, Date.now())
          }
        }
      }

      // Forward everything to Gemini
      if (geminiWs?.readyState === WebSocket.OPEN) {
        geminiWs.send(JSON.stringify(data))
      }
    } catch (err: any) {
      console.error(`[${inviteToken.slice(0, 8)}] Message parse error:`, err.message)
    }
  })

  // ── Browser disconnected ────────────────────────────────────
  browserWs.on('close', async () => {
    console.log(`[${inviteToken.slice(0, 8)}] Browser disconnected — ending session`)

    sessionTerminated = true // ← stops Gemini from reconnecting

    flushTranscriptBuffer()

    if (geminiWs) geminiWs.close()

    if (explicitSessionEndRequested) {
      await db.collection('sessions').updateOne(
        { inviteToken },
        { $set: { status: 'ended', endedAt: new Date() } }
      )
      return
    }

    await db.collection('sessions').updateOne(
      { inviteToken },
      { $set: { status: 'processing', endedAt: new Date(), resumptionHandle: null } }
    )

    generateDocument(inviteToken, db)
  })

  browserWs.on('error', (err) => {
    console.error(`[${inviteToken.slice(0, 8)}] Browser WS error:`, err.message)
  })

  connectToGemini(session.resumptionHandle || null)
}

// ── Document generation via OpenAI ──────────────────────────────────────────
async function generateDocument(inviteToken: string, db: any) {
  console.log(`[${inviteToken.slice(0, 8)}] Generating document via OpenAI...`)
  try {
    const session = await db.collection('sessions').findOne({ inviteToken })
    if (!session || !session.transcript || session.transcript.length === 0) {
      console.log(`[${inviteToken.slice(0, 8)}] No transcript — skipping document generation`)
      return
    }

    const transcriptText = session.transcript
      .map((c: any) => `${c.speaker.toUpperCase()}: ${c.text}`)
      .join('\n')

    const prompt = `You are a senior technical documentation specialist creating a high-level Knowledge Transfer (KT) document.

SESSION DETAILS:
- Employee: ${session.employeeName}
- Role: ${session.role}
- Interview Type: ${session.interviewType}
- Goal: ${session.interviewGoal}
- Topics to cover: ${session.topics.join(', ')}

TRANSCRIPT:
${transcriptText}

Create a comprehensive, professional KT document suitable for a new hire or successor to understand this role deeply.

Return ONLY valid JSON with this exact structure:
{
  "title": "Knowledge Transfer: [Role] — [Employee Name]",
  "executiveSummary": "A 3-4 sentence high-level summary of what was captured, why this role matters, and what the successor needs to know most urgently.",
  "sections": [
    {
      "heading": "Section title based on topics covered",
      "content": "Detailed, multi-paragraph prose. Include specifics, not vague statements. Cover edge cases, tribal knowledge, and anything that only this person knows. Write as if onboarding someone with zero context.",
      "gaps": "Any areas in this topic that were not fully explained or need follow-up (empty string if none)"
    }
  ],
  "criticalKnowledge": ["Bullet points of the most critical, hard-to-discover things learned"],
  "handoverRisks": ["Specific risks if this knowledge is not transferred properly"],
  "gaps": ["Overall knowledge gaps that still need documentation"],
  "recommendedActions": ["Concrete next steps for the receiving team or manager"],
  "followUpQuestions": ["Questions to ask in a follow-up session to fill gaps"]
}`

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a technical documentation specialist. Always return valid JSON only, no markdown fences.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    })

    const generatedText = completion.choices[0]?.message?.content
    if (!generatedText) throw new Error('No content in OpenAI response')

    const document = JSON.parse(generatedText)
    const documentHtml = documentToHtml(document)

    await db.collection('sessions').updateOne(
      { inviteToken },
      { $set: { document, documentHtml, status: 'completed' } }
    )
    console.log(`[${inviteToken.slice(0, 8)}] Document generated successfully`)
  } catch (err: any) {
    console.error(`[${inviteToken.slice(0, 8)}] Document generation failed:`, err.message)
    await db.collection('sessions').updateOne(
      { inviteToken },
      { $set: { status: 'failed' } }
    )
  }
}

export async function generateDocumentById(sessionId: string, inviteToken: string): Promise<void> {
  const mongoose = await import('mongoose')
  const db = mongoose.default.connection.db
  await generateDocument(inviteToken, db)
}
