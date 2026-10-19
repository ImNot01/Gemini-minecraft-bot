// Minecraft AI bot (mineflayer + Gemini)
// Talks like Gemini, answers questions, and obeys chat commands
// ("come to me", "hold shield", "build a house", "follow me", "guard"...).
//
// Setup:   npm install
// Run:     $env:GEMINI_API_KEY="your_key"; $env:MC_OWNER="YourMinecraftName"; npm start
// Get a free key: https://aistudio.google.com/apikey

const readline = require('node:readline')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3').Vec3

// ================= CONFIG (edit these) =================
const CONFIG = {
  host: process.env.MC_HOST || 'idk03.aternos.me',
  port: Number(process.env.MC_PORT) || 36835,
  username: process.env.MC_USER || 'IDK03',
  auth: process.env.MC_AUTH || 'offline',
  version: process.env.MC_VERSION || false,

  reconnectDelayMs: 5000,
  antiAfkMinMs: 600,
  antiAfkMaxMs: 1500,

  password: process.env.MC_PASS || 'ChangeThisPassword123',
  joinCommands: [],

  // ---------- AI ----------
  geminiKey: process.env.GEMINI_API_KEY || 'AQ.Ab8RN6Ld6zd1jCQhlnEP6Q6LW4sIRG8Gbn4R90ewTATAMuhFvw',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',

  // Players allowed to give COMMANDS (comma separated, case-insensitive).
  // Owners can talk to the bot without any prefix: just type "come to me".
  // Everyone else can only chat/ask questions, and only by saying a trigger word.
  // If left empty, anyone can command the bot, but must use a trigger word.
  owners: (process.env.MC_OWNER || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  triggers: ['bot', 'ai', 'idk03', 'gemini'],

  // Building: if the bot is OP, set true to build instantly with /fill and /setblock.
  // If false, it places blocks from its inventory (or from the creative menu in creative mode).
  buildWithCommands: process.env.MC_BUILD_CMDS === 'true',
  maxBuildBlocks: 2500,
}
// =======================================================

let bot = null
let antiAfkTimer = null
let reconnecting = false

// ---- task / state ----
let taskToken = 0          // incremented to cancel the running task
let busy = false           // true while an AI action is running
let shieldTimer = null
let guardOn = false
let history = []           // Gemini conversation history
let queue = Promise.resolve()
let terminalInterface = null

class Cancelled extends Error {}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a)
const check = (token) => { if (token !== taskToken) throw new Cancelled() }

// =====================================================
//                    BOT SETUP
// =====================================================
function createBot() {
  log(`Connecting to ${CONFIG.host}:${CONFIG.port} as ${CONFIG.username}...`)

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    auth: CONFIG.auth,
    version: CONFIG.version || undefined,
    checkTimeoutInterval: 60 * 1000,
  })

  bot.loadPlugin(pathfinder)

  bot.once('spawn', async () => {
    log('Spawned in the world. AI + anti-AFK started.')
    reconnecting = false

    const movements = new Movements(bot)
    movements.canDig = false          // don't break things while walking
    movements.allowSprinting = true
    bot.pathfinder.setMovements(movements)

    for (const cmd of CONFIG.joinCommands) {
      await sleep(1500)
      bot.chat(cmd)
    }

    if (!CONFIG.geminiKey) log('WARNING: GEMINI_API_KEY is not set. AI replies are disabled.')
    startAntiAfk()
  })

  // Knockback fallback (unchanged)
  bot.on('entityHurt', (entity) => {
    if (!bot.entity || entity !== bot.entity) return
    const before = bot.entity.velocity.clone()
    setTimeout(() => {
      if (!bot || !bot.entity) return
      const v = bot.entity.velocity
      const moved = Math.hypot(v.x - before.x, v.z - before.z)
      if (moved > 0.05) return
      const attacker = bot.nearestEntity(
        (e) => e.type === 'player' && e.position.distanceTo(bot.entity.position) < 6
      )
      if (!attacker) return
      const dx = bot.entity.position.x - attacker.position.x
      const dz = bot.entity.position.z - attacker.position.z
      const len = Math.hypot(dx, dz) || 1
      bot.entity.velocity.x += (dx / len) * 0.4
      bot.entity.velocity.z += (dz / len) * 0.4
      bot.entity.velocity.y += 0.36
    }, 60)
  })

  bot.on('health', () => {
    if (bot.health <= 0) log('Bot died, waiting for respawn...')
  })
  bot.on('death', () => {
    log('Bot died.')
    cancelTask()
  })
  bot.on('kicked', (reason) => {
    log('Kicked:', typeof reason === 'string' ? reason : JSON.stringify(reason))
  })
  bot.on('error', (err) => log('Error:', err.code || err.message))
  bot.on('end', (reason) => {
    log('Disconnected:', reason)
    cancelTask()
    stopAntiAfk()
    scheduleReconnect()
  })

  // Auto register / login
  let lastAuthAt = 0
  bot.on('messagestr', (msg) => {
    if (!msg.trim()) return
    log('[chat]', msg)
    const text = msg.toLowerCase()
    const now = Date.now()
    if (now - lastAuthAt < 3000) return
    if (text.includes('/register') || text.includes('/reg ')) {
      lastAuthAt = now
      log('Server asked to register -> registering...')
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    } else if (text.includes('/login') || text.includes('/l ')) {
      lastAuthAt = now
      log('Server asked to login -> logging in...')
      bot.chat(`/login ${CONFIG.password}`)
    }
  })

  // Player chat -> Gemini
  bot.on('chat', (username, message) => {
    if (!bot || username === bot.username) return
    if (!shouldHandle(username, message)) return
    enqueueChat(username, message)
  })
}

function enqueueChat(username, message, source = 'minecraft') {
  queue = queue
    .then(() => handleChat(username, message, source))
    .catch((e) => log('Chat handler error:', e.message))
}

function startTerminalChat() {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  let terminalClosed = false
  terminalInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  })

  const prompt = () => {
    if (interactive && !terminalClosed) terminalInterface.prompt()
  }

  if (interactive) {
    console.log('Terminal chat ready. Type /help for usage; press Ctrl+C to stop the bot.')
    terminalInterface.setPrompt('You> ')
    prompt()
  }

  terminalInterface.on('line', (input) => {
    const message = input.trim()
    if (!message) {
      prompt()
      return
    }
    if (message === '/help') {
      console.log('Type a message or instruction for the bot. Replies also appear in Minecraft chat.')
      console.log('Set MC_OWNER to your Minecraft name for commands that target you, such as come and follow.')
      prompt()
      return
    }
    if (!bot || !bot.entity) {
      log('The bot is not connected yet; wait for it to spawn before chatting.')
      prompt()
      return
    }
    if (!CONFIG.geminiKey) {
      log('Set GEMINI_API_KEY before starting the bot to enable AI chat.')
      prompt()
      return
    }

    const speaker = CONFIG.owners[0] || 'Terminal'
    enqueueChat(speaker, message, 'terminal')
    queue.finally(prompt)
  })

  terminalInterface.on('close', () => { terminalClosed = true })
  terminalInterface.on('SIGINT', () => process.emit('SIGINT'))
}

function scheduleReconnect() {
  if (reconnecting) return
  reconnecting = true
  log(`Reconnecting in ${CONFIG.reconnectDelayMs / 1000}s...`)
  setTimeout(() => {
    reconnecting = false
    createBot()
  }, CONFIG.reconnectDelayMs)
}

// =====================================================
//                      GEMINI
// =====================================================
const SYSTEM_PROMPT = `You are the brain of a Minecraft bot player named "${CONFIG.username}", powered by Gemini.
You chat with players like a friendly, smart assistant (like Gemini) AND you control the bot body by returning actions.

ALWAYS answer with a single JSON object, nothing else:
{"reply": "<short chat message>", "actions": [ ...zero or more actions... ]}

Rules for "reply":
- Plain text only, no markdown, no emojis, no newlines. Keep it under ~250 characters unless the player asks for a long explanation (then max ~600).
- Answer any question helpfully (Minecraft or anything else). Reply in the same language the player uses.
- When you do an action, say briefly what you're doing ("On my way!", "Building a house, give me a moment.").
- If the player is only chatting or asking something, use "actions": [].
- When an owner gives a clear Minecraft command, carry it out using the available actions instead of refusing or only describing what you would do. Do not refuse combat because you are friendly or peaceful; this is a Minecraft game action. For "hit me" or "attack me", target the speaking player.
- For "mine [resource]", use the mine action. If the required pickaxe is missing or too weak, ask the owner to provide a suitable pickaxe instead of pretending to mine.

Available actions (executed in order):
- {"type":"come"}                                   walk to the speaker
- {"type":"follow","player":"<name optional>"}      keep following the speaker (or named player)
- {"type":"goto","x":0,"y":64,"z":0}                walk to coordinates
- {"type":"stop"}                                   stop everything (walking, following, shield, guard)
- {"type":"shield","on":true}                       hold up (true) or lower (false) the shield; auto-equips it to the off-hand
- {"type":"equip","item":"diamond_sword","slot":"hand"}   slot: hand | off-hand | head | torso | legs | feet
- {"type":"attack","target":"<player name | me | mob name | hostile>"}   fight until it dies
- {"type":"guard","on":true}                        automatically fight hostile mobs nearby
- {"type":"mine","resource":"iron","count":8}        find and mine nearby loaded ore (count optional; default 8)
- {"type":"drop","item":"cobblestone","count":16}   drop items (count optional)
- {"type":"look","at":"me"}                         face the speaker
- {"type":"jump"}
- {"type":"wait","seconds":2}
- {"type":"build","ops":[ ... ]}                    build a structure, see below

BUILD action. Coordinates are offsets from an origin point placed a few blocks in front of the bot.
Axes: +x = east, +z = south, +y = up. The structure should occupy x,z >= 0 and y >= 0 (y=0 is the ground level layer, so a floor is at y=0 and walls start at y=1).
ops (max ~30 ops, be efficient, use boxes):
  {"shape":"box","from":[x1,y1,z1],"to":[x2,y2,z2],"block":"oak_planks","hollow":false}
      hollow:true builds only the outer shell (walls+floor+roof) of the box.
  {"shape":"block","at":[x,y,z],"block":"torch"}
Use valid Minecraft block ids (e.g. oak_planks, cobblestone, glass, oak_door, torch, stone_bricks). Use "air" to carve out openings (doors/windows).
Build order matters: draw big shells first, then carve air for doors/windows, then place details.
Pick sensible sizes (a small house ~7x5x7) unless the player gives sizes/materials. If they name a material, use it.

Context about the world is provided with every message. Never invent coordinates for "me" - use "come" instead.
Mine searches loaded nearby chunks up to 48 blocks away; report clearly if no matching ore is available there.
If a request is impossible or unclear, just explain in "reply" with actions [].`

async function askGemini(userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.geminiModel}:generateContent?key=${CONFIG.geminiKey}`
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [...history, { role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = await res.json()
  const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim()
  if (!raw) throw new Error('Gemini returned an empty response')

  let parsed
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim())
  } catch {
    parsed = { reply: raw.slice(0, 250), actions: [] } // model ignored JSON: just chat it
  }

  history.push({ role: 'user', parts: [{ text: userText }] })
  history.push({ role: 'model', parts: [{ text: raw }] })
  if (history.length > 24) history = history.slice(-24)

  return {
    reply: typeof parsed.reply === 'string' ? parsed.reply : '',
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
  }
}

// =====================================================
//                  CHAT HANDLING
// =====================================================
function isOwner(name) {
  return CONFIG.owners.length === 0 || CONFIG.owners.includes(name.toLowerCase())
}

function hasTrigger(msg) {
  const m = msg.toLowerCase()
  return CONFIG.triggers.some((t) => new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(m))
}

function shouldHandle(username, msg) {
  if (!CONFIG.geminiKey) return false
  if (CONFIG.owners.length > 0 && CONFIG.owners.includes(username.toLowerCase())) return true
  return hasTrigger(msg)
}

function describeContext(speaker) {
  const p = bot.entity.position
  const sp = bot.players[speaker]?.entity
  const items = bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', ') || 'empty'
  const nearby = Object.values(bot.players)
    .filter((pl) => pl.username !== bot.username && pl.entity)
    .map((pl) => pl.username)
  const hostiles = Object.values(bot.entities)
    .filter((e) => e.type === 'hostile' && e.position.distanceTo(p) < 16).length
  const dirs = ['south', 'west', 'north', 'east']
  const facing = dirs[Math.round((((bot.entity.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) % 4]
  return [
    `Bot position: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} (facing ${facing})`,
    `Bot health: ${bot.health}, food: ${bot.food}, gamemode: ${bot.game?.gameMode}`,
    `Bot holding: ${bot.heldItem ? bot.heldItem.name : 'nothing'}`,
    `Bot inventory: ${items}`,
    `Speaker "${speaker}" ${sp ? `is at ${sp.position.x.toFixed(1)}, ${sp.position.y.toFixed(1)}, ${sp.position.z.toFixed(1)}` : 'is not visible to the bot (too far away)'}`,
    `Players in view: ${nearby.join(', ') || 'none'}`,
    `Hostile mobs within 16 blocks: ${hostiles}`,
    `Bot is currently ${busy ? 'busy with a task' : 'idle'}.`,
  ].join('\n')
}

async function handleChat(username, message, source = 'minecraft') {
  const owner = isOwner(username)
  const prompt = `${describeContext(username)}\n\n${owner ? '' : '(This player is NOT an owner: chat only, never return actions.)\n'}${username} says: ${message}`

  let result
  try {
    result = await askGemini(prompt)
  } catch (e) {
    log('Gemini error:', e.message)
    say(e.message.includes('429') ? 'I am getting too many requests, try again in a minute.' : 'My AI brain had an error, try again.')
    return
  }

  if (result.reply) {
    if (source === 'terminal') log('[bot]', result.reply)
    await say(result.reply)
  }

  if (owner && result.actions.length) {
    taskToken++                       // cancel whatever was running
    const token = taskToken
    runActions(result.actions, username, token) // not awaited: chat stays responsive
  }
}

async function say(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim()
  if (!clean || !bot) return
  const chunks = clean.match(/.{1,200}(\s|$)/g) || [clean]
  for (const c of chunks) {
    if (!bot) return
    bot.chat(c.trim())
    await sleep(700)
  }
}

// =====================================================
//                   ACTION RUNNER
// =====================================================
function cancelTask() {
  taskToken++
  busy = false
  guardOn = false
  setShield(false)
  try { if (bot && bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
  try { if (bot && bot.entity) bot.clearControlStates() } catch {}
}

async function runActions(actions, speaker, token) {
  busy = true
  try {
    for (const a of actions) {
      check(token)
      log('Action:', JSON.stringify(a).slice(0, 200))
      await runAction(a, speaker, token)
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) {
      log('Action error:', e.message)
      say(`I could not finish that: ${e.message}`.slice(0, 200))
    }
  } finally {
    if (token === taskToken) busy = guardOn
  }
}

async function runAction(a, speaker, token) {
  switch (a.type) {
    case 'come': {
      const e = bot.players[speaker]?.entity
      if (!e) return say("I can't see you, you are too far away.")
      await goTo(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), token)
      return
    }
    case 'follow': {
      const name = a.player || speaker
      const e = bot.players[name]?.entity
      if (!e) return say(`I can't see ${name}.`)
      bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true)
      return
    }
    case 'goto': {
      const { x, y, z } = a
      if ([x, y, z].some((n) => typeof n !== 'number')) return
      await goTo(new goals.GoalNear(x, y, z, 1), token)
      return
    }
    case 'stop':
      taskToken++ // also cancels the rest of this action list
      cancelTask()
      return
    case 'shield':
      await setShield(a.on !== false)
      return
    case 'equip': {
      const item = findItem(a.item)
      if (!item) return say(`I don't have ${a.item}.`)
      const slot = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(a.slot) ? a.slot : 'hand'
      await bot.equip(item, slot)
      return
    }
    case 'attack':
      await attackTarget(a.target, speaker, token)
      return
    case 'guard':
      guardOn = a.on !== false
      if (guardOn) await guardLoop(token)
      return
    case 'mine':
      await mineResource(a.resource, a.count, token)
      return
    case 'drop': {
      const item = findItem(a.item)
      if (!item) return say(`I don't have ${a.item}.`)
      await bot.toss(item.type, null, a.count ? Math.min(a.count, item.count) : item.count)
      return
    }
    case 'look': {
      const e = bot.players[speaker]?.entity
      if (e) await bot.lookAt(e.position.offset(0, e.height * 0.9, 0))
      return
    }
    case 'jump':
      bot.setControlState('jump', true)
      await sleep(150)
      bot.setControlState('jump', false)
      return
    case 'wait':
      await sleep(Math.min(Number(a.seconds) || 1, 30) * 1000)
      return
    case 'build':
      await buildStructure(a.ops, token)
      return
    default:
      log('Unknown action type:', a.type)
  }
}

async function goTo(goal, token) {
  check(token)
  try {
    await bot.pathfinder.goto(goal)
  } catch (e) {
    check(token) // if cancelled, throw Cancelled
    throw new Error('I cannot reach that place')
  }
}

function findItem(name) {
  if (!name) return null
  const n = String(name).toLowerCase()
  return bot.inventory.items().find((i) => i.name === n) ||
    bot.inventory.items().find((i) => i.name.includes(n)) || null
}

// ---------------- Shield ----------------
async function setShield(on) {
  if (shieldTimer) { clearInterval(shieldTimer); shieldTimer = null }
  if (!bot || !bot.entity) return
  if (!on) {
    try { bot.deactivateItem() } catch {}
    return
  }
  const shield = findItem('shield')
  if (!shield) return say("I don't have a shield.")
  const offhand = bot.inventory.slots[45]
  if (!offhand || offhand.name !== 'shield') await bot.equip(shield, 'off-hand')
  const raise = () => { try { bot.activateItem(true) } catch {} } // true = off-hand
  raise()
  shieldTimer = setInterval(raise, 2000) // keep it raised
}

// ---------------- Combat ----------------
function findTarget(name) {
  const n = String(name || '').toLowerCase()
  const me = bot.entity.position
  if (!n || n === 'hostile' || n === 'nearest_hostile' || n === 'mob') {
    return bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(me) < 24)
  }
  return bot.nearestEntity((e) =>
    (e.username && e.username.toLowerCase() === n) ||
    (e.name && e.name.toLowerCase() === n) ||
    (e.displayName && String(e.displayName).toLowerCase() === n)
  )
}

async function equipBestWeapon() {
  const weapons = bot.inventory.items().filter((i) => /sword|axe/.test(i.name))
  if (!weapons.length) return
  const rank = (i) => ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].findIndex((m) => i.name.startsWith(m))
  weapons.sort((a, b) => (/sword/.test(b.name) - /sword/.test(a.name)) || rank(a) - rank(b))
  try { await bot.equip(weapons[0], 'hand') } catch {}
}

async function attackTarget(name, speaker, token) {
  const targetName = ['me', 'myself', 'the speaker', 'speaker'].includes(String(name || '').toLowerCase())
    ? speaker
    : name
  const target = findTarget(targetName)
  if (!target) return say(`I can't find ${name || 'a target'} nearby.`)
  await equipBestWeapon()
  const end = Date.now() + 45000
  while (Date.now() < end) {
    check(token)
    if (!target.isValid) break
    const d = bot.entity.position.distanceTo(target.position)
    if (d > 3) {
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
    } else {
      bot.pathfinder.setGoal(null)
      await bot.lookAt(target.position.offset(0, target.height * 0.9, 0))
      bot.attack(target)
    }
    await sleep(550)
  }
  bot.pathfinder.setGoal(null)
}

async function mineResource(resource, requestedCount, token) {
  const requested = String(resource || '').toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  if (!requested) return say('Tell me which resource to mine.')

  const ore = requested.replace(/^deepslate_/, '').replace(/^nether_/, '').replace(/_ore$/, '')
  const targets = ore === 'ancient_debris'
    ? new Set(['ancient_debris'])
    : new Set([`${ore}_ore`, `deepslate_${ore}_ore`])
  if (ore === 'quartz') targets.add('nether_quartz_ore')

  const knownTargets = [...targets].filter((name) => bot.registry.blocksByName[name])
  if (!knownTargets.length) return say(`I don't know a mineable ore for "${resource}".`)

  if (!bot.inventory.items().some((item) => /_pickaxe$/.test(item.name))) {
    return say(`I need a pickaxe to mine ${ore}. Please give me one and ask again.`)
  }

  const requestedAmount = Number(requestedCount)
  const amount = Number.isFinite(requestedAmount) && requestedAmount > 0
    ? Math.min(Math.floor(requestedAmount), 64)
    : 8
  const matchingNames = new Set(knownTargets)
  const unreachable = new Set()
  let mined = 0

  while (mined < amount) {
    check(token)
    const positions = bot.findBlocks({
      matching: (block) => block && matchingNames.has(block.name),
      maxDistance: 48,
      count: 32,
    })
    const candidates = positions
      .filter((position) => !unreachable.has(position.toString()))
      .map((position) => bot.blockAt(position))
      .filter((block) => block && matchingNames.has(block.name))
    if (!candidates.length) break

    let minedCandidate = false
    for (const block of candidates) {
      check(token)
      const pickaxes = bot.inventory.items().filter((item) => /_pickaxe$/.test(item.name))
      const usablePickaxes = pickaxes.filter((item) => block.canHarvest(item.type))
      if (!usablePickaxes.length) {
        return say(`I need a stronger pickaxe to mine ${block.name.replace(/_/g, ' ')}. Please give me one and ask again.`)
      }
      usablePickaxes.sort((a, b) => {
        const rank = (item) => ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
          .findIndex((material) => item.name.startsWith(material))
        return rank(a) - rank(b)
      })

      try {
        await goTo(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3), token)
      } catch (e) {
        if (e instanceof Cancelled) throw e
        unreachable.add(block.position.toString())
        continue
      }
      check(token)
      const currentBlock = bot.blockAt(block.position)
      if (!currentBlock || !matchingNames.has(currentBlock.name)) {
        unreachable.add(block.position.toString())
        continue
      }

      const pickaxe = usablePickaxes.find((item) => bot.inventory.items().some((held) => held.slot === item.slot))
      if (!pickaxe) return say(`I no longer have a usable pickaxe for ${ore}. Please give me one and ask again.`)
      await bot.equip(pickaxe, 'hand')
      if (!bot.canDigBlock(currentBlock)) {
        unreachable.add(block.position.toString())
        continue
      }
      try {
        await bot.dig(currentBlock)
        mined++
        minedCandidate = true
        break
      } catch (e) {
        if (e instanceof Cancelled) throw e
        log(`Could not mine ${currentBlock.name}:`, e.message)
        unreachable.add(block.position.toString())
      }
    }
    if (!minedCandidate && candidates.every((block) => unreachable.has(block.position.toString()))) break
  }

  if (mined === 0) return say(`I couldn't find reachable ${ore} ore in the nearby loaded area. Please bring me closer to an ore vein.`)
  await say(mined < amount
    ? `I mined ${mined} ${ore} ore block${mined === 1 ? '' : 's'}, but couldn't find more nearby.`
    : `I mined ${mined} ${ore} ore block${mined === 1 ? '' : 's'}.`)
}

async function guardLoop(token) {
  while (guardOn) {
    check(token)
    const mob = bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 10)
    if (mob) {
      await equipBestWeapon()
      const end = Date.now() + 15000
      while (guardOn && mob.isValid && Date.now() < end) {
        check(token)
        if (bot.entity.position.distanceTo(mob.position) > 3) {
          bot.pathfinder.setGoal(new goals.GoalFollow(mob, 2), true)
        } else {
          bot.pathfinder.setGoal(null)
          await bot.lookAt(mob.position.offset(0, mob.height * 0.9, 0))
          bot.attack(mob)
        }
        await sleep(550)
      }
      bot.pathfinder.setGoal(null)
    }
    await sleep(500)
  }
}

// ---------------- Building ----------------
function cardinal() {
  // direction the bot is facing, snapped to an axis (mineflayer yaw: 0 = north(-z), pi/2 = west(-x))
  const yaw = bot.entity.yaw
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  return Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
}

function expandOps(ops, origin) {
  const map = new Map()
  const put = (x, y, z, block) => map.set(`${x},${y},${z}`, { pos: new Vec3(origin.x + x, origin.y + y, origin.z + z), block })
  for (const op of ops) {
    if (!op || typeof op.block !== 'string') continue
    const block = op.block.replace(/^minecraft:/, '')
    if (op.shape === 'block' && Array.isArray(op.at)) {
      put(Math.round(op.at[0]), Math.round(op.at[1]), Math.round(op.at[2]), block)
    } else if (op.shape === 'box' && Array.isArray(op.from) && Array.isArray(op.to)) {
      const [x1, y1, z1] = op.from.map(Math.round)
      const [x2, y2, z2] = op.to.map(Math.round)
      const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
      const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)]
      const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
      if ((bx - ax + 1) * (by - ay + 1) * (bz - az + 1) > 20000) continue
      for (let x = ax; x <= bx; x++)
        for (let y = ay; y <= by; y++)
          for (let z = az; z <= bz; z++) {
            const edge = x === ax || x === bx || y === ay || y === by || z === az || z === bz
            if (!op.hollow || edge) put(x, y, z, block)
          }
    }
  }
  return [...map.values()]
}

async function buildStructure(ops, token) {
  if (!Array.isArray(ops) || !ops.length) return say('I have no blueprint to build.')

  const base = bot.entity.position.floored()
  const origin = base.plus(cardinal().scaled(3)).offset(0, -1, 0) // y=0 layer = the ground the bot stands on
  const blocks = expandOps(ops, new Vec3(origin.x, origin.y, origin.z))
  if (!blocks.length) return say('That blueprint was empty.')
  if (blocks.length > CONFIG.maxBuildBlocks) return say(`That is too big (${blocks.length} blocks). Ask for something smaller.`)

  // Instant mode: /fill and /setblock (needs OP)
  if (CONFIG.buildWithCommands) {
    for (const op of ops) {
      check(token)
      const block = String(op.block || '').replace(/^minecraft:/, '')
      if (!block) continue
      if (op.shape === 'box' && op.from && op.to) {
        const [x1, y1, z1] = op.from, [x2, y2, z2] = op.to
        const mode = op.hollow ? ' hollow' : ''
        bot.chat(`/fill ${origin.x + x1} ${origin.y + y1} ${origin.z + z1} ${origin.x + x2} ${origin.y + y2} ${origin.z + z2} ${block}${mode}`)
      } else if (op.shape === 'block' && op.at) {
        bot.chat(`/setblock ${origin.x + op.at[0]} ${origin.y + op.at[1]} ${origin.z + op.at[2]} ${block}`)
      }
      await sleep(400)
    }
    return say('Done building!')
  }

  // Survival/creative mode: place blocks one by one
  blocks.sort((a, b) => a.pos.y - b.pos.y || a.pos.distanceTo(base) - b.pos.distanceTo(base))
  const missing = new Set()
  let placed = 0
  for (const { pos, block } of blocks) {
    check(token)
    try {
      const ok = await placeAt(pos, block, token)
      if (ok === 'missing') missing.add(block)
      else if (ok) placed++
    } catch (e) {
      if (e instanceof Cancelled) throw e
      log('Place error:', e.message)
    }
  }
  if (missing.size) await say(`Built ${placed} blocks. I ran out of: ${[...missing].join(', ')}.`)
  else await say(`Finished building! Placed ${placed} blocks.`)
}

async function ensureItem(name) {
  let item = bot.inventory.items().find((i) => i.name === name)
  if (item) return item
  if (bot.game?.gameMode === 'creative' && bot.registry.itemsByName[name]) {
    const Item = require('prismarine-item')(bot.registry)
    await bot.creative.setInventorySlot(36, new Item(bot.registry.itemsByName[name].id, 64))
    return bot.inventory.slots[36]
  }
  return null
}

async function placeAt(pos, blockName, token) {
  const existing = bot.blockAt(pos)
  if (!existing) return false
  if (blockName === 'air') {
    if (existing.name === 'air') return true
    await goTo(new goals.GoalNear(pos.x, pos.y, pos.z, 4), token)
    await bot.dig(existing)
    return true
  }
  if (existing.name === blockName) return true
  if (existing.boundingBox === 'block' && existing.name !== blockName) return false // occupied

  const item = await ensureItem(blockName)
  if (!item) return 'missing'
  await bot.equip(item, 'hand')

  // get within reach, and don't stand inside the target block
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.5) {
    await goTo(new goals.GoalNear(pos.x, pos.y, pos.z, 3), token)
  }
  const me = bot.entity.position.floored()
  if ((me.x === pos.x && me.z === pos.z && (me.y === pos.y || me.y === pos.y - 1))) {
    await goTo(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 2)), token)
  }

  const faces = [[0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]]
  for (const f of faces) {
    const ref = bot.blockAt(pos.offset(f[0], f[1], f[2]))
    if (ref && ref.boundingBox === 'block') {
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5))
      await bot.placeBlock(ref, new Vec3(-f[0], -f[1], -f[2]))
      await sleep(120)
      return true
    }
  }
  return false // nothing to attach to yet
}

// =====================================================
//                     ANTI-AFK
// =====================================================
function stopAntiAfk() {
  if (antiAfkTimer) clearTimeout(antiAfkTimer)
  antiAfkTimer = null
  if (bot && bot.entity) bot.clearControlStates()
}

function startAntiAfk() {
  stopAntiAfk()
  const loop = async () => {
    if (!bot || !bot.entity) return
    // don't fight with the AI: skip while a task / shield / following is active
    if (!busy && !shieldTimer && !bot.pathfinder.goal) {
      try { await doRandomAction() } catch (e) { log('Anti-AFK action error:', e.message) }
    }
    antiAfkTimer = setTimeout(loop, rand(CONFIG.antiAfkMinMs, CONFIG.antiAfkMaxMs))
  }
  antiAfkTimer = setTimeout(loop, rand(CONFIG.antiAfkMinMs, CONFIG.antiAfkMaxMs))
}

async function doRandomAction() {
  const actions = [lookAround, jump, walkShort, sneakTap, swingArm, lookAround]
  await actions[rand(0, actions.length - 1)]()
}

async function lookAround() {
  const yaw = Math.random() * Math.PI * 2
  const pitch = (Math.random() - 0.5) * (Math.PI / 3)
  await bot.look(yaw, pitch, false)
}

async function jump() {
  bot.setControlState('jump', true)
  await sleep(120)
  bot.setControlState('jump', false)
}

async function walkShort() {
  const dirs = ['forward', 'back', 'left', 'right']
  const dir = dirs[rand(0, dirs.length - 1)]
  const ms = rand(150, 450)
  bot.setControlState('sprint', Math.random() < 0.5)
  bot.setControlState(dir, true)
  await sleep(ms)
  bot.setControlState(dir, false)
  const opposite = { forward: 'back', back: 'forward', left: 'right', right: 'left' }[dir]
  bot.setControlState(opposite, true)
  await sleep(ms)
  bot.setControlState(opposite, false)
  bot.setControlState('sprint', false)
}

async function sneakTap() {
  bot.setControlState('sneak', true)
  await sleep(rand(150, 400))
  bot.setControlState('sneak', false)
}

async function swingArm() {
  bot.swingArm('right')
}

// ---------------- Safety / shutdown ----------------
process.on('uncaughtException', (err) => log('Uncaught exception:', err.message))
process.on('unhandledRejection', (err) => log('Unhandled rejection:', err && err.message))

process.on('SIGINT', () => {
  log('Shutting down...')
  if (terminalInterface) terminalInterface.close()
  cancelTask()
  stopAntiAfk()
  if (bot) bot.quit()
  setTimeout(() => process.exit(0), 500)
})

startTerminalChat()
createBot()
