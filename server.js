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

function normalizeUserStatus(user) {
  if (!user) return user;
  if (!user.accountStatus) user.accountStatus = 'approved';
  if (!user.registeredAt) user.registeredAt = new Date().toISOString();
  return user;
}

function isApproved(user) {
  return user && String(user.accountStatus).toLowerCase() === 'approved';
}

function isPending(user) {
  return user && String(user.accountStatus).toLowerCase() === 'pending';
}

function isRejected(user) {
  return user && String(user.accountStatus).toLowerCase() === 'rejected';
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

// Serve index.html at root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/signup', (req, res) => {
  // debug log to help diagnose malformed requests
  if (req.rawBody) console.log('RAW SIGNUP BODY:', req.rawBody);
  const { email, firstName, lastName, serial, hospital, password } = req.body || {};
  if (!email || !firstName || !lastName || !serial || !hospital || !password) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  if (data.users[email]) return res.status(400).json({ error: 'Email already registered' });
  data.users[email] = {
    email,
    firstName,
    lastName,
    serial,
    hospital,
    password,
    accountStatus: 'pending',
    registeredAt: new Date().toISOString()
  };
  writeData(data);
  res.json({
    success: true,
    message: 'Your account is pending admin approval. Please wait for approval.'
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const user = data.users[email];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  normalizeUserStatus(user);
  if (isPending(user)) {
    return res.status(403).json({ error: 'Your account is pending admin approval. Please wait for approval.' });
  }
  if (isRejected(user)) {
    return res.status(403).json({
      error: 'Your account has been rejected. Please contact support.',
      reason: user.rejectedReason || undefined
    });
  }
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
  const user = normalizeUserStatus(data.users[email]);
  if (!isApproved(user)) return res.status(403).json({ error: 'Account not approved' });
  const prog = data.progress[email] || {};
  res.json({ success: true, progress: prog });
});

app.post('/api/progress', (req, res) => {
  const { token, section, value } = req.body;
  if (!token || !section) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const email = data.sessions[token];
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const user = normalizeUserStatus(data.users[email]);
  if (!isApproved(user)) return res.status(403).json({ error: 'Account not approved' });
  data.progress[email] = data.progress[email] || {};
  data.progress[email][section] = value;
  writeData(data);
  res.json({ success: true });
});

// Get user profile
app.get('/api/profile', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const data = readData();
  const email = data.sessions[token];
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  normalizeUserStatus(user);
  if (!isApproved(user)) return res.status(403).json({ error: 'Account not approved' });
  // Don't send password
  const { password, ...userWithoutPassword } = user;
  res.json({ success: true, user: userWithoutPassword });
});

// Update user profile
app.post('/api/profile', (req, res) => {
  const { token, firstName, lastName, serial, hospital } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const data = readData();
  const email = data.sessions[token];
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  normalizeUserStatus(user);
  if (!isApproved(user)) return res.status(403).json({ error: 'Account not approved' });
  
  // Update user data
  if (firstName) user.firstName = firstName;
  if (lastName) user.lastName = lastName;
  if (serial) user.serial = serial;
  if (hospital) user.hospital = hospital;
  
  writeData(data);
  res.json({ success: true, message: 'Profile updated successfully' });
});

// Change password
app.post('/api/change-password', (req, res) => {
  const { token, currentPassword, newPassword } = req.body;
  if (!token || !currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const email = data.sessions[token];
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  normalizeUserStatus(user);
  if (!isApproved(user)) return res.status(403).json({ error: 'Account not approved' });
  
  // Verify current password
  if (user.password !== currentPassword) return res.status(401).json({ error: 'Current password is incorrect' });
  
  // Update password
  user.password = newPassword;
  writeData(data);
  res.json({ success: true, message: 'Password changed successfully' });
});

// ============ ADMIN ENDPOINTS ============

function requireAdmin(req, res, data) {
  const token = req.query.token || req.body.token;
  if (!token) return { ok: false, error: res.status(400).json({ error: 'Missing token' }) };
  if (!data.adminSessions || !data.adminSessions[token]) {
    return { ok: false, error: res.status(401).json({ error: 'Unauthorized' }) };
  }
  return { ok: true, token };
}

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
  const data = readData();
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) return;
  
  const users = Object.values(data.users || {}).map(u => ({
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    hospital: u.hospital,
    serial: u.serial,
    accountStatus: normalizeUserStatus(u).accountStatus,
    registeredAt: u.registeredAt,
    rejectedReason: u.rejectedReason || null
  }));
  
  res.json({ 
    success: true, 
    users,
    progress: data.progress || {}
  });
});

// Approve user
app.post('/api/admin/users/approve', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) return;

  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  normalizeUserStatus(user);
  user.accountStatus = 'approved';
  user.rejectedReason = undefined;
  writeData(data);
  res.json({ success: true, message: 'User approved' });
});

// Reject user (optional)
app.post('/api/admin/users/reject', (req, res) => {
  const { email, reason } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) return;

  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  normalizeUserStatus(user);
  user.accountStatus = 'rejected';
  user.rejectedReason = reason || 'Rejected by admin';
  writeData(data);
  res.json({ success: true, message: 'User rejected' });
});

// Get module content
app.get('/api/admin/modules/content', (req, res) => {
  const data = readData();
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) return;
  
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
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) {
    // Clean up uploaded file
    if (req.file) fs.unlinkSync(req.file.path);
    return;
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
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) return;
  
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
