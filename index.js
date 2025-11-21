const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'text/xml' }));
app.use(express.static('public'));

// API Configuration
const API_URL = 'http://iclock.iserviceforce.com/webservice.asmx';
const USERNAME = 'essl';
const PASSWORD = 'essl';
const LOCATION = '00009';

// Proxy endpoint for SOAP requests
app.post('/api/attendance', async (req, res) => {
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

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
