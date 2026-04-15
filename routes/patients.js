const express = require('express');
const router = express.Router();
const pool = require('../db');
const { processBatch } = require('../services/processor');

// GET /api/patients
// Returns a paginated list of patients from upload_patients.
router.get('/patients', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const [rows] = await pool.query(`
      SELECT 
        p.id,
        p.patient_id, 
        (SELECT upload_status FROM upload_log l WHERE l.patient_id = p.patient_id ORDER BY l.id DESC LIMIT 1) as fetch_status,
        (SELECT log FROM upload_log l WHERE l.patient_id = p.patient_id ORDER BY l.id DESC LIMIT 1) as last_log
      FROM upload_patients p
      ORDER BY p.id ASC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    res.json({ patients: rows, page, limit });
  } catch (err) {
    console.error('Error fetching patients:', err);
    res.status(500).json({ error: 'Failed to fetch patients list.' });
  }
});

// POST /api/process-batch
// Start the processing orchestrator for a batch of patients.
router.post('/process-batch', (req, res) => {
  const { patients } = req.body; // Array of patient_ids
  if (!patients || !Array.isArray(patients)) {
    return res.status(400).json({ error: 'patients array is required in the body' });
  }

  // Acknowledge the trigger immediately
  res.json({ message: 'Batch processing started.' });

  // Get io from app.locals
  const io = req.app.locals.io;
  
  // Run asynchronously
  processBatch(patients, io).catch(err => {
    console.error('Batch processing error:', err);
  });
});

module.exports = router;
