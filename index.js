const express = require('express');
// Load environment variables from .env if present
require('dotenv').config();
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== SESSION & AUTH CONFIG ====================
// Read sensitive values from environment variables with sensible defaults
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_to_a_strong_secret_in_production';

// Static user credentials (move to env for production)
const VALID_USER = {
  username: process.env.VALID_USER_USERNAME || 'admin',
  password: process.env.VALID_USER_PASSWORD || 'admin123'
};

// Session configuration
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true' || false, // set to true when using HTTPS
    maxAge: parseInt(process.env.SESSION_MAX_AGE, 10) || 24 * 60 * 60 * 1000 // default 24 hours
  }
}));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'text/xml' }));
app.use(express.static('public'));

// API Configuration (can be overridden via environment variables)
const API_URL = process.env.API_URL || 'http://iclock.iserviceforce.com/webservice.asmx';
const USERNAME = process.env.API_USERNAME || 'essl';
const PASSWORD = process.env.API_PASSWORD || 'essl';
const LOCATION = process.env.API_LOCATION || '00009';

// ==================== AUTH MIDDLEWARE ====================
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
}

// ==================== AUTH ENDPOINTS ====================

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // Validate input
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  // Check credentials
  if (username === VALID_USER.username && password === VALID_USER.password) {
    // Create session
    req.session.user = {
      username: username,
      loginTime: new Date()
    };

    return res.json({ 
      success: true, 
      message: 'Login successful',
      user: req.session.user
    });
  } else {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout.' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// Check auth status endpoint
app.get('/api/auth-status', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ 
      authenticated: true, 
      user: req.session.user 
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ==================== PROTECTED API ENDPOINTS ====================

// Proxy endpoint for daily SOAP requests
app.post('/api/attendance', isAuthenticated, async (req, res) => {
  try {
    const { date } = req.body;
    
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetDeviceLogs xmlns="http://tempuri.org/">
      <UserName>${USERNAME}</UserName>
      <Password>${PASSWORD}</Password>
      <Location>${LOCATION}</Location>
      <LogDate>${date}</LogDate>
    </GetDeviceLogs>
  </soap:Body>
</soap:Envelope>`;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://tempuri.org/GetDeviceLogs'
      },
      body: soapEnvelope
    });

    const xmlText = await response.text();
    res.set('Content-Type', 'text/xml');
    res.send(xmlText);
    
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});

// Monthly attendance endpoint - fetches all dates in parallel
app.post('/api/monthly-attendance', isAuthenticated, async (req, res) => {
  try {
    const { yearMonth } = req.body;
    const [year, month] = yearMonth.split('-');
    const daysInMonth = new Date(year, month, 0).getDate();
    
    // Create promises for all dates
    const datePromises = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      datePromises.push(fetchAttendanceForDate(date));
    }
    
    // Fetch all dates in parallel
    const logsArray = await Promise.all(datePromises);
    
    // Consolidate data by employee
    const monthlyData = {};
    
    for (let i = 0; i < logsArray.length; i++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
      const attendanceRecords = processAttendanceLogs(logsArray[i], date);
      
      // Organize by employee
      attendanceRecords.forEach(record => {
        if (!monthlyData[record.pin]) {
          monthlyData[record.pin] = {
            pin: record.pin,
            name: record.name,
            dailyRecords: {}
          };
        }
        monthlyData[record.pin].dailyRecords[date] = record;
      });
    }
    
    res.json(monthlyData);
    
  } catch (error) {
    console.error('Error fetching monthly attendance:', error);
    res.status(500).json({ error: 'Failed to fetch monthly attendance data' });
  }
});

// Helper function to fetch attendance for a single date
async function fetchAttendanceForDate(date) {
  try {
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetDeviceLogs xmlns="http://tempuri.org/">
      <UserName>${USERNAME}</UserName>
      <Password>${PASSWORD}</Password>
      <Location>${LOCATION}</Location>
      <LogDate>${date}</LogDate>
    </GetDeviceLogs>
  </soap:Body>
</soap:Envelope>`;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://tempuri.org/GetDeviceLogs'
      },
      body: soapEnvelope
    });

    return await response.text();
  } catch (error) {
    console.error(`Error fetching attendance for date ${date}:`, error);
    return '';
  }
}

// Helper function to process attendance logs
function processAttendanceLogs(xmlText, date) {
  if (!xmlText || xmlText.trim() === '') {
    return [];
  }

  try {
    // Parse XML response to extract logs text
    const startTag = '<GetDeviceLogsResult>';
    const endTag = '</GetDeviceLogsResult>';
    const startIndex = xmlText.indexOf(startTag);
    const endIndex = xmlText.indexOf(endTag);
    
    if (startIndex === -1 || endIndex === -1) {
      return [];
    }
    
    const logsText = xmlText.substring(startIndex + startTag.length, endIndex);
    const lines = logsText.trim().split('\n').filter(line => line.trim());
    
    const employeeLogs = {};

    // Parse each log entry
    lines.forEach(line => {
      const parts = line.split(',');
      if (parts.length < 5) return;

      const timestamp = parts[0].trim();
      const empCode = parts[1].trim();
      
      if (!employeeLogs[empCode]) {
        employeeLogs[empCode] = [];
      }
      employeeLogs[empCode].push(new Date(timestamp));
    });

    // Calculate attendance for each employee
    const attendanceRecords = [];
    
    for (const [empCode, timestamps] of Object.entries(employeeLogs)) {
      timestamps.sort((a, b) => a - b);
      
      const firstPunch = timestamps[0];
      const lastPunch = timestamps[timestamps.length - 1];
      const durationMs = lastPunch - firstPunch;
      const durationMinutes = Math.floor(durationMs / 60000);
      const durationHours = durationMinutes / 60;

      let status;
      if (durationHours >= 6) {
        status = 'PRESENT';
      } else if (durationHours > 0) {
        status = 'SHORT';
      } else {
        status = 'ABSENT';
      }

      attendanceRecords.push({
        pin: empCode,
        name: getEmployeeName(empCode),
        first_ts: firstPunch.toISOString(),
        last_ts: lastPunch.toISOString(),
        duration_minutes: durationMinutes,
        status: status
      });
    }

    return attendanceRecords;
  } catch (error) {
    console.error('Error processing attendance logs:', error);
    return [];
  }
}

// Helper function to get employee name
function getEmployeeName(empCode) {
  const EMPLOYEES = {
    'TS0002': 'Kavita Pandey',
    'TS0003': 'Chakresh Mahobiya',
    'TS0004': 'Ravikant Dixit',
    'TS0005': 'Ram K Gautam',
    'TS0006': 'Suraj Kumar',
    'TS0007': 'Ravi Awasthi',
    'TS0008': 'Deepti Sarathe',
    'TS0009': 'Arpita Prajapati',
    'TS0010': 'Manya Jain',
    'TS0011': 'Kaushiki Gautam',
    'TS0012': 'Sourabh Bhatnagar',
    'TS0013': 'Rohit Sahu',
    'TS0014': 'Gourav Wani',
    'TS0015': 'Arshan Ghouri',
    'TS0016': 'Jatin Prajapati',
    'TS0017': 'Aman das',
    'TS0018': 'Arman Kacher',
    'TS0019': 'Ilman Khan',
    'TS0020': 'Shifa Raine',
    'TS0021': 'Saeed Khan',
    'TS0022': 'Muskan Mishra',
    'TS0023': 'Supriya Soni',
    'TS0024': 'kajal Priya',
    'TS0025': 'Atul Kumar Dwivedi',
    'TS0026': 'neeraj sharma',
    'TS0027': 'Rahul Raghuwanshi',
    'TS0028': 'Kuldeep Shrivastava',
    'TS0029': 'Harikesh Dwivedi',
    'TS0030': 'Shivendra Dwivedi',
    'TS0031': 'Sunil Rathore',
    'TS0032': 'jitendra Shrivastava',
    'TS0033': 'Manish Kumar',
    'TS0034': 'Bilal khan',
    'TS0035': 'Sanjay Sharma',
    'TS0036': 'Chatrupa Goud',
    'TS0037': 'Sandeep Mishra',
    'TS0038': 'srishti Bangde',
    'TS0039': 'Nishi Bhargava',
    'TS0045': 'Anil Sharma',
    'TS0053': 'Manju Jonwal',
    'TS0056': 'Amresh Kushwaha',
    'TS0057': 'Sanjay Dhiman',
    'TS0058': 'Siddharth raikwar',
    'TS0070': 'Ruma Akhtar',
    'TS0072': 'Sanjeet Kumar Dhurwey',
    'TS0078': 'Ansh Jain',
    'TS0079': 'Ramanand Tiwari',
    'TS0080': 'Swatantra Kumar Shukla',
    'TS0082': 'Dablu Kumar',
    'TS0083': 'Sachin Malviya',
    'TS0084': 'Anjali Dwivedi'
  };
  return EMPLOYEES[empCode] || 'Unknown';
}

// Serve index.html (requires authentication)
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/login.html');
  }
});

// Serve login.html (public)
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Default credentials - Username: ${VALID_USER.username}, Password: ${VALID_USER.password}`);
});
