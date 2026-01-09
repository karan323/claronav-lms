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
app.use(express.json());

// Serve static files (front-end)
app.use(express.static(path.join(__dirname)));

app.post('/api/signup', (req, res) => {
  const { email, firstName, lastName, serial, hospital, password } = req.body;
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
