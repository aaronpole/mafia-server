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
  return players.map((name, i) => ({
    name, role: roles[i], alive: true, id: i
  }))
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id)

  socket.on('create_room', ({ hostName }) => {
  const code = generateRoomCode()
  rooms[code] = {
    code,
    host: socket.id,
    players: [
       { id: socket.id, name: hostName, isHost: true }
      ],
      state: 'lobby',
      round: 1,
      assignedPlayers: []
    }
    socket.join(code)
    socket.emit('room_created', { code })
    io.to(code).emit('lobby_update', rooms[code].players)
    console.log(`Room created: ${code}`)
  })

  socket.on('join_room', ({ code, playerName }) => {
    const room = rooms[code]
    if (!room) { socket.emit('error', 'Room not found'); return }
    if (room.state !== 'lobby') { socket.emit('error', 'Game already started'); return }
    room.players.push({ id: socket.id, name: playerName, isHost: false })
    socket.join(code)
    socket.emit('room_joined', { code, players: room.players })
    io.to(code).emit('lobby_update', room.players)
    console.log(`${playerName} joined ${code}`)
  })

  socket.on('start_game', ({ code }) => {
    const room = rooms[code]
    if (!room || room.host !== socket.id) return

    const names = room.players.map(p => p.name)
    const assigned = assignRoles(names)
    room.assignedPlayers = assigned
    room.state = 'roleReveal'

    const mafiaTeam = assigned
      .filter(p => p.role === 'mafia')
      .map(p => p.name)

    room.players.forEach((player, i) => {
      const assignedPlayer = assigned[i]
      io.to(player.id).emit('role_assigned', {
        role: assignedPlayer.role,
        name: assignedPlayer.name,
        mafiaTeam: assignedPlayer.role === 'mafia' ? mafiaTeam : []
      })
    })

    io.to(code).emit('game_started', { assignedPlayers: assigned })
    console.log(`Game started in ${code}`)
  })

  socket.on('start_round', ({ code }) => {
    const room = rooms[code]
    if (!room) return
    room.state = 'round'
    io.to(code).emit('round_started', { round: room.round })
  })

  socket.on('start_vote', ({ code }) => {
    const room = rooms[code]
    if (!room) return
    room.state = 'voting'
    const alivePlayers = room.assignedPlayers.filter(p => p.alive)
    io.to(code).emit('vote_started', { alivePlayers })
  })

  socket.on('cast_vote', ({ code, votedId }) => {
    const room = rooms[code]
    if (!room) return
    if (!room.votes) room.votes = {}
    room.votes[socket.id] = votedId

    const alivePlayers = room.assignedPlayers.filter(p => p.alive)
    const totalVotes = Object.keys(room.votes).length

    io.to(code).emit('vote_update', { totalVotes, needed: alivePlayers.length })

    if (totalVotes >= alivePlayers.length) {
      const tally = {}
      Object.values(room.votes).forEach(id => {
        tally[id] = (tally[id] || 0) + 1
      })
      const eliminatedId = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0]
      const eliminated = room.assignedPlayers.find(p => p.id == eliminatedId)
      if (eliminated) eliminated.alive = false
      room.votes = {}

      const alive = room.assignedPlayers.filter(p => p.alive)
      const aliveMafia = alive.filter(p => p.role === 'mafia').length
      const aliveCivilians = alive.filter(p => p.role === 'civilian').length

      if (aliveMafia === 0) {
        io.to(code).emit('game_over', { winner: 'civilians', eliminated })
      } else if (aliveMafia >= aliveCivilians) {
        io.to(code).emit('game_over', { winner: 'mafia', eliminated })
      } else {
        room.round++
        io.to(code).emit('player_eliminated', { eliminated, round: room.round })
      }
    }
  })

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id)
    for (const code in rooms) {
      const room = rooms[code]
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