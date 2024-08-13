import fs from 'fs/promises'
import path from 'path'
import z from 'zod'
import { Session, ready } from '@session.js/client'
await ready
import { generateSeedHex } from '@session.js/keypair'
import { encode, decode } from '@session.js/mnemonic'
import { FileKeyvalStorage } from '@session.js/file-keyval-storage'
import generate from 'vanilla-captcha'
import { nanoid } from 'nanoid'

const configSerialized = await fs.readFile(path.join(__dirname, './config.json'), 'utf-8')
const config = z.object({
  rooms: z.record(
    z.string(),
    z.object({
      message: z.string().min(1).max(1024).optional(),
      captcha: z.boolean().optional(),
      captcha_difficult: z.boolean().optional(),
      verified_message: z.string().max(1024).optional(),
    })
  )
}).parse(JSON.parse(configSerialized))

const verified = new Map<string, Set<number>>()
// Room token -> Set of verified user IDs
const sessions = new Map<string, Session>()
// Room token -> Session instance
const db = new Map<string, Map<string, { captchaAnswer?: string, captchaSentAt?: number, messageId?: number }>>()
// Room token -> User blinded Session ID -> { captchaAnswer, captchaSentAt } | {}

const dbPath = path.join(__dirname, './db.json')

try {
  await fs.access(dbPath, fs.constants.F_OK)
} catch {
  await fs.writeFile(dbPath, '{}', 'utf-8')
}

const dbSerialized = await fs.readFile(dbPath, 'utf-8')
const dbParsed = JSON.parse(dbSerialized.trim() || '{}') as {
  verified?: Record<string, number[]>,
  // Room token -> array of verified user IDs
  sessions?: Record<string, string>,
  // Room token -> Session instance's seed hex. DO NOT CHANGE IT MANUALLY, IT WILL BREAK SESSION.JS STORAGE
  db?: Record<string, Record<string, { captchaAnswer?: string, captchaSentAt?: number, messageId?: number }>>
  // Room token -> User blinded Session ID -> { captchaAnswer, captchaSentAt } | {}
}

for (const roomToken in config.rooms) {
  const verifiedUserIds = dbParsed.verified?.[roomToken]
  verified.set(roomToken, new Set(verifiedUserIds))

  const sessionSeedHex = dbParsed.sessions?.[roomToken] ?? generateSeedHex()
  const session = new Session({
    storage: new FileKeyvalStorage({
      filePath: path.join(__dirname, `./session_${roomToken}`)
    }),
  })
  session.setMnemonic(encode(sessionSeedHex))
  sessions.set(roomToken, session)

  const roomDb = dbParsed.db?.[roomToken]
  db.set(roomToken, new Map(Object.entries(roomDb ?? {})))
}

const persist = async () => {
  const dbJson = Object.fromEntries(Array.from(db.entries()).map(([roomToken, roomDb]) => [
    roomToken,
    Object.fromEntries(Array.from(roomDb.entries()))
  ]))
  const dbSerialized = JSON.stringify({
    warning: "DO NOT EDIT THIS FILE MANUALLY, IT WILL BREAK SESSION.JS STORAGE",
    verified: Object.fromEntries(Array.from(verified.entries()).map(([roomToken, verifiedSet]) => [
      roomToken,
      Array.from(verifiedSet)
    ])),
    sessions: Object.fromEntries(Array.from(sessions.entries()).map(([roomToken, session]) => [
      roomToken,
      decode(session.getMnemonic()!)
    ])),
    db: dbJson
  })
  await fs.writeFile(path.join(__dirname, './db.json'), dbSerialized)
}

let lastChange: number | undefined = undefined
const promptPersist = async () => {
  if (lastChange === undefined) return await persist()
  else {
    if(Date.now() - lastChange > 1000 * 5) {
      await persist()
    }
  }
}

self.addEventListener('message', async event => {
  if (event.data.ref) {
    switch(event.data.type) {
      case 'onBeforePost': {
        await onBeforePost(event.data)
        break
      }
      default:
        postMessage({ ok: false, ref: event.data.ref })
        break
    }
  } else {
    switch (event.data.type) {
      case 'onRecentMessagesRequest': {
        const user = event.data.payload.user
        if (!user) return
        const roomToken = event.data.payload.room.token
        const verifiedSet = verified.get(roomToken)
        if (!verifiedSet || verifiedSet.has(user.id)) {
          return
        }
        if (user.admin || user.moderator || user.roomPermissions.admin || user.roomPermissions.moderator) {
          verifiedSet.add(user.id)
          promptPersist()
          return
        }
        const roomDb = db.get(roomToken)
        if (!roomDb) {
          return
        }
        const record = roomDb.get(user.session_id)
        if (!record || (record.captchaAnswer && record.captchaSentAt && Date.now() - record.captchaSentAt > 1000 * 60 * 60 * 24 * 30)) {
          onUserJoin({ user, room: event.data.payload.room, server: event.data.payload.server })
        }
        break
      }
      case 'onLoad': {
        addModerator(event.data.payload.rooms, event.data.payload.server.pk)
        break
      }
      default:
        break
    }
  }
})

let blindedSessionId: string
async function addModerator(rooms: { id: number, token: string }[], pk: string) {
  for (const room of rooms) {
    const session = sessions.get(room.token)
    if (!session) continue
    blindedSessionId = session.blindSessionId(pk)
    self.postMessage({
      method: 'setRoomModerator',
      room: room.token,
      user: blindedSessionId,
      visible: true
    })
  }
}

async function onBeforePost(evData: any) {
  const user = evData.payload.message.author
  if (!user) return
  if (user.admin || user.moderator || user.roomPermissions.admin || user.roomPermissions.moderator) {
    postMessage({ ok: true, action: 'send', ref: evData.ref })
    return
  }
  const room = evData.payload.message.room
  const server = evData.payload.server
  const verifiedSet = verified.get(room.token)
  if (!verifiedSet || verifiedSet.has(user.id)) {
    postMessage({ ok: true, action: 'send', ref: evData.ref })
  } else {
    const roomConfig = config.rooms[room.token]
    if (roomConfig.captcha) {
      const roomDb = db.get(room.token)
      if (!roomDb) return
      const captcha = roomDb?.get(user.session_id)
      if (captcha) {
        if (captcha.messageId !== undefined) {
          postMessage({
            method: 'deleteMessage',
            room: room.id,
            user: blindedSessionId,
            messageId: captcha.messageId
          })
        }
        if(evData.payload.message.text && evData.payload.message.text?.toLowerCase() === captcha.captchaAnswer?.toLowerCase()) {
          verifiedSet.add(user.id)
          postMessage({ ok: true, action: 'drop', ref: evData.ref })
          const session = sessions.get(room.token)
          if (session && roomConfig.verified_message) {
            const { data, signature } = session.encodeSogsMessage({
              serverPk: server.pk,
              text: roomConfig.verified_message
            })
            self.postMessage({
              method: 'sendMessage',
              user: blindedSessionId,
              room: room.id,
              data: data,
              signature: signature,
              whisperTo: user.session_id,
            })
          }
          return
        }
      }
      postMessage({ ok: true, action: 'reject', ref: evData.ref })
      const { captchaId, captchaImage, captchaAnswer } = await generateCaptcha({
        difficult: roomConfig.captcha_difficult ?? false,
        room: room,
        userSessionId: user.session_id
      })
      const session = sessions.get(room.token)
      if (!session) return
      const { data, signature } = session.encodeSogsMessage({
        serverPk: server.pk,
        ...(captchaImage && captchaId !== undefined && {
          attachments: [{
            id: captchaId,
            url: `${server.url}/room/${room.token}/file/${captchaId}`,
            contentType: 'image/png',
            size: captchaImage.byteLength,
            fileName: `captcha-${nanoid()}-${Date.now()}.png`
          }]
        })
      })
      const sendMessageRequestId = nanoid()
      self.postMessage({
        method: 'sendMessage',
        user: blindedSessionId,
        room: room.id,
        data: data,
        signature: signature,
        whisperTo: user.session_id,
        ref: sendMessageRequestId
      })
      const messageId = await new Promise<number>(resolve => {
        self.addEventListener('message', event => {
          if (event.data.response_ref === sendMessageRequestId) {
            resolve(event.data.id)
          }
        })
      })
      roomDb.set(user.session_id, {
        captchaAnswer, 
        captchaSentAt: Date.now(),
        messageId
      })
    } else {
      verifiedSet.add(evData.payload.user.id)
      postMessage({ ok: true, action: 'send', ref: evData.ref })
    }
  }
}

async function onUserJoin({ user, room, server }: {
  user: { id: number, session_id: string }
  room: { id: number, token: string }
  server: { pk: string, url: string }
}) {
  const roomConfig = config.rooms[room.token]
  const session = sessions.get(room.token)
  const roomDb = db.get(room.token)
  const verifiedSet = verified.get(room.token)
  if (!roomConfig || !session || !roomDb || !verifiedSet) return
  if(roomConfig.message) {
    let captchaImage: Buffer | undefined, captchaId: number | undefined

    if(roomConfig.captcha) {
      const captcha = await generateCaptcha({
        difficult: roomConfig.captcha_difficult ?? false,
        room: { id: room.id, token: room.token },
        userSessionId: user.session_id
      })
      captchaImage = captcha.captchaImage
      captchaId = captcha.captchaId
      roomDb.set(user.session_id, {
        captchaAnswer: captcha.captchaAnswer,
        captchaSentAt: Date.now(),
        messageId: undefined
      })
    } else {
      verifiedSet.add(user.id)
      roomDb.set(user.session_id, {})
    }

    const { data, signature } = session.encodeSogsMessage({
      serverPk: server.pk,
      text: roomConfig.message,
      ...(captchaImage && captchaId !== undefined && {
        attachments: [{
          id: captchaId,
          url: `${server.url}/room/${room.token}/file/${captchaId}`,
          contentType: 'image/png',
          size: captchaImage.byteLength,
          fileName: `captcha-${nanoid() }-${Date.now()}.png`
        }]
      })
    })
    self.postMessage({
      method: 'sendMessage',
      user: blindedSessionId,
      room: room.id,
      data: data,
      signature: signature,
      whisperTo: user.session_id,
    })

    // TODO: figure out how DMs work and why signature does not work
    // self.postMessage({
    //   method: 'sendDm',
    //   from: blindedSessionId,
    //   to: user.session_id,
    //   message: data
    // })
  }

  promptPersist()
}

async function generateCaptcha({ difficult, room, userSessionId }: {
  difficult: boolean
  room: { id: number, token: string }
  userSessionId: string
}): Promise<{
  captchaId: number
  captchaImage: Buffer
  captchaAnswer: string
}> {
  const { answer, captcha } = await generate(difficult ? 5 : 4, {
    width: 200,
    height: 200,
    backgroundColor: '#2D2D2D',
    fontColor: '#31F196',
    lineColor: '#31F196',
    font: 'Arial',
    fontSize: 53,
    lineWidth: 8,
    lineAmount: 8,
    fontWeight: difficult ? 900 : 400
  })

  const roomDb = db.get(room.token)
  if(!roomDb) throw new Error('Room not found')

  const uploadRequestRef = nanoid()
  postMessage({
    method: 'uploadFile',
    uploader: blindedSessionId,
    room: room.id,
    file: captcha,
    ref: uploadRequestRef
  })
  const captchaId = await new Promise<number>(resolve => {
    self.addEventListener('message', event => {
      if (event.data.response_ref === uploadRequestRef) {
        resolve(event.data.id)
      }
    })
  })
  const captchaImage = captcha
  return { captchaId, captchaImage, captchaAnswer: answer }
}

self.addEventListener('close', async () => {
  await persist()
})