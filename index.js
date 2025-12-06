const express = require('express');
// Load environment variables from .env if present
require('dotenv').config();
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const session = require('express-session');
const redis = require('redis');
const RedisStore = require('connect-redis').default;
// Turso DB client
const turso = require('./db/turso-client');
// Excel generation
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== SESSION & AUTH CONFIG ====================
// Read sensitive values from environment variables with sensible defaults
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_to_a_strong_secret_in_production';

// Redis configuration
const REDIS_URL = process.env.REDIS_URL;
let redisClient;
let sessionStore;

// Initialize Redis client if REDIS_URL is provided
if (REDIS_URL) {
  redisClient = redis.createClient({
    url: REDIS_URL,
    legacyMode: false
  });

  redisClient.connect().catch(err => {
    console.error('Redis connection error:', err);
    process.exit(1);
  });

  redisClient.on('error', (err) => {
    console.error('Redis error:', err);
  });

  redisClient.on('connect', () => {
    console.log('Connected to Redis successfully');
  });

  // Create Redis session store
  sessionStore = new RedisStore({
    client: redisClient,
    prefix: 'adms:session:'
  });
} else {
  console.warn('REDIS_URL not provided. Using default in-memory session store. This is NOT suitable for production.');
}

// Static user credentials (move to env for production)
const VALID_USER = {
  username: process.env.VALID_USER_USERNAME || 'admin',
  password: process.env.VALID_USER_PASSWORD || 'admin123'
};

// Session configuration
const sessionConfig = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true' || false, // set to true when using HTTPS
    maxAge: parseInt(process.env.SESSION_MAX_AGE, 10) || 24 * 60 * 60 * 1000 // default 24 hours
  }
};

// Add Redis store if available
if (sessionStore) {
  sessionConfig.store = sessionStore;
}

app.use(session(sessionConfig));

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

// ==================== CACHING SYSTEM ====================
// Cache structure: { 'YYYY-MM': { attendanceData, employeeMap, timestamp } }
const monthlyAttendanceCache = {};
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour cache

function clearExpiredCache() {
  const now = Date.now();
  Object.keys(monthlyAttendanceCache).forEach(key => {
    if (now - monthlyAttendanceCache[key].timestamp > CACHE_DURATION_MS) {
      delete monthlyAttendanceCache[key];
      console.log(`Cleared cache for ${key}`);
    }
  });
}

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

// Get list of all employees (with optional status filter)
app.get('/api/employees', isAuthenticated, async (req, res) => {
  try {
    // Fetch from Turso DB
    const rows = await turso.getAllEmployees();
    const employeeList = rows.map(r => ({ pin: r.pin, name: r.name, status: r.status }));
    res.json(employeeList);
  } catch (err) {
    console.error('Error fetching employees from DB:', err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// Get all employees with status information
app.get('/api/employees/status/all', isAuthenticated, async (req, res) => {
  try {
    const rows = await turso.getAllEmployees();
    // Convert BigInt ids to strings for JSON serialization
    const sanitizedRows = rows.map(row => ({
      ...row,
      id: row.id ? String(row.id) : null
    }));
    res.json(sanitizedRows);
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// Update employee status
app.post('/api/employees/status', isAuthenticated, async (req, res) => {
  try {
    const { pin, status } = req.body;
    
    if (!pin || !status) {
      return res.status(400).json({ error: 'PIN and status are required' });
    }
    
    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be "active" or "inactive"' });
    }
    
    const result = await turso.updateEmployeeStatus(pin, status);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error updating employee status:', err);
    res.status(500).json({ error: 'Failed to update employee status' });
  }
});

// Add new employee to device and database
app.post('/api/employees/add', isAuthenticated, async (req, res) => {
  try {
    const { pin, name } = req.body;
    
    if (!pin || !name) {
      return res.status(400).json({ error: 'PIN and name are required' });
    }
    
    // Check if employee already exists
    const existing = await turso.getEmployeeByPin(pin);
    if (existing) {
      return res.status(400).json({ error: 'Employee with this PIN already exists' });
    }
    
    // Send SOAP request to add employee to device
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <UpdateEmployee xmlns="http://tempuri.org/">
      <UserName>${USERNAME}</UserName>
      <Password>${PASSWORD}</Password>
      <EmployeeCode>${pin}</EmployeeCode>
      <EmployeeName>${name}</EmployeeName>
      <EmployeeLocation>${LOCATION}</EmployeeLocation>
      <EmployeeRole>Normal User</EmployeeRole>
      <EmployeeVerificationType>Finger or Face or Card or Password</EmployeeVerificationType>
    </UpdateEmployee>
  </soap:Body>
</soap:Envelope>`;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://tempuri.org/UpdateEmployee'
      },
      body: soapEnvelope
    });

    const xmlText = await response.text();
    
    // Check if SOAP response indicates success (basic check)
    if (!xmlText.includes('UpdateEmployeeResult')) {
      console.error('SOAP Response:', xmlText);
      return res.status(500).json({ error: 'Failed to add employee to device' });
    }
    
    // Add employee to database
    const dbResult = await turso.addEmployee(pin, name);
    
    // Convert BigInt id to string for JSON serialization
    const responseData = {
      ...dbResult,
      id: dbResult.id ? String(dbResult.id) : null
    };
    
    res.json({ 
      success: true, 
      message: 'Employee added successfully to device and database',
      data: responseData
    });
    
  } catch (error) {
    console.error('Error adding employee:', error);
    res.status(500).json({ error: 'Failed to add employee' });
  }
});

// POST alias used by client to fetch employee list for monthly view
app.post('/api/monthly-attendance-list', isAuthenticated, async (req, res) => {
  try {
    const rows = await turso.getAllEmployees('active');
    const employeeList = rows.map(r => ({ pin: r.pin, name: r.name })).sort((a, b) => a.pin.localeCompare(b.pin));
    res.json(employeeList);
  } catch (err) {
    console.error('Error in monthly-attendance-list endpoint:', err);
    res.status(500).json({ error: 'Failed to fetch employee list' });
  }
});

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
    
    // Process all logs in parallel (not sequential!)
    const processPromises = logsArray.map((xmlText, i) => {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
      return processAttendanceLogs(xmlText, date).then(records => ({ date, records }));
    });
    
    const processedDays = await Promise.all(processPromises);
    
    // Consolidate data by employee
    const monthlyData = {};
    
    processedDays.forEach(({ date, records }) => {
      records.forEach(record => {
        if (!monthlyData[record.pin]) {
          monthlyData[record.pin] = {
            pin: record.pin,
            name: record.name,
            dailyRecords: {}
          };
        }
        monthlyData[record.pin].dailyRecords[date] = record;
      });
    });
    
    res.json(monthlyData);
    
  } catch (error) {
    console.error('Error fetching monthly attendance:', error);
    res.status(500).json({ error: 'Failed to fetch monthly attendance data' });
  }
});

// Single employee monthly attendance endpoint
app.post('/api/employee-attendance', isAuthenticated, async (req, res) => {
  try {
    const { empCode, yearMonth } = req.body;
    
    if (!empCode || !yearMonth) {
      return res.status(400).json({ error: 'Employee code and year-month are required' });
    }

    // Clear any expired cache first
    clearExpiredCache();

    // Check if we have cached data for this month
    const cacheKey = yearMonth;
    let monthlyData = monthlyAttendanceCache[cacheKey];

    if (!monthlyData) {
      // Cache miss - fetch all data for the month
      console.log(`Cache miss for ${cacheKey}, fetching from API...`);
      
      const [year, month] = yearMonth.split('-');
      const daysInMonth = new Date(year, month, 0).getDate();
      
      // Create promises for all dates (parallel fetching)
      const datePromises = [];
      for (let day = 1; day <= daysInMonth; day++) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        datePromises.push(fetchAttendanceForDate(date));
      }
      
      // Fetch all dates in parallel
      const logsArray = await Promise.all(datePromises);
      
      // Process all logs in parallel (not sequential!)
      const processPromises = logsArray.map((xmlText, i) => {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
        return processAttendanceLogs(xmlText, date).then(records => ({ date, records }));
      });
      
      const processedDays = await Promise.all(processPromises);
      
      // Consolidate data by employee
      const allMonthlyData = {};
      const employeeNames = {};
      
      processedDays.forEach(({ date, records }) => {
        records.forEach(record => {
          if (!allMonthlyData[record.pin]) {
            allMonthlyData[record.pin] = {
              pin: record.pin,
              name: record.name,
              dailyRecords: {}
            };
            employeeNames[record.pin] = record.name;
          }
          allMonthlyData[record.pin].dailyRecords[date] = record;
        });
      });
      
      // Cache the complete monthly data
      monthlyAttendanceCache[cacheKey] = {
        data: allMonthlyData,
        employeeNames: employeeNames,
        timestamp: Date.now()
      };
      
      monthlyData = monthlyAttendanceCache[cacheKey];
      console.log(`Cached ${Object.keys(allMonthlyData).length} employees for ${cacheKey}`);
    } else {
      console.log(`Cache hit for ${cacheKey}`);
    }
    
    // Get employee data from cache
    const cachedEmployeeData = monthlyData.data[empCode];
    
    if (!cachedEmployeeData) {
      // Employee has no records for this month, but return structure anyway
      const employeeName = monthlyData.employeeNames[empCode] || await getEmployeeNameAsync(empCode);
      return res.json({
        pin: empCode,
        name: employeeName,
        dailyRecords: {}
      });
    }
    
    res.json(cachedEmployeeData);
    
  } catch (error) {
    console.error('Error fetching employee attendance:', error);
    res.status(500).json({ error: 'Failed to fetch employee attendance data' });
  }
});

// Local employees map used as a fallback when Turso DB is not available
const LOCAL_EMPLOYEES = {
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
  'TS0084': 'Anjali Dwivedi',
  '85': 'Ayush Sen'
};

// Async helper that prefers Turso DB, falls back to local map
async function getEmployeeNameAsync(pin) {
  try {
    const name = await turso.getEmployeeNameByPin(pin);
    return name || LOCAL_EMPLOYEES[pin] || 'Unknown';
  } catch (e) {
    return LOCAL_EMPLOYEES[pin] || 'Unknown';
  }
}

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
async function processAttendanceLogs(xmlText, date) {
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
      // Store the raw timestamp string as-is (it's already in UTC format from the device)
      employeeLogs[empCode].push(timestamp);
    });

    // Calculate attendance for each employee
    const attendanceRecords = [];
    
    for (const [empCode, timestamps] of Object.entries(employeeLogs)) {
      // Convert timestamps to Date objects for sorting
      const dateObjects = timestamps.map(ts => {
        const isoFormat = ts.replace(' ', 'T') + 'Z';
        return new Date(isoFormat);
      });
      dateObjects.sort((a, b) => a - b);
      
      const firstPunch = dateObjects[0];
      const lastPunch = dateObjects[dateObjects.length - 1];
      const durationMs = lastPunch - firstPunch;
      const durationMinutes = Math.floor(durationMs / 60000);

      // Mark as PRESENT only if there's a checkin AND duration > 0; otherwise ABSENT
      let status;
      if (firstPunch) {
        status = 'PRESENT';
      } else if (durationMinutes < 360) {
        status = 'SHORT';
      } else {
        status = 'ABSENT';
      }

      // Fetch name (DB-first, fallback to local)
      let empName = await getEmployeeNameAsync(empCode);

      attendanceRecords.push({
        pin: empCode,
        name: empName,
        first_ts: firstPunch.toISOString(),
        last_ts: lastPunch.toISOString(),
        duration_minutes: durationMinutes,
        status: status
      });
    }

    // Add ABSENT records for employees with no checkins (fetch list from DB, only active)
    try {
      const allEmps = await turso.getAllEmployees('active');
      for (const e of allEmps) {
        if (!employeeLogs[e.pin]) {
          attendanceRecords.push({
            pin: e.pin,
            name: e.name,
            first_ts: null,
            last_ts: null,
            duration_minutes: 0,
            status: 'ABSENT'
          });
        }
      }
    } catch (dbErr) {
      console.error('Failed to fetch all employees for absent fill:', dbErr);
    }

    return attendanceRecords;
  } catch (error) {
    console.error('Error processing attendance logs:', error);
    return [];
  }
}

// Helper function to get employee name from the local fallback map
function getEmployeeName(empCode) {
  return LOCAL_EMPLOYEES[empCode] || 'Unknown';
}

// Helper function to format time for display
function formatTimeForDisplay(isoString) {
  if (!isoString) return '-';
  try {
    const date = new Date(isoString);
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const seconds = date.getUTCSeconds();
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${String(displayHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} ${period}`;
  } catch (e) {
    return isoString;
  }
}

// Helper function to format duration (minutes) to "Xh Ym"
function formatDurationForDisplay(minutes) {
  if (!minutes && minutes !== 0) return '-';
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hrs}h ${mins}m`;
}

// Daily attendance endpoint - returns display-ready records for a single date
app.post('/api/daily-attendance', isAuthenticated, async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'Date is required' });

    const xmlText = await fetchAttendanceForDate(date);
  const attendanceRecords = await processAttendanceLogs(xmlText, date);

    const formattedRecords = attendanceRecords.map(record => ({
      pin: record.pin,
      name: record.name,
      first_ts: formatTimeForDisplay(record.first_ts),
      last_ts: formatTimeForDisplay(record.last_ts),
      duration: formatDurationForDisplay(record.duration_minutes),
      status: record.status
    }));

    res.json(formattedRecords);
  } catch (err) {
    console.error('Error in /api/daily-attendance:', err);
    res.status(500).json({ error: 'Failed to fetch daily attendance' });
  }
});

// Employee monthly detail endpoint - returns formatted monthly calendar for a specific employee
app.post('/api/employee-monthly-detail', isAuthenticated, async (req, res) => {
  try {
    const { empCode, yearMonth } = req.body;
    if (!empCode || !yearMonth) {
      return res.status(400).json({ error: 'Employee code and year-month are required' });
    }

    const [year, month] = yearMonth.split('-');
    const daysInMonth = new Date(year, month, 0).getDate();

    // Fetch all dates in parallel for performance
    const datePromises = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      datePromises.push(fetchAttendanceForDate(date));
    }

    const logsArray = await Promise.all(datePromises);

    // Process all logs in parallel
    const processPromises = logsArray.map((xmlText, i) => {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
      return processAttendanceLogs(xmlText, date).then(records => ({ date, records }));
    });

    const processedDays = await Promise.all(processPromises);

    // Consolidate data for the specific employee
    const dailyRecords = {};

    processedDays.forEach(({ date, records }) => {
      // Find records for this specific employee
      const empRecord = records.find(record => record.pin === empCode);
      if (empRecord) {
        dailyRecords[date] = {
          status: empRecord.status,
          first_ts: formatTimeForDisplay(empRecord.first_ts),
          last_ts: formatTimeForDisplay(empRecord.last_ts),
          duration: formatDurationForDisplay(empRecord.duration_minutes)
        };
      }
    });

    const employeeName = await getEmployeeNameAsync(empCode);

    res.json({
      pin: empCode,
      name: employeeName,
      dailyRecords
    });
  } catch (err) {
    console.error('Error in /api/employee-monthly-detail:', err);
    res.status(500).json({ error: 'Failed to fetch employee monthly detail' });
  }
});

// Streaming endpoint for employee monthly detail with progress
app.get('/api/employee-monthly-detail-stream', isAuthenticated, async (req, res) => {
  try {
    const { empCode, yearMonth } = req.query;
    
    if (!empCode || !yearMonth) {
      return res.status(400).json({ error: 'Employee code and year-month are required' });
    }

    // Set up Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const [year, month] = yearMonth.split('-');
    const daysInMonth = new Date(year, month, 0).getDate();

    // Send initial message
    res.write(`data: ${JSON.stringify({ type: 'start', total: daysInMonth })}\n\n`);

    // Fetch all dates in parallel for performance
    const datePromises = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      datePromises.push(fetchAttendanceForDate(date));
    }

    const logsArray = await Promise.all(datePromises);

    // Process all logs in parallel
    const processPromises = logsArray.map((xmlText, i) => {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
      return processAttendanceLogs(xmlText, date).then(records => ({ date, records, index: i + 1 }));
    });

    // Stream results as they complete using Promise.allSettled
    const allResults = [];
    for (const promise of processPromises) {
      try {
        const { date, records, index } = await promise;
        
        // Find records for this specific employee
        const empRecord = records.find(record => record.pin === empCode);
        if (empRecord) {
          const dayData = {
            date,
            status: empRecord.status,
            first_ts: formatTimeForDisplay(empRecord.first_ts),
            last_ts: formatTimeForDisplay(empRecord.last_ts),
            duration: formatDurationForDisplay(empRecord.duration_minutes)
          };
          
          allResults.push({ date, dayData });
          
          // Stream progress update with result
          res.write(`data: ${JSON.stringify({ 
            type: 'progress', 
            current: index, 
            total: daysInMonth,
            date,
            dayData
          })}\n\n`);
        } else {
          // Stream progress without result (no data for this day)
          res.write(`data: ${JSON.stringify({ 
            type: 'progress', 
            current: index, 
            total: daysInMonth,
            date: null
          })}\n\n`);
        }
      } catch (err) {
        console.error(`Error processing day ${promise.index}:`, err);
        res.write(`data: ${JSON.stringify({ type: 'error', message: `Failed to process day ${promise.index}` })}\n\n`);
      }
    }

    // Get employee name
    const employeeName = await getEmployeeNameAsync(empCode);

    // Send completion message
    res.write(`data: ${JSON.stringify({ 
      type: 'complete', 
      pin: empCode, 
      name: employeeName,
      total: allResults.length
    })}\n\n`);

    res.end();
  } catch (err) {
    console.error('Error in /api/employee-monthly-detail-stream:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to fetch employee monthly detail' })}\n\n`);
    res.end();
  }
});

// Export monthly attendance to Excel endpoint
app.post('/api/export-monthly-attendance', isAuthenticated, async (req, res) => {
  try {
    const { yearMonth, employees } = req.body;
    
    if (!yearMonth || !employees || employees.length === 0) {
      return res.status(400).json({ error: 'Year-month and employee list are required' });
    }

    // Set response headers for Excel download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${yearMonth}.xlsx"`);

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Attendance ${yearMonth}`);

    // Get days in month
    const [year, month] = yearMonth.split('-');
    const daysInMonth = new Date(year, month, 0).getDate();
    
    // Clear any expired cache
    clearExpiredCache();

    // Check cache for monthly data
    const cacheKey = yearMonth;
    let monthlyData = monthlyAttendanceCache[cacheKey];

    if (!monthlyData) {
      // Fetch from API
      const datePromises = [];
      for (let day = 1; day <= daysInMonth; day++) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        datePromises.push(fetchAttendanceForDate(date));
      }
      
      const logsArray = await Promise.all(datePromises);
      
      const processPromises = logsArray.map((xmlText, i) => {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
        return processAttendanceLogs(xmlText, date).then(records => ({ date, records }));
      });
      
      const processedDays = await Promise.all(processPromises);
      
      const allMonthlyData = {};
      const employeeNames = {};
      
      processedDays.forEach(({ date, records }) => {
        records.forEach(record => {
          if (!allMonthlyData[record.pin]) {
            allMonthlyData[record.pin] = {
              pin: record.pin,
              name: record.name,
              dailyRecords: {}
            };
            employeeNames[record.pin] = record.name;
          }
          allMonthlyData[record.pin].dailyRecords[date] = record;
        });
      });
      
      monthlyAttendanceCache[cacheKey] = {
        data: allMonthlyData,
        employeeNames: employeeNames,
        timestamp: Date.now()
      };
      
      monthlyData = monthlyAttendanceCache[cacheKey];
    }

    // Helper function to get day of week
    const getDayOfWeek = (dateStr) => {
      const date = new Date(dateStr + 'T00:00:00');
      const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      return days[date.getDay()];
    };

    // Helper function to get status abbreviation
    const getStatusAbbrev = (status) => {
      if (!status) return 'A'; // Absent
      const statusLower = status.toLowerCase();
      if (statusLower === 'present') return 'P';
      if (statusLower === 'short') return 'S';
      if (statusLower === 'absent') return 'A';
      return 'A';
    };

    // Set up header row with dates
    worksheet.columns = [
      { header: 'Employee Name', key: 'name', width: 20 },
      ...Array.from({ length: daysInMonth }, (_, i) => ({
        header: `${i + 1}`,
        key: `day${i + 1}`,
        width: 8
      })),
      { header: 'TOTAL PRESENT', key: 'totalPresent', width: 15 },
      { header: 'TOTAL ABSENT', key: 'totalAbsent', width: 15 }
    ];

    // Add day of week header row
    const dow = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      dow.push(getDayOfWeek(date));
    }

    // Style header rows
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF366092' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
    headerRow.height = 25;

    // Add day of week row
    const dowRow = worksheet.insertRow(2, {});
    dowRow.getCell(1).value = 'Day Of Week';
    for (let day = 1; day <= daysInMonth; day++) {
      dowRow.getCell(day + 1).value = dow[day - 1];
    }
    dowRow.font = { bold: true, italic: true };
    dowRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    dowRow.alignment = { horizontal: 'center', vertical: 'center' };
    dowRow.height = 20;

    // Add employee data rows
    let currentRow = 3;
    let processedCount = 0;

    for (const empCode of employees) {
      processedCount++;

      const employeeData = monthlyData.data[empCode];
      if (!employeeData) continue;

      const row = {
        name: employeeData.name
      };

      let totalPresent = 0;
      let totalAbsent = 0;

      for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayRecord = employeeData.dailyRecords[dateStr];
        
        const status = dayRecord?.status || 'ABSENT';
        const abbrev = getStatusAbbrev(status);
        row[`day${day}`] = abbrev;

        if (abbrev === 'P') totalPresent++;
        if (abbrev === 'A') totalAbsent++;
      }

      row.totalPresent = totalPresent;
      row.totalAbsent = totalAbsent;

      const wsRow = worksheet.insertRow(currentRow, row);
      
      // Style data rows
      wsRow.font = { size: 11 };
      for (let day = 1; day <= daysInMonth; day++) {
        const cell = wsRow.getCell(day + 1);
        cell.alignment = { horizontal: 'center', vertical: 'center' };
        
        // Color code: Green = P, Red = A, Yellow = S
        if (cell.value === 'P') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
          cell.font = { color: { argb: 'FF006100' } };
        } else if (cell.value === 'A') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
          cell.font = { color: { argb: 'FF9C0006' } };
        } else if (cell.value === 'S') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF99' } };
          cell.font = { color: { argb: 'FF9C6500' } };
        }
      }

      // Style summary columns
      wsRow.getCell(daysInMonth + 2).font = { bold: true };
      wsRow.getCell(daysInMonth + 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCFFCC' } };
      wsRow.getCell(daysInMonth + 3).font = { bold: true };
      wsRow.getCell(daysInMonth + 3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCCC' } };

      currentRow++;
    }

    // Write workbook to response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Error in /api/export-monthly-attendance:', error);
    res.status(500).json({ error: 'Failed to export attendance data' });
  }
});

// Root route - redirect to dashboard or login based on auth status
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login.html');
  }
});

// Serve dashboard (requires authentication)
app.get('/dashboard', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve login.html (public)
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Initialize Turso DB (accept TURSO_DB_URL as alias for TURSO_CONNECTION_URL)
process.env.TURSO_CONNECTION_URL = process.env.TURSO_CONNECTION_URL || process.env.TURSO_DB_URL;

(async () => {
  try {
    await turso.initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
      console.log(`Default credentials - Username: ${VALID_USER.username}, Password: ${VALID_USER.password}`);
    });
  } catch (err) {
    console.error('Failed to initialize Turso DB, server not started:', err);
    process.exit(1);
  }
})();
