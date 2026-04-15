require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const patientsRouter = require('./routes/patients');

const app = express();
const server = http.createServer(app);

// Enable CORS
app.use(cors());
app.use(express.json());

// Set up Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Pass io to routes by storing it in app.locals
app.locals.io = io;

io.on('connection', (socket) => {
  console.log('A client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

app.use('/api', patientsRouter);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
