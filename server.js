const express = require('express')
const http = require('http')
const { randomBytes, randomInt } = require('crypto')
const { Server } = require('socket.io')
const cors = require('cors')

const app = express()
const clientOrigins = (process.env.CLIENT_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map(origin => origin.trim()).filter(Boolean)
app.use(cors({ origin: clientOrigins }))
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: clientOrigins, methods: ['GET', 'POST'] }
})

const rooms = Object.create(null)
const DISCUSSION_DURATION = Number(process.env.DISCUSSION_DURATION_MS) || 5 * 60 * 1000
const VOTE_DURATION = Number(process.env.VOTE_DURATION_MS) || 15 * 1000
const NIGHT_DURATION = Number(process.env.NIGHT_DURATION_MS) || 30 * 1000
const ELIMINATION_REVEAL_DURATION = 3 * 1000
const NEXT_ROUND_REVEAL_DURATION = 5 * 1000

function generateRoomCode() {
  let code
  do {
    code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase()
  } while (rooms[code])
  return code
}

function assignRoles(players) {
  const mafiaCount = Math.round(players.length / 3)
  const roles = [
    ...Array(mafiaCount).fill('mafia'),
    ...Array(players.length - mafiaCount).fill('civilian')
  ]
  for (let i = roles.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [roles[i], roles[j]] = [roles[j], roles[i]]
  }
  return players.map((player, i) => ({
    socketId: player.id,
    name: player.name,
    isHost: player.isHost,
    role: roles[i],
    alive: true,
    id: i
  }))
}

function publicPlayers(players) {
  return players.map(({ id, name, isHost, alive }) => ({ id, name, isHost, alive }))
}

function publicLobbyPlayers(players) {
  return players.map(({ name, isHost }) => ({ name, isHost }))
}

function publicElimination(player) {
  return player ? { id: player.id, name: player.name, role: player.role } : null
}

function isRoomMember(room, socketId) {
  return room.players.some(player => player.id === socketId)
}

function startVoting(code) {
  const room = rooms[code]
  if (!room || room.state !== 'round') return
  if (room.roundTimer) clearTimeout(room.roundTimer)
  room.roundTimer = null
  room.state = 'voting'
  room.votes = {}
  room.voteStartTime = Date.now()
  const alivePlayers = room.assignedPlayers.filter(player => player.alive)

  io.to(code).emit('vote_started', {
    alivePlayers: publicPlayers(alivePlayers),
    startTime: room.voteStartTime,
    duration: VOTE_DURATION
  })

  room.voteTimer = setTimeout(() => resolveVote(code), VOTE_DURATION)
}

function beginRound(code) {
  const room = rooms[code]
  if (!room || room.state !== 'roleReveal') return
  if (room.transitionTimer) clearTimeout(room.transitionTimer)
  room.transitionTimer = null
  room.state = 'round'
  room.roundStartTime = Date.now()
  room.lastResult = null
  room.votes = {}
  room.roundTimer = setTimeout(() => startVoting(code), DISCUSSION_DURATION)
  io.to(code).emit('round_started', {
    round: room.round,
    startTime: room.roundStartTime,
    duration: DISCUSSION_DURATION,
    alivePlayers: publicPlayers(room.assignedPlayers.filter(player => player.alive))
  })
}

function startNight(code) {
  const room = rooms[code]
  if (!room || room.state !== 'resolving') return
  room.transitionTimer = null
  room.state = 'night'
  room.nightActions = {}
  room.nightStartTime = Date.now()
  const alivePlayers = room.assignedPlayers.filter(player => player.alive)
  const mafiaCount = alivePlayers.filter(player => player.role === 'mafia').length
  io.to(code).emit('night_started', {
    alivePlayers: publicPlayers(alivePlayers),
    startTime: room.nightStartTime,
    duration: NIGHT_DURATION,
    mafiaCount,
    round: room.round
  })
  room.nightTimer = setTimeout(() => resolveNight(code), NIGHT_DURATION)
}

function resolveNight(code) {
  const room = rooms[code]
  if (!room || room.state !== 'night') return
  room.state = 'resolving'
  if (room.nightTimer) {
    clearTimeout(room.nightTimer)
    room.nightTimer = null
  }

  const tally = {}
  Object.values(room.nightActions).forEach(id => {
    tally[id] = (tally[id] || 0) + 1
  })
  const rankedTargets = Object.entries(tally).sort((a, b) => b[1] - a[1])
  let eliminated = null
  if (rankedTargets.length && (!rankedTargets[1] || rankedTargets[0][1] > rankedTargets[1][1])) {
    eliminated = room.assignedPlayers.find(player => player.id === Number(rankedTargets[0][0]))
    if (eliminated) eliminated.alive = false
  }

  const alive = room.assignedPlayers.filter(player => player.alive)
  const aliveMafia = alive.filter(player => player.role === 'mafia').length
  const aliveCivilians = alive.length - aliveMafia
  if (aliveMafia === 0 || aliveMafia >= aliveCivilians) {
    const winner = aliveMafia === 0 ? 'civilians' : 'mafia'
    room.state = 'gameOver'
    room.lastResult = { event: 'game_over', data: { winner, eliminated: publicElimination(eliminated) } }
    io.to(code).emit('game_over', room.lastResult.data)
    return
  }

  room.round++
  room.state = 'roleReveal'
  room.roundStartTime = null
  room.lastResult = { event: 'night_resolved', data: { eliminated: publicElimination(eliminated), round: room.round } }
  io.to(code).emit('night_resolved', room.lastResult.data)
  room.transitionTimer = setTimeout(() => beginRound(code), NEXT_ROUND_REVEAL_DURATION)
}

function resolveVote(code) {
  const room = rooms[code]
  if (!room || room.state !== 'voting') return
  room.state = 'resolving'

  if (room.voteTimer) {
    clearTimeout(room.voteTimer)
    room.voteTimer = null
  }

  const tally = {}
  Object.values(room.votes).forEach(id => {
    tally[id] = (tally[id] || 0) + 1
  })

  let eliminated = null
  if (Object.keys(tally).length > 0) {
    const eliminatedId = Number(
      Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0]
    )
    eliminated = room.assignedPlayers.find(p => p.id === eliminatedId)
    if (eliminated) eliminated.alive = false
  }
  room.votes = {}

  const alive = room.assignedPlayers.filter(p => p.alive)
  const aliveMafia = alive.filter(p => p.role === 'mafia').length
  const aliveCivilians = alive.filter(p => p.role === 'civilian').length

  console.log(`Eliminated: ${eliminated?.name} (${eliminated?.role}). Alive: ${aliveMafia} mafia, ${aliveCivilians} civilians`)

  if (aliveMafia === 0) {
    room.state = 'gameOver'
    room.lastResult = { event: 'game_over', data: { winner: 'civilians', eliminated: publicElimination(eliminated) } }
    io.to(code).emit('game_over', room.lastResult.data)
  } else if (aliveMafia >= aliveCivilians) {
    room.state = 'gameOver'
    room.lastResult = { event: 'game_over', data: { winner: 'mafia', eliminated: publicElimination(eliminated) } }
    io.to(code).emit('game_over', room.lastResult.data)
  } else {
    room.lastResult = {
      event: 'player_eliminated',
      data: { eliminated: publicElimination(eliminated), round: room.round }
    }
    io.to(code).emit('player_eliminated', room.lastResult.data)
    room.transitionTimer = setTimeout(() => startNight(code), ELIMINATION_REVEAL_DURATION)
  }
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id)

  // Reconnection uses the bearer token issued when the player joined.
  socket.on('request_lobby', (payload) => {
    const { code } = payload || {}
    const room = rooms[code]
    if (!room || !isRoomMember(room, socket.id)) return
    socket.emit('lobby_update', publicLobbyPlayers(room.players))
  })
  socket.on('reconnect_player', (payload) => {
    const { code, reconnectToken } = payload || {}
    const room = rooms[code]
    if (!room) { socket.emit('join_error', 'Room not found'); return }

    const existingPlayer = room.players.find(p => p.reconnectToken === reconnectToken)
    if (existingPlayer) {
      const oldSocketId = existingPlayer.id
      existingPlayer.id = socket.id

      const assigned = room.assignedPlayers.find(p => p.socketId === oldSocketId)
      if (assigned) assigned.socketId = socket.id

      if (room.host === oldSocketId) room.host = socket.id

      if (room.deleteTimeout) {
        clearTimeout(room.deleteTimeout)
        room.deleteTimeout = null
      }

      socket.join(code)
      console.log(`${existingPlayer.name} reconnected to ${code}`)

      // Send current state
      socket.emit('reconnected', {
        state: room.state,
        assignedPlayers: publicPlayers(room.assignedPlayers),
        round: room.round,
        roundStartTime: room.roundStartTime,
        duration: DISCUSSION_DURATION,
        voteStartTime: room.voteStartTime,
        lastResult: room.lastResult
      })

      // Always send lobby update so host sees current players
      socket.emit('lobby_update', publicLobbyPlayers(room.players))

      // Re-send role if game started
      if (assigned && room.state !== 'lobby') {
        const mafiaTeam = room.assignedPlayers
          .filter(p => p.role === 'mafia')
          .map(p => p.name)
        socket.emit('role_assigned', {
          role: assigned.role,
          name: assigned.name,
          socketId: assigned.socketId,
          mafiaTeam: assigned.role === 'mafia' ? mafiaTeam : []
        })
      }

      // If voting is active, re-send vote state
      if (room.state === 'voting') {
        socket.emit('vote_started', {
          alivePlayers: publicPlayers(room.assignedPlayers.filter(p => p.alive)),
          startTime: room.voteStartTime,
          duration: VOTE_DURATION,
          alreadyVoted: Boolean(assigned && room.votes[assigned.id] !== undefined)
        })
      }
      if (room.state === 'night') {
        socket.emit('night_started', {
          alivePlayers: publicPlayers(room.assignedPlayers.filter(p => p.alive)),
          startTime: room.nightStartTime,
          duration: NIGHT_DURATION,
          round: room.round,
          mafiaCount: room.assignedPlayers.filter(p => p.alive && p.role === 'mafia').length,
          alreadyActed: Boolean(assigned && room.nightActions[assigned.id] !== undefined)
        })
      }
      if (room.state === 'resolving' && room.lastResult?.event === 'player_eliminated') {
        socket.emit('player_eliminated', room.lastResult.data)
      }

      // If game already resolved, send last result
      if (room.lastResult) {
        socket.emit(room.lastResult.event, room.lastResult.data)
      }
    } else {
      socket.emit('join_error', 'Player not found in room')
    }
  })
  socket.on('create_room', (payload) => {
    const { hostName } = payload || {}
    if (typeof hostName !== 'string' || !hostName.trim() || hostName.trim().length > 16) return
    const code = generateRoomCode()
    rooms[code] = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: hostName.trim(), isHost: true, reconnectToken: randomBytes(32).toString('hex') }],
      state: 'lobby',
      round: 1,
      assignedPlayers: [],
      roundStartTime: null,
      roundTimer: null,
      transitionTimer: null,
      voteStartTime: null,
      voteTimer: null,
      nightStartTime: null,
      nightTimer: null,
      transitionTimer: null,
      nightActions: {},
      votes: {},
      lastResult: null,
      deleteTimeout: null
    }
    socket.join(code)
    socket.emit('room_created', { code, reconnectToken: rooms[code].players[0].reconnectToken })
    io.to(code).emit('lobby_update', publicLobbyPlayers(rooms[code].players))
    console.log(`Room created: ${code}`)
  })

  socket.on('join_room', (payload) => {
    const { code, playerName } = payload || {}
    const room = rooms[code]
    if (!room) { socket.emit('join_error', 'Room not found'); return }
    if (room.state !== 'lobby') { socket.emit('join_error', 'Game already started'); return }
    if (typeof playerName !== 'string' || !playerName.trim() || playerName.trim().length > 16) {
      socket.emit('join_error', 'Enter a name up to 16 characters')
      return
    }
    if (room.players.some(player => player.name.toLowerCase() === playerName.trim().toLowerCase())) {
      socket.emit('join_error', 'That name is already in use')
      return
    }
    if (room.players.length >= 16) { socket.emit('join_error', 'Room is full'); return }

    if (room.deleteTimeout) {
      clearTimeout(room.deleteTimeout)
      room.deleteTimeout = null
    }

    const player = {
      id: socket.id,
      name: playerName.trim(),
      isHost: false,
      reconnectToken: randomBytes(32).toString('hex')
    }
    room.players.push(player)
    socket.join(code)
    socket.emit('room_joined', { code, players: publicLobbyPlayers(room.players), reconnectToken: player.reconnectToken })
    io.to(code).emit('lobby_update', publicLobbyPlayers(room.players))
    console.log(`${playerName} joined ${code}`)
  })

  socket.on('start_game', (payload) => {
    const { code } = payload || {}
    const room = rooms[code]
    if (!room || room.host !== socket.id || room.state !== 'lobby' || room.players.length < 4) return
    const assigned = assignRoles(room.players)
    room.assignedPlayers = assigned
    room.state = 'roleReveal'

    const mafiaTeam = assigned.filter(p => p.role === 'mafia').map(p => p.name)

    assigned.forEach((assignedPlayer) => {
      io.to(assignedPlayer.socketId).emit('role_assigned', {
        role: assignedPlayer.role,
        name: assignedPlayer.name,
        socketId: assignedPlayer.socketId,
        mafiaTeam: assignedPlayer.role === 'mafia' ? mafiaTeam : []
      })
    })

    io.to(code).emit('game_started', { assignedPlayers: publicPlayers(assigned) })
    console.log(`Game started in ${code}`)
  })

  socket.on('start_round', (payload) => {
    const { code } = payload || {}
    const room = rooms[code]
    if (!room || !isRoomMember(room, socket.id)) return
    if (room.state === 'round' && room.roundStartTime) {
      socket.emit('round_started', {
        round: room.round,
        startTime: room.roundStartTime,
        duration: DISCUSSION_DURATION,
        alivePlayers: publicPlayers(room.assignedPlayers.filter(p => p.alive))
      })
      return
    }
    const hostPlayer = room.assignedPlayers.find(player => player.socketId === socket.id)
    if (room.host !== socket.id || !hostPlayer?.alive || room.state !== 'roleReveal') return
    beginRound(code)
  })

  socket.on('start_vote', (payload) => {
    const { code } = payload || {}
    const room = rooms[code]
    if (!room || !isRoomMember(room, socket.id)) return
    const assigned = room.assignedPlayers.find(player => player.socketId === socket.id)
    if (room.state !== 'voting') return
    socket.emit('vote_started', {
      alivePlayers: publicPlayers(room.assignedPlayers.filter(p => p.alive)),
      startTime: room.voteStartTime,
      duration: VOTE_DURATION,
      alreadyVoted: Boolean(assigned && room.votes[assigned.id] !== undefined)
    })
  })

  socket.on('cast_vote', (payload) => {
    const { code, votedId } = payload || {}
    const room = rooms[code]
    if (!room || room.state !== 'voting') return
    const voter = room.assignedPlayers.find(player => player.socketId === socket.id)
    const targetId = Number(votedId)
    const target = room.assignedPlayers.find(player => player.id === targetId)
    if (!voter || !voter.alive || !target || !target.alive || voter.id === target.id) return

    if (room.votes[voter.id] !== undefined) return

    room.votes[voter.id] = targetId

    const alivePlayers = room.assignedPlayers.filter(p => p.alive)
    const totalVotes = Object.keys(room.votes).length

    io.to(code).emit('vote_update', { totalVotes, needed: alivePlayers.length })
    console.log(`Vote in ${code}: ${totalVotes}/${alivePlayers.length}`)
  })

  socket.on('cast_night_action', (payload) => {
    const { code, targetId } = payload || {}
    const room = rooms[code]
    if (!room || room.state !== 'night' || !isRoomMember(room, socket.id)) return
    const actor = room.assignedPlayers.find(player => player.socketId === socket.id)
    const target = room.assignedPlayers.find(player => player.id === Number(targetId))
    if (!actor || !actor.alive || actor.role !== 'mafia' || !target || !target.alive || target.role === 'mafia') return
    if (room.nightActions[actor.id] !== undefined) return

    room.nightActions[actor.id] = target.id
    const mafiaCount = room.assignedPlayers.filter(player => player.alive && player.role === 'mafia').length
    const actionCount = Object.keys(room.nightActions).length
    io.to(code).emit('night_update', { actionCount, mafiaCount })
    if (actionCount >= mafiaCount) resolveNight(code)
  })

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id)
    for (const code in rooms) {
      const room = rooms[code]
      const wasInRoom = room.players.some(p => p.id === socket.id)
      if (!wasInRoom) continue

      if (room.host === socket.id) {
        // Give host 5 mins to reconnect
        room.deleteTimeout = setTimeout(() => {
          delete rooms[code]
          console.log(`Room ${code} deleted after host timeout`)
        }, 5 * 60 * 1000)
        return
      }

      // Non-host — keep them in the room, just mark disconnected
      // They can reconnect via reconnect_player event
    }
  })
})

const PORT = Number(process.env.PORT) || 3001
server.listen(PORT, () => console.log(`Server running on port ${PORT}`))