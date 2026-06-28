const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')

const app = express()
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
})

const rooms = {}

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase()
}

function assignRoles(players) {
  const mafiaCount = Math.round(players.length / 3)
  const roles = [
    ...Array(mafiaCount).fill('mafia'),
    ...Array(players.length - mafiaCount).fill('civilian')
  ]
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]]
  }
  return players.map((player, i) => ({
    socketId: player.id,
    name: player.name,
    role: roles[i],
    alive: true,
    id: i
  }))
}

function resolveVote(code) {
  const room = rooms[code]
  if (!room || room.state !== 'voting') return
  room.state = 'resolving'

  const tally = {}
  Object.values(room.votes).forEach(id => {
    tally[id] = (tally[id] || 0) + 1
  })

  const eliminatedId = Number(
    Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0]
  )
  const eliminated = room.assignedPlayers.find(p => p.id === eliminatedId)
  if (eliminated) eliminated.alive = false
  room.votes = {}

  const alive = room.assignedPlayers.filter(p => p.alive)
  const aliveMafia = alive.filter(p => p.role === 'mafia').length
  const aliveCivilians = alive.filter(p => p.role === 'civilian').length

  console.log(`Eliminated: ${eliminated?.name} (${eliminated?.role}). Alive: ${aliveMafia} mafia, ${aliveCivilians} civilians`)

  if (aliveMafia === 0) {
    room.lastResult = { event: 'game_over', data: { winner: 'civilians', eliminated } }
    io.to(code).emit('game_over', { winner: 'civilians', eliminated })
  } else if (aliveMafia >= aliveCivilians) {
    room.lastResult = { event: 'game_over', data: { winner: 'mafia', eliminated } }
    io.to(code).emit('game_over', { winner: 'mafia', eliminated })
  } else {
    room.round++
    room.lastResult = { event: 'player_eliminated', data: { eliminated, round: room.round } }
    io.to(code).emit('player_eliminated', { eliminated, round: room.round })
  }
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id)

  socket.on('create_room', ({ hostName }) => {
    const code = generateRoomCode()
    rooms[code] = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: hostName, isHost: true }],
      state: 'lobby',
      round: 1,
      assignedPlayers: [],
      roundStartTime: null,
      votes: {}
    }
    socket.join(code)
    socket.emit('room_created', { code })
    io.to(code).emit('lobby_update', rooms[code].players)
    console.log(`Room created: ${code}`)
  })

  socket.on('join_room', ({ code, playerName }) => {
    const room = rooms[code]
    if (!room) { socket.emit('join_error', 'Room not found'); return }
    if (room.state !== 'lobby') { socket.emit('join_error', 'Game already started'); return }
    room.players.push({ id: socket.id, name: playerName, isHost: false })
    socket.join(code)
    socket.emit('room_joined', { code, players: room.players })
    io.to(code).emit('lobby_update', room.players)
    console.log(`${playerName} joined ${code}`)
  })

  socket.on('start_game', ({ code }) => {
    const room = rooms[code]
    if (!room || room.host !== socket.id) return
    const assigned = assignRoles(room.players)
    room.assignedPlayers = assigned
    room.state = 'roleReveal'

    const mafiaTeam = assigned
      .filter(p => p.role === 'mafia')
      .map(p => p.name)

    assigned.forEach((assignedPlayer) => {
      io.to(assignedPlayer.socketId).emit('role_assigned', {
        role: assignedPlayer.role,
        name: assignedPlayer.name,
        socketId: assignedPlayer.socketId,
        mafiaTeam: assignedPlayer.role === 'mafia' ? mafiaTeam : []
      })
    })

    io.to(code).emit('game_started', { assignedPlayers: assigned })
    console.log(`Game started in ${code}`)
  })

  socket.on('start_round', ({ code }) => {
    const room = rooms[code]
    if (!room) return
    // Only start the timer once — ignore duplicate start_round from other tabs
    if (room.state === 'round' && room.roundStartTime) {
      // Re-send current state to this socket so they sync up
      socket.emit('round_started', {
        round: room.round,
        startTime: room.roundStartTime,
        duration: 5 * 60 * 1000,
        alivePlayers: room.assignedPlayers.filter(p => p.alive)
      })
      return
    }
    room.state = 'round'
    room.roundStartTime = Date.now()
    room.votes = {}
    io.to(code).emit('round_started', {
      round: room.round,
      startTime: room.roundStartTime,
      duration: 5 * 60 * 1000,
      alivePlayers: room.assignedPlayers.filter(p => p.alive)
    })
  })

  socket.on('start_vote', ({ code }) => {
    const room = rooms[code]
    if (!room) return
    room.state = 'voting'
    room.votes = {}
    const alivePlayers = room.assignedPlayers.filter(p => p.alive)
    io.to(code).emit('vote_started', { alivePlayers })
  })

  socket.on('cast_vote', ({ code, votedId }) => {
    const room = rooms[code]
    if (!room) return
    
    // If already resolved, re-send the last result to this socket
    if (room.state === 'resolving' || room.state === 'round' || room.state === 'roleReveal') {
      if (room.lastResult) {
        socket.emit(room.lastResult.event, room.lastResult.data)
      }
      return
    }
    
    if (room.state !== 'voting') return
    if (room.votes[socket.id] !== undefined) return

    room.votes[socket.id] = Number(votedId)

    const alivePlayers = room.assignedPlayers.filter(p => p.alive)
    const totalVotes = Object.keys(room.votes).length

    io.to(code).emit('vote_update', { totalVotes, needed: alivePlayers.length })
    console.log(`Vote in ${code}: ${totalVotes}/${alivePlayers.length}`)

    if (totalVotes >= alivePlayers.length) {
      setTimeout(() => resolveVote(code), 1000)
    }
  })
    console.log(`Vote in ${code}: ${totalVotes}/${alivePlayers.length}`)

    if (totalVotes >= alivePlayers.length) { 
      resolveVote(code)
    }
  })

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id)
    for (const code in rooms) {
      const room = rooms[code]
      const wasInRoom = room.players.some(p => p.id === socket.id)
      if (!wasInRoom) continue
      room.players = room.players.filter(p => p.id !== socket.id)
      if (room.players.length === 0) {
        delete rooms[code]
      } else {
        io.to(code).emit('lobby_update', room.players)
      }
    }
  })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => console.log(`Server running on port ${PORT}`))