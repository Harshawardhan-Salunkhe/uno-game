const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- PERSISTENCE ---
const USERS_FILE = path.join(__dirname, 'users.json');
function getUsers() {
    if (!fs.existsSync(USERS_FILE)) return [];
    const data = fs.readFileSync(USERS_FILE);
    return data.length ? JSON.parse(data) : [];
}
function saveUser(user) {
    const users = getUsers();
    users.push(user);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// --- AUTH ---
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    if (users.find(u => u.username === username)) return res.json({ success: false, message: "Username taken!" });
    saveUser({ username, password });
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = getUsers().find(u => u.username === username && u.password === password);
    res.json(user ? { success: true, username: user.username } : { success: false, message: "Invalid credentials" });
});

// ==========================================================
//  MULTI-LOBBY SYSTEM
// ==========================================================
const lobbies = {}; 

function generateLobbyCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function createDeck() {
    let deck = [];
    const colors = ['Red', 'Blue', 'Green', 'Yellow'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
    colors.forEach(c => values.forEach(v => { deck.push({color:c, value:v}); if(v!=='0') deck.push({color:c, value:v}); }));
    for(let i=0; i<4; i++) { deck.push({color:'Black', value:'Wild'}); deck.push({color:'Black', value:'Wild Draw4'}); }
    return deck;
}
function shuffle(deck) { for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; } }

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    // 1. CREATE
    socket.on('createLobby', (username) => {
        const code = generateLobbyCode();
        lobbies[code] = {
            code: code,
            players: [{ id: socket.id, name: username, hand: [], finished: false, saidUno: false }],
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            gameRunning: false,
            drawPenalty: 0,
            currentColor: '',
            turnTimer: null
        };
        socket.join(code);
        socket.emit('lobbyCreated', code);
        io.to(code).emit('updatePlayerList', lobbies[code].players);
    });

    // 2. JOIN
    socket.on('joinLobby', ({ code, username }) => {
        const lobby = lobbies[code];
        if (!lobby) return socket.emit('error', 'Lobby not found!');
        if (lobby.gameRunning) return socket.emit('error', 'Game already started!');
        
        if (lobby.players.find(p => p.name === username)) return socket.emit('error', 'Name taken!');

        lobby.players.push({ id: socket.id, name: username, hand: [], finished: false, saidUno: false });
        socket.join(code);
        socket.emit('joinedLobby', code);
        io.to(code).emit('updatePlayerList', lobby.players);
    });

    // 3. START
    socket.on('startGame', (code) => {
        const lobby = lobbies[code];
        if (!lobby || lobby.players.length < 2) return;

        lobby.deck = createDeck();
        shuffle(lobby.deck);
        
        lobby.players.forEach(p => {
            p.hand = lobby.deck.splice(0, 7);
            p.finished = false;
            p.saidUno = false;
        });

        lobby.discardPile = [lobby.deck.pop()];
        while(lobby.discardPile[0].color === 'Black') { 
            lobby.deck.unshift(lobby.discardPile.pop()); 
            shuffle(lobby.deck); 
            lobby.discardPile.push(lobby.deck.pop()); 
        }
        
        lobby.currentColor = lobby.discardPile[0].color;
        lobby.gameRunning = true;
        lobby.turnIndex = 0;
        
        updateGameState(code);
    });

    // 4. PLAY CARD
    socket.on('playCard', ({ code, cardIndex, chosenColor }) => {
        const lobby = lobbies[code];
        if(!lobby || !lobby.gameRunning) return;
        
        const player = lobby.players.find(p => p.id === socket.id);
        if (!player || lobby.players[lobby.turnIndex].id !== socket.id) return;

        const card = player.hand[cardIndex];
        const top = lobby.discardPile[lobby.discardPile.length - 1];

        // VALIDATION
        let isValid = false;
        if (lobby.drawPenalty > 0) {
            if (card.value.includes('Draw4')) isValid = true;
            else if (card.value === 'Draw2' && (card.color === lobby.currentColor || top.value === 'Draw2')) isValid = true;
        } else {
            if (card.color === lobby.currentColor || card.value === top.value || card.color === 'Black') isValid = true;
        }

        if (!isValid) return;

        // Clear Timer if they played in time
        if(lobby.turnTimer) { clearTimeout(lobby.turnTimer); lobby.turnTimer = null; }

        // --- UNO LOGIC ---
        let penalty = false;
        if (player.hand.length === 2 && !player.saidUno) penalty = true;

        player.hand.splice(cardIndex, 1);
        lobby.discardPile.push(card);
        player.saidUno = false;

        if (penalty) {
            refillDeck(lobby);
            player.hand.push(lobby.deck.pop(), lobby.deck.pop());
            io.to(code).emit('message', `🔔 ${player.name} forgot UNO! (+2 cards)`);
        }

        lobby.currentColor = (card.color === 'Black') ? chosenColor : card.color;

        let skip = 0;
        if (card.value === 'Reverse') {
            lobby.direction *= -1;
            if(lobby.players.filter(p => !p.finished).length === 2) skip = 1;
        }
        else if (card.value === 'Skip') skip = 1;
        else if (card.value === 'Draw2') lobby.drawPenalty += 2;
        else if (card.value.includes('Draw4')) lobby.drawPenalty += 4;

        if (player.hand.length === 0) {
            player.finished = true;
            const winners = lobby.players.filter(p => p.finished);
            io.to(code).emit('message', `🏆 ${player.name} Finished!`);
            
            if (lobby.players.filter(p => !p.finished).length <= 1) {
                lobby.gameRunning = false;
                io.to(code).emit('gameOver', winners);
                delete lobbies[code];
                return;
            }
        }

        advanceTurn(lobby, skip);
        updateGameState(code);
    });

    // 5. DRAW CARD (FIXED WITH 3s TIMER)
    socket.on('drawCard', (code) => {
        const lobby = lobbies[code];
        if(!lobby || !lobby.gameRunning) return;
        if(lobby.players[lobby.turnIndex].id !== socket.id) return;

        const player = lobby.players.find(p => p.id === socket.id);

        // A. STACKING PENALTY (Take all cards immediately)
        if (lobby.drawPenalty > 0) {
            for(let i=0; i<lobby.drawPenalty; i++) {
                if(lobby.deck.length === 0) refillDeck(lobby);
                player.hand.push(lobby.deck.pop());
            }
            io.to(code).emit('message', `💥 ${player.name} took +${lobby.drawPenalty} cards!`);
            lobby.drawPenalty = 0;
            io.to(player.id).emit('yourHand', player.hand);
            advanceTurn(lobby);
            updateGameState(code);
            return;
        }

        // B. NORMAL DRAW
        if(lobby.deck.length === 0) refillDeck(lobby);
        const newCard = lobby.deck.pop();
        player.hand.push(newCard);
        io.to(player.id).emit('yourHand', player.hand);

        // --- CHECK IF PLAYABLE (THE FIX) ---
        const top = lobby.discardPile[lobby.discardPile.length - 1];
        const isPlayable = (newCard.color === lobby.currentColor) || 
                           (newCard.value === top.value) || 
                           (newCard.color === 'Black');

        if (isPlayable) {
            // 1. Tell user they have 3s
            socket.emit('message', "Playable! Drop it in 3s!");
            io.to(code).emit('timerStart', 3); // Start 3s visual timer for everyone

            // 2. Start Server Timer
            if(lobby.turnTimer) clearTimeout(lobby.turnTimer);
            lobby.turnTimer = setTimeout(() => {
                io.to(code).emit('message', `${player.name} hesitated! Next turn.`);
                advanceTurn(lobby);
                updateGameState(code);
            }, 3000); // 3000ms = 3 Seconds

            // 3. Update state (show card) but DO NOT ADVANCE TURN yet
            updateGameState(code);
        } else {
            // Not playable? Pass immediately.
            socket.emit('message', "No luck. Next turn.");
            advanceTurn(lobby);
            updateGameState(code);
        }
    });

    // 6. SAY UNO
    socket.on('sayUno', (code) => {
        const lobby = lobbies[code];
        if(!lobby) return;
        const player = lobby.players.find(p => p.id === socket.id);
        if (player && player.hand.length === 2) {
            player.saidUno = true;
            io.to(code).emit('message', `🔔 ${player.name} shouted UNO!`);
        }
    });

    // 7. DISCONNECT
    socket.on('disconnect', () => {
        for (const [code, lobby] of Object.entries(lobbies)) {
            const pIndex = lobby.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1) {
                const player = lobby.players[pIndex];
                const wasTurn = (pIndex === lobby.turnIndex);
                
                lobby.players.splice(pIndex, 1);
                
                if (lobby.players.length === 0) {
                    delete lobbies[code];
                } else {
                    if (pIndex < lobby.turnIndex) lobby.turnIndex--;
                    if (wasTurn) advanceTurn(lobby, 0);
                    
                    io.to(code).emit('message', `⚠️ ${player.name} disconnected.`);
                    io.to(code).emit('updatePlayerList', lobby.players);
                    updateGameState(code);
                }
                break;
            }
        }
    });
});

function refillDeck(lobby) {
    if (lobby.discardPile.length > 1) {
        let top = lobby.discardPile.pop();
        lobby.deck = lobby.discardPile;
        lobby.discardPile = [top];
        shuffle(lobby.deck);
    } else if (lobby.deck.length === 0) {
        lobby.deck = createDeck();
        shuffle(lobby.deck);
    }
}

function advanceTurn(lobby, skips=0) {
    if(lobby.turnTimer) { clearTimeout(lobby.turnTimer); lobby.turnTimer = null; } // Safety Clear
    
    let steps = 1 + skips;
    let active = lobby.players.filter(p => !p.finished);
    if (active.length === 0) return;
    
    while(steps > 0) {
        lobby.turnIndex = (lobby.turnIndex + lobby.direction + lobby.players.length) % lobby.players.length;
        if (!lobby.players[lobby.turnIndex].finished) steps--;
    }
}

function updateGameState(code) {
    const lobby = lobbies[code];
    if(!lobby || !lobby.gameRunning) return;
    
    io.to(code).emit('gameState', {
        topCard: lobby.discardPile[lobby.discardPile.length - 1],
        currentColor: lobby.currentColor,
        currentPlayer: lobby.players[lobby.turnIndex].id,
        direction: lobby.direction > 0 ? "CW" : "CCW",
        playerInfo: lobby.players.map(p => ({ 
            name: p.name, 
            cards: p.hand.length, 
            id: p.id 
        }))
    });
    
    lobby.players.forEach(p => io.to(p.id).emit('yourHand', p.hand));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
