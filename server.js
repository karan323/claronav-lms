const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { randomBytes, createHash } = require('crypto');
const nodemailer = require('nodemailer');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
const AI_UPLOAD_DIR = path.join(UPLOAD_DIR, 'ai');
const OTP_TTL_MS = 10 * 60 * 1000;

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}
if (!fs.existsSync(AI_UPLOAD_DIR)) {
  fs.mkdirSync(AI_UPLOAD_DIR, { recursive: true });
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

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, AVATAR_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

const aiStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, AI_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const aiUpload = multer({
  storage: aiStorage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {
      users: {},
      sessions: {},
      progress: {},
      admins: {},
      moduleContent: { cranial: [], spine: [], ent: [] },
      aiKnowledge: []
    };
  }
}

function normalizeUserStatus(user) {
  if (!user) return user;
  if (!user.accountStatus) user.accountStatus = 'approved';
  if (!user.registeredAt) user.registeredAt = new Date().toISOString();
  if (user.emailVerified === undefined) user.emailVerified = true;
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

function isRestricted(user) {
  return user && String(user.accountStatus).toLowerCase() === 'restricted';
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function hashOtp(otp) {
  return createHash('sha256').update(String(otp)).digest('hex');
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function setUserOtp(user) {
  const otp = generateOtp();
  user.otpHash = hashOtp(otp);
  user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  user.emailVerified = false;
  return otp;
}

function isOtpValid(user, otp) {
  if (!user || !user.otpHash || !user.otpExpiresAt) return false;
  const expiresAt = new Date(user.otpExpiresAt).getTime();
  if (Number.isNaN(expiresAt) || Date.now() > expiresAt) return false;
  return user.otpHash === hashOtp(otp);
}

function getMailer() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass }
  });
}

async function sendOtpEmail(email, otp) {
  const transporter = getMailer();
  if (!transporter) throw new Error('Email service not configured');
  const fromName = process.env.SMTP_FROM_NAME || 'Claronav LMS';
  await transporter.sendMail({
    from: `${fromName} <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Your Claronav LMS verification code',
    text: `Your verification code is ${otp}. It expires in 10 minutes.`
  });
}

function ensureAiKnowledge(data) {
  if (!data.aiKnowledge) data.aiKnowledge = [];
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalizeText(text)
    .split(' ')
    .filter(w => w.length > 2);
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter(s => s && s.trim().length > 0);
}

async function extractTextFromFile(filePath, mimeType, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();

  if (mimeType === 'text/plain' || ext === '.txt') {
    return fs.readFileSync(filePath, 'utf8');
  }

  if (mimeType === 'application/pdf' || ext === '.pdf') {
    const buffer = fs.readFileSync(filePath);
    const parsed = await pdfParse(buffer);
    return parsed && parsed.text ? parsed.text : '';
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result && result.value ? result.value : '';
  }

  throw new Error('Unsupported file type. Please upload TXT, PDF, or DOCX.');
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
    registeredAt: new Date().toISOString(),
    emailVerified: false
  };
  const otp = setUserOtp(data.users[email]);
  writeData(data);
  sendOtpEmail(email, otp)
    .then(() => {
      res.json({
        success: true,
        requiresVerification: true,
        message: 'We sent a verification code to your email.'
      });
    })
    .catch((err) => {
      console.error('Email send error:', err && err.message);
      res.status(500).json({ error: 'Could not send verification email. Please try again later.' });
    });
});

app.post('/api/signup/verify-otp', (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  normalizeUserStatus(user);
  if (user.emailVerified) return res.json({ success: true, message: 'Email already verified.' });
  if (!isOtpValid(user, otp)) return res.status(400).json({ error: 'Invalid or expired verification code.' });
  user.emailVerified = true;
  user.otpHash = undefined;
  user.otpExpiresAt = undefined;
  writeData(data);
  res.json({ success: true, message: 'Email verified. Your account is pending admin approval.' });
});

app.post('/api/signup/resend-otp', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  normalizeUserStatus(user);
  if (user.emailVerified) return res.json({ success: true, message: 'Email already verified.' });
  const otp = setUserOtp(user);
  writeData(data);
  sendOtpEmail(email, otp)
    .then(() => res.json({ success: true, message: 'Verification code resent.' }))
    .catch((err) => {
      console.error('Email send error:', err && err.message);
      res.status(500).json({ error: 'Could not send verification email. Please try again later.' });
    });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const user = data.users[email];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  normalizeUserStatus(user);
  if (!user.emailVerified) {
    return res.status(403).json({ error: 'Please verify your email to continue.' });
  }
  if (isPending(user)) {
    return res.status(403).json({ error: 'Your account is pending admin approval. Please wait for approval.' });
  }
  if (isRejected(user)) {
    return res.status(403).json({
      error: 'Your account has been rejected. Please contact support.',
      reason: user.rejectedReason || undefined
    });
  }
  if (isRestricted(user)) {
    return res.status(403).json({
      error: 'Your account has been restricted by an administrator. Please contact support.'
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

// Upload profile photo
app.post('/api/profile/photo', avatarUpload.single('photo'), (req, res) => {
  const { token } = req.body || {};
  if (!token || !req.file) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const email = data.sessions[token];
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  normalizeUserStatus(user);
  if (!isApproved(user)) return res.status(403).json({ error: 'Account not approved' });

  user.profilePhoto = '/uploads/avatars/' + req.file.filename;
  writeData(data);
  res.json({ success: true, photoUrl: user.profilePhoto });
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

// Restrict user (disable login)
app.post('/api/admin/users/restrict', (req, res) => {
  const { email, reason } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing fields' });
  const data = readData();
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) return;

  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  normalizeUserStatus(user);
  user.accountStatus = 'restricted';
  user.rejectedReason = reason || 'Restricted by admin';
  writeData(data);
  res.json({ success: true, message: 'User restricted' });
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

// ============ AI KNOWLEDGE BASE ============

// List AI knowledge entries
app.get('/api/admin/ai/knowledge', (req, res) => {
  const data = readData();
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) return;

  ensureAiKnowledge(data);
  const entries = data.aiKnowledge.map(({ id, title, originalName, mimeType, size, uploadedAt }) => ({
    id,
    title,
    originalName,
    mimeType,
    size,
    uploadedAt
  }));

  res.json({ success: true, entries });
});

// Upload AI knowledge file
app.post('/api/admin/ai/upload', aiUpload.single('file'), async (req, res) => {
  const { title, token } = req.body || {};

  if (!title || !token || !req.file) {
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    }
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const data = readData();
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) {
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    }
    return;
  }

  try {
    ensureAiKnowledge(data);
    const extractedText = await extractTextFromFile(req.file.path, req.file.mimetype, req.file.originalname);
    const cleanedText = String(extractedText || '').trim();

    if (!cleanedText) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
      return res.status(400).json({ error: 'No readable text found in file' });
    }

    const entry = {
      id: randomBytes(8).toString('hex'),
      title,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      text: cleanedText,
      uploadedAt: new Date().toISOString()
    };

    data.aiKnowledge.push(entry);
    writeData(data);

    res.json({ success: true, entry: { id: entry.id, title: entry.title, originalName: entry.originalName } });
  } catch (err) {
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    }
    res.status(400).json({ error: err.message || 'Failed to process file' });
  }
});

// Delete AI knowledge entry
app.delete('/api/admin/ai/knowledge', (req, res) => {
  const { id, token } = req.body || {};

  if (!id || !token) return res.status(400).json({ error: 'Missing required fields' });

  const data = readData();
  const auth = requireAdmin(req, res, data);
  if (!auth.ok) return;

  ensureAiKnowledge(data);
  const idx = data.aiKnowledge.findIndex(item => item.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Entry not found' });

  const entry = data.aiKnowledge[idx];
  const filePath = path.join(AI_UPLOAD_DIR, entry.filename || '');
  if (entry.filename && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { console.error('Error deleting AI file:', e); }
  }

  data.aiKnowledge.splice(idx, 1);
  writeData(data);

  res.json({ success: true, message: 'Entry deleted' });
});

// Public AI chat endpoint
app.post('/api/ai/chat', (req, res) => {
  const { question } = req.body || {};
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'Missing question' });
  }

  const data = readData();
  ensureAiKnowledge(data);

  if (data.aiKnowledge.length === 0) {
    return res.json({
      success: true,
      answer: 'No training material is available yet. Please try again later.'
    });
  }

  const questionTokens = tokenize(question);
  let best = { score: 0, sentence: '', title: '' };

  data.aiKnowledge.forEach(entry => {
    const sentences = splitSentences(entry.text);
    sentences.forEach(sentence => {
      const tokens = tokenize(sentence);
      let overlap = 0;
      questionTokens.forEach(q => {
        if (tokens.includes(q)) overlap += 1;
      });
      if (overlap > best.score) {
        best = { score: overlap, sentence: sentence.trim(), title: entry.title };
      }
    });
  });

  if (!best.sentence) {
    return res.json({
      success: true,
      answer: 'I could not find a relevant answer in the training material. Try rephrasing your question.'
    });
  }

  res.json({
    success: true,
    answer: best.sentence,
    sourceTitle: best.title || undefined
  });
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
