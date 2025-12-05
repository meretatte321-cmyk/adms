const { createClient } = require('@libsql/client');

let db;

/**
 * Initialize Turso database client
 * Expects TURSO_CONNECTION_URL and TURSO_AUTH_TOKEN environment variables
 */
async function initializeDatabase() {
  try {
    if (!process.env.TURSO_CONNECTION_URL) {
      throw new Error('TURSO_CONNECTION_URL environment variable is not set');
    }

    if (!process.env.TURSO_AUTH_TOKEN) {
      throw new Error('TURSO_AUTH_TOKEN environment variable is not set');
    }

    db = createClient({
      url: process.env.TURSO_CONNECTION_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });

    console.log('Connected to Turso database successfully');
    return db;
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Get database instance
 */
function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first');
  }
  return db;
}

/**
 * Get all employees from database
 */
async function getAllEmployees(statusFilter = null) {
  try {
    let query = 'SELECT id, pin, name, status FROM employees ORDER BY pin';
    let params = [];
    
    if (statusFilter) {
      query = 'SELECT id, pin, name, status FROM employees WHERE status = ? ORDER BY pin';
      params = [statusFilter];
    }
    
    const result = await db.execute(query, params);
    return result.rows.map(row => ({
      id: row[0],
      pin: row[1],
      name: row[2],
      status: row[3]
    }));
  } catch (error) {
    console.error('Error fetching employees:', error);
    throw error;
  }
}

/**
 * Get employee by PIN
 */
async function getEmployeeByPin(pin) {
  try {
    const result = await db.execute('SELECT id, pin, name, status FROM employees WHERE pin = ?', [pin]);
    if (result.rows.length === 0) {
      return null;
    }
    return {
      id: result.rows[0][0],
      pin: result.rows[0][1],
      name: result.rows[0][2],
      status: result.rows[0][3]
    };
  } catch (error) {
    console.error('Error fetching employee by PIN:', error);
    throw error;
  }
}

/**
 * Get employee name by PIN
 */
async function getEmployeeNameByPin(pin) {
  try {
    const result = await db.execute('SELECT name FROM employees WHERE pin = ?', [pin]);
    if (result.rows.length === 0) {
      return 'Unknown';
    }
    return result.rows[0][0];
  } catch (error) {
    console.error('Error fetching employee name:', error);
    return 'Unknown';
  }
}

/**
 * Add a new employee
 */
async function addEmployee(pin, name) {
  try {
    const result = await db.execute(
      'INSERT INTO employees (pin, name) VALUES (?, ?)',
      [pin, name]
    );
    return {
      id: result.lastInsertRowid,
      pin,
      name
    };
  } catch (error) {
    console.error('Error adding employee:', error);
    throw error;
  }
}

/**
 * Update employee information
 */
async function updateEmployee(pin, name) {
  try {
    await db.execute(
      'UPDATE employees SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE pin = ?',
      [name, pin]
    );
    return {
      pin,
      name
    };
  } catch (error) {
    console.error('Error updating employee:', error);
    throw error;
  }
}

/**
 * Delete employee by PIN
 */
async function deleteEmployee(pin) {
  try {
    await db.execute('DELETE FROM employees WHERE pin = ?', [pin]);
    return { success: true, pin };
  } catch (error) {
    console.error('Error deleting employee:', error);
    throw error;
  }
}

/**
 * Update employee status
 */
async function updateEmployeeStatus(pin, status) {
  try {
    if (!['active', 'inactive'].includes(status)) {
      throw new Error('Invalid status. Must be "active" or "inactive"');
    }
    
    await db.execute(
      'UPDATE employees SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE pin = ?',
      [status, pin]
    );
    return {
      pin,
      status
    };
  } catch (error) {
    console.error('Error updating employee status:', error);
    throw error;
  }
}

module.exports = {
  initializeDatabase,
  getDatabase,
  getAllEmployees,
  getEmployeeByPin,
  getEmployeeNameByPin,
  addEmployee,
  updateEmployee,
  deleteEmployee,
  updateEmployeeStatus
};
