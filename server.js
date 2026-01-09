const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { randomBytes } = require('crypto');

const DATA_FILE = path.join(__dirname, 'data.json');

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { users: {}, sessions: {}, progress: {} };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const app = express();
app.use(cors());
// capture raw body for debugging parse errors
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf && buf.toString(); } }));

// Serve static files (front-end)
app.use(express.static(path.join(__dirname)));

app.post('/api/signup', (req, res) => {
  // debug log to help diagnose malformed requests
  if (req.rawBody) console.log('RAW SIGNUP BODY:', req.rawBody);
  const { email, firstName, lastName, serial, hospital, password } = req.body || {};
  if (!email || !firstName || !lastName || !serial || !hospital || !password) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  if (data.users[email]) return res.status(400).json({ error: 'Email already registered' });
  data.users[email] = { email, firstName, lastName, serial, hospital, password };
  writeData(data);
  // create session token
  const token = randomBytes(16).toString('hex');
  data.sessions[token] = email;
  writeData(data);
  res.json({ success: true, token, name: firstName + ' ' + lastName, email, serial, hospital });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const user = data.users[email];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  const token = randomBytes(16).toString('hex');
  data.sessions[token] = email;
  writeData(data);
  res.json({ success: true, token, name: user.firstName + ' ' + user.lastName, email: user.email, serial: user.serial, hospital: user.hospital });
});

app.get('/api/progress', (req, res) => {
  const token = req.query.token;
  const data = readData();
  const email = data.sessions[token];
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const prog = data.progress[email] || {};
  res.json({ success: true, progress: prog });
});

app.post('/api/progress', (req, res) => {
  const { token, section, value } = req.body;
  if (!token || !section) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const email = data.sessions[token];
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  data.progress[email] = data.progress[email] || {};
  data.progress[email][section] = value;
  writeData(data);
  res.json({ success: true });
});

// JSON parse error handler - return JSON instead of HTML and log raw body
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.error('JSON parse error:', err && err.message);
    console.error('Raw body at error:', req && req.rawBody);
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
