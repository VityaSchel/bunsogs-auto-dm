import fs from 'fs/promises'
import path from 'path'
import z from 'zod'
import { Session } from '@session.js/client'
import { generateSeedHex } from '@session.js/keypair'
import { encode, decode } from '@session.js/mnemonic'
import { FileKeyvalStorage } from '@session.js/file-keyval-storage'

const configSerialized = await fs.readFile(path.join(__dirname, './config.json'), 'utf-8')
const config = z.object({
  rooms: z.record(
    z.string(),
    z.object({
      message: z.string().min(1).max(1024).optional(),
      captcha: z.boolean().optional(),
    })
  )
}).parse(JSON.parse(configSerialized))

const verified = new Map<string, Set<number>>()
// Room token -> Set of verified user IDs
const sessions = new Map<string, Session>()
// Room token -> Session instance
const db = new Map<string, Map<string, { captchaAnswer?: string, captchaSentAt?: number }>>()
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
  db?: Record<string, Record<string, { captchaAnswer?: string, captchaSentAt?: number }>>
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

  // TODO: get blinded id and make user moderator

  const roomDb = dbParsed.db?.[roomToken]
  db.set(roomToken, new Map(Object.entries(roomDb ?? {})))
}

const persist = async () => {
  const dbJson = Object.fromEntries(Array.from(db.entries()).map(([roomToken, roomDb]) => [
    roomToken,
    Object.fromEntries(Array.from(roomDb.entries()))
  ]))
  const dbSerialized = JSON.stringify({
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
    postMessage({ ok: false, ref: event.data.ref })
  } else {
    switch (event.data.type) {
      case 'onRecentMessagesRequest': {
        const user = event.data.payload.user
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
        const room = db.get(roomToken)
        if (!room) {
          return
        }
        const record = room.get(user.id)
        if (!record || (record.captchaAnswer && record.captchaSentAt && Date.now() - record.captchaSentAt > 1000 * 60 * 60 * 24 * 30)) {
          onUserJoin({ user, room: event.data.payload.room, serverPk: event.data.payload.server.pk })
        }
        break
      }
      default:
        break
    }
  }
})

async function onUserJoin({ user, room, serverPk }: {
  user: { session_id: string }
  room: { id: number, token: string }
  serverPk: string
}) {
  const roomConfig = config.rooms[room.token]
  const session = sessions.get(room.token)
  if (!roomConfig || !session) return
  if(roomConfig.message) {
    let captchaId: number // TODO: generate captcha

    const { data, signature, blindedSessionId } = session.encodeSogsMessage({
      serverPk: serverPk,
      text: user.session_id + ', ' + roomConfig.message,
      // ...(captcha && { attachment: { id: captchaId } })
    })

    // TODO: remove this and move in startup block
    postMessage({
      method: 'setRoomModerator',
      room: room.token,
      user: blindedSessionId,
      visible: true
    })

    await new Promise<void>(resolve => setTimeout(resolve, 10))

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

self.addEventListener('close', async () => {
  await persist()
})