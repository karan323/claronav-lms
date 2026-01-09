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
  const { name, serial, hospital, password } = req.body;
  if (!name || !serial || !hospital || !password) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  if (data.users[serial]) return res.status(400).json({ error: 'Serial already registered' });
  data.users[serial] = { name, serial, hospital, password };
  writeData(data);
  // create session token
  const token = randomBytes(16).toString('hex');
  data.sessions[token] = serial;
  writeData(data);
  res.json({ success: true, token, name, serial, hospital });
});

app.post('/api/login', (req, res) => {
  const { serial, password } = req.body;
  if (!serial || !password) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const user = data.users[serial];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  const token = randomBytes(16).toString('hex');
  data.sessions[token] = serial;
  writeData(data);
  res.json({ success: true, token, name: user.name, serial: user.serial, hospital: user.hospital });
});

app.get('/api/progress', (req, res) => {
  const token = req.query.token;
  const data = readData();
  const serial = data.sessions[token];
  if (!serial) return res.status(401).json({ error: 'Unauthorized' });
  const prog = data.progress[serial] || {};
  res.json({ success: true, progress: prog });
});

app.post('/api/progress', (req, res) => {
  const { token, section, value } = req.body;
  if (!token || !section) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const serial = data.sessions[token];
  if (!serial) return res.status(401).json({ error: 'Unauthorized' });
  data.progress[serial] = data.progress[serial] || {};
  data.progress[serial][section] = value;
  writeData(data);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
