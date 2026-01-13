const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { randomBytes } = require('crypto');
const multer = require('multer');

const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { users: {}, sessions: {}, progress: {}, admins: {}, moduleContent: { cranial: [], spine: [], ent: [] } };
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

// Serve home.html at root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'home.html'));
});

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

// ============ ADMIN ENDPOINTS ============

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  
  const data = readData();
  
  // Initialize admin storage if needed and create default admin
  if (!data.admins) data.admins = {};
  if (!data.admins['admin@claronav.com']) {
    data.admins['admin@claronav.com'] = { email: 'admin@claronav.com', password: 'admin123' };
    writeData(data);
  }
  
  const admin = data.admins[email];
  if (!admin || admin.password !== password) return res.status(401).json({ error: 'Invalid admin credentials' });
  
  const token = randomBytes(16).toString('hex');
  if (!data.adminSessions) data.adminSessions = {};
  data.adminSessions[token] = email;
  writeData(data);
  
  res.json({ success: true, token, email });
});

// Get all users with progress
app.get('/api/admin/users', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  
  const data = readData();
  
  // Verify admin token
  if (!data.adminSessions || !data.adminSessions[token]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const users = Object.values(data.users || {}).map(u => ({
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    hospital: u.hospital,
    serial: u.serial
  }));
  
  res.json({ 
    success: true, 
    users,
    progress: data.progress || {}
  });
});

// Get module content
app.get('/api/admin/modules/content', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  
  const data = readData();
  
  // Verify admin token
  if (!data.adminSessions || !data.adminSessions[token]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const content = data.moduleContent || { cranial: [], spine: [], ent: [] };
  
  res.json({ success: true, content });
});

// Public: Get module content (no admin token required)
app.get('/api/modules/content', (req, res) => {
  const module = req.query.module;
  const data = readData();
  const content = data.moduleContent || { cranial: [], spine: [], ent: [] };

  if (module) {
    return res.json({ success: true, content: content[module] || [] });
  }
  return res.json({ success: true, content });
});

// Upload module content
app.post('/api/admin/modules/upload', upload.single('file'), (req, res) => {
  const { module, type, title, token } = req.body;
  
  if (!module || !type || !title || !token || !req.file) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const data = readData();
  
  // Verify admin token
  if (!data.adminSessions || !data.adminSessions[token]) {
    // Clean up uploaded file
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Initialize moduleContent if needed
  if (!data.moduleContent) data.moduleContent = { cranial: [], spine: [], ent: [] };
  if (!data.moduleContent[module]) data.moduleContent[module] = [];
  
  // Add content entry
  const contentEntry = {
    title,
    type,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    uploadedAt: new Date().toISOString()
  };
  
  data.moduleContent[module].push(contentEntry);
  writeData(data);
  
  res.json({ 
    success: true, 
    message: 'Content uploaded successfully',
    content: contentEntry
  });
});

// Delete module content
app.delete('/api/admin/modules/content', (req, res) => {
  const { module, index, token } = req.body;
  
  if (!module || index === undefined || !token) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const data = readData();
  
  // Verify admin token
  if (!data.adminSessions || !data.adminSessions[token]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!data.moduleContent || !data.moduleContent[module] || !data.moduleContent[module][index]) {
    return res.status(404).json({ error: 'Content not found' });
  }
  
  const content = data.moduleContent[module][index];
  
  // Delete file if it exists
  const filePath = path.join(UPLOAD_DIR, content.filename);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error('Error deleting file:', e);
    }
  }
  
  // Remove from array
  data.moduleContent[module].splice(index, 1);
  writeData(data);
  
  res.json({ success: true, message: 'Content deleted successfully' });
});

// Serve uploaded files
app.use('/uploads', express.static(UPLOAD_DIR));

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
