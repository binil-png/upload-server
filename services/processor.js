const pool = require('../db');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');

/**
 * Splits an array into chunks of a given size.
 */
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Update the upload status and emit a WebSocket event.
 */
async function updateStatus(patientId, status, io, logMessage = null) {
  // Emit to frontend
  if (io) {
    io.emit('patient_status_update', {
      patientId,
      status,
      log: logMessage
    });
  }

  const now = new Date();
  
  if (status === 'Success' || status === 'Error') {
    // Insert log
    await pool.query(`
      INSERT INTO upload_log (patient_id, upload_status, log)
      VALUES (?, ?, ?)
    `, [patientId, status, logMessage || (status === 'Success' ? 'Upload successful' : 'Unknown error')]);
  }
}

/**
 * Process a batch of patients.
 */
async function processBatch(patientIds, io) {
  const externalApiUrl = process.env.EXTERNAL_API_URL;

  for (const patientId of patientIds) {
    try {
      console.log(`Starting process for patient: ${patientId}`);
      await updateStatus(patientId, 'Uploading', io, 'Starting upload...');

      // 1. Fetch BLOB data and filename
      const [rows] = await pool.query(
        'SELECT BlobData, BlobFileName FROM vs_patienthistory WHERE PatientID = ?', 
        [patientId]
      );

      if (!rows || rows.length === 0) {
        await updateStatus(patientId, 'Success', io, 'No files to upload.');
        continue;
      }

      // Filter out invalid/empty BLOBs and rows without a valid BlobFileName
      const files = rows.map(r => {
        if (!r.BlobData || !r.BlobFileName || r.BlobFileName.trim() === '') return null;
        // Convert to Buffer if it comes as string or other format from DB
        const buffer = Buffer.isBuffer(r.BlobData) ? r.BlobData : Buffer.from(r.BlobData);
        return { buffer, filename: r.BlobFileName };
      }).filter(f => f && f.buffer.length > 0);
      
      if (files.length === 0) {
        await updateStatus(patientId, 'Success', io, 'No valid files to upload.');
        continue;
      }

      // 2. Chunk files (Max 25 rule)
      const batches = chunkArray(files, 25);
      
      let batchIndex = 1;
      for (const batch of batches) {
        console.log(`Patient ${patientId}: Sending batch ${batchIndex}/${batches.length} (${batch.length} files)`);
        
        // 3. Construct FormData
        const form = new FormData();
        form.append('patientId', String(patientId));
        form.append('date', new Date().toISOString());
        
        batch.forEach((fileObj) => {
          // Explicitly wrap the buffer as a file with options so the external server writes it properly
          form.append('file[]', fileObj.buffer, {
            filename: fileObj.filename,
            contentType: 'application/octet-stream',
            knownLength: fileObj.buffer.length
          });
        });

        // 4. Send sequentially to external API
        const response = await axios.post(externalApiUrl, form, {
          headers: {
            ...form.getHeaders()
          },
          // Increase limits for potentially large BLOBs
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        if (response.status !== 200 && response.status !== 201) {
          throw new Error(`External API returned status ${response.status}`);
        }
        
        batchIndex++;
      }

      // 5. Log Success
      await updateStatus(patientId, 'Success', io, `Successfully uploaded ${files.length} files.`);
      console.log(`Successfully completed patient: ${patientId}`);

    } catch (error) {
      console.error(`Error processing patient ${patientId}:`, error.message);
      await updateStatus(patientId, 'Error', io, `Failed: ${error.message}`);
    }
  }

  // After processing all patients in the batch, update the global upload_status table
  try {
    if (patientIds.length > 0) {
      const [rows] = await pool.query('SELECT MIN(id) as start_id, MAX(id) as end_id FROM upload_patients WHERE patient_id IN (?)', [patientIds]);
      if (rows && rows.length > 0) {
        const { start_id, end_id } = rows[0];
        
        // Update or insert global status
        const [existing] = await pool.query('SELECT id FROM upload_status LIMIT 1');
        if (existing.length === 0) {
          await pool.query('INSERT INTO upload_status (start, end) VALUES (?, ?)', [start_id, end_id]);
        } else {
          await pool.query('UPDATE upload_status SET start = ?, end = ?', [start_id, end_id]);
        }
        console.log(`Updated global batch status: start=${start_id}, end=${end_id}`);
      }
    }
  } catch (err) {
    console.error('Failed to update global upload_status:', err.message);
  }
}

module.exports = {
  processBatch
};
